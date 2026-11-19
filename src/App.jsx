import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';

import './styles.css';
import './motion.css';
import './mobile.css';
/* The Linear design, last so it wins: tokens, the sidebar shell, and every
   component in Linear's language. Take this one line out and the app is in
   its earlier design again (git tag pre-linear-redesign has all of it). */
import './linear.css';
import { Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { KEY_RAIL, useSetting, writeSetting } from './lib/settings.js';
import { listProjects } from './lib/api';
import Dashboard from './views/Dashboard';
import NotesDrawer, { OPEN_NOTES } from './ui/NotesDrawer.jsx';
import Streak from './ui/Streak.jsx';
import Standby from './ui/Standby.jsx';
import TodayWindow from './ui/TodayWindow.jsx';
import CornerWheel from './ui/CornerWheel.jsx';
import Sidebar from './ui/Sidebar.jsx';
import PhoneBar from './ui/PhoneBar.jsx';
import { ICONS, NAV } from './ui/nav.js';

/* The dashboard is in the first bundle; the other five screens are chunks of
   their own, fetched in the background as soon as the first screen is up (see
   the preload in App), so the first paint parses one screen rather than six
   and a later visit still finds its code already here. */
const loadCaseFiles = () => import('./views/CaseFiles');
const loadReporting = () => import('./views/Reporting');
const loadCalendar = () => import('./views/Calendar');
const loadSettings = () => import('./views/Settings');
const loadPlan = () => import('./views/Plan');
const CaseFiles = lazy(loadCaseFiles);
const Reporting = lazy(loadReporting);
const Calendar = lazy(loadCalendar);
const Settings = lazy(loadSettings);
const Plan = lazy(loadPlan);
const PRELOAD = [loadCaseFiles, loadReporting, loadCalendar, loadPlan, loadSettings];

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

/* The phone's corner wheel, out of the held to-do button: every screen, and
   the notes pad (the to-do is the button itself). Reversed: Notes out to the
   left, Dashboard at the top. */
const OPEN_NOTES_ITEM = { id: 'notes', label: 'Notes', run: () => window.dispatchEvent(new Event(OPEN_NOTES)) };
const CORNER = [...NAV, OPEN_NOTES_ITEM].reverse();

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
/* The screens with a details rail down their left side (ui/Rail.jsx). */
const RAIL_VIEWS = new Set(['dashboard', 'cases']);

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
  /* The sidebar as a drawer, on a phone. */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  /* The details rail, on the screens that have one. */
  const railOn = useSetting(KEY_RAIL, true);
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

  /* Every screen opens at its top. The window is the page's scroller and
     nothing reset it, so coming to the dashboard from a long screen kept the
     old offset, and the shorter page opened at its bottom; the browser's own
     restoring of a position on reload did the same to the first screen. */
  useLayoutEffect(() => {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
  }, []);
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

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

  // Once the browser is idle after the first screen, fetch the rest.
  useEffect(() => {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
    idle(() => { for (const load of PRELOAD) load().catch(() => {}); });
  }, []);

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

  /* There used to be a pointer field here: --px and --py written onto the root
     element on every pointer frame. Nothing read them any more, and a custom
     property changed on the root restyles every element in the document, so
     each mouse move cost a full-page style recalc (20-30ms a frame, measured).
     The streak behind the app and the case flow both track the pointer
     themselves, scoped to what they move. */

  const standing = useMemo(() => standingOf(projects, now), [projects, now]);
  const CurrentIcon = ICONS[view];
  const currentLabel = NAV.find((n) => n.id === view)?.label || '';

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
  } else if (view === 'calendar') {
    // Two calendars: the entry month, which is every dated entry in the
    // archive, and the class timetable, which is the bundled .ics with those
    // same projects hung on it — a case named after a course puts that
    // course's quizzes, exams, readings and deadlines onto its classes.
    // onSelectCase is what lets an entry on the month open its case file.
    body = <Calendar now={now} projects={projects} onSelectCase={openCase} />;
  } else if (view === 'plan') {
    // Boards of steps, left to right on a canvas (views/Plan.jsx).
    body = <Plan />;
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
      {/* Linear's shell: the sidebar down the left, and the page beside it on
          a panel of its own. On a phone the sidebar is a drawer instead, and
          the tab bar along the bottom (with the to-do button seated in it)
          takes its place. Loaded means loaded — before that the standing
          would report "all clear" about an empty list. */}
      <Sidebar
        current={view}
        onGo={go}
        onOpenCase={openCase}
        activeCaseId={activeCaseId}
        projects={projects}
        standing={loaded ? standing : null}
        open={drawerOpen}
        onClose={closeDrawer}
      />

      <div className="page">
        <header className="pagebar">
          <button type="button" className="pagebar__menu" onClick={() => setDrawerOpen(true)} aria-label="Open menu">
            <Menu size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {CurrentIcon ? <CurrentIcon className="pagebar__icon" aria-hidden="true" /> : null}
          <h1 className="pagebar__title">{currentLabel}</h1>
          {loaded ? (
            <span className={`pagebar__standing is-${standing.tone}`} role="status">
              <span className="pagebar__dot" aria-hidden="true" />
              {standing.text}
            </span>
          ) : null}
          {RAIL_VIEWS.has(view) ? (
            <button
              type="button"
              className="pagebar__rail"
              aria-pressed={railOn}
              onClick={() => writeSetting(KEY_RAIL, railOn ? false : null)}
              title={railOn ? 'Hide details' : 'Show details'}
              aria-label={railOn ? 'Hide details' : 'Show details'}
            >
              {railOn ? <PanelLeftClose aria-hidden="true" /> : <PanelLeftOpen aria-hidden="true" />}
            </button>
          ) : null}
        </header>

        <main className="shell" id="main">
          {/* The key is the whole trick: navigating remounts this subtree, which
              restarts every CSS animation inside it, so each screen assembles
              itself on arrival instead of cutting in. */}
          <BuildStage key={view} stamp={view}>
            <Suspense fallback={null}>{body}</Suspense>
          </BuildStage>
        </main>
      </div>

      <PhoneBar current={view} onGo={go} />

      {/* Outside <main> and outside the keyed BuildStage: the pad belongs to the
          app rather than to whichever screen is showing, so navigating must not
          remount it and throw away what is being typed.

          It takes the cases so filing can offer them by name, and `refresh` so
          that what the clerk writes is on screen before the drawer has closed. */}
      <NotesDrawer projects={projects} now={now} onFiled={refresh} />

      {/* Today's to-do, on Shift+T. It takes the cases to show each row's
          entry, and `refresh` so ticking one off shows in its case too. */}
      <TodayWindow projects={projects} now={now} onChanged={refresh} />

      {/* Last, and above everything: left alone for a minute the app goes soft
          behind a clock. It covers the pad and its tab as well, which is the
          point — standby is about the window, not about a screen. */}
      {/* A phone: the screens and the notes pad, fanned out of the held to-do button. */}
      <CornerWheel items={CORNER} current={view} onPick={(item) => (item.run ? item.run() : go(item.id))} />

      <Standby />
      </div>

    </>
  );
}
