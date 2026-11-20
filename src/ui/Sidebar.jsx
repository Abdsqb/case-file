/**
 * Sidebar.jsx — the app's navigation, down the left edge, as Linear has it.
 *
 *   the app's name
 *   Today's to-do and Notes, the two things that open over the page
 *   the screens
 *   Cases: every top-level case, each a click from its file, grouped into
 *     its case folder (each folder opens and closes, and remembers which);
 *     cases in no folder follow the folders
 *   Settings, and how the archive is standing
 *
 * On a desktop it is always there. On a phone it is a drawer: the header's
 * menu button slides it in over the page, and picking anything, tapping the
 * dimmed page or Escape slides it away again.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Folder, X } from 'lucide-react';
import { caseColor, FOLDERS_CHANGED, ICONS, NAV } from './nav.js';
import api from '../lib/api.js';
import { onRemoteChange } from '../lib/live.js';
import { OPEN_TODAY } from './TodayWindow.jsx';
import { OPEN_NOTES } from './NotesDrawer.jsx';

const cx = (...c) => c.filter(Boolean).join(' ');

/* Which folders are closed, kept across visits. Open is the default, so a
   new folder shows its cases. */
const CLOSED_KEY = 'casefile.sbClosedFolders';
const readClosed = () => {
  try { return new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]')); } catch { return new Set(); }
};
const writeClosed = (set) => {
  try { localStorage.setItem(CLOSED_KEY, JSON.stringify([...set])); } catch { /* private window */ }
};

/* Entries in a case (and its sub-cases) not yet done. */
function openCount(project, byParent) {
  let n = 0;
  const walk = (p) => {
    for (const t of p.tasks || []) {
      if (!t.completed) n += 1;
      for (const s of t.subtasks || []) if (!s.completed) n += 1;
    }
    for (const child of byParent.get(p.id) || []) walk(child);
  };
  walk(project);
  return n;
}

export default function Sidebar({ current, onGo, onOpenCase, activeCaseId, projects, standing, open, onClose }) {
  /* Escape closes the drawer. */
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const cases = useMemo(() => {
    const list = Array.isArray(projects) ? projects : [];
    const byParent = new Map();
    for (const p of list) {
      if (!p.parentId) continue;
      if (!byParent.has(p.parentId)) byParent.set(p.parentId, []);
      byParent.get(p.parentId).push(p);
    }
    return list
      .filter((p) => !p.parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((p) => ({ id: p.id, name: p.name, folderId: p.folderId ?? null, open: openCount(p, byParent) }));
  }, [projects]);

  /* The case folders: fetched once, then kept in step by Case files, which
     announces every change it makes to them. */
  const [folders, setFolders] = useState([]);
  useEffect(() => {
    let live = true;
    const load = () => api.listCaseFolders()
      .then((list) => { if (live && Array.isArray(list)) setFolders(list); })
      .catch(() => { /* no folders: the cases show as one list */ });
    load();
    const offRemote = onRemoteChange(load);
    const onFolders = (e) => { if (Array.isArray(e.detail)) setFolders(e.detail); };
    window.addEventListener(FOLDERS_CHANGED, onFolders);
    return () => { live = false; offRemote(); window.removeEventListener(FOLDERS_CHANGED, onFolders); };
  }, []);

  const groups = useMemo(() => {
    const known = new Set(folders.map((f) => f.id));
    return {
      folders: folders.map((f) => ({ folder: f, cases: cases.filter((c) => c.folderId === f.id) })),
      loose: cases.filter((c) => !c.folderId || !known.has(c.folderId)),
    };
  }, [folders, cases]);

  const [closed, setClosed] = useState(readClosed);
  const toggleFolder = (id) => setClosed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    writeClosed(next);
    return next;
  });

  const caseRow = (c) => (
    <button
      key={c.id}
      type="button"
      className={cx('sb__item sb__item--case', current === 'cases' && activeCaseId === c.id && 'is-current')}
      onClick={() => { onOpenCase(c.id); onClose?.(); }}
      title={c.name}
    >
      <span className="sb__dot" style={{ '--dot': caseColor(c.id) }} aria-hidden="true" />
      <span className="sb__label">{c.name}</span>
      {c.open ? <span className="sb__count">{c.open}</span> : null}
    </button>
  );

  const fire = (event) => {
    onClose?.();
    window.dispatchEvent(new Event(event));
  };

  const screens = NAV.filter((n) => n.id !== 'settings');
  const Settings = ICONS.settings;
  const Today = ICONS.today;
  const Notes = ICONS.notes;

  return (
    <>
      <div className={cx('sb-scrim', open && 'is-open')} onClick={onClose} aria-hidden="true" />
      <nav className={cx('sb', open && 'is-open')} aria-label="Main">
        <div className="sb__brand">
          <span className="sb__name">Case File</span>
          <button type="button" className="sb__close" onClick={onClose} aria-label="Close menu">
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        <div className="sb__group">
          <button type="button" className="sb__item" onClick={() => fire(OPEN_TODAY)}>
            <Today className="sb__icon" aria-hidden="true" />
            <span className="sb__label">Today's to-do</span>
            <kbd className="sb__kbd">⇧T</kbd>
          </button>
          <button type="button" className="sb__item" onClick={() => fire(OPEN_NOTES)}>
            <Notes className="sb__icon" aria-hidden="true" />
            <span className="sb__label">Notes</span>
            <kbd className="sb__kbd">⇧N</kbd>
          </button>
        </div>

        <div className="sb__group">
          {screens.map((n) => {
            const Icon = ICONS[n.id];
            return (
              <a
                key={n.id}
                href={`#${n.id}`}
                className={cx('sb__item', current === n.id && 'is-current')}
                aria-current={current === n.id ? 'page' : undefined}
                onClick={(e) => { e.preventDefault(); onGo(n.id); onClose?.(); }}
              >
                <Icon className="sb__icon" aria-hidden="true" />
                <span className="sb__label">{n.label}</span>
              </a>
            );
          })}
        </div>

        {cases.length ? (
          <div className="sb__group sb__group--cases">
            <div className="sb__heading">Cases</div>
            <div className="sb__cases">
              {groups.folders.map(({ folder, cases: inside }) => {
                const isOpen = !closed.has(folder.id);
                const holdsCurrent = current === 'cases' && inside.some((c) => c.id === activeCaseId);
                return (
                  <div key={folder.id} className={cx('sb__folder', isOpen && 'is-open')}>
                    <button
                      type="button"
                      className={cx('sb__item sb__item--folder', !isOpen && holdsCurrent && 'has-current')}
                      onClick={() => toggleFolder(folder.id)}
                      aria-expanded={isOpen}
                      title={folder.name}
                    >
                      <ChevronRight className="sb__chev" aria-hidden="true" />
                      <Folder className="sb__icon" aria-hidden="true" />
                      <span className="sb__label">{folder.name}</span>
                    </button>
                    <div className="sb__fold" inert={isOpen ? undefined : true}>
                      <div className="sb__fold-in">
                        {inside.length ? inside.map(caseRow) : <div className="sb__empty">No cases</div>}
                      </div>
                    </div>
                  </div>
                );
              })}
              {groups.loose.map(caseRow)}
            </div>
          </div>
        ) : null}

        <div className="sb__foot">
          <a
            href="#settings"
            className={cx('sb__item', current === 'settings' && 'is-current')}
            aria-current={current === 'settings' ? 'page' : undefined}
            onClick={(e) => { e.preventDefault(); onGo('settings'); onClose?.(); }}
          >
            <Settings className="sb__icon" aria-hidden="true" />
            <span className="sb__label">Settings</span>
          </a>
          {standing ? (
            <div className={cx('sb__standing', `is-${standing.tone}`)} role="status">
              <span className="sb__standing-dot" aria-hidden="true" />
              {standing.text}
            </div>
          ) : null}
        </div>
      </nav>
    </>
  );
}
