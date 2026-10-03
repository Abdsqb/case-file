/**
 * NotesDrawer.jsx — a scratchpad that lives everywhere.
 *
 * A tab on the left edge of every screen; clicking it slides a page in from
 * that edge with nothing on it but somewhere to type. No title, no toolbar, no
 * save button — the pad is the whole interface.
 *
 * Saving is on a debounce rather than a button, and on close, and on the page
 * being hidden. A pad you have to remember to save is a pad that loses things.
 *
 * It is also where FILING happens. The pad was already the place unstructured
 * text lands in this app — a syllabus week, an email, what someone said in a
 * lecture — and filing is the step that was missing from the other end of it.
 * `File it` hands the pad to the clerk, which proposes entries; the proposals
 * replace the pad on screen until you accept or discard them, and the text
 * itself is never touched either way.
 */

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';

import api from '../lib/api.js';
import * as clerk from '../lib/clerk.js';
import Filing from './Filing.jsx';
/* The editor is CodeMirror, which is most of 300KB — every screen should not
   pay for something that lives behind a tab. It is split into its own chunk and
   fetched once the app goes idle, so by the time the pad is opened it is almost
   always already there. */
const loadEditor = () => import('./LiveMarkdown.jsx');
const LiveMarkdown = lazy(loadEditor);

/* Long enough that ordinary typing does not put a request on every keystroke,
   short enough that a stray tab-close rarely beats it. Closing and hiding both
   flush immediately, so this only governs the idle case. */
const SAVE_AFTER = 700;

export default function NotesDrawer({ projects = [], now = Date.now(), onFiled }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [loaded, setLoaded] = useState(false);

  /* ---- filing ------------------------------------------------------------
     Four states and no more: nothing, waiting on the clerk, reviewing what it
     proposed, and the one line that says what was written. `onDuty` is
     undefined until the server has answered, which is what keeps the button
     from flickering into view on a server with no key. */
  const [onDuty, setOnDuty] = useState(null);
  const [filing, setFiling] = useState(false);
  const [proposal, setProposal] = useState(null);
  const [filed, setFiled] = useState(null);
  const [fileError, setFileError] = useState('');

  useEffect(() => {
    let alive = true;
    clerk.status().then((s) => { if (alive) setOnDuty(!!s.ready); });
    return () => { alive = false; };
  }, []);

  const areaRef = useRef(null);
  /* Only mounted from the first open onwards, so the chunk is not demanded the
     moment the app starts. */
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => { if (open) setEverOpened(true); }, [open]);
  useEffect(() => {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
    const id = idle(() => { loadEditor().catch(() => {}); });
    return () => (window.cancelIdleCallback || clearTimeout)(id);
  }, []);
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

  /* ---- handing the pad to the clerk --------------------------------------
     The pad is saved first. What the clerk reads and what is on disk should be
     the same text, so that if anything goes wrong the pad is still the record
     of what you wrote. */
  const askClerk = useCallback(async () => {
    const text = bodyRef.current.trim();
    if (!text || filing) return;
    setFiling(true);
    setFileError('');
    setFiled(null);
    try {
      await flush();
      setProposal(await clerk.file(text));
    } catch (err) {
      setFileError(err.message || 'the clerk could not read the pad.');
    } finally {
      setFiling(false);
    }
  }, [filing, flush]);

  /* What the reader approved, written.

     The pad is deliberately NOT cleared afterwards. Filing is not a transfer —
     the same notes are often filed twice as a week goes on, and silently
     emptying a page someone wrote by hand to confirm a button worked is the
     kind of helpfulness that loses work. The line that appears says what was
     written; clearing the pad stays the reader's decision. */
  const applyProposal = useCallback(async (rows) => {
    setFiling(true);
    setFileError('');
    try {
      const made = await clerk.apply(rows);
      setProposal(null);
      setFiled(made);
      if (onFiled) onFiled();
    } catch (err) {
      setFileError(err.message || 'that could not be filed.');
    } finally {
      setFiling(false);
    }
  }, [onFiled]);

  const discard = useCallback(() => { setProposal(null); setFileError(''); }, []);

  /* ---- open and close ---------------------------------------------------- */

  /* Shift+N toggles the pad from anywhere — except while typing. There, it is
     just a capital N: an entry title, the log box and the pad itself all need
     to be able to take one. That includes the pad, which takes focus when it
     opens, so from inside it Escape (or clicking away) is what closes it. */
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'N' && e.key !== 'n') return;
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
      if (openRef.current) close();
      else setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      /* The review sheet is a layer over the pad, so Escape dismisses that
         first. Closing the whole drawer on a keypress meant for the sheet
         would throw away a set of proposals that took a model call to get. */
      if (proposal) discard();
      else close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close, proposal, discard]);

  useEffect(() => {
    if (!open) return;
    /* Focus the pad, not the tab that opened it — the point of opening it is to
       type. After the frame, or the transform is still running and Safari
       scrolls the panel into view from off screen. */
    const id = requestAnimationFrame(() => {
      const view = areaRef.current;
      if (view) {
        view.focus();
        view.dispatch({ selection: { anchor: view.state.doc.length } });
      }
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
        title="Notes (Shift+N)"
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
        {/* Markdown, rendered live: every line but the one being edited shows
            its finished form. What is saved is still the plain markdown.

            Kept mounted under the review sheet rather than swapped out, because
            unmounting CodeMirror loses the cursor, the scroll position and the
            undo history — and going back to the pad after discarding should
            land you exactly where you left it. */}
        {everOpened ? (
          <Suspense fallback={null}>
            <LiveMarkdown
              editorRef={areaRef}
              className="notes__pad"
              value={body}
              onChange={onType}
              onBlur={flush}
              autoFocus={open}
            />
          </Suspense>
        ) : null}

        {/* The one line of result, and the one button that starts it. Absent
            entirely when no key is configured: an app that cannot do a thing
            should not have a button for it. */}
        {onDuty ? (
          <div className="notes__foot">
            {filed ? (
              <span className="notes__filed">
                {[
                  filed.cases ? `${filed.cases} ${filed.cases === 1 ? 'case' : 'cases'}` : '',
                  filed.entries ? `${filed.entries} ${filed.entries === 1 ? 'entry' : 'entries'}` : '',
                  filed.subtasks ? `${filed.subtasks} ${filed.subtasks === 1 ? 'subtask' : 'subtasks'}` : '',
                ].filter(Boolean).join(', ') || 'nothing'} filed.
              </span>
            ) : fileError && !proposal ? (
              <span className="notes__filed notes__filed--bad">{fileError}</span>
            ) : (
              <span className="notes__hint">the clerk reads this and proposes entries. nothing is written without you.</span>
            )}

            <button
              type="button"
              className="pill pill--micro notes__file"
              onClick={askClerk}
              disabled={filing || !body.trim()}
            >
              {filing && !proposal ? 'reading…' : 'File it'}
            </button>
          </div>
        ) : null}

        {proposal ? (
          <div className="notes__review">
            <Filing
              result={proposal}
              cases={projects}
              now={now}
              busy={filing}
              error={fileError}
              onApply={applyProposal}
              onDiscard={discard}
            />
          </div>
        ) : null}
      </aside>
    </>
  );
}
