/**
 * NotesDrawer.jsx — a scratchpad that lives everywhere.
 *
 * A tab on the left edge of every screen; clicking it slides a page in from
 * that edge with nothing on it but somewhere to type. No title, no toolbar, no
 * save button — the pad is the whole interface.
 *
 * Saving is on a debounce rather than a button, and on close, and on the page
 * being hidden. A pad you have to remember to save is a pad that loses things.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import api from '../lib/api.js';

/* Long enough that ordinary typing does not put a request on every keystroke,
   short enough that a stray tab-close rarely beats it. Closing and hiding both
   flush immediately, so this only governs the idle case. */
const SAVE_AFTER = 700;

export default function NotesDrawer() {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [loaded, setLoaded] = useState(false);

  const areaRef = useRef(null);
  const timer = useRef(0);
  /* What the server is known to hold. Saving compares against this so closing
     an untouched pad does not write, and so a failed write can be retried
     without having to track a separate dirty flag. */
  const saved = useRef('');
  const bodyRef = useRef('');
  bodyRef.current = body;

  /* ---- load once, the first time it is opened ---------------------------- */

  useEffect(() => {
    if (!open || loaded) return;
    let alive = true;
    (async () => {
      try {
        const res = await api.getNotes();
        if (!alive) return;
        const text = res && typeof res.body === 'string' ? res.body : '';
        saved.current = text;
        setBody(text);
      } catch (err) {
        /* An unreachable server must not cost the pad its contents. Leaving it
           empty here would look like the notes were gone; leaving `loaded`
           false means the next open tries again.

           Logged rather than swallowed. A silent catch here hid a plain
           programming error — the client method was missing from the module's
           default export, so this threw on every open and the pad quietly
           refused to save with nothing anywhere saying why. */
        console.error('notes: could not load', err);
        return;
      }
      if (alive) setLoaded(true);
    })();
    return () => { alive = false; };
  }, [open, loaded]);

  /* ---- saving ------------------------------------------------------------ */

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = 0; }
    const text = bodyRef.current;
    if (!loaded || text === saved.current) return;
    try {
      await api.saveNotes(text);
      saved.current = text;
    } catch (err) {
      /* Keep the text on screen and leave `saved` behind it, so the next edit
         or close tries again rather than reporting a loss that has not
         happened — but say so, so a pad that is silently not saving is not
         also invisible. */
      console.error('notes: could not save', err);
    }
  }, [loaded]);

  const onType = (value) => {
    setBody(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_AFTER);
  };

  /* Anything that can take the page away flushes first: switching tabs, closing
     the window, or the drawer sliding shut. */
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
    };
  }, [flush]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const close = useCallback(() => { flush(); setOpen(false); }, [flush]);

  /* ---- open and close ---------------------------------------------------- */

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    /* Focus the pad, not the tab that opened it — the point of opening it is to
       type. After the frame, or the transform is still running and Safari
       scrolls the panel into view from off screen. */
    const id = requestAnimationFrame(() => {
      const el = areaRef.current;
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="notab"
        aria-label="Notes"
        aria-expanded={open}
        title="Notes"
        onClick={() => (open ? close() : setOpen(true))}
      >
        {/* A page with lines on it. Drawn rather than lettered so it carries no
            language and needs no font. */}
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 3.5h9.5L19 7v13.5H6z" />
          <path d="M15 3.5V7h4" />
          <path d="M9 11h7M9 14.5h7M9 18h4.5" />
        </svg>
      </button>

      {/* Sits under the panel and takes the next click, so clicking back onto
          the app closes the pad the way tapping away from it would. */}
      <div
        className={`notescrim${open ? ' is-open' : ''}`}
        onClick={close}
        aria-hidden="true"
      />

      <aside className={`notes${open ? ' is-open' : ''}`} aria-label="Notes">
        <textarea
          ref={areaRef}
          className="notes__pad"
          value={body}
          spellCheck="true"
          aria-label="Notes"
          placeholder=""
          onChange={(e) => onType(e.target.value)}
          onBlur={flush}
        />
      </aside>
    </>
  );
}
