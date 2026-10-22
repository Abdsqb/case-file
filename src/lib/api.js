/**
 * api.js — the whole REST surface of Case File, and nothing else.
 *
 * No retries, no caching, no state, no React. Every call returns parsed JSON
 * (or `null` for a 204) and throws an `ApiError` with a readable message on
 * anything that is not a 2xx. Callers own loading state and error display.
 *
 * Endpoints (unchanged from the server):
 *   GET    /api/projects
 *   POST   /api/projects                 { name, parentId }
 *   PATCH  /api/projects/:id             { name?, parentId?, folderId? }
 *   GET    /api/case-folders
 *   POST   /api/case-folders             { name }
 *   PATCH  /api/case-folders/:id         { name }
 *   DELETE /api/case-folders/:id         cases are unfiled, never deleted
 *   POST   /api/projects/:id/move        { direction:'up'|'down' }
 *   DELETE /api/projects/:id
 *   POST   /api/projects/:id/tasks       { title, priority, dueDate }
 *   POST   /api/tasks/:id/subtasks       { title }
 *   PATCH  /api/tasks/:id                { title?, completed?, priority?, dueDate? }
 *   DELETE /api/tasks/:id
 *   GET    /api/headlines
 *   GET    /api/system/memory            the server process, the archive on disk, the machine
 *
 * Paths are relative, so this works behind the Vite dev proxy and from the
 * Express server that serves the built app, with no configuration.
 */

const BASE = '/api';

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function enc(value) {
  return encodeURIComponent(String(value ?? ''));
}

async function request(method, path, payload) {
  const url = `${BASE}${path}`;
  const hasBody = payload !== undefined;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(payload) : undefined,
    });
  } catch (cause) {
    throw new ApiError(`${method} ${url} — the server is unreachable.`, 0, null);
  }

  if (res.status === 204) return null;

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const detail =
      data && typeof data === 'object' && typeof data.error === 'string'
        ? data.error
        : typeof data === 'string' && data.trim()
          ? data.trim().slice(0, 200)
          : res.statusText;
    throw new ApiError(
      `${method} ${url} failed (${res.status}${detail ? `: ${detail}` : ''})`,
      res.status,
      data,
    );
  }

  return data;
}

/* ---------------------------------- cases --------------------------------- */

/** → [{ id, name, openedAt, parentId, sortOrder, tasks[] }] */
export function listProjects() {
  return request('GET', '/projects');
}

/** → the created project (with an empty tasks array). */
export function createProject(name, parentId = null) {
  return request('POST', '/projects', { name, parentId: parentId ?? null });
}

/** → the renamed project. */
export function renameProject(projectId, name) {
  return request('PATCH', `/projects/${enc(projectId)}`, { name });
}

/** direction: 'up' | 'down'. → { moved: boolean } — false at either end. */
export function moveProject(projectId, direction) {
  return request('POST', `/projects/${enc(projectId)}/move`, { direction });
}

/** Deletes the case, its sub-cases and all their entries. → null. */
/** Rename a case, move it between folders, or re-parent it. */
export function updateProject(projectId, patch) {
  return request('PATCH', `/projects/${enc(projectId)}`, patch);
}

/** `folderId: null` takes the case out of every folder. */
export function fileProject(projectId, folderId) {
  return request('PATCH', `/projects/${enc(projectId)}`, { folderId });
}

export function listCaseFolders() {
  return request('GET', '/case-folders');
}

export function createCaseFolder(name) {
  return request('POST', '/case-folders', { name });
}

export function renameCaseFolder(folderId, name) {
  return request('PATCH', `/case-folders/${enc(folderId)}`, { name });
}

export function deleteCaseFolder(folderId) {
  return request('DELETE', `/case-folders/${enc(folderId)}`);
}

export function deleteProject(projectId) {
  return request('DELETE', `/projects/${enc(projectId)}`);
}

/* --------------------------------- entries -------------------------------- */

/**
 * createTask(projectId, { title, priority, dueDate })
 * createTask(projectId, title, priority, dueDate)   — both call shapes work.
 * → the created task.
 */
export function createTask(projectId, task, priority, dueDate) {
  const body =
    typeof task === 'string'
      ? { title: task, priority: priority ?? 'normal', dueDate: dueDate ?? null }
      : {
          title: task?.title ?? '',
          priority: task?.priority ?? 'normal',
          dueDate: task?.dueDate ?? null,
        };
  return request('POST', `/projects/${enc(projectId)}/tasks`, body);
}

/**
 * createSubtask(taskId, 'title') or createSubtask(taskId, { title }).
 * Only one level deep — the server rejects a subtask of a subtask.
 * → the created task.
 */
export function createSubtask(taskId, task) {
  const title = typeof task === 'string' ? task : (task?.title ?? '');
  return request('POST', `/tasks/${enc(taskId)}/subtasks`, { title });
}

/**
 * updateTask(taskId, { title?, completed?, priority?, dueDate?, parentTaskId? })
 * Omitted fields are left alone; pass `dueDate: null` to clear a due date.
 *
 * `parentTaskId` files the entry under another one as a subtask, and `null`
 * lifts it back out. The server keeps subtasks one level deep and will refuse a
 * move that would make a grandchild, so the message it sends back is the one
 * worth showing.
 * → the updated task.
 */
export function updateTask(taskId, patch) {
  const body = {};
  if (patch && typeof patch === 'object') {
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.completed !== undefined) body.completed = !!patch.completed;
    if (patch.priority !== undefined) body.priority = patch.priority;
    if (patch.dueDate !== undefined) body.dueDate = patch.dueDate;
    if (patch.parentTaskId !== undefined) body.parentTaskId = patch.parentTaskId;
  }
  return request('PATCH', `/tasks/${enc(taskId)}`, body);
}

/** Deletes the entry and any subtasks under it. → null. */
export function deleteTask(taskId) {
  return request('DELETE', `/tasks/${enc(taskId)}`);
}

/* ------------------------------- scratchpad ------------------------------- */

/** The one free-text pad. → { body, updatedAt } — body is '' when never written. */
export function getNotes() {
  return request('GET', '/notes');
}

/** Replaces the pad wholesale. → { body, updatedAt } */
export function saveNotes(body) {
  return request('PUT', '/notes', { body: typeof body === 'string' ? body : '' });
}

/* ---------------------------------- wire ---------------------------------- */

/** → [{ id, source, title, url, publishedAt }] */
export function listHeadlines() {
  return request('GET', '/headlines');
}

const api = {
  listProjects,
  createProject,
  renameProject,
  updateProject,
  fileProject,
  moveProject,
  listCaseFolders,
  createCaseFolder,
  renameCaseFolder,
  deleteCaseFolder,
  deleteProject,
  createTask,
  createSubtask,
  updateTask,
  deleteTask,
  getNotes,
  saveNotes,
  listHeadlines,
};

/* --------------------------------- system --------------------------------- */

/** What the server and the archive are using right now. Never cached. */
export function getMemory() {
  return request('GET', '/system/memory');
}

export default api;
