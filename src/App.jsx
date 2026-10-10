import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import './styles.css';
import './motion.css';
import { listProjects } from './lib/api';
import Dashboard from './views/Dashboard';
import CaseFiles from './views/CaseFiles';
import Reporting from './views/Reporting';
import Calendar from './views/Calendar';
import Flashcards from './views/Flashcards';
import Settings from './views/Settings';
import NotesDrawer from './ui/NotesDrawer.jsx';
import Streak from './ui/Streak.jsx';
import Standby from './ui/Standby.jsx';

const CLOCK_MS = 30000;         // drives overdue arithmetic only; nothing renders seconds

const DAY_MS = 86400000;

const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * The one line in the top bar: what, if anything, is on fire.
 *
 * Reads what the app has already loaded — no request of its own — and reports
 * the worst thing it finds, because a summary that says both "2 overdue" and
 * "3 due today" is not a summary. Subtasks are entries too; a nested one that
 * is late is just as late.
 */
function standingOf(projects, now) {
  let overdue = 0;
  let today = 0;
  const day = startOfDay(now);
  for (const project of projects || []) {
    for (const task of project.tasks || []) {
      for (const entry of [task, ...(task.subtasks || [])]) {
        if (entry.completed || !entry.dueDate) continue;
        const due = startOfDay(new Date(entry.dueDate).getTime());
        if (!Number.isFinite(due)) continue;
        const days = Math.round((due - day) / DAY_MS);
        if (days < 0) overdue += 1;
        else if (days === 0) today += 1;
      }
    }
  }
  if (overdue) return { tone: 'overdue', text: `${overdue} overdue` };
  if (today) return { tone: 'soon', text: `${today} due today` };
  return { tone: 'ok', text: 'all clear' };
}

const NAV = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'cases', label: 'Case files' },
  { id: 'reporting', label: 'Reporting' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'flashcards', label: 'Flashcards' },
  { id: 'settings', label: 'Settings' },
];

// How long the longest card in a screen takes to finish assembling. The tail is
// the case render's pin sequence, which finishes at ~1920ms; this keeps headroom
// so the last pin is never cut off mid-pop.
const BUILD_MS = 2300;

/**
 * Wraps a screen and drives its assembly sequence.
 *
 * `is-building` is what gates every hidden-start animation in motion.css. It is
 * added on mount and removed once the sequence is over, which matters for more
 * than tidiness: those animations use `fill-mode: both`, so if they were left
 * permanently armed and anything prevented them from running — an unsupported
 * engine, a suppressed animation timeline — the content would be stranded at
 * opacity 0 forever. Gating on a class that gets removed means the failure mode
 * is a screen that appears instantly, never a blank one.
 */
function BuildStage({ stamp, children }) {
  const [building, setBuilding] = useState(true);

  useEffect(() => {
    setBuilding(true);
    const id = setTimeout(() => setBuilding(false), BUILD_MS);
    return () => clearTimeout(id);
  }, [stamp]);

  return <div className={`view${building ? ' is-building' : ''}`}>{children}</div>;
}

function readHash() {
  const raw = (typeof window === 'undefined' ? '' : window.location.hash || '').replace(/^#\/?/, '');
  return NAV.some(n => n.id === raw) ? raw : 'dashboard';
}

export default function App() {
  const [projects, setProjects] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  // The view lives in the hash so sections are linkable and the browser's back
  // button works. Anything unrecognised falls back to the dashboard.
  const [view, setView] = useState(() => readHash());
  const [activeCaseId, setActiveCaseId] = useState(null);

  useEffect(() => {
    const onHash = () => setView(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback(next => {
    setView(next);
    if (readHash() !== next) window.location.hash = next;
  }, []);

  // One live clock for the whole app. Never a module-scope Date.now() — every
  // overdue decision on every screen reads this, so a frozen clock would make
  // the entire dashboard quietly wrong after midnight.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(id);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await listProjects();
      setProjects(Array.isArray(data) ? data : []);
      setLoadError(null);
    } catch (err) {
      console.error('Failed to load case files', err);
      setLoadError(err.message || 'could not reach the archive');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Keep a valid selection without fighting the user: only auto-pick when the
  // current one has gone away (deleted) or nothing is chosen yet.
  const roots = useMemo(
    () => projects.filter(p => !p.parentId).sort((a, b) => a.sortOrder - b.sortOrder),
    [projects],
  );
  useEffect(() => {
    if (!roots.length) { if (activeCaseId !== null) setActiveCaseId(null); return; }
    if (!roots.some(p => p.id === activeCaseId)) setActiveCaseId(roots[0].id);
  }, [roots, activeCaseId]);

  const openCase = useCallback(id => { setActiveCaseId(id); go('cases'); }, [go]);

  /* The nav is always on screen.

     It used to be summoned by putting the pointer near the top edge, which
     meant a whole apparatus: a threshold test on every pointermove, an idle
     timer to close it again, a guard so a stationary cursor aiming at it was
     never yanked away, and a safety net for the case where the pointer leaves
     through the top of the window into the browser's own chrome and the last
     reported y latches it open forever. All of it is gone.

     What is left is the one thing the layout still needs: the shell has to
     start below the bar, and the bar is `position: fixed` so it contributes no
     height of its own. Its measured height is published as --nav-h rather than
     hard-coded, because the pill wraps to a second line on a narrow window and
     a constant would be wrong exactly when it mattered. */
  const barRef = useRef(null);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return undefined;

    const publish = () => {
      document.documentElement.style.setProperty('--nav-h', `${Math.round(el.offsetHeight)}px`);
    };
    publish();

    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* There used to be a pointer field here: --px and --py written onto the root
     element on every pointer frame. Nothing read them any more, and a custom
     property changed on the root restyles every element in the document, so
     each mouse move cost a full-page style recalc (20-30ms a frame, measured).
     The streak behind the app and the case flow both track the pointer
     themselves, scoped to what they move. */

  const standing = useMemo(() => standingOf(projects, now), [projects, now]);

  let body = null;
  if (!loaded) {
    body = <div className="empty empty--center"><div className="empty__lead">reading the archive…</div></div>;
  } else if (loadError && projects.length === 0) {
    body = (
      <div className="empty empty--center">
        <div className="empty__lead">the archive is unreachable.</div>
        <div className="empty__hint">{loadError}</div>
      </div>
    );
  } else if (view === 'dashboard') {
    body = (
      <Dashboard
        projects={projects}
        now={now}
        activeCaseId={activeCaseId}
        onSelectCase={openCase}
        onPickCase={setActiveCaseId}
        onMutate={refresh}
      />
    );
  } else if (view === 'cases') {
    body = (
      <CaseFiles
        projects={projects}
        now={now}
        activeCaseId={activeCaseId}
        onSelectCase={setActiveCaseId}
        onMutate={refresh}
      />
    );
  } else if (view === 'flashcards') {
    // Its own store (decks/cards); nothing to do with projects.
    body = <Flashcards />;
  } else if (view === 'calendar') {
    // Two calendars: the entry month, which is every dated entry in the
    // archive, and the class timetable, which is the bundled .ics with those
    // same projects hung on it — a case named after a course puts that
    // course's quizzes, exams, readings and deadlines onto its classes.
    // onSelectCase is what lets an entry on the month open its case file.
    body = <Calendar now={now} projects={projects} onSelectCase={openCase} />;
  } else if (view === 'reporting') {
    // onRefresh lets Reporting refetch after it reorders a case.
    body = <Reporting projects={projects} now={now} onSelectCase={openCase} onRefresh={refresh} />;
  } else {
    body = <Settings projects={projects} now={now} />;
  }

  return (
    <>
      {/* Outside .app on purpose. The background layers stack by z-index in
          one context — grid 0, streak 1, vignette 2, app 3 — and nesting the
          canvas inside the app would put it above the vignette that is there
          to keep text legible over it. */}
      <Streak view={view} />

      <div className="app">
      <header className="topbar" ref={barRef}>
        <nav className="topbar__nav" aria-label="Sections">
          {NAV.map(item => (
            <button
              key={item.id}
              type="button"
              className={`navlink${view === item.id ? ' is-active' : ''}`}
              aria-current={view === item.id ? 'page' : undefined}
              onClick={() => go(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {/* The readout, not a control: it says how the archive is standing and
            there is nothing to click. Loaded means loaded — before that it
            would be reporting "all clear" about an empty list. */}
        {loaded ? (
          <span className={`statpill statpill--${standing.tone} topbar__standing`}>
            {standing.text}
          </span>
        ) : null}
      </header>

      <main className="shell" id="main">
        {/* The key is the whole trick: navigating remounts this subtree, which
            restarts every CSS animation inside it, so each screen assembles
            itself on arrival instead of cutting in. */}
        <BuildStage key={view} stamp={view}>
          {body}
        </BuildStage>
      </main>

      {/* Outside <main> and outside the keyed BuildStage: the pad belongs to the
          app rather than to whichever screen is showing, so navigating must not
          remount it and throw away what is being typed.

          It takes the cases so filing can offer them by name, and `refresh` so
          that what the clerk writes is on screen before the drawer has closed. */}
      <NotesDrawer projects={projects} now={now} onFiled={refresh} />

      {/* Last, and above everything: left alone for a minute the app goes soft
          behind a clock. It covers the pad and its tab as well, which is the
          point — standby is about the window, not about a screen. */}
      <Standby />
      </div>
    </>
  );
}
