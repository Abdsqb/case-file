/**
 * clerk.js — the agent that works the archive.
 *
 * Four jobs, one set of tools, and one rule that shapes all of it:
 *
 *      READS LOOP. WRITES ARE PROPOSALS.
 *
 * The clerk can look things up as many times as it needs to — whether a case
 * for a course already exists, what is already logged under it, when you are
 * actually in class — because deciding where something belongs genuinely
 * requires looking, and a model that cannot look guesses instead.
 *
 * It cannot write. Every change it wants to make comes back as a PROPOSAL: a
 * list of rows you read, edit and accept. `apply()` is a separate call that
 * takes what you approved, validates it as untrusted input — because by then
 * it has been through a browser and is exactly that — and writes it with the
 * same statements the REST routes use.
 *
 * This is not timidity about the model. It is that the archive is real work,
 * and a filing assistant you have to audit afterwards is slower than filing it
 * yourself. Reviewing nine proposed rows takes ten seconds; finding the three
 * an unattended agent got wrong takes longer than typing all nine.
 *
 * The jobs:
 *   file(text)   unstructured text in, proposed cases/entries/subtasks out
 *   brief(now)   the day in two sentences, then one thing off the news wire
 *   ask(turns)   the chat card — questions about the archive, answered from it
 *   deck(text)   lecture notes in, proposed flashcards out
 */

import { randomUUID } from 'node:crypto';

import { db } from './db.js';
import { complete, ready, status, AiError } from './ai.js';
import { getHeadlines } from './news.js';
import {
  classWeek, classesOn, courses, loadCaseFolders, loadProjects, snapshot,
} from './archive.js';

/* Re-exported so the routes import one module. `status` is what the browser
   is told about the setup; it is defined in ai.js because that is the only
   file that has ever seen a key, and it must stay that way. */
export { ready, status, AiError };

const MAX_TOOL_ROUNDS = 4;
const MAX_INPUT_CHARS = 40000;

/* ------------------------------------------------------------------- voice */

/* The app writes in one voice and the clerk is not exempt. Lowercase sentences,
   an em dash where a comma would be too quick, no exclamation marks, no
   "Great question!", no bullet points where a sentence will do. The copy in
   metrics.js is the reference — if what comes back could be dropped into
   recommendations() unnoticed, it is right. */
const VOICE = `You write in the app's own voice: plain lowercase sentences, an em dash
where a comma is too quick, no exclamation marks, no emoji, no headings, no
preamble and no sign-off. Never say "I" unless asked something about yourself.
Never congratulate or encourage. State what is true and what to do about it.`;

/* The brief gets its own, and only the brief.
   --------------------------------------------------------------------------
   VOICE above is written for the other three jobs, where the clerk is
   transcribing: filing is a list of proposed rows, chat is an answer to a
   question, a deck is pairs of cards. Flat is right for all of those — a
   personality in a proposed row is a personality getting between the reader
   and a thing they are about to approve.

   The brief is the one place the clerk writes rather than transcribes. It is
   two or three sentences a person reads once a day, in the only column of
   prose on the screen, and "state what is true" produced exactly what you
   would expect: competent, correct and completely inert. Read four days
   running it was the same sentence with different nouns in it.

   So: character. The first pass at it was dry and blunt — a clerk with a
   view — and it read as a sharp colleague: correct, a little cold, still
   somebody at work. What the reader asked for is a friend: the person who
   read your file over your shoulder and texts you what they think. Warm
   without being a cheerleader, honest without being a manager, and allowed a
   joke when the facts hand it one.

   The guard rails are the two ways that goes wrong. One is the assistant
   voice — "it is recommended", "please note" — which is the professional
   register by another name. The other is the motivational poster — "you've
   got this" — which is what a stranger says, not a friend. */
const BRIEF_VOICE = `You're the reader's friend — the one who has actually read their whole case
file — and they've just asked you "ok, what's my day looking like". Answer the
way you'd text them back: casual, warm, honest, and a bit funny when the facts
hand you something funny. Contractions, plain words, short sentences. Talk to
them as "you". You can say "I" when it's natural ("I'd start with HW 5").

Be specific like a friend who was paying attention: the name of the entry, the
hour of the gap, the course it's for. Have an opinion about what to do first
and say why in normal words. If something has been sitting there for weeks,
you can tease them about it a little. If the day is light, say so and tell
them to enjoy it. If something got finished, a quick "nice" is fine.

You are NOT:
- a professional. no assistant voice, no "it is recommended", "please note",
  "ensure", "prioritize", "consider", no report language.
- a cheerleader. no "you've got this", "you can do it", "stay focused", no
  motivational lines, no lectures about productivity.
- a nag. no "don't forget", no "make sure", and don't pile on when something
  is going badly — say it straight once, like a friend would, and move on.

Write in lower case, like a text — a sentence doesn't get a capital just for
being first. Names keep their own capitals exactly as written (Intro to
Marketing, HW 5, OpenAI). No emoji, no hashtags, at most one exclamation mark
in the whole thing, no headings, no sign-off.

The screen already says good morning and gives the counts right above you, so
don't open with a greeting, the date, the weekday or a number.

The tone, from made-up days — never reuse these words or these names:

  ok so the Stats problem set is the one. it's due tomorrow and you've got two
  free hours after lunch, which is basically made for it.

  honestly not much on today. the History essay has been sitting there 12 days
  though, it's starting to look a little lonely.

  also, apparently Apple's pushing the new Siri back again.`;

const ROLE = `You are the clerk of Case File, a local case tracker. Work is grouped into
cases; each case holds entries with due dates and priorities; an entry can hold
subtasks one level deep. The person reading you is the only user and owns all of
this work.`;

/* ------------------------------------------------------------------- tools */

/**
 * Everything the clerk can do on its own, and all of it is reading.
 *
 * Deliberately not one `query` tool taking SQL. A tool per question means the
 * model cannot ask for something that does not exist, the answers come back in
 * a shape built for reading rather than for a database, and there is no path
 * from a model's output to an arbitrary statement against your archive.
 */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'case_detail',
      description:
        'Every entry in one case, open and closed, with its due date, priority and subtasks. '
        + 'Use before proposing an entry, to check it is not already logged.',
      parameters: {
        type: 'object',
        properties: { caseId: { type: 'string', description: 'the case id from the case list' } },
        required: ['caseId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_entries',
      description:
        'Find entries anywhere in the archive whose title matches some words. '
        + 'Cheaper than reading a whole case when you only want to know whether something exists.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          includeDone: { type: 'boolean', description: 'defaults to false' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'timetable',
      description:
        'The class schedule for the next N days, by day, with course names, rooms and times. '
        + 'Use to resolve "before the midterm" or "week 9", and to know when the reader is busy.',
      parameters: {
        type: 'object',
        properties: { days: { type: 'integer', description: '1 to 28, defaults to 7' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'standing',
      description:
        'The counts: how many entries are open, overdue, due soon, and what is due next. '
        + 'These are computed by the app, so they are correct — never recount them yourself.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const titleOf = (row) => (typeof row.title === 'string' ? row.title : '');

function runTool(name, args, now) {
  const a = args && typeof args === 'object' ? args : {};

  if (name === 'case_detail') {
    const project = loadProjects().find((p) => p.id === String(a.caseId || ''));
    if (!project) return { error: 'no case with that id' };
    return {
      id: project.id,
      name: project.name,
      entries: (project.tasks || []).map((t) => ({
        id: t.id,
        title: titleOf(t),
        due: t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 10) : null,
        priority: t.priority,
        done: !!t.completed,
        subtasks: (t.subtasks || []).map((s) => ({ id: s.id, title: titleOf(s), done: !!s.completed })),
      })),
    };
  }

  if (name === 'search_entries') {
    const q = String(a.query || '').toLowerCase().trim();
    if (!q) return { matches: [] };
    const words = q.split(/\s+/).filter(Boolean);
    const out = [];
    for (const p of loadProjects()) {
      for (const t of p.tasks || []) {
        for (const e of [t, ...(t.subtasks || [])]) {
          if (!a.includeDone && e.completed) continue;
          const hay = titleOf(e).toLowerCase();
          if (!words.every((w) => hay.includes(w))) continue;
          out.push({
            id: e.id,
            title: titleOf(e),
            case: p.name,
            caseId: p.id,
            due: e.dueDate ? new Date(e.dueDate).toISOString().slice(0, 10) : null,
            done: !!e.completed,
          });
        }
      }
    }
    return { matches: out.slice(0, 25) };
  }

  if (name === 'timetable') {
    const days = Math.min(28, Math.max(1, Number(a.days) || 7));
    return { courses: courses(), week: classWeek(now, days) };
  }

  if (name === 'standing') {
    const s = snapshot(now);
    return { today: s.today, counts: s.counts, dueNext: s.dueNext, classesToday: s.classesToday };
  }

  return { error: `no tool named ${name}` };
}

/**
 * Answer a round of tool calls, and notice when the model is going round in
 * circles.
 *
 * Observed against a real model: asked to file a syllabus, it called
 * search_entries three times in a row, exhausted the four-round cap, and then
 * had to produce its answer on the forced final round — which is the round
 * least likely to go well, and it cost four requests out of a free tier that
 * allows a few hundred a day.
 *
 * A repeat is not a failure to punish, it is a signal that the model has what
 * it needs and has lost the thread. So a tool it has already run with the same
 * arguments gets a short note back instead of the same payload, and a tool run
 * more than twice is closed off. Both say the same thing in the only channel
 * the model is listening on: you have this already, answer now.
 *
 * `ledger` is per-job, so this never leaks between one filing and the next.
 */
const SAME_TOOL_LIMIT = 2;

function dispatch(calls, { now, used, ledger }) {
  const out = [];

  for (const call of calls) {
    const fn = (call.function && call.function.name) || '';
    const rawArgs = (call.function && call.function.arguments) || '{}';

    let args = {};
    try { args = JSON.parse(rawArgs); } catch { args = {}; }

    const signature = `${fn}:${JSON.stringify(args)}`;
    const timesThisTool = (ledger.byTool.get(fn) || 0) + 1;
    ledger.byTool.set(fn, timesThisTool);

    let payload;
    if (ledger.signatures.has(signature)) {
      payload = {
        note: 'You already ran this exact lookup and its result is above. '
          + 'Do not call it again — give your final answer now.',
      };
    } else if (timesThisTool > SAME_TOOL_LIMIT) {
      payload = {
        note: `You have called ${fn} ${SAME_TOOL_LIMIT} times already. `
          + 'Work with what you have and give your final answer now.',
      };
    } else {
      ledger.signatures.add(signature);
      try {
        payload = runTool(fn, args, now);
      } catch (err) {
        /* A thrown tool is a bug here, not there. Tell the model plainly and
           let it carry on without it rather than failing the whole job. */
        payload = { error: `that lookup failed: ${err.message}` };
      }
      used.push(fn);
    }

    out.push({
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify(payload).slice(0, 12000),
    });
  }

  return out;
}

const newLedger = () => ({ signatures: new Set(), byTool: new Map() });

/* --------------------------------------------------------------- the loop */

/**
 * The agent loop: call, answer any tool calls, call again, up to a cap.
 *
 * The cap is not a safety rail so much as an honesty one. A model that has
 * asked four times and still has nothing is not one round away from the
 * answer — it is lost, and the right thing is to make it commit with what it
 * has rather than let it spend your free tier circling.
 */
async function runAgent({ capability, system, user, schema, now, temperature = 0.3, maxTokens = 2400 }) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const used = [];
  const ledger = newLedger();

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const last = round === MAX_TOOL_ROUNDS;

    const result = await complete({
      capability,
      messages,
      /* On the final round the tools are taken away, which is what forces an
         answer instead of a fifth question. */
      tools: last ? null : TOOLS,
      /* ...and only then can a schema be attached, because a provider cannot
         be given tools and a response_format in the same request: the answer
         is either a tool call or the shape, and asking for both is a request
         most of them reject outright. Which leaves a gap — the model usually
         stops asking long before the cap, on a round where no schema was
         enforced. `settle` below is what closes it. */
      schema: last ? schema : null,
      temperature,
      maxTokens,
    });

    if (!result.toolCalls.length) {
      const final = schema && !last
        ? await settle(result, { capability, messages, schema, temperature, maxTokens })
        : result;
      return { ...final, toolsUsed: used };
    }

    messages.push({
      role: 'assistant',
      content: result.text || '',
      tool_calls: result.toolCalls,
    });

    for (const m of dispatch(result.toolCalls, { now, used, ledger })) messages.push(m);
  }

  throw new AiError('the clerk could not settle on an answer.', { status: 502 });
}

/**
 * The model answered a round where no schema could be enforced. Is the answer
 * the right shape anyway?
 *
 * Usually yes — it was told the shape in words and models are good at this. So
 * the common path costs nothing: parse it, and if it parsed, that is the
 * answer. Only when it did not does this spend one more call, with the tools
 * off so a schema CAN be attached, handing back what the model already said
 * and asking for it again properly.
 *
 * Always re-asking would be one wasted call on every filing; never re-asking
 * would mean the schema in FILE_SCHEMA was decoration. This is the only
 * version that is both correct and cheap.
 */
async function settle(result, { capability, messages, schema, temperature, maxTokens }) {
  /* The same salvage the real parse uses, not a bare JSON.parse. A fenced
     block is a correct answer wearing a jacket — re-asking for it would spend
     a call on every filing, because fencing JSON is what models do. */
  if (tryObject(result.text)) return result;

  const retry = await complete({
    capability,
    /* The original question, the answer, and "say that again properly" — and
       deliberately NOT the tool round trips in between. Two reasons. The
       lookups are already folded into the answer being re-asked about, so
       they add nothing; and a request carrying `tool` messages while
       declaring no tools is the sort of thing providers disagree about, which
       is a poor bet to make on the one path that only runs when something has
       already gone slightly wrong. */
    messages: [
      ...messages.slice(0, 2),
      { role: 'assistant', content: result.text || '' },
      {
        role: 'user',
        content: 'Return that same answer as JSON matching the schema, and nothing else — '
          + 'no prose around it and no code fence.',
      },
    ],
    tools: null,
    schema,
    temperature,
    maxTokens,
  });

  /* If the second attempt came back empty, the first one is still the better
     of the two — parseObject can often salvage a fenced block out of it. */
  return retry.text ? retry : result;
}

/* ------------------------------------------------------------- parsing JSON */

/**
 * Pull an object out of whatever came back.
 *
 * Even with response_format set, a model will occasionally wrap JSON in a
 * fenced block or put a sentence in front of it. Throwing on that would make
 * the feature feel broken for a reason the reader cannot act on, so: try it
 * straight, then try the outermost braces, then give up with a message that
 * says what happened.
 */
function tryObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const attempts = [raw];

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) attempts.push(fenced[1].trim());

  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(raw.slice(first, last + 1));

  for (const candidate of attempts) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') return value;
    } catch { /* next */ }
  }

  return null;
}

function parseObject(text) {
  if (!String(text || '').trim()) throw new AiError('the clerk returned nothing.');
  const value = tryObject(text);
  if (value) return value;
  throw new AiError('the clerk did not answer in a shape this app can read.');
}

/* ------------------------------------------------------------------ filing */

const PRIORITIES = new Set(['low', 'normal', 'high']);
const KINDS = new Set(['case', 'entry', 'subtask']);

const FILE_SCHEMA = {
  name: 'filing',
  schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      nothing: { type: 'string' },
      proposals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string' },
            kind: { type: 'string', enum: ['case', 'entry', 'subtask'] },
            name: { type: 'string' },
            title: { type: 'string' },
            caseId: { type: 'string' },
            caseRef: { type: 'string' },
            under: { type: 'string' },
            due: { type: 'string' },
            priority: { type: 'string', enum: ['low', 'normal', 'high'] },
            why: { type: 'string' },
          },
          required: ['ref', 'kind'],
        },
      },
    },
    required: ['proposals'],
  },
};

/**
 * Text in, proposed rows out. Nothing is written.
 *
 * The case list and today's date go in the prompt rather than behind a tool:
 * every filing job needs both, and making the model spend a round trip asking
 * for something it always wants is a slower answer for no benefit. What stays
 * behind a tool is the per-case detail — needed only when it is about to
 * propose something that might already be there.
 */
export async function file(text, now = Date.now()) {
  const body = String(text || '').trim().slice(0, MAX_INPUT_CHARS);
  if (!body) throw new AiError('there is nothing on the pad to file.', { status: 400 });

  const snap = snapshot(now, { limit: 12 });
  const folders = loadCaseFolders();

  const system = `${ROLE}

${VOICE}

Your job here is FILING: turn what the reader has written down into entries in
the archive. You propose; you never write. Everything you return is reviewed
before anything happens.

How to do it well:
- One proposal per real piece of work. A line that mentions three deadlines is
  three entries, not one entry listing them.
- STRONGLY prefer an existing case. The same course goes by several names — its
  code (CS 341), its title (Operating Systems), or both together — and a case
  called "Operating Systems" is the right home for anything headed "CS 341
  Operating Systems". Match on what the work is ABOUT, not on the string. The
  same goes for a project or a client under a shortened name.
  Propose a new case only when nothing in the list covers that subject at all.
  A duplicate case is the worst thing you can do here: it splits a course's
  work across two places, and the reader has to merge them by hand afterwards.
- Before proposing an entry into an existing case, call case_detail on that case
  and do not propose something that is already logged there.
- Dates: resolve everything to an absolute YYYY-MM-DD against today's date.
  "friday" is the next one, "week 9" and "before the midterm" need the timetable
  tool. If a date is genuinely not stated or implied, leave it out — a guessed
  deadline is worse than none, because it will be trusted.
- Priority is a RANKING, not a label. If you are about to mark everything
  'high', you are not ranking anything and the field has stopped meaning
  anything. Most work is 'normal'. Spend 'high' on the few things that would
  genuinely hurt most to miss — a final, an exam, a large graded submission —
  and leave routine coursework, reading and preparation at 'normal'. A syllabus
  is mostly graded work; that does not make all of it high.
- Titles are what the reader would have typed: short, specific, no filler, no
  trailing full stop. Keep their wording where it is usable.
- Steps that only make sense as part of one deliverable are subtasks of it.
- 'why' quotes the few words from the source that produced this row, so the
  reader can check it at a glance. Never invent it.

Return JSON only:
{
  "summary": "one short sentence on what you found",
  "proposals": [
    { "ref": "c1", "kind": "case",    "name": "CS 341" },
    { "ref": "e1", "kind": "entry",   "caseId": "<existing id>" OR "caseRef": "c1",
      "title": "Assignment 3", "due": "2026-10-17", "priority": "high",
      "why": "A3 due Oct 17" },
    { "ref": "s1", "kind": "subtask", "under": "e1", "title": "read chapter 4" }
  ]
}

'ref' is a short id you invent so later rows can point at earlier ones. An entry
names its case with caseId (one that exists) or caseRef (a case you are
proposing in this same list) — never both. A subtask names its parent entry
with 'under'.

If the text holds no work to file, return {"proposals": [], "summary": "..."}
saying what it looked like instead. Do not invent work to be useful.`;

  const user = `Today is ${snap.weekday} ${snap.today}, ${snap.clock}.

Cases that exist:
${snap.cases.length
    ? snap.cases.map((c) => `  ${c.id}  ${c.name}${c.parentId ? ' (sub-case)' : ''} — ${c.open} open of ${c.total}`).join('\n')
    : '  (none yet)'}
${folders.length ? `\nCase folders: ${folders.map((f) => f.name).join(', ')}` : ''}
${courses().length ? `\nCourses on the timetable: ${courses().join(', ')}` : ''}

Classes today:
${snap.classesToday.length
    ? snap.classesToday.map((c) => `  ${c.from}–${c.to}  ${c.course}${c.where ? ` (${c.where})` : ''}`).join('\n')
    : '  none'}

--- what the reader wrote ---
${body}
--- end ---

File it.`;

  const result = await runAgent({
    capability: 'deep',
    system,
    user,
    schema: FILE_SCHEMA,
    now,
    temperature: 0.2,
    maxTokens: 3000,
  });

  const parsed = parseObject(result.text);
  const proposals = normaliseProposals(parsed.proposals, now);

  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
    proposals,
    model: result.model,
    provider: result.providerLabel,
    toolsUsed: [...new Set(result.toolsUsed)],
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A due date, or nothing — and the two are never allowed to disagree.
 *
 * `dueText` is what the review sheet renders and `due` is what gets written,
 * so they have to come from the same decision. Deriving the text from the
 * shape alone was a real bug: "2026-13-45" matches the pattern, fails the
 * calendar, and a browser asked to lay it out rolls it over to February 2027
 * — so the sheet would have shown a confident wrong date for a value the
 * server had already rejected. Both now come out of dateToMs or neither does.
 */
function dueOf(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!DATE_RE.test(text)) return { due: null, dueText: null };
  const due = dateToMs(text);
  return due === null ? { due: null, dueText: null } : { due, dueText: text };
}

/** 'YYYY-MM-DD' → local midnight in ms, or null. Local, because a deadline is
    a day on your calendar and not an instant in UTC. */
export function dateToMs(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value.trim())) return null;
  const [y, m, d] = value.trim().split('-').map(Number);
  const date = new Date(y, m - 1, d, 0, 0, 0, 0);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date.getTime();
}

/**
 * Everything the model proposed, reduced to rows this app could actually make.
 *
 * Anything malformed is dropped rather than repaired — a proposal with a
 * mangled date that gets silently "fixed" to today is the exact failure this
 * whole review step exists to prevent. Each survivor carries `ok: true` and its
 * own id so the browser can let you toggle and edit it.
 */
function normaliseProposals(list, now) {
  if (!Array.isArray(list)) return [];

  const caseIds = new Set(loadProjects().map((p) => p.id));
  const seenRefs = new Map();
  const out = [];

  for (const raw of list.slice(0, 80)) {
    if (!raw || typeof raw !== 'object') continue;

    const kind = String(raw.kind || '').trim();
    if (!KINDS.has(kind)) continue;

    const ref = String(raw.ref || '').trim() || `r${out.length + 1}`;
    if (seenRefs.has(ref)) continue;

    const why = typeof raw.why === 'string' ? raw.why.trim().slice(0, 200) : '';

    if (kind === 'case') {
      const name = String(raw.name || raw.title || '').trim().slice(0, 120);
      if (!name) continue;
      const row = { id: randomUUID(), ref, kind, name, why };
      seenRefs.set(ref, row);
      out.push(row);
      continue;
    }

    const title = String(raw.title || raw.name || '').trim().replace(/\.$/, '').slice(0, 300);
    if (!title) continue;

    if (kind === 'subtask') {
      const under = String(raw.under || '').trim();
      const parent = seenRefs.get(under);
      /* A subtask whose parent did not survive has nowhere to go. Rather than
         drop the work, it becomes an entry in its own right — the reader can
         see it and delete it, which is better than it vanishing silently. */
      if (!parent || parent.kind !== 'entry') {
        const row = {
          id: randomUUID(), ref, kind: 'entry', title, why,
          caseId: parent && parent.kind === 'case' ? null : firstCaseId(raw, caseIds),
          caseRef: parent && parent.kind === 'case' ? parent.ref : null,
          ...dueOf(raw.due),
          priority: PRIORITIES.has(raw.priority) ? raw.priority : 'normal',
          orphaned: true,
        };
        if (!row.caseId && !row.caseRef) continue;
        seenRefs.set(ref, row);
        out.push(row);
        continue;
      }
      const row = { id: randomUUID(), ref, kind, title, under, why };
      seenRefs.set(ref, row);
      out.push(row);
      continue;
    }

    // kind === 'entry'
    const caseRefRaw = String(raw.caseRef || '').trim();
    const proposedCase = seenRefs.get(caseRefRaw);
    const caseRef = proposedCase && proposedCase.kind === 'case' ? caseRefRaw : null;
    const caseId = caseRef ? null : firstCaseId(raw, caseIds);
    if (!caseId && !caseRef) continue;

    const row = {
      id: randomUUID(),
      ref,
      kind,
      title,
      caseId,
      caseRef,
      ...dueOf(raw.due),
      priority: PRIORITIES.has(raw.priority) ? raw.priority : 'normal',
      why,
    };
    seenRefs.set(ref, row);
    out.push(row);
  }

  return out;
}

function firstCaseId(raw, caseIds) {
  const id = String(raw.caseId || '').trim();
  return id && caseIds.has(id) ? id : null;
}

/* ------------------------------------------------------------------- apply */

const insertProject = () => db.prepare(
  'INSERT INTO projects (id, name, opened_at, sort_order, parent_id, folder_id) VALUES (?, ?, ?, ?, NULL, NULL)',
);
const insertTask = () => db.prepare(
  `INSERT INTO tasks (project_id, title, priority, created_at, due_date, completed, blocked_by, parent_task_id)
   VALUES (?, ?, ?, ?, ?, 0, NULL, ?)`,
);

/**
 * Write what the reader approved.
 *
 * Treated as untrusted input, because it is: these rows have been through a
 * browser where they were edited, and nothing here may assume they are still
 * what the model said. Cases first, then entries, then subtasks, so a ref can
 * only ever point backwards at something already real.
 *
 * One transaction. A filing that half-applied would leave entries under a case
 * that does not exist, and the reader would have no way to tell which half.
 */
export function apply(list, now = Date.now()) {
  if (!Array.isArray(list) || !list.length) {
    throw new AiError('nothing was approved.', { status: 400 });
  }

  const rows = list.filter((r) => r && typeof r === 'object').slice(0, 200);
  const caseIds = new Set(loadProjects().map((p) => p.id));

  const made = { cases: 0, entries: 0, subtasks: 0 };
  const refToCase = new Map();
  const refToTask = new Map();

  const run = db.prepare('BEGIN');
  const commit = db.prepare('COMMIT');
  const rollback = db.prepare('ROLLBACK');

  const projectStmt = insertProject();
  const taskStmt = insertTask();

  run.run();
  try {
    const nextOrder = () => {
      const { n } = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM projects').get();
      return n;
    };

    for (const row of rows) {
      if (String(row.kind) !== 'case') continue;
      const name = String(row.name || '').trim().slice(0, 120);
      if (!name) continue;
      const id = randomUUID();
      projectStmt.run(id, name, now, nextOrder());
      caseIds.add(id);
      if (row.ref) refToCase.set(String(row.ref), id);
      made.cases += 1;
    }

    for (const row of rows) {
      if (String(row.kind) !== 'entry') continue;
      const title = String(row.title || '').trim().slice(0, 300);
      if (!title) continue;

      const viaRef = row.caseRef ? refToCase.get(String(row.caseRef)) : null;
      const direct = String(row.caseId || '').trim();
      const projectId = viaRef || (caseIds.has(direct) ? direct : null);
      if (!projectId) continue;

      const priority = PRIORITIES.has(row.priority) ? row.priority : 'normal';
      const due = Number.isFinite(row.due) ? row.due : dateToMs(row.dueText);

      const res = taskStmt.run(projectId, title, priority, now, due ?? null, null);
      if (row.ref) refToTask.set(String(row.ref), { id: res.lastInsertRowid, projectId });
      made.entries += 1;
    }

    for (const row of rows) {
      if (String(row.kind) !== 'subtask') continue;
      const title = String(row.title || '').trim().slice(0, 300);
      const parent = refToTask.get(String(row.under || ''));
      if (!title || !parent) continue;
      taskStmt.run(parent.projectId, title, 'normal', now, null, parent.id);
      made.subtasks += 1;
    }

    commit.run();
  } catch (err) {
    rollback.run();
    throw new AiError(`filing failed and nothing was written: ${err.message}`, { status: 500 });
  }

  return made;
}

/* ------------------------------------------------------------------- brief */

/* The brief is cached against the facts that produced it, not against the
   clock. Opening the dashboard four times before lunch should not spend four
   calls; ticking something overdue off SHOULD change what it says. The
   fingerprint is the handful of numbers a sentence about the day depends on —
   anything finer and it would regenerate while you typed.

   The wire is in the fingerprint too, and only its lead story from each beat.
   That is the right grain for the same reason the rest of it is: the brief
   spends one sentence on the news, so it goes out of date exactly when the
   story it spent that sentence on stops being the top one — a few times a day,
   not every five minutes when the feed refreshes and item forty moves. */
/* Bumped whenever the brief changes shape or voice, so a brief written under
   the old rules is not served as if it had been written under the new ones.
   v2: two parts, and the friend's voice. */
const BRIEF_VERSION = 'v2';

function briefKey(snap, wire) {
  const head = snap.dueNext.slice(0, 3).map((e) => `${e.id}:${e.state}`).join(',');
  const cls = snap.classesToday.map((c) => c.from).join(',');
  const lead = [wire.tech[0]?.id || '-', wire.world[0]?.id || '-'].join(',');
  return [BRIEF_VERSION, snap.today, snap.counts.overdue, snap.counts.open, snap.counts.dueSoon, head, cls, lead].join('|');
}

/* The brief is two parts — the day, then the news — and the table has one
   column for it. So the column holds JSON, and anything that is not JSON is a
   brief from before the split: all of it is the day, and there is no news. */
function briefParts(stored) {
  try {
    const value = JSON.parse(stored);
    if (value && typeof value.work === 'string') {
      return { work: value.work, news: typeof value.news === 'string' ? value.news : '' };
    }
  } catch { /* a v1 brief: plain text */ }
  return { work: String(stored || ''), news: '' };
}

function briefOut(row, cached) {
  const { work, news } = briefParts(row.body);
  return {
    work,
    news,
    /* Both parts as one paragraph, for anything that still reads `body`. */
    body: news ? `${work} ${news}` : work,
    model: row.model,
    madeAt: row.made_at,
    cached,
  };
}

db.exec(`
  CREATE TABLE IF NOT EXISTS clerk_brief (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cache_key TEXT NOT NULL,
    body TEXT NOT NULL,
    model TEXT,
    made_at INTEGER NOT NULL
  );
`);

/* The prompt asks for two or three sentences under fifty words. This is what
   makes that a fact rather than a request.
 *
 * It is a layout constraint as much as an editorial one. The brief is set in
 * the dashboard's left column, above what is coming up, inside a column whose
 * height is fixed — so every line it gains is a line pushed toward the bottom
 * of that column, and past a point it pushes what is coming up out of the
 * frame. 430 is what fits at the SHORTEST window the dashboard supports, not
 * at a comfortable one; measured at five viewport heights with the longest
 * brief the budget allows.
 *
 * Trimmed on sentence boundaries, never mid-word: a brief that stops in the
 * middle of a clause reads as broken software, which is a worse failure than
 * saying one thing less.
 *
 * Split between the two parts now, and the split sums to a little under the
 * old 430: the news is its own paragraph, and the gap between the two costs
 * about one line's height of the same column. */
const WORK_CHARS = 270;
const NEWS_CHARS = 150;

/* THE REGISTER, ENFORCED.
   --------------------------------------------------------------------------
   The prompt asks for lower case and mostly gets it; "mostly" is not a style.
   Measured over a run of briefs, roughly one in three came back in sentence
   case — correct, well written, and visibly not this app, sitting directly
   under a headline that is lower case.

   So it is enforced here, the way the length is. The hard part is that a
   blanket lowercase would be worse than the drift: it would turn "the MIDTERM
   for Intro to Marketing" into noise and rewrite the name of a company. Only
   the word that OPENS a sentence is touched, and only when nothing says it is
   a name:

     - it appears capitalised in the facts the brief was written from, which is
       where every entry title, course, case and headline comes from;
     - it carries a capital that is not the first letter (OpenAI, iPhone,
       TechCrunch), which is never an accident;
     - it is all capitals (AI, NASA, EU, and entry titles written that way).

   Everything else is a word that got a capital for standing first, which is
   the one thing this app does not do. */
/* Every name the brief is entitled to write, spelled the way the archive spells
   it. Taken from the snapshot and the wire STRUCTURALLY rather than by reading
   capitals out of the prompt text, because the prompt text also contains the
   words Today, Open, Classes and Tech, and none of those is a name. */
function namesOf(snap, wire) {
  const out = new Set();
  const add = (v) => { const t = String(v || '').trim(); if (t) out.add(t); };

  for (const e of [...snap.dueNext, ...snap.undated]) { add(e.title); add(e.case); }
  for (const c of snap.cases || []) add(c.name);
  for (const c of snap.classesToday) add(c.course);

  /* Out of a headline, only the words that are unmistakably a name on their
     own: an internal capital is never an accident of position. Taking every
     capitalised word in a headline would take the first word of every one. */
  for (const h of [...wire.tech, ...wire.world]) {
    for (const w of h.title.match(/[A-Za-z][\w'’-]*/g) || []) {
      if (/[A-Z]/.test(w.slice(1))) add(w);
    }
  }
  return [...out];
}

/* A name is safe to restore only if it cannot also be an ordinary word in an
   ordinary sentence. Multi-word phrases, internal capitals and all-capitals
   qualify; a lone, plainly capitalised word does not, and that exclusion is
   load-bearing — this archive has cases called "Case" and "Granny", and
   restoring those would rewrite "the case is open" into something absurd. */
const distinct = (n) =>
  /\s/.test(n) || /[A-Z]/.test(n.slice(1)) || (n.length > 1 && n === n.toUpperCase());

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function houseCase(text, facts, names = []) {
  /* First the names, wherever they fell. The prompt asks for them as written
     and mostly complies; "mostly" turned "OpenAI" into "openai" in three briefs
     out of five, and this reader's own course into "intro to marketing".
     Longest first, so "Intro to Marketing" is settled before "Marketing" can
     match inside it. */
  let out = text;
  for (const name of names.filter(distinct).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\w'’-])${escapeRe(name)}(?![\\w'’-])`, 'gi'), name);
  }

  /* Then the word that only got a capital for standing first. */
  const known = new Set(facts.match(/\b[A-Z][\w'’-]*/g) || []);

  return out.replace(/(^|[.?!]["')’]?\s+)([A-Za-z][\w'’-]*)/g, (whole, lead, word) => {
    if (known.has(word)) return whole;
    /* The friend is allowed "I", and "i'd start with" is a typo, not a register. */
    if (/^I(['’]\w+)?$/.test(word)) return whole;
    if (/[A-Z]/.test(word.slice(1))) return whole;
    if (word.length > 1 && word === word.toUpperCase()) return whole;
    return `${lead}${word.charAt(0).toLowerCase()}${word.slice(1)}`;
  });
}

function trimToSentences(text, budget) {
  if (text.length <= budget) return text;

  let out = '';
  for (const piece of text.split(/(?<=[.?!])\s+/)) {
    if (out && (out.length + 1 + piece.length) > budget) break;
    out = out ? `${out} ${piece}` : piece;
  }

  /* The first sentence is always taken, because taking none would be worse —
     which means one sentence longer than the entire budget gets through the
     loop untouched. Cut it on a word boundary and let the ellipsis say so. */
  if (out.length > budget) {
    const head = out.slice(0, budget);
    const space = head.lastIndexOf(' ');
    out = `${(space > 0 ? head.slice(0, space) : head).replace(/[,;:.]$/, '')}…`;
  }

  return out;
}

/**
 * The last brief, for the one case where the model could not be reached.
 *
 * Deliberately NOT matched against the fingerprint. Its only caller is the
 * route's catch, where the alternative is an error box; a sentence written an
 * hour ago under slightly different numbers beats that, and the route marks it
 * stale so nothing pretends otherwise. The one thing it will not do is serve
 * yesterday's: a brief opens by saying what today is.
 */
/* How many headlines the brief is shown. Enough that it has a choice and few
   enough that it cannot spend the request reading the news: the model gets one
   sentence out of this, so a longer list is tokens bought to be thrown away —
   and on Groq's free tier the cap is tokens per minute, which is the one the
   brief would hit first. Titles only, no summaries, for the same reason. */
const WIRE_TECH = 8;
const WIRE_WORLD = 4;

/**
 * The wire, or an empty one.
 *
 * The brief is about the reader's day and the news is the last sentence of it,
 * so an outlet being down is not a reason to fail: it is a reason to write two
 * sentences instead of three. getHeadlines already serves stale rather than
 * blanking, and this is the belt to that braces.
 */
async function readWire() {
  try {
    const [tech, world] = await Promise.all([getHeadlines('tech'), getHeadlines('world')]);
    return { tech: tech.slice(0, WIRE_TECH), world: world.slice(0, WIRE_WORLD) };
  } catch (err) {
    console.warn('Clerk: the wire is down, writing the brief without it —', err.message);
    return { tech: [], world: [] };
  }
}

function wireBlock(wire) {
  if (!wire.tech.length && !wire.world.length) {
    return 'The wire is down right now, so there is no news to report. Leave "news" empty.';
  }
  const list = (items) => items.map((h) => `  [${h.source}] ${h.title}`).join('\n');
  return `On the wire right now. These are real headlines, newest first. Pick ONE of
them for "news" — tech unless there is nothing in it:

Tech:
${wire.tech.length ? list(wire.tech) : '  nothing on the tech wire'}

World:
${wire.world.length ? list(wire.world) : '  nothing on the world wire'}`;
}

export function cachedBrief(now = Date.now()) {
  const row = db.prepare('SELECT * FROM clerk_brief WHERE id = 1').get();
  if (!row) return null;
  const sameDay = new Date(row.made_at).toDateString() === new Date(now).toDateString();
  if (!sameDay) return null;
  return briefOut(row, true);
}

const BRIEF_SCHEMA = {
  name: 'brief',
  schema: {
    type: 'object',
    properties: {
      work: { type: 'string' },
      news: { type: 'string' },
    },
    required: ['work', 'news'],
  },
};

/* One part of the brief, cleaned the way the whole of it used to be — and
   finished: a paragraph that just stops reads as cut off, even when it isn't. */
function briefPart(text, budget, facts, names) {
  const out = trimToSentences(
    houseCase(
      String(text || '')
        .trim()
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/\s+/g, ' '),
      facts,
      names,
    ),
    budget,
  );
  return out && !/[.?!…]["')’]?$/.test(out) ? `${out}.` : out;
}

/**
 * The day in two sentences, then one thing off the wire, on the dashboard's
 * left column.
 *
 * It is handed the numbers and told not to count. Everything in the brief that
 * is a quantity came from the app's own arithmetic; the model's contribution is
 * the part arithmetic cannot do — what to do first, given a deadline in two
 * days and a four-hour gap between classes this afternoon.
 */
export async function brief(now = Date.now(), { force = false } = {}) {
  const snap = snapshot(now, { limit: 10 });
  const wire = await readWire();
  const key = briefKey(snap, wire);

  if (!force) {
    const row = db.prepare('SELECT * FROM clerk_brief WHERE id = 1').get();
    if (row && row.cache_key === key) return briefOut(row, true);
  }

  const system = `${ROLE}

${BRIEF_VOICE}

The brief has two parts, and they are shown as two separate paragraphs.

"work" — their day. Two sentences, under fifty words. Which one thing to do
first and why that one. When there's actually room to do it, given the
classes. Anything quietly going wrong — something stalled, a pile landing on
one day. Say the thing the numbers can't; the numbers are already on screen.
If there's genuinely nothing pressing, say that in one sentence.

"news" — one thing from the wire, the way you'd mention it to a friend
("also, apparently ..."). One or two short sentences, under thirty words.
Lead with tech — that's what this reader follows. Say what the story IS: the
company, the thing, what happened. "there's news about ai" is a category, not
news. Use the world list only if nothing in tech is worth it. If the wire is
empty, "news" is an empty string. "news" doesn't go back over their to-do list.

Connect a headline to their work ONLY when the link is really there — a
course that's about the thing in the story, an entry it actually bears on.
Most days there's no link, and then you just tell them the story. Don't
explain why there's no link.

Hard rules:
- Every number you use must appear in the facts below. Never count anything
  yourself and never estimate. If you want to say something you cannot support
  from the facts, say less.
- Name entries and courses as they are written.
- Never invent a headline and never change what one says. You may compress one
  into a clause; you may not sharpen it, guess at its consequences, or state as
  fact anything the headline does not.
- You only know TODAY's classes. Never say anything about free time, classes
  or plans on any other day — "you've got the week off" is a guess.
- Being casual never loosens any of the above. A friend who gets the date
  wrong is worse than a stiff one who gets it right.

Return JSON: {"work": "...", "news": "..."}. Plain sentences inside each
string — no markdown, no quotes around them.`;

  const user = `Facts, all computed by the app and all correct:

Today: ${snap.weekday} ${snap.today}, the time is ${snap.clock}
Open: ${snap.counts.open} · overdue: ${snap.counts.overdue} · due soon: ${snap.counts.dueSoon}
Closed so far: ${snap.counts.done} of ${snap.counts.logged} (${snap.counts.completionPct}%)
Longest-idle open entry: ${snap.counts.oldestIdleDays}d

Classes today:
${snap.classesToday.length
    ? snap.classesToday.map((c) => `  ${c.from}–${c.to}  ${c.course}${c.where ? ` (${c.where})` : ''}`).join('\n')
    : '  none today'}

What is due, soonest first:
${snap.dueNext.length
    ? snap.dueNext.map((e) => `  ${e.due} (${e.inDays < 0 ? `${-e.inDays}d late` : e.inDays === 0 ? 'today' : `in ${e.inDays}d`}) [${e.priority}] ${e.title} — ${e.case}`).join('\n')
    : '  nothing dated'}

${snap.undated.length ? `Open with no date:\n${snap.undated.map((e) => `  [${e.priority}] ${e.title} — ${e.case}`).join('\n')}` : ''}

What the app already says:
${snap.signals.map((s) => `  ${s}`).join('\n')}

${wireBlock(wire)}

Write the brief.`;

  const result = await complete({
    capability: 'fast',
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    /* A notch warmer than the rest of the clerk: a friend who says the same
       sentence every morning is a recording. */
    temperature: 0.7,
    schema: BRIEF_SCHEMA,
    /* Far more than two sentences needs, because some models spend most of a
       budget on reasoning before emitting any prose — gpt-oss wrote 594
       characters of it to produce 85 of answer. Too small a budget there does
       not truncate the brief, it returns an empty one. The length is governed
       by trimToSentences below, not by this. */
    maxTokens: 900,
  });

  /* A model that ignored the shape and wrote prose has still written the
     brief — all of it becomes the day, and there is no news today. Better
     than throwing away a good paragraph over a missing brace. */
  const parsed = tryObject(result.text);
  const raw = parsed && typeof parsed.work === 'string'
    ? { work: parsed.work, news: typeof parsed.news === 'string' ? parsed.news : '' }
    : { work: String(result.text || ''), news: '' };

  /* The facts are what gets to vouch for a capital. Nothing else can: a name
     the brief invented is a name this app has never written. */
  const facts = `${user}\n${system}`;
  const names = namesOf(snap, wire);
  const work = briefPart(raw.work, WORK_CHARS, facts, names);
  const news = briefPart(raw.news, NEWS_CHARS, facts, names);

  if (!work) throw new AiError('the clerk had nothing to say.');

  const madeAt = Date.now();
  const row = { body: JSON.stringify({ work, news }), model: result.model, made_at: madeAt };

  db.prepare(`
    INSERT INTO clerk_brief (id, cache_key, body, model, made_at) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET cache_key = excluded.cache_key, body = excluded.body,
                                  model = excluded.model, made_at = excluded.made_at
  `).run(key, row.body, row.model, madeAt);

  return briefOut(row, false);
}

/* -------------------------------------------------------------------- chat */

const MAX_TURNS = 12;

/**
 * The chat card. Questions about the archive, answered out of the archive.
 *
 * Same tools as filing, so "what did I say I'd do for the databases course"
 * is answerable rather than guessed at. It still cannot write — if you ask it
 * to add something it says so and points you at the pad, which is where filing
 * lives.
 */
export async function ask(turns, now = Date.now()) {
  const history = (Array.isArray(turns) ? turns : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  if (!history.length || history[history.length - 1].role !== 'user') {
    throw new AiError('there is no question to answer.', { status: 400 });
  }

  const snap = snapshot(now, { limit: 10 });

  const system = `${ROLE}

${VOICE}

You are answering questions in a small card on the dashboard, so be short —
a couple of sentences usually, a short list only when the answer genuinely is
a list. Never more than about eighty words unless asked for detail.

You can look things up with the tools. Use them rather than guessing: if you
are asked about a case, read it. Never state a number you have not been given
or looked up.

You cannot change anything — you have no tools that write. If you are asked to
add, move or complete something, say that filing happens on the scratchpad
(the tab on the left edge) and offer to draft the text for it.

If the archive does not answer the question, say so plainly. The reader would
rather hear "that is not logged anywhere" than a confident guess.`;

  const context = `Where things stand right now, so you do not have to look it up:
Today is ${snap.weekday} ${snap.today}, ${snap.clock}.
${snap.counts.open} open, ${snap.counts.overdue} overdue, ${snap.counts.dueSoon} due soon, ${snap.counts.completionPct}% of everything logged is closed.

Cases:
${snap.cases.length ? snap.cases.map((c) => `  ${c.id}  ${c.name} — ${c.open} open of ${c.total}`).join('\n') : '  (none)'}

Due next:
${snap.dueNext.length ? snap.dueNext.slice(0, 8).map((e) => `  ${e.due} [${e.priority}] ${e.title} — ${e.case}`).join('\n') : '  nothing dated'}

Classes today:
${snap.classesToday.length ? snap.classesToday.map((c) => `  ${c.from}–${c.to} ${c.course}`).join('\n') : '  none'}`;

  const messages = [
    { role: 'system', content: system },
    { role: 'system', content: context },
    ...history,
  ];

  const used = [];
  const ledger = newLedger();

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const last = round === MAX_TOOL_ROUNDS;
    const result = await complete({
      capability: 'fast',
      messages,
      tools: last ? null : TOOLS,
      temperature: 0.5,
      /* Headroom for a model that reasons before it answers; the prompt is
         what keeps the reply short, not the ceiling. */
      maxTokens: 1200,
    });

    if (!result.toolCalls.length) {
      const text = String(result.text || '').trim();
      if (!text) throw new AiError('the clerk had nothing to say.');
      return { reply: text, model: result.model, provider: result.providerLabel, toolsUsed: [...new Set(used)] };
    }

    messages.push({ role: 'assistant', content: result.text || '', tool_calls: result.toolCalls });

    for (const m of dispatch(result.toolCalls, { now, used, ledger })) messages.push(m);
  }

  throw new AiError('the clerk could not settle on an answer.');
}

/* -------------------------------------------------------------------- deck */

const DECK_SCHEMA = {
  name: 'deck',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      cards: {
        type: 'array',
        items: {
          type: 'object',
          properties: { front: { type: 'string' }, back: { type: 'string' } },
          required: ['front', 'back'],
        },
      },
    },
    required: ['cards'],
  },
}

/**
 * Lecture notes in, proposed cards out. Nothing is imported until you say so.
 *
 * The deck table already keeps `source_text`, so a generated deck is no less
 * traceable than an imported file — "show me what this came from" gives you
 * the lecture back.
 */
export async function deck(text, { name = '', count = 0, now = Date.now() } = {}) {
  const body = String(text || '').trim().slice(0, MAX_INPUT_CHARS);
  if (!body) throw new AiError('there is no source text to build a deck from.', { status: 400 });

  const target = Number(count) > 0 ? Math.min(60, Math.round(Number(count))) : 0;

  const system = `${ROLE}

Your job here is building a flashcard deck out of a piece of source material —
lecture notes, a chapter, a summary. The deck is reviewed on an SM-2 spaced
schedule, which is what makes the card format matter:

- One fact per card. A card that asks two things cannot be graded.
- The front is a question or a prompt that can be answered from memory, not a
  topic heading. "what does ACID stand for" — not "ACID".
- The back is the shortest complete answer. A sentence or two. Never a
  paragraph, never a list of six things unless the six are the answer.
- Write cards for what the material actually teaches: definitions, mechanisms,
  distinctions, the conditions under which something holds, worked rules. Skip
  administrivia, slide numbers, the lecturer's asides and anything that is only
  true of this one document.
- Do not pad. ${target ? `Aim for about ${target} cards.` : 'Make as many as the material supports and no more — fifteen good cards beat forty thin ones.'}
- Keep the material's own terminology and notation.
- Never invent content that is not in the source. If something is unclear in
  the source, leave it out.

Return JSON only: {"name": "a short deck name", "cards": [{"front": "...", "back": "..."}]}`;

  const user = `${name ? `The reader called this "${name}".\n\n` : ''}--- source ---
${body}
--- end ---

Build the deck.`;

  const result = await complete({
    capability: 'deep',
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    schema: DECK_SCHEMA,
    temperature: 0.3,
    maxTokens: 6000,
  });

  const parsed = parseObject(result.text);

  const seen = new Set();
  const cards = (Array.isArray(parsed.cards) ? parsed.cards : [])
    .map((c) => ({
      front: typeof c?.front === 'string' ? c.front.trim().slice(0, 600) : '',
      back: typeof c?.back === 'string' ? c.back.trim().slice(0, 1200) : '',
    }))
    .filter((c) => {
      if (!c.front || !c.back) return false;
      /* A deck with the same question twice schedules the same fact twice and
         teaches you it is two facts. */
      const key = c.front.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 120);

  if (!cards.length) throw new AiError('nothing in that text turned into a card.');

  return {
    name: (typeof parsed.name === 'string' && parsed.name.trim()) || name || 'Untitled deck',
    cards,
    model: result.model,
    provider: result.providerLabel,
  };
}
