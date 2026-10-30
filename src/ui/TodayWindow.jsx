/**
 * TodayWindow.jsx — today's to-do, a window in the middle of the screen.
 *
 * Shift+T opens and closes it from anywhere except while typing, the same
 * rule as Shift+N and the notes pad. It is laid out like the case structure
 * card: a title bar with the measurements beside the name, the body, and the
 * completion bar along the bottom. The body is the entries you put on today's
 * list from their cases, in the order you put them.
 *
 * Nothing here is a copy. A row is a pointer to a real entry (or subtask), so
 * ticking it off closes the entry in its case and reopening it here reopens it
 * there. Dragging a row, or Alt+Up/Down on it, changes only today's order.
 *
 * A new day starts with an empty list. The first time the window opens on a
 * day after one that had a list, it offers what was left unfinished: bring it
 * over, or start fresh. Either answer is remembered for the day.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, GripVertical, ListTodo, X } from 'lucide-react';

import api from '../lib/api.js';
import { dayDiff } from '../lib/metrics.js';
import { answerOffer, removeFromToday, reorderToday, useToday } from '../lib/today.js';
import { Meter } from './primitives.jsx';
import { useSheetDrag } from './sheet.js';

/* Raised by the top island's "Today's to-do" row: the way in on a phone,
   which has no Shift+T. */
export const OPEN_TODAY = 'casefile:open-today';

const cx = (...parts) => parts.filter(Boolean).join(' ');

/* Every entry and subtask by id, with the case it is in and, for a subtask,
   the entry it hangs off — so a row can say where it came from. */
function indexEntries(projects) {
  const map = new Map();
  for (const p of projects || []) {
    if (!p) continue;
    for (const t of p.tasks || []) {
      map.set(t.id, { task: t, caseName: p.name, parent: null });
      for (const s of t.subtasks || []) map.set(s.id, { task: s, caseName: p.name, parent: t.title });
    }
  }
  return map;
}

function dueLine(due, now, completed) {
  if (completed) return 'closed';
  if (due === null || due === undefined) return 'no due date';
  const diff = dayDiff(Number(due), now);
  if (!Number.isFinite(diff)) return 'no due date';
  if (diff < 0) return `${-diff}d late`;
  if (diff === 0) return 'due today';
  if (diff === 1) return 'due tomorrow';
  return `due in ${diff}d`;
}

const move = (ids, id, to) => {
  const next = ids.filter((x) => x !== id);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, id);
  return next;
};

export default function TodayWindow({ projects = [], now = Date.now(), onChanged }) {
  const [open, setOpen] = useState(false);
  const today = useToday();
  const index = useMemo(() => indexEntries(projects), [projects]);

  /* Ticks land on screen at once and stay until the refetch shows the same
     thing; a failed write drops them, so the row goes back to what is true. */
  const [pending, setPending] = useState({});
  const isDone = (item) => (item.task.id in pending ? pending[item.task.id] : !!item.task.completed);

  /* While a row is being dragged the list shows the order it would land in;
     the store is written once, on drop. */
  const [drag, setDrag] = useState(null);
  const order = drag ? drag.ids : today.taskIds;
  const items = order.map((id) => index.get(id)).filter(Boolean);
  const doneCount = items.filter(isDone).length;
  const completion = items.length ? doneCount / items.length : 0;

  const offered = today.offer ? today.offer.taskIds.filter((id) => index.has(id)) : [];

  const panelRef = useRef(null);
  const returnTo = useRef(null);

  const close = useCallback(() => setOpen(false), []);

  /* Shift+T, the same guard as the notes pad: inside a field it is just a
     capital T. */
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'T' && e.key !== 't') return;
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const t = e.target;
      const typing = t && (
        t.isContentEditable ||
        t.tagName === 'TEXTAREA' ||
        t.tagName === 'SELECT' ||
        (t.tagName === 'INPUT' && !/^(button|checkbox|radio|range|submit|reset|file|color)$/i.test(t.type || ''))
      );
      if (typing) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_TODAY, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_TODAY, onOpen);
    };
  }, []);

  const sheetDrag = useSheetDrag(panelRef, close, open);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  /* Focus comes into the window when it opens and goes back where it was
     when it closes, so the keyboard is never left on something hidden. */
  useEffect(() => {
    if (open) {
      returnTo.current = document.activeElement;
      const id = requestAnimationFrame(() => panelRef.current && panelRef.current.focus());
      return () => cancelAnimationFrame(id);
    }
    const back = returnTo.current;
    returnTo.current = null;
    if (back && back.isConnected && typeof back.focus === 'function') back.focus();
    return undefined;
  }, [open]);

  const toggleDone = async (item) => {
    const id = item.task.id;
    const next = !isDone(item);
    setPending((p) => ({ ...p, [id]: next }));
    try {
      await api.updateTask(id, { completed: next });
      if (onChanged) await onChanged();
    } catch (err) {
      console.error('today: could not update the entry', err);
    } finally {
      setPending((p) => { const { [id]: _, ...rest } = p; return rest; });
    }
  };

  /* Reordering by touch. The browser's drag and drop is mouse-only, so on a
     touch screen each row has a grip (mobile.css shows it there only): held
     and dragged, the row moves through the list as the finger passes the
     middle of its neighbours, and the order is written once, on release. The
     grip takes the gesture itself (touch-action: none), so dragging anywhere
     else on a row still scrolls the sheet. */
  /* The finger is followed on the window, not by capturing it on the grip:
     moving a row through the list moves its element in the page, and a moved
     element loses its pointer capture, so the release never arrived. */
  const listRef = useRef(null);
  const dragRef = useRef(null);
  dragRef.current = drag;
  const gripDown = (e, id) => {
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    const pointer = e.pointerId;
    setDrag({ id, ids: today.taskIds, from: today.taskIds, touch: true });
    const onMove = (ev) => {
      if (ev.pointerId !== pointer || !listRef.current) return;
      const rows = [...listRef.current.children];
      let to = rows.length - 1;
      for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { to = i; break; }
      }
      setDrag((d) => (d && d.ids.indexOf(d.id) !== to ? { ...d, ids: move(d.ids, d.id, to) } : d));
    };
    const onUp = (ev) => {
      if (ev.pointerId !== pointer) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const d = dragRef.current;
      setDrag(null);
      if (d && d.touch && d.ids.join() !== d.from.join()) reorderToday(d.ids);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const step = (id, by) => {
    const at = today.taskIds.indexOf(id);
    if (at < 0) return;
    const to = at + by;
    if (to < 0 || to >= today.taskIds.length) return;
    reorderToday(move(today.taskIds, id, to));
  };

  const dayLabel = useMemo(
    () => new Date(now).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
    // the label only changes with the day
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [today.day]
  );
  const openCount = items.length - doneCount;
  const standing = !items.length
    ? { tone: 'idle', text: 'Nothing set' }
    : openCount === 0
      ? { tone: 'ok', text: 'All done' }
      : { tone: 'ok', text: `${openCount} open` };

  return (
    <>
      <div className={cx('todoscrim', open && 'is-open')} onClick={close} aria-hidden="true" />

      <section
        ref={panelRef}
        className={cx('card todo', open && 'is-open')}
        role="dialog"
        aria-modal="false"
        aria-label="Today's to-do"
        aria-hidden={!open}
        inert={!open || undefined}
        tabIndex={-1}
      >
        {/* Phone only (mobile.css): the handle to pull the sheet down by. */}
        <div className="sheet__grab" aria-hidden="true" {...sheetDrag}><span /></div>

        <header className="flow__bar todo__bar">
          <span className="flow__name">Today</span>
          <span className="flow__count">
            {dayLabel}
            <span className="flow__sep">/</span>
            {items.length} {items.length === 1 ? 'entry' : 'entries'}
            <span className="flow__sep">/</span>
            {doneCount} done
          </span>
          <span className={cx('statpill', `statpill--${standing.tone}`, 'flow__state')}>{standing.text}</span>
          <button type="button" className="sheet__close" aria-label="Close today's to-do" onClick={close}>
            <X strokeWidth={1.8} aria-hidden="true" />
          </button>
        </header>

        <div className="todo__body">
          {offered.length ? (
            <div className="todo__offer">
              <span className="todo__offer-text">
                {offered.length} {offered.length === 1 ? 'entry' : 'entries'} left unfinished from your last list.
              </span>
              <button type="button" className="entry__action" onClick={() => answerOffer(true)}>
                Bring over
              </button>
              <button type="button" className="entry__action" onClick={() => answerOffer(false)}>
                Start fresh
              </button>
            </div>
          ) : null}

          {items.length ? (
            <div className="todo__list" ref={listRef}>
              {items.map((item, i) => {
                const id = item.task.id;
                const done = isDone(item);
                return (
                  <div
                    key={id}
                    className={cx('entry todo__row', done && 'entry--done', drag && drag.id === id && 'entry--dragging')}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      try { e.dataTransfer.setData('text/plain', String(id)); } catch { /* ignore */ }
                      setDrag({ id, ids: today.taskIds, from: today.taskIds });
                    }}
                    onDragOver={(e) => {
                      if (!drag) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (drag.id === id) return;
                      const to = drag.ids.indexOf(id);
                      setDrag((d) => (d ? { ...d, ids: move(d.ids, d.id, to) } : d));
                    }}
                    onDrop={(e) => e.preventDefault()}
                    onDragEnd={() => {
                      const d = drag;
                      setDrag(null);
                      if (d && d.ids.join() !== d.from.join()) reorderToday(d.ids);
                    }}
                    onKeyDown={(e) => {
                      if (!e.altKey) return;
                      if (e.key === 'ArrowUp') { e.preventDefault(); step(id, -1); }
                      if (e.key === 'ArrowDown') { e.preventDefault(); step(id, 1); }
                    }}
                  >
                    <button
                      type="button"
                      className="entry__check"
                      aria-pressed={done}
                      aria-label={done ? `Reopen ${item.task.title}` : `Complete ${item.task.title}`}
                      onClick={() => toggleDone(item)}
                    >
                      <Check strokeWidth={2.4} aria-hidden="true" />
                    </button>

                    <div className="entry__main">
                      <span className="entry__title todo__title">{item.task.title || 'Untitled entry'}</span>
                      <div className="entry__meta">
                        <span>{dueLine(item.task.dueDate, now, done)}</span>
                        <span className="entry__case">{item.caseName}</span>
                        {item.parent ? <span className="entry__case truncate">in {item.parent}</span> : null}
                      </div>
                    </div>

                    <span
                      className="todo__grip"
                      aria-hidden="true"
                      onPointerDown={(e) => gripDown(e, id)}
                    >
                      <GripVertical strokeWidth={1.6} />
                    </span>

                    <div className="entry__actions">
                      <button
                        type="button"
                        className="entry__action todo__icon"
                        onClick={() => step(id, -1)}
                        disabled={i === 0}
                        aria-label={`Move ${item.task.title} up`}
                        title="Move up (Alt+Up)"
                      >
                        <ArrowUp strokeWidth={1.6} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="entry__action todo__icon"
                        onClick={() => step(id, 1)}
                        disabled={i === items.length - 1}
                        aria-label={`Move ${item.task.title} down`}
                        title="Move down (Alt+Down)"
                      >
                        <ArrowDown strokeWidth={1.6} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="entry__action todo__icon"
                        onClick={() => removeFromToday(id)}
                        aria-label={`Take ${item.task.title} off today`}
                        title="Take off today"
                      >
                        <X strokeWidth={1.6} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="todo__empty">
              Nothing set for today. Press <span className="mono">Today</span> on any entry in a case to put it here.
            </p>
          )}
        </div>

        <div className="card__foot">
          <span className="nowrap">Completion</span>
          <Meter value={completion} label="Today's completion" className="grow" />
        </div>
      </section>

      {/* Phone only (mobile.css): a phone has no Shift+T, so the list has a
          button of its own, resting at the bottom edge where a thumb is. It
          steps aside while the sheet is up. */}
      <button
        type="button"
        className={cx('todofab', open && 'is-hidden')}
        onClick={() => setOpen(true)}
        aria-label={openCount ? `Today's to-do, ${openCount} open` : "Today's to-do"}
        tabIndex={open ? -1 : undefined}
      >
        <ListTodo strokeWidth={1.7} aria-hidden="true" />
        {openCount ? <span className="todofab__count">{openCount}</span> : null}
      </button>
    </>
  );
}
