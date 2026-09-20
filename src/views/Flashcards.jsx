/**
 * Flashcards.jsx — import a deck, file it under a course, review it on a
 * spaced schedule.
 *
 *   Library — folders of decks, each with its size and how much is due
 *   Import  — a .json file or pasted text, with the parse error shown inline
 *   Source  — the file a deck came from, and the option to replace it
 *   Study   — one card at a time: front, reveal, rate, reschedule, next
 *
 * This screen never calls a model. Card files are written elsewhere and only
 * read here; the whole of the intelligence is the SM-2 schedule in lib/flashcards.
 *
 * The screens are one view with a mode rather than four routes, because a study
 * session is transient — leaving and coming back should land you on the library,
 * not resume a half-finished queue from an earlier sitting.
 *
 * Everything here is laid out in a single narrow column (.fc-col), not the bento
 * grid the other screens use. Studying is reading, and reading wants a measure.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check, ChevronRight, FileText, FolderPlus, Layers, Plus, RotateCcw, Trash2, Upload, X,
} from 'lucide-react'

import { EmptyState, Field, IconMenu, Meter, Pill } from '../ui/primitives.jsx'
import * as api from '../lib/api.js'
import {
  ImportError, RATINGS, deckNameFromFile, parseDeckFile, previewIntervals, scheduleCard,
} from '../lib/flashcards.js'

function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

const RATING_LABEL = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' }
const UNFILED = '__unfiled__'

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`
}

/* A panel is the unit of this screen: a titled slab in the narrow column. Its
   own element rather than the shared Card, because these are not bento cells
   and should not inherit the grid's spans or its build choreography. */
function Panel({ title, subtitle, right, children, className, ...rest }) {
  return (
    <section className={cx('fc-panel', className)} {...rest}>
      {title ? (
        <header className="fc-panel__head">
          <div className="fc-panel__titles">
            <h2 className="fc-panel__title">{title}</h2>
            {subtitle ? <p className="fc-panel__sub">{subtitle}</p> : null}
          </div>
          {right ? <div className="fc-panel__right">{right}</div> : null}
        </header>
      ) : null}
      <div className="fc-panel__body">{children}</div>
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * import                                                              *
 * ------------------------------------------------------------------ */

function ImportPanel({ folders, onImported, onCancel, busy }) {
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [folderId, setFolderId] = useState('')
  const [error, setError] = useState(null)
  const [preview, setPreview] = useState(null)

  /* Parsed on every keystroke so the count, the deck name it found and any
     error are all visible before committing rather than after. */
  const read = useCallback((raw, fallback) => {
    setError(null)
    setPreview(null)
    if (!String(raw || '').trim()) return
    try {
      setPreview(parseDeckFile(raw, fallback))
    } catch (err) {
      setError(err instanceof ImportError ? err.message : 'Could not read that file.')
    }
  }, [])

  const onFile = (e) => {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    const base = deckNameFromFile(f.name)
    setFileName(f.name)
    // FileReader rather than f.text(), so this still works where the newer
    // promise-based API is missing.
    const reader = new FileReader()
    reader.onerror = () => setError('That file could not be read.')
    reader.onload = () => {
      const raw = String(reader.result || '')
      setText(raw)
      read(raw, base)
      if (!name.trim()) setName(base)
    }
    reader.readAsText(f)
  }

  const submit = async () => {
    let parsed
    try {
      parsed = parseDeckFile(text, deckNameFromFile(fileName))
    } catch (err) {
      setError(err instanceof ImportError ? err.message : 'Could not read that file.')
      return
    }
    const finalName = name.trim() || parsed.deck || deckNameFromFile(fileName)
    if (!finalName) {
      setError('Give the deck a name — this file does not carry one.')
      return
    }
    await onImported(finalName, parsed.cards, {
      folderId: folderId || null,
      // Kept verbatim so the deck can show what it came from, and be replaced
      // from a corrected copy later.
      sourceText: text,
      sourceName: fileName || null,
    })
  }

  const ready = preview && preview.cards.length > 0

  return (
    <Panel
      title="Import a deck"
      subtitle="A .json file of cards, or paste the JSON straight in"
      right={
        <Pill className="pill--ghost" onClick={onCancel}>
          <X size={13} strokeWidth={1.5} aria-hidden="true" />
          <span className="pill__label">Cancel</span>
        </Pill>
      }
    >
      <div className="fc-form">
        <div className="fc-form__row">
          <Field
            label="Deck name"
            value={name}
            onChange={setName}
            placeholder={preview && preview.deck ? preview.deck : 'Taken from the file if blank'}
          />
          <label className="field" htmlFor="fc-folder">
            <span className="field__label">Folder</span>
            <select
              id="fc-folder"
              className="fc-select"
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
            >
              <option value="">No folder</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="fc-form__file">
          <span className="field__label">Card file</span>
          <input
            type="file"
            accept="application/json,.json"
            onChange={onFile}
            className="fc-file"
            aria-label="Choose a JSON card file"
          />
          {fileName ? <span className="micro dim truncate">{fileName}</span> : null}
        </div>

        <label className="field" htmlFor="fc-paste">
          <span className="field__label">Or paste JSON</span>
          <textarea
            id="fc-paste"
            className="fc-paste"
            value={text}
            spellCheck="false"
            placeholder={'{\n  "deck": "Cell Biology - Lecture 4",\n  "cards": [\n    { "question": "...", "answer": "..." }\n  ]\n}'}
            onChange={(e) => {
              setText(e.target.value)
              read(e.target.value, deckNameFromFile(fileName))
            }}
          />
        </label>

        <div className="fc-status" role={error ? 'alert' : undefined}>
          {error ? (
            <p className="fc-msg fc-msg--bad">{error}</p>
          ) : ready ? (
            <p className="fc-msg fc-msg--good">
              {plural(preview.cards.length, 'card', 'cards')} ready
              {preview.deck ? ` · "${preview.deck}"` : ''}
              {preview.dropped ? ` · ${preview.dropped} skipped for missing a question or answer` : ''}
            </p>
          ) : (
            <p className="fc-msg">
              Accepts a wrapping object or a bare array. question/front/q and answer/back/a all work.
            </p>
          )}
        </div>

        <div className="row" style={{ gap: '8px' }}>
          <Pill active onClick={submit} disabled={!ready || busy}>
            <Upload size={13} strokeWidth={1.5} aria-hidden="true" />
            <span className="pill__label">
              {busy ? 'Importing…' : `Import${ready ? ` ${preview.cards.length}` : ''}`}
            </span>
          </Pill>
        </div>
      </div>
    </Panel>
  )
}

/* ------------------------------------------------------------------ *
 * source + replace                                                    *
 * ------------------------------------------------------------------ */

function SourcePanel({ deck, onClose, onReplaced, busy }) {
  const [source, setSource] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [replacing, setReplacing] = useState(false)
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [preview, setPreview] = useState(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.getDeckSource(deck.id)
      .then((s) => { if (alive) { setSource(s); setText(s.sourceText || '') } })
      .catch((err) => { if (alive) setError(err.message || 'Could not read the source.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [deck.id])

  const read = (raw) => {
    setError(null)
    setPreview(null)
    if (!String(raw || '').trim()) return
    try {
      setPreview(parseDeckFile(raw, deck.name))
    } catch (err) {
      setError(err instanceof ImportError ? err.message : 'Could not read that file.')
    }
  }

  const onFile = (e) => {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    setFileName(f.name)
    const reader = new FileReader()
    reader.onerror = () => setError('That file could not be read.')
    reader.onload = () => {
      const raw = String(reader.result || '')
      setText(raw)
      read(raw)
    }
    reader.readAsText(f)
  }

  const submit = async () => {
    let parsed
    try {
      parsed = parseDeckFile(text, deck.name)
    } catch (err) {
      setError(err instanceof ImportError ? err.message : 'Could not read that file.')
      return
    }
    await onReplaced(deck, parsed.cards, { sourceText: text, sourceName: fileName || source?.sourceName || null })
  }

  const ready = preview && preview.cards.length > 0

  return (
    <Panel
      title={deck.name}
      subtitle={
        loading
          ? 'Reading the source…'
          : source && source.sourceName
            ? `${source.sourceName} · ${plural(source.cardCount, 'card', 'cards')}`
            : `${plural(deck.cardCount || 0, 'card', 'cards')}`
      }
      right={
        <Pill className="pill--ghost" onClick={onClose}>
          <X size={13} strokeWidth={1.5} aria-hidden="true" />
          <span className="pill__label">Close</span>
        </Pill>
      }
    >
      {loading ? (
        <p className="fc-msg">Loading…</p>
      ) : !source || !source.sourceText ? (
        <EmptyState
          lead="No source on file."
          hint="This deck was imported before sources were kept. Replacing it will store one."
        />
      ) : (
        <pre className="fc-source" tabIndex={0} aria-label="Imported source file">{source.sourceText}</pre>
      )}

      <div className="fc-replace">
        {!replacing ? (
          <Pill onClick={() => setReplacing(true)}>
            <RotateCcw size={13} strokeWidth={1.5} aria-hidden="true" />
            <span className="pill__label">Replace with a new file</span>
          </Pill>
        ) : (
          <div className="fc-form">
            <p className="fc-note">
              Cards whose <strong>question is unchanged</strong> keep their schedule — their ease,
              interval and streak all survive. New questions are added as fresh cards, and questions
              no longer in the file are removed.
            </p>

            <div className="fc-form__file">
              <span className="field__label">New card file</span>
              <input
                type="file"
                accept="application/json,.json"
                onChange={onFile}
                className="fc-file"
                aria-label="Choose a replacement JSON file"
              />
              {fileName ? <span className="micro dim truncate">{fileName}</span> : null}
            </div>

            <label className="field" htmlFor="fc-replace-paste">
              <span className="field__label">Or edit the JSON directly</span>
              <textarea
                id="fc-replace-paste"
                className="fc-paste"
                value={text}
                spellCheck="false"
                onChange={(e) => { setText(e.target.value); read(e.target.value) }}
              />
            </label>

            <div className="fc-status" role={error ? 'alert' : undefined}>
              {error ? (
                <p className="fc-msg fc-msg--bad">{error}</p>
              ) : ready ? (
                <p className="fc-msg fc-msg--good">
                  {plural(preview.cards.length, 'card', 'cards')} in the new file
                  {preview.dropped ? ` · ${preview.dropped} skipped` : ''}
                </p>
              ) : (
                <p className="fc-msg">Choose a file or edit the JSON above.</p>
              )}
            </div>

            <div className="row" style={{ gap: '8px' }}>
              <Pill active onClick={submit} disabled={!ready || busy}>
                <Check size={13} strokeWidth={1.5} aria-hidden="true" />
                <span className="pill__label">{busy ? 'Replacing…' : 'Replace cards'}</span>
              </Pill>
              <Pill className="pill--ghost" onClick={() => { setReplacing(false); setPreview(null); setError(null) }}>
                Cancel
              </Pill>
            </div>
          </div>
        )}
      </div>
    </Panel>
  )
}

/* ------------------------------------------------------------------ *
 * study                                                               *
 * ------------------------------------------------------------------ */

function StudyPanel({ queue, title, onRate, onEnd, index }) {
  const [shown, setShown] = useState(false)
  const card = queue[index] || null

  // A new card must always arrive face-down, however we got to it.
  useEffect(() => { setShown(false) }, [index, card && card.id])

  /* Space reveals, then 1-4 rate. A rating before the answer is shown is
     ignored: grading a card you have not read is never intentional. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        setShown(true)
        return
      }
      if (!shown) return
      const n = Number(e.key)
      if (n >= 1 && n <= 4) {
        e.preventDefault()
        onRate(RATINGS[n - 1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shown, onRate])

  const previews = useMemo(() => (card ? previewIntervals(card, Date.now()) : {}), [card])

  if (!card) return null

  return (
    <Panel
      title={title}
      subtitle={`Card ${index + 1} of ${queue.length}`}
      right={
        <Pill className="pill--ghost" onClick={onEnd}>
          <X size={13} strokeWidth={1.5} aria-hidden="true" />
          <span className="pill__label">End session</span>
        </Pill>
      }
      aria-label="Study session"
    >
      <Meter value={queue.length ? index / queue.length : 0} label="Session progress" />

      {/* Keyed on the card so each one mounts fresh and plays its own entrance
          rather than the text swapping inside a stationary box. */}
      <div className="fc-card" key={card.id}>
        <div className="fc-face">
          <span className="fc-face__tag">Question</span>
          <p className="fc-face__text">{card.front}</p>
        </div>

        {shown ? (
          <div className="fc-face fc-face--back">
            <span className="fc-face__tag">Answer</span>
            <p className="fc-face__text">{card.back}</p>
          </div>
        ) : null}
      </div>

      {shown ? (
        <div className="fc-rate">
          {RATINGS.map((r, i) => (
            <button
              key={r}
              type="button"
              className={cx('fc-rate__btn', `fc-rate__btn--${r}`)}
              style={{ '--i': i }}
              onClick={() => onRate(r)}
            >
              <span className="fc-rate__key">{i + 1}</span>
              <span className="fc-rate__label">{RATING_LABEL[r]}</span>
              <span className="fc-rate__when">{previews[r]}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="fc-reveal">
          <Pill active onClick={() => setShown(true)}>
            <span className="pill__label">Show answer</span>
          </Pill>
          <span className="micro dim">or press space</span>
        </div>
      )}
    </Panel>
  )
}

/* ------------------------------------------------------------------ *
 * the screen                                                          *
 * ------------------------------------------------------------------ */

export default function Flashcards() {
  const [decks, setDecks] = useState([])
  const [folders, setFolders] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState('library')      // library | import | source | study
  const [confirm, setConfirm] = useState(null)     // {kind:'deck'|'folder', id}
  const [sourceDeck, setSourceDeck] = useState(null)
  const [newFolder, setNewFolder] = useState(false)
  const [folderName, setFolderName] = useState('')
  // {id, value} while a folder name is being edited in place.
  const [editing, setEditing] = useState(null)
  const [collapsed, setCollapsed] = useState(() => new Set())

  const [queue, setQueue] = useState([])
  const [index, setIndex] = useState(0)
  const [sessionTitle, setSessionTitle] = useState('')
  const [reviewed, setReviewed] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const [d, f] = await Promise.all([api.listDecks(), api.listFolders()])
      setDecks(d)
      setFolders(f)
      setError(null)
    } catch (err) {
      setError(err && err.message ? err.message : 'Could not load your decks.')
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  /* Folders in creation order, then everything unfiled last — an unfiled deck is
     an unsorted one, and it belongs at the bottom of the list, not the top. */
  const groups = useMemo(() => {
    const out = folders.map((f) => ({
      key: f.id,
      folder: f,
      decks: decks.filter((d) => d.folderId === f.id),
    }))
    const loose = decks.filter((d) => !d.folderId)
    if (loose.length) out.push({ key: UNFILED, folder: null, decks: loose })
    return out.map((g) => ({
      ...g,
      cards: g.decks.reduce((n, d) => n + (d.cardCount || 0), 0),
      due: g.decks.reduce((n, d) => n + (d.dueCount || 0), 0),
    }))
  }, [folders, decks])

  const totals = useMemo(() => {
    let cards = 0
    let due = 0
    let decksDue = 0
    for (const d of decks) {
      cards += d.cardCount || 0
      due += d.dueCount || 0
      if (d.dueCount > 0) decksDue += 1
    }
    return { cards, due, decksDue }
  }, [decks])

  const run = async (fn, failure) => {
    setBusy(true)
    try {
      return await fn()
    } catch (err) {
      setError(err && err.message ? err.message : failure)
      return null
    } finally {
      setBusy(false)
    }
  }

  const doImport = async (name, cards, meta) => {
    const ok = await run(() => api.createDeck(name, cards, meta), 'Import failed.')
    if (ok) {
      await refresh()
      setMode('library')
      setNotice(`Imported ${plural(cards.length, 'card', 'cards')} into "${name}".`)
    }
  }

  const doReplace = async (deck, cards, meta) => {
    const r = await run(
      () => api.replaceDeck(deck.id, { cards, ...meta }),
      'Could not replace that deck.'
    )
    if (r) {
      await refresh()
      setMode('library')
      setSourceDeck(null)
      const bits = [`${r.kept} kept`]
      if (r.added) bits.push(`${r.added} added`)
      if (r.removed) bits.push(`${r.removed} removed`)
      setNotice(`"${deck.name}" replaced — ${bits.join(', ')}. Schedules kept for unchanged questions.`)
    }
  }

  const doDelete = async () => {
    if (!confirm) return
    const ok = await run(
      () => (confirm.kind === 'deck' ? api.deleteDeck(confirm.id) : api.deleteFolder(confirm.id)),
      'Could not delete that.'
    )
    if (ok !== null) {
      setConfirm(null)
      await refresh()
    }
  }

  const addFolder = async () => {
    const n = folderName.trim()
    if (!n) return
    const ok = await run(() => api.createFolder(n), 'Could not create that folder.')
    if (ok) {
      setFolderName('')
      setNewFolder(false)
      await refresh()
    }
  }

  const saveFolderName = async () => {
    if (!editing) return
    const next = editing.value.trim()
    const current = (folders.find((f) => f.id === editing.id) || {}).name
    // Nothing to write if it did not actually change; just close the editor.
    if (!next || next === current) { setEditing(null); return }
    const ok = await run(() => api.renameFolder(editing.id, next), 'Could not rename that folder.')
    if (ok) {
      setEditing(null)
      await refresh()
    }
  }

  const moveDeck = async (deck, folderId) => {
    const ok = await run(() => api.updateDeck(deck.id, { folderId }), 'Could not move that deck.')
    if (ok) await refresh()
  }

  const startSession = async (scope, title) => {
    const due = await run(() => api.listDueCards(scope), 'Could not build a queue.')
    if (!due) return
    setQueue(due)
    setIndex(0)
    setReviewed(0)
    setSessionTitle(title)
    setMode('study')
  }

  const endSession = useCallback(async () => {
    setMode('library')
    setQueue([])
    setIndex(0)
    await refresh()
  }, [refresh])

  const rate = useCallback(
    async (rating) => {
      const card = queue[index]
      if (!card) return
      const next = scheduleCard(card, rating, Date.now())
      // Advance immediately; the write is not something the reader should wait
      // on, and a failure is surfaced rather than blocking the session.
      setIndex((i) => i + 1)
      setReviewed((n) => n + 1)
      try {
        await api.updateCard(card.id, next)
      } catch (err) {
        setError(err && err.message ? err.message : 'That review could not be saved.')
      }
    },
    [queue, index]
  )

  const done = mode === 'study' && index >= queue.length
  useEffect(() => { if (done) refresh() }, [done, refresh])

  const toggle = (key) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const confirmLabel = () => {
    if (!confirm) return ''
    if (confirm.kind === 'folder') {
      const f = folders.find((x) => x.id === confirm.id)
      const n = decks.filter((d) => d.folderId === confirm.id).length
      return `delete the folder "${f ? f.name : ''}"? its ${plural(n, 'deck stays', 'decks stay')} — they just move out of it.`
    }
    const d = decks.find((x) => x.id === confirm.id)
    return `delete "${d ? d.name : 'this deck'}" and its ${plural(d ? d.cardCount || 0 : 0, 'card', 'cards')}? this cannot be undone.`
  }

  return (
    <div className="fc-col">
      <div className="viewhead">
        <div className="viewhead__left">
          <span className="section-label">Flashcards</span>
          <span className="micro dim">Spaced repetition</span>
        </div>
        <div className="viewhead__right">
          <span className="micro muted">{plural(decks.length, 'deck', 'decks')}</span>
          <span className="micro dim">·</span>
          <span className="micro muted">{totals.cards} cards</span>
          <span className="micro dim">·</span>
          <span className={totals.due ? 'micro' : 'micro dim'}>{totals.due} due</span>
        </div>
      </div>

      {error ? (
        <div className="fc-banner fc-banner--bad" role="alert">
          <span className="grow">{error}</span>
          <Pill className="pill--ghost pill--micro" onClick={() => setError(null)}>Dismiss</Pill>
        </div>
      ) : null}

      {notice ? (
        <div className="fc-banner" role="status">
          <span className="grow">{notice}</span>
          <Pill className="pill--ghost pill--micro" onClick={() => setNotice(null)}>Dismiss</Pill>
        </div>
      ) : null}

      {confirm ? (
        <div className="fc-banner fc-banner--bad" role="alert">
          <span className="grow">{confirmLabel()}</span>
          <Pill className="pill--danger pill--micro" onClick={doDelete} disabled={busy}>
            <Trash2 size={12} strokeWidth={1.5} aria-hidden="true" />
            Delete
          </Pill>
          <Pill className="pill--ghost pill--micro" onClick={() => setConfirm(null)}>Cancel</Pill>
        </div>
      ) : null}

      {/* Keyed on the mode so each screen mounts fresh and plays its entrance,
          instead of one screen's content morphing into the next. */}
      <div className="fc-stage" key={mode + (done ? '-done' : '')}>
        {mode === 'import' ? (
          <ImportPanel
            folders={folders}
            onImported={doImport}
            onCancel={() => setMode('library')}
            busy={busy}
          />
        ) : mode === 'source' && sourceDeck ? (
          <SourcePanel
            deck={sourceDeck}
            busy={busy}
            onClose={() => { setMode('library'); setSourceDeck(null) }}
            onReplaced={doReplace}
          />
        ) : mode === 'study' && !done ? (
          <StudyPanel queue={queue} index={index} title={sessionTitle} onRate={rate} onEnd={endSession} />
        ) : mode === 'study' && done ? (
          <Panel title="Session complete" subtitle={sessionTitle}>
            <div className="fc-done">
              <span className="fc-done__n">{reviewed}</span>
              <span className="fc-done__label">{reviewed === 1 ? 'card reviewed' : 'cards reviewed'}</span>
              <p className="fc-msg">
                Anything rated Again comes back in ten minutes; the rest are scheduled further out.
              </p>
              <Pill active onClick={endSession}>
                <Check size={13} strokeWidth={1.5} aria-hidden="true" />
                <span className="pill__label">Back to the library</span>
              </Pill>
            </div>
          </Panel>
        ) : (
          <>
            <div className="fc-actions">
              {totals.decksDue > 1 ? (
                <Pill active onClick={() => startSession({}, 'All decks')} disabled={busy}>
                  <Layers size={13} strokeWidth={1.5} aria-hidden="true" />
                  <span className="pill__label">Study everything due ({totals.due})</span>
                </Pill>
              ) : null}
              <Pill onClick={() => setMode('import')}>
                <Plus size={13} strokeWidth={1.5} aria-hidden="true" />
                <span className="pill__label">Import a deck</span>
              </Pill>
              <Pill onClick={() => setNewFolder((v) => !v)}>
                <FolderPlus size={13} strokeWidth={1.5} aria-hidden="true" />
                <span className="pill__label">New folder</span>
              </Pill>
            </div>

            {newFolder ? (
              <div className="fc-newfolder">
                <Field
                  value={folderName}
                  onChange={setFolderName}
                  placeholder="Course name, e.g. Cell Biology"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); addFolder() }
                    if (e.key === 'Escape') { setNewFolder(false); setFolderName('') }
                  }}
                />
                <Pill active onClick={addFolder} disabled={!folderName.trim() || busy}>Create</Pill>
                <Pill className="pill--ghost" onClick={() => { setNewFolder(false); setFolderName('') }}>
                  Cancel
                </Pill>
              </div>
            ) : null}

            {!loaded ? (
              <Panel><p className="fc-msg">Loading…</p></Panel>
            ) : decks.length === 0 && folders.length === 0 ? (
              <Panel>
                <EmptyState
                  lead="No decks yet."
                  hint="Import a .json file of cards to start studying."
                  action={
                    <Pill active onClick={() => setMode('import')}>
                      <Plus size={13} strokeWidth={1.5} aria-hidden="true" />
                      <span className="pill__label">Import a deck</span>
                    </Pill>
                  }
                />
              </Panel>
            ) : (
              groups.map((g, gi) => {
                const shut = collapsed.has(g.key)
                const isEditing = !!(editing && g.folder && editing.id === g.folder.id)
                return (
                  <section className="fc-group" key={g.key} style={{ '--i': gi }}>
                    <header className="fc-group__head">
                      {isEditing ? (
                        <div className="fc-rename">
                          <Field
                            value={editing.value}
                            onChange={(v) => setEditing({ id: editing.id, value: v })}
                            aria-label="Folder name"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); saveFolderName() }
                              if (e.key === 'Escape') { e.preventDefault(); setEditing(null) }
                            }}
                          />
                          <Pill
                            className="pill--micro"
                            active
                            onClick={saveFolderName}
                            disabled={busy || !editing.value.trim()}
                          >
                            Save
                          </Pill>
                          <Pill className="pill--micro pill--ghost" onClick={() => setEditing(null)}>
                            Cancel
                          </Pill>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="fc-group__toggle"
                          onClick={() => toggle(g.key)}
                          aria-expanded={!shut}
                        >
                          <ChevronRight
                            size={14}
                            strokeWidth={1.6}
                            className={cx('fc-group__chev', !shut && 'is-open')}
                            aria-hidden="true"
                          />
                          <span className="fc-group__name truncate">
                            {g.folder ? g.folder.name : 'Unfiled'}
                          </span>
                        </button>
                      )}

                      {isEditing ? null : (
                        <>
                          <span className="fc-group__meta nowrap">
                            {plural(g.decks.length, 'deck', 'decks')} · {g.cards} cards
                          </span>
                          <span className={cx('fc-group__due nowrap', g.due > 0 && 'is-due')}>
                            {g.due > 0 ? `${g.due} due` : 'none due'}
                          </span>
                        </>
                      )}

                      {isEditing ? null : (
                      <span className="fc-group__acts">
                        {g.due > 0 && g.folder ? (
                          <Pill
                            className="pill--micro"
                            onClick={() => startSession({ folderId: g.folder.id }, g.folder.name)}
                            disabled={busy}
                          >
                            <span className="pill__label">Study folder</span>
                          </Pill>
                        ) : null}
                        {g.folder ? (
                          <IconMenu
                            label={`Actions for ${g.folder.name}`}
                            items={[
                              {
                                key: 'rename',
                                label: 'Rename folder',
                                onClick: () => {
                                  setConfirm(null)
                                  setEditing({ id: g.folder.id, value: g.folder.name })
                                },
                              },
                              {
                                key: 'del',
                                label: 'Delete folder',
                                danger: true,
                                onClick: () => setConfirm({ kind: 'folder', id: g.folder.id }),
                              },
                            ]}
                          />
                        ) : null}
                      </span>
                      )}
                    </header>

                    {/* 0fr -> 1fr is the one height animation that does not need
                        a measured pixel value, so a folder can open smoothly
                        without JS measuring its own contents. */}
                    <div className={cx('fc-group__wrap', shut && 'is-shut')}>
                      <div className="fc-group__inner">
                        {g.decks.length === 0 ? (
                          <p className="fc-msg fc-group__empty">
                            Nothing filed here yet — move a deck in from its ··· menu.
                          </p>
                        ) : (
                          g.decks.map((d, di) => (
                            <div className="fc-deck" key={d.id} style={{ '--i': di }}>
                              <span className="fc-deck__name truncate">{d.name}</span>
                              <span className="fc-deck__meta nowrap">
                                {plural(d.cardCount, 'card', 'cards')}
                              </span>
                              <span className={cx('fc-deck__due nowrap', d.dueCount > 0 && 'is-due')}>
                                {d.dueCount > 0 ? `${d.dueCount} due` : 'none due'}
                              </span>
                              <span className="fc-deck__acts">
                                <Pill
                                  className="pill--micro"
                                  onClick={() => startSession({ deckId: d.id }, d.name)}
                                  disabled={busy || d.dueCount === 0}
                                  aria-label={
                                    d.dueCount === 0
                                      ? `${d.name}: nothing due`
                                      : `Study ${d.name}, ${d.dueCount} due`
                                  }
                                >
                                  <RotateCcw size={12} strokeWidth={1.5} aria-hidden="true" />
                                  <span className="pill__label">Study</span>
                                </Pill>
                                <IconMenu
                                  label={`Actions for ${d.name}`}
                                  items={[
                                    {
                                      key: 'src',
                                      label: 'View source file',
                                      onClick: () => { setSourceDeck(d); setMode('source') },
                                    },
                                    ...folders
                                      .filter((f) => f.id !== d.folderId)
                                      .map((f) => ({
                                        key: `mv-${f.id}`,
                                        label: `Move to ${f.name}`,
                                        onClick: () => moveDeck(d, f.id),
                                      })),
                                    ...(d.folderId
                                      ? [{ key: 'unfile', label: 'Move out of folder', onClick: () => moveDeck(d, null) }]
                                      : []),
                                    {
                                      key: 'del',
                                      label: 'Delete deck',
                                      danger: true,
                                      onClick: () => setConfirm({ kind: 'deck', id: d.id }),
                                    },
                                  ]}
                                />
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </section>
                )
              })
            )}

            {loaded && decks.length > 0 && totals.due === 0 ? (
              <Panel>
                <EmptyState
                  lead="Nothing due right now."
                  hint="Come back later, or import another deck."
                />
              </Panel>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
