/**
 * Sidebar.jsx — the app's navigation, down the left edge, as Linear has it.
 *
 *   the app's name
 *   Today's to-do and Notes, the two things that open over the page
 *   the screens
 *   Cases: every top-level case, each a click from its file
 *   Settings, and how the archive is standing
 *
 * On a desktop it is always there. On a phone it is a drawer: the header's
 * menu button slides it in over the page, and picking anything, tapping the
 * dimmed page or Escape slides it away again.
 */

import { useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { caseColor, ICONS, NAV } from './nav.js';
import { OPEN_TODAY } from './TodayWindow.jsx';
import { OPEN_NOTES } from './NotesDrawer.jsx';

const cx = (...c) => c.filter(Boolean).join(' ');

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
      .map((p) => ({ id: p.id, name: p.name, open: openCount(p, byParent) }));
  }, [projects]);

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
          <span className="sb__mark" aria-hidden="true">C</span>
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
              {cases.map((c) => (
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
              ))}
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
