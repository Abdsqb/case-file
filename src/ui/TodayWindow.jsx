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
 * On a phone a row is held a moment to lift it (or taken by its grip at
 * once), and swiped left to show its delete.
 *
 * Or a row is a task of the day's own, typed into the field at the top: it
 * belongs to no case, lives on today's list alone, and taking it off deletes
 * it. Left unticked, it is offered the next morning with the entries.
 *
 * A new day starts with an empty list. The first time the window opens on a
 * day after one that had a list, it offers what was left unfinished: bring it
 * over, or start fresh. Either answer is remembered for the day.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, GripVertical, ListTodo, Plus, X } from 'lucide-react';

import api from '../lib/api.js';
import { dayDiff } from '../lib/metrics.js';
import {
  addOwnTask, answerOffer, removeFromToday, removeOwnTask, reorderToday, setOwnTaskDone, useToday,
} from '../lib/today.js';
import { Meter } from './primitives.jsx';
import { useSheetDrag } from './sheet.js';
import { CORNER_WHEEL } from './CornerWheel.jsx';

const HOLD_MS = 200;   // held this long, the button opens the corner wheel instead
const SLIDE_PX = 10;   // or slid this far off it, at once
const PRESS_MS = 260;  // a row held this long lifts, to be dragged (a phone)
const REVEAL = 76;     // px a row swiped left opens to, showing its delete

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

  /* Ticks on an entry land on screen at once and stay until the refetch
     shows the same thing; a failed write drops them, so the row goes back to
     what is true. A day's own task is ticked in the store itself. */
  const [pending, setPending] = useState({});
  const isDone = (row) => (row.kind === 'own'
    ? !!row.own.completed
    : (row.id in pending ? pending[row.id] : !!row.entry.task.completed));

  /* While a row is being dragged the list shows the order it would land in;
     the store is written once, on drop. The order is keys: e<id> an entry,
     l<id> a day's own task. */
  const [drag, setDrag] = useState(null);
  const order = drag ? drag.ids : today.order;
  const items = order.map((key) => {
    const id = Number(key.slice(1));
    if (key[0] === 'e') {
      const entry = index.get(id);
      return entry ? { key, kind: 'entry', id, title: entry.task.title || 'Untitled entry', entry } : null;
    }
    const own = today.loose[id];
    return own ? { key, kind: 'own', id, title: own.title, own } : null;
  }).filter(Boolean);
  const doneCount = items.filter(isDone).length;
  const completion = items.length ? doneCount / items.length : 0;

  const offeredCount = today.offer
    ? (today.offer.taskIds || []).filter((id) => index.has(id)).length + (today.offer.loose || []).length
    : 0;

  /* The field for a task of the day's own. */
  const [draft, setDraft] = useState('');
  const addOwn = (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    addOwnTask(text);
  };

  const panelRef = useRef(null);
  const hold = useRef(null);
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
    if (item.kind === 'own') { setOwnTaskDone(item.id, !isDone(item)); return; }
    const id = item.id;
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

  /* A finger on a row (a phone; the browser's drag and drop is mouse-only):
       held still a moment, or taken by its grip, the row lifts and follows
         the finger through the list, landing where it is let go;
       slid sideways to the left, it opens to show its delete, and stays open
         if it went more than halfway;
       moved up or down first, it is a scroll, or the sheet being pulled.
     Touch events, not pointer events: once a row has lifted, its moves must
     stop the sheet scrolling, and only a touchmove listener that is not
     passive can. While a row is lifted or sliding the sheet is told to keep
     still (data-busy, ui/sheet.js), or a drag downward would pull it shut. */
  const listRef = useRef(null);
  const dragRef = useRef(null);
  dragRef.current = drag;
  const [swiped, setSwiped] = useState(null);     // the row swiped open, by key
  const swipedRef = useRef(null);
  swipedRef.current = swiped;
  const orderRef = useRef(today.order);
  orderRef.current = today.order;

  useEffect(() => {
    const list = listRef.current;
    const sheet = panelRef.current;
    if (!open || !list || !sheet) return undefined;
    let g = null;
    const slideOf = (item) => item.querySelector('.todo__row');
    const onStart = (e) => {
      g = null;
      if (e.touches.length !== 1) return;
      const item = e.target.closest?.('.todo__item');
      if (!item || e.target.closest('.todo__del')) return;
      const p = e.touches[0];
      g = { key: item.dataset.key, item, x: p.clientX, y: p.clientY, mode: null, dx: 0,
        base: swipedRef.current === item.dataset.key ? -REVEAL : 0, t: 0 };
      const lift = () => {
        if (!g || g.mode) return;
        g.mode = 'drag';
        sheet.dataset.busy = '1';
        navigator.vibrate?.(8);
        setSwiped(null);
        setDrag({ id: g.key, ids: orderRef.current, from: orderRef.current, touch: true });
      };
      if (e.target.closest('.todo__grip')) lift();
      else g.t = setTimeout(lift, PRESS_MS);
    };
    const onMove = (e) => {
      if (!g) return;
      const p = e.touches[0];
      const dx = p.clientX - g.x;
      const dy = p.clientY - g.y;
      if (!g.mode) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        clearTimeout(g.t);
        if (Math.abs(dx) <= Math.abs(dy)) { g = null; return; }   // a scroll, or the sheet's pull
        g.mode = 'swipe';
        sheet.dataset.busy = '1';
        g.item.classList.add('is-sliding');
        slideOf(g.item).style.transition = 'none';
      }
      e.preventDefault();
      if (g.mode === 'drag') {
        const rows = [...list.children];
        let to = rows.length - 1;
        for (let i = 0; i < rows.length; i += 1) {
          const r = rows[i].getBoundingClientRect();
          if (p.clientY < r.top + r.height / 2) { to = i; break; }
        }
        setDrag((d) => (d && d.ids.indexOf(d.id) !== to ? { ...d, ids: move(d.ids, d.id, to) } : d));
      } else {
        g.dx = Math.max(-REVEAL * 1.4, Math.min(0, g.base + dx));
        slideOf(g.item).style.transform = `translateX(${g.dx}px)`;
      }
    };
    const onEnd = () => {
      if (!g) return;
      clearTimeout(g.t);
      delete sheet.dataset.busy;
      if (g.mode === 'drag') {
        const d = dragRef.current;
        setDrag(null);
        if (d && d.ids.join() !== d.from.join()) reorderToday(d.ids);
      } else if (g.mode === 'swipe') {
        const el = slideOf(g.item);
        g.item.classList.remove('is-sliding');
        el.style.transition = '';
        el.style.transform = '';
        setSwiped(g.dx < -REVEAL / 2 ? g.key : null);
      } else if (swipedRef.current && swipedRef.current !== g.key) {
        setSwiped(null);   // a touch on another row closes the open one
      }
      g = null;
    };
    list.addEventListener('touchstart', onStart, { passive: true });
    list.addEventListener('touchmove', onMove, { passive: false });
    list.addEventListener('touchend', onEnd);
    list.addEventListener('touchcancel', onEnd);
    return () => {
      if (g) clearTimeout(g.t);
      delete sheet.dataset.busy;
      list.removeEventListener('touchstart', onStart);
      list.removeEventListener('touchmove', onMove);
      list.removeEventListener('touchend', onEnd);
      list.removeEventListener('touchcancel', onEnd);
    };
  }, [open, items.length > 0]);

  // Closing the window closes any row left swiped open.
  useEffect(() => { if (!open) setSwiped(null); }, [open]);

  const step = (key, by) => {
    const at = today.order.indexOf(key);
    if (at < 0) return;
    const to = at + by;
    if (to < 0 || to >= today.order.length) return;
    reorderToday(move(today.order, key, to));
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
            {items.length} {items.length === 1 ? 'task' : 'tasks'}
            <span className="flow__sep">/</span>
            {doneCount} done
          </span>
          <span className={cx('statpill', `statpill--${standing.tone}`, 'flow__state')}>{standing.text}</span>
          <button type="button" className="sheet__close" aria-label="Close today's to-do" onClick={close}>
            <X strokeWidth={1.8} aria-hidden="true" />
          </button>
        </header>

        <div className="todo__body">
          <form className="todo__add" onSubmit={addOwn}>
            <input
              id="todo-add"
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a task for today"
              aria-label="Add a task for today"
              autoComplete="off"
              maxLength={300}
            />
            <button type="submit" className="entry__action todo__icon" disabled={!draft.trim()} aria-label="Add the task">
              <Plus strokeWidth={1.6} aria-hidden="true" />
            </button>
          </form>

          {offeredCount ? (
            <div className="todo__offer">
              <span className="todo__offer-text">
                {offeredCount} {offeredCount === 1 ? 'task' : 'tasks'} left unfinished from your last list.
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
              {items.map((item) => {
                const id = item.key;
                const done = isDone(item);
                const remove = () => (item.kind === 'own' ? removeOwnTask(item.id) : removeFromToday(item.id));
                const removeLabel = item.kind === 'own' ? `Delete ${item.title}` : `Take ${item.title} off today`;
                return (
                  <div key={id} className={cx('todo__item', swiped === id && 'is-swiped')} data-key={id}>
                  {/* A phone's delete, behind the row: a swipe left shows it. */}
                  <button
                    type="button"
                    className="todo__del"
                    onClick={() => { setSwiped(null); remove(); }}
                    aria-label={removeLabel}
                    tabIndex={swiped === id ? 0 : -1}
                  >
                    <X strokeWidth={1.8} aria-hidden="true" />
                  </button>
                  <div
                    className={cx('entry todo__row', done && 'entry--done', drag && drag.id === id && 'entry--dragging')}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      try { e.dataTransfer.setData('text/plain', String(id)); } catch { /* ignore */ }
                      setDrag({ id, ids: today.order, from: today.order });
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
                      aria-label={done ? `Reopen ${item.title}` : `Complete ${item.title}`}
                      onClick={() => toggleDone(item)}
                    >
                      <Check strokeWidth={2.4} aria-hidden="true" />
                    </button>

                    <div className="entry__main">
                      <span className="entry__title todo__title">{item.title}</span>
                      {item.kind === 'entry' ? (
                        <div className="entry__meta">
                          <span>{dueLine(item.entry.task.dueDate, now, done)}</span>
                          <span className="entry__case">{item.entry.caseName}</span>
                          {item.entry.parent ? <span className="entry__case truncate">in {item.entry.parent}</span> : null}
                        </div>
                      ) : (
                        <div className="entry__meta">
                          <span>{done ? 'done' : 'today only'}</span>
                        </div>
                      )}
                    </div>

                    <span className="todo__grip" aria-hidden="true">
                      <GripVertical strokeWidth={1.6} />
                    </span>

                    {/* A mouse's delete; a phone swipes for it instead (mobile.css). */}
                    <div className="entry__actions">
                      <button
                        type="button"
                        className="entry__action todo__icon"
                        onClick={remove}
                        aria-label={removeLabel}
                        title={item.kind === 'own' ? 'Delete' : 'Take off today'}
                      >
                        <X strokeWidth={1.6} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="todo__empty">
              Nothing set for today. Add a task above, or press <span className="mono">Today</span> on any entry in a case.
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
        /* A tap opens the list. Held, it hands the finger to the corner wheel
           (CornerWheel.jsx): the screens fan out from here, a slide picks one,
           and lifting opens it. Capture keeps the finger's moves coming here
           wherever it slides. */
        onPointerDown={(e) => {
          if (e.button > 0) return;
          const b = e.currentTarget;
          try { b.setPointerCapture(e.pointerId); } catch { /* gone */ }
          const r = b.getBoundingClientRect();
          const id = e.pointerId;
          clearTimeout(hold.current?.t);
          const h = { fired: false, t: 0, x: e.clientX, y: e.clientY, id };
          h.fire = () => {
            if (h.fired) return;
            h.fired = true;
            clearTimeout(h.t);
            navigator.vibrate?.(8);
            window.dispatchEvent(new CustomEvent(CORNER_WHEEL, {
              detail: { x: r.left + r.width / 2, y: r.top + r.height / 2, pointerId: id },
            }));
          };
          h.t = setTimeout(h.fire, HOLD_MS);
          hold.current = h;
        }}
        /* Sliding off the button opens the wheel at once, without the hold. */
        onPointerMove={(e) => {
          const h = hold.current;
          if (!h || h.fired || e.pointerId !== h.id) return;
          if (Math.hypot(e.clientX - h.x, e.clientY - h.y) > SLIDE_PX) h.fire();
        }}
        onPointerUp={() => clearTimeout(hold.current?.t)}
        onPointerCancel={() => clearTimeout(hold.current?.t)}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => {
          if (hold.current?.fired) { hold.current = null; return; }   // that was a hold
          setOpen(true);
        }}
        aria-label={openCount ? `Today's to-do, ${openCount} open` : "Today's to-do"}
        tabIndex={open ? -1 : undefined}
      >
        <ListTodo strokeWidth={1.7} aria-hidden="true" />
        {openCount ? <span className="todofab__count">{openCount}</span> : null}
      </button>
    </>
  );
}
