import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import './styles.css';
import './motion.css';
import { listProjects } from './lib/api';
import Dashboard from './views/Dashboard';
import CaseFiles from './views/CaseFiles';
import Reporting from './views/Reporting';
import Calendar from './views/Calendar';
import Settings from './views/Settings';

const CLOCK_MS = 30000;         // drives overdue arithmetic only; nothing renders seconds
const NAV_REVEAL_Y = 96;        // how near the top edge the pointer must come to summon the nav
const NAV_IDLE_MS = 1800;       // how long it waits before hiding itself again unattended

const NAV = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'cases', label: 'Case files' },
  { id: 'reporting', label: 'Reporting' },
  { id: 'calendar', label: 'Class calendar' },
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

  /* The nav is summoned by moving the pointer near the top edge.
   *
   * The class is toggled straight on the node and only when the threshold is
   * actually crossed — never through React state. A pointermove that set state
   * would re-render the entire app on every mouse move, which would make the
   * whole dashboard feel broken to save one line of code.
   *
   * It starts hidden on EVERY device — no media query force-shows it — and a
   * press in the same band summons it where there is no mouse to hover with. */
  const barRef = useRef(null);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return undefined;

    let open = false;
    let idle = 0;
    let px = -1;
    let py = -1;

    const set = next => {
      if (next === open) return;
      open = next;
      el.classList.toggle('is-open', open);
    };

    /* Keep it up while it is genuinely being used, so a motionless pointer
     * resting on it — about to click — is never yanked out from under the user.
     *
     * This tests the last reported pointer position against the bar's box
     * rather than asking CSS `:hover`. While hidden the bar is
     * pointer-events:none, so when it fades in beneath a stationary cursor
     * there is no pointer movement left to make :hover true, and a hover-based
     * guard would let the idle timer hide it while the user is aiming at it. */
    const inUse = () => {
      if (el.querySelector(':focus-visible')) return true;
      const nav = el.querySelector('.topbar__nav');
      if (!nav) return false;
      const r = nav.getBoundingClientRect();
      return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
    };

    const close = () => { clearTimeout(idle); set(false); };

    /* The safety net. Leaving through the TOP edge into the browser's own
     * chrome is the common case and the worst one: the final pointermove
     * reports y ~ 0, which latches the bar open, and no leave event is
     * guaranteed to follow. So an armed timer closes it once the pointer has
     * stopped reporting from the top band — unless it is being used, in which
     * case it re-arms and keeps watching. */
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => { if (inUse()) arm(); else close(); }, NAV_IDLE_MS);
    };

    const onMove = e => {
      px = e.clientX;
      py = e.clientY;
      if (py <= NAV_REVEAL_Y) { set(true); arm(); }
      else close();
    };

    /* The shell has to start below this band, or reaching for the first row of
       controls summons a bar nobody asked for. Publishing the constant is what
       keeps the padding honest if this number ever changes. */
    document.documentElement.style.setProperty('--nav-reveal', `${NAV_REVEAL_Y}px`);

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onMove, { passive: true });
    // Pointer left the page entirely, or the window lost focus (alt-tab, a
    // second monitor) — either way the mouse is not "there" any more.
    document.addEventListener('mouseleave', close);
    document.addEventListener('pointerleave', close);
    window.addEventListener('blur', close);
    return () => {
      clearTimeout(idle);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onMove);
      document.removeEventListener('mouseleave', close);
      document.removeEventListener('pointerleave', close);
      window.removeEventListener('blur', close);
    };
  }, []);

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
    // Reads a bundled .ics and nothing else — no projects, no server.
    body = <Calendar now={now} />;
  } else if (view === 'reporting') {
    // onRefresh lets Reporting refetch after it reorders a case.
    body = <Reporting projects={projects} now={now} onSelectCase={openCase} onRefresh={refresh} />;
  } else {
    body = <Settings projects={projects} now={now} />;
  }

  return (
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
      </header>

      <main className="shell" id="main">
        {/* The key is the whole trick: navigating remounts this subtree, which
            restarts every CSS animation inside it, so each screen assembles
            itself on arrival instead of cutting in. */}
        <BuildStage key={view} stamp={view}>
          {body}
        </BuildStage>
      </main>
    </div>
  );
}
