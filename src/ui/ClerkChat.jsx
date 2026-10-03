/**
 * ClerkChat.jsx — the chat card, second in the dashboard deck.
 *
 * A question box over the archive. It reads: it can open a case, search the
 * entries and look at the timetable before answering, which is the difference
 * between "what have I got for the databases course" being answered and being
 * guessed at. It cannot write — filing lives on the scratchpad, and the clerk
 * says so when asked to change something.
 *
 * The transcript is deliberately not persisted. A study session is not resumed
 * in this app and neither is a conversation: coming back to the dashboard
 * tomorrow and finding yesterday's half-finished exchange still on the card
 * would be a stale thing in a screen whose whole job is being current. The
 * card remembers while you are on it and forgets when the app reloads.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, RotateCcw } from 'lucide-react'

import * as clerk from '../lib/clerk.js'

function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

/* Openers, rather than an empty box. The first question is the hardest one to
   think of, and these are the three the archive answers best — each one needs
   a lookup, so they also demonstrate that it is reading rather than musing. */
const OPENERS = [
  'what should I do first today?',
  'what is quietly slipping?',
  'what is due this week, by day?',
]

export default function ClerkChat({ onDuty }) {
  const [turns, setTurns] = useState([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const logRef = useRef(null)
  const inputRef = useRef(null)

  /* Pinned to the bottom as it grows. Layout effect rather than effect: after
     paint, the new turn is visible at the old scroll position for one frame
     and the card reads as jumping. */
  useLayoutEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, busy])

  const send = useCallback(async (text) => {
    const question = String(text || '').trim()
    if (!question || busy) return

    const next = [...turns, { role: 'user', content: question }]
    setTurns(next)
    setDraft('')
    setError('')
    setBusy(true)

    try {
      const res = await clerk.chat(next.map((t) => ({ role: t.role, content: t.content })))
      setTurns([...next, { role: 'assistant', content: res.reply, tools: res.toolsUsed || [] }])
    } catch (err) {
      /* The question stays in the transcript and the error sits under it, so
         retrying is a matter of asking again rather than retyping. */
      setError(err.message || 'the clerk could not answer.')
    } finally {
      setBusy(false)
    }
  }, [busy, turns])

  useEffect(() => {
    if (!busy && inputRef.current && turns.length) inputRef.current.focus()
  }, [busy, turns.length])

  /* `onDuty` is null until the server has answered. Hold an empty card for
     that moment rather than claiming either state — "the clerk is off" shown
     for one frame and then replaced is worse than nothing shown at all,
     because it is a sentence the reader half-registers and then cannot find
     again. */
  if (onDuty === null || onDuty === undefined) {
    return <div className="chat chat--waiting" aria-busy="true" />
  }

  if (!onDuty) {
    return (
      <div className="chat chat--off">
        <p className="chat__offlead">the clerk is <em className="serif">off</em>.</p>
        <p className="chat__offhint">
          add a GEMINI_API_KEY or GROQ_API_KEY to .env and restart, and this card answers
          questions about the archive.
        </p>
      </div>
    )
  }

  return (
    <div className="chat">
      <div className="chat__log" ref={logRef} aria-live="polite" aria-atomic="false">
        {turns.length === 0 ? (
          <div className="chat__opening">
            <p className="chat__lead">
              ask about the archive — it reads the cases, the entries and the timetable
              before it answers.
            </p>
            <div className="chat__seeds">
              {OPENERS.map((q) => (
                <button key={q} type="button" className="chat__seed" onClick={() => send(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((t, i) => (
            <div key={i} className={cx('chat__turn', `chat__turn--${t.role}`)}>
              <span className="chat__who">{t.role === 'user' ? 'you' : 'clerk'}</span>
              <p className="chat__text">{t.content}</p>
              {t.tools && t.tools.length ? (
                /* What it looked at. Small, and under the answer rather than
                   over it — it is evidence you check when something reads
                   oddly, not a progress log. */
                <span className="chat__tools">read {t.tools.join(', ').replace(/_/g, ' ')}</span>
              ) : null}
            </div>
          ))
        )}

        {busy ? (
          <div className="chat__turn chat__turn--assistant">
            <span className="chat__who">clerk</span>
            <p className="chat__text chat__text--wait">
              <span className="chat__dots" aria-hidden="true"><i /><i /><i /></span>
              <span className="sr-only">thinking</span>
            </p>
          </div>
        ) : null}

        {error ? <p className="chat__error">{error}</p> : null}
      </div>

      <form
        className="chat__ask"
        onSubmit={(e) => { e.preventDefault(); send(draft) }}
      >
        {turns.length ? (
          <button
            type="button"
            className="chat__clear"
            onClick={() => { setTurns([]); setError(''); setDraft('') }}
            title="Start again"
            aria-label="Start again"
          >
            <RotateCcw size={13} aria-hidden="true" />
          </button>
        ) : null}

        <input
          ref={inputRef}
          className="chat__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="ask about the archive"
          aria-label="Ask the clerk"
          disabled={busy}
          spellCheck="false"
        />

        <button
          type="submit"
          className="chat__send"
          disabled={busy || !draft.trim()}
          title="Ask"
          aria-label="Ask"
        >
          <ArrowUp size={14} aria-hidden="true" />
        </button>
      </form>
    </div>
  )
}
