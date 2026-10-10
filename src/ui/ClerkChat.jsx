/**
 * ClerkChat.jsx — the chat card, second in the dashboard deck.
 *
 * A question box over the archive. It reads: it can open a case, search the
 * entries and look at the timetable before answering, which is the difference
 * between "what have I got for the databases course" being answered and being
 * guessed at. Asked to change something — add, edit, close or delete entries —
 * it stages the changes, and they sit under its reply until you apply them.
 *
 * The transcript is deliberately not persisted. A study session is not resumed
 * in this app and neither is a conversation: coming back to the dashboard
 * tomorrow and finding yesterday's half-finished exchange still on the card
 * would be a stale thing in a screen whose whole job is being current. The
 * card remembers while you are on it and forgets when the app reloads.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, Check, RotateCcw } from 'lucide-react'

import * as clerk from '../lib/clerk.js'
import ChatMarkdown from './ChatMarkdown.jsx'

function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

/* What a staged change does, in the words of the row. `close` with done:false
   is a reopen, and says so — "close" next to something already closed would
   read as a mistake. */
function opLabel(c) {
  if (c.op === 'create') return c.under ? 'new sub' : 'new'
  if (c.op === 'update') return 'edit'
  if (c.op === 'close') return c.done === false ? 'reopen' : 'close'
  return 'delete'
}

function changeDetail(c) {
  if (c.op === 'create') {
    return [
      c.under ? `under ${c.under.title}` : c.caseName,
      c.dueText ? `due ${c.dueText}` : null,
      c.priority && c.priority !== 'normal' ? c.priority : null,
    ].filter(Boolean).join(' · ')
  }
  if (c.op === 'update') {
    const s = c.set || {}
    const b = c.before || {}
    return [
      s.title !== undefined ? `title → ${s.title}` : null,
      'dueText' in s ? `due ${b.dueText || 'none'} → ${s.dueText || 'none'}` : null,
      s.priority !== undefined ? `${b.priority} → ${s.priority}` : null,
    ].filter(Boolean).join(' · ')
  }
  if (c.op === 'delete' && c.subtasks) {
    return `and its ${c.subtasks} ${c.subtasks === 1 ? 'subtask' : 'subtasks'}`
  }
  return ''
}

function madeLine(m) {
  const parts = [
    m.created && `${m.created} added`,
    m.updated && `${m.updated} edited`,
    m.closed && `${m.closed} closed`,
    m.reopened && `${m.reopened} reopened`,
    m.deleted && `${m.deleted} deleted`,
    m.skipped && `${m.skipped} skipped — no longer there`,
  ].filter(Boolean)
  return parts.length ? `applied — ${parts.join(', ')}.` : 'nothing to apply.'
}

/* The model is told what became of what it staged, so "actually, undo that"
   in the next turn is about something it knows happened. */
function historyText(t) {
  if (!t.changes || !t.changes.length) return t.content
  const fate = t.applied ? 'the reader applied them' : t.dismissed ? 'the reader dismissed them' : 'not applied yet'
  return `${t.content}\n\n[staged ${t.changes.length} change(s): ${fate}]`
}

/* The staged changes under a reply. Every row starts ticked — the reader
   asked for these — and can be left out before applying. Once applied or
   dismissed the list stays, settled, so the transcript still shows what
   happened; it just stops offering to do it again. */
function ChangeList({ turn, onToggle, onApply, onDismiss }) {
  const { changes, off, applying, applied, dismissed, applyError } = turn
  const settled = !!applied || !!dismissed
  const count = changes.length - off.length

  return (
    <div className={cx('chat__changes', settled && 'is-settled')}>
      <ul className="chat__changelist">
        {changes.map((c) => {
          const on = !off.includes(c.id)
          const detail = changeDetail(c)
          return (
            <li key={c.id} className={cx('chat__change', !on && 'is-off', `chat__change--${c.op}`)}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                className="chat__changetick"
                onClick={() => onToggle(c.id)}
                disabled={settled || applying}
                aria-label={`${on ? 'Leave out' : 'Include'} ${opLabel(c)} ${c.title}`}
              >
                {on ? <Check size={11} strokeWidth={3} aria-hidden="true" /> : null}
              </button>
              <span className="chat__changeop">{opLabel(c)}</span>
              <span className="chat__changebody">
                <span className="chat__changetitle">{c.title}</span>
                {detail ? <span className="chat__changedetail">{detail}</span> : null}
              </span>
            </li>
          )
        })}
      </ul>

      {applied ? (
        <p className="chat__changenote">{madeLine(applied)}</p>
      ) : dismissed ? (
        <p className="chat__changenote">dismissed — nothing changed.</p>
      ) : (
        <div className="chat__changeactions">
          <button
            type="button"
            className="chat__apply"
            onClick={onApply}
            disabled={applying || !count}
          >
            {applying ? 'applying…' : `apply ${count}`}
          </button>
          <button type="button" className="chat__dismiss" onClick={onDismiss} disabled={applying}>
            dismiss
          </button>
          {applyError ? <span className="chat__changeerror">{applyError}</span> : null}
        </div>
      )}
    </div>
  )
}

/* Openers, rather than an empty box. The first question is the hardest one to
   think of, and these are the three the archive answers best — each one needs
   a lookup, so they also demonstrate that it is reading rather than musing. */
const OPENERS = [
  'what should I do first today?',
  'what is quietly slipping?',
  'what is due this week, by day?',
]

export default function ClerkChat({ onDuty, onChanged }) {
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
      const res = await clerk.chat(next.map((t) => ({ role: t.role, content: historyText(t) })))
      setTurns([...next, {
        role: 'assistant',
        content: res.reply,
        tools: res.toolsUsed || [],
        changes: Array.isArray(res.changes) ? res.changes : [],
        off: [],
      }])
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

  const patchTurn = useCallback((i, patch) => {
    setTurns((all) => all.map((t, j) => (j === i ? { ...t, ...patch } : t)))
  }, [])

  const toggleChange = useCallback((i, id) => {
    setTurns((all) => all.map((t, j) => {
      if (j !== i) return t
      const off = t.off.includes(id) ? t.off.filter((x) => x !== id) : [...t.off, id]
      return { ...t, off }
    }))
  }, [])

  const applyTurn = useCallback(async (i) => {
    const t = turns[i]
    if (!t || t.applying) return
    const picked = t.changes.filter((c) => !t.off.includes(c.id))
    if (!picked.length) return
    patchTurn(i, { applying: true, applyError: '' })
    try {
      const made = await clerk.applyChanges(picked)
      patchTurn(i, { applying: false, applied: made })
      if (onChanged) onChanged()
    } catch (err) {
      patchTurn(i, { applying: false, applyError: err.message || 'the changes could not be made.' })
    }
  }, [turns, patchTurn, onChanged])

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
              {t.role === 'assistant'
                ? <ChatMarkdown className="chat__text chat__text--md" text={t.content} />
                : <p className="chat__text">{t.content}</p>}
              {t.changes && t.changes.length ? (
                <ChangeList
                  turn={t}
                  onToggle={(id) => toggleChange(i, id)}
                  onApply={() => applyTurn(i)}
                  onDismiss={() => patchTurn(i, { dismissed: true })}
                />
              ) : null}
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
