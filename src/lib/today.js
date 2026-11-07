/**
 * today.js — the one copy of today's to-do list in the browser.
 *
 * Two places read it: the Today toggle on every entry row, and the window
 * Shift+T opens. They must never disagree about whether an entry is on the
 * list, so neither keeps its own; both subscribe here.
 *
 * The list holds two kinds of thing in one order: entries from cases, and
 * tasks of the day's own that belong to no case, typed straight into the
 * to-do. It keeps them as keys — e<id> for an entry, l<id> for a day's own
 * task — so one order covers both. `taskIds` is the entries alone, for the
 * toggle on an entry row.
 *
 * The list lives on the server, keyed by the day as this browser reads it
 * (YYYY-MM-DD, local time). Every change is optimistic: the list on screen
 * changes at once and the whole ordered list is written behind it. A failed
 * write reloads from the server rather than leaving a list that was never
 * saved on screen.
 *
 * A new day is a new list. The day is checked whenever the window comes back
 * into focus and once a minute, so a tab left open overnight turns over by
 * itself.
 */

import { useSyncExternalStore } from 'react'
import { addTodayTask, getToday, saveToday, updateTodayTask } from './api.js'

const listeners = new Set()
let state = { day: dayKey(), order: [], loose: {}, taskIds: [], offer: null, loaded: false }

/** The local calendar day, as the server keys it. */
export function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** An entry's key in the order, and a day's own task's. */
export const entryKey = (id) => `e${id}`
export const ownKey = (id) => `l${id}`

const entriesOf = (order) => order.filter((k) => k[0] === 'e').map((k) => Number(k.slice(1)))

function set(next) {
  state = { ...state, ...next }
  if (next.order) state.taskIds = entriesOf(state.order)
  for (const fn of listeners) fn()
}

/* What the server said the day is. */
function take(day, res) {
  const loose = {}
  for (const t of res.loose || []) loose[t.id] = t
  set({
    day,
    order: res.order || (res.taskIds || []).map(entryKey),
    loose,
    offer: res.offer || null,
    loaded: true,
  })
}

let loading = null
/** Fetches today's list. Called on first use and whenever the day turns. */
export function loadToday() {
  const day = dayKey()
  if (loading && loading.day === day) return loading.promise
  // A new day starts empty on screen too, not with yesterday's list showing.
  if (state.day !== day) set({ day, order: [], loose: {}, offer: null })
  const promise = getToday(day)
    .then((res) => { if (dayKey() === day) take(day, res) })
    .catch((err) => {
      console.error('today: could not load', err)
      set({ day, loaded: true })
    })
    .finally(() => { if (loading && loading.promise === promise) loading = null })
  loading = { day, promise }
  return promise
}

function write(order, decided = false, extra = {}) {
  const day = state.day
  set({ order, ...extra, ...(decided ? { offer: null } : {}) })
  return saveToday(day, order, decided).catch((err) => {
    console.error('today: could not save', err)
    return loadToday()
  })
}

/** Adds the entry to the end of today's list, or takes it off. */
export function toggleToday(taskId) {
  const k = entryKey(taskId)
  const order = state.order
  return write(order.includes(k) ? order.filter((x) => x !== k) : [...order, k])
}

export function removeFromToday(taskId) {
  return write(state.order.filter((x) => x !== entryKey(taskId)))
}

/** Puts the list in this order (the window's drag and arrow keys), as keys. */
export function reorderToday(order) {
  return write(order)
}

/** A task of the day's own, typed into the to-do; it goes on the end. */
export function addOwnTask(title) {
  const day = state.day
  const text = String(title || '').trim()
  if (!text) return Promise.resolve()
  return addTodayTask(day, text)
    .then((res) => { if (state.day === day) take(day, res) })
    .catch((err) => {
      console.error('today: could not add the task', err)
      return loadToday()
    })
}

/** Ticks one of the day's own tasks off, or back on. */
export function setOwnTaskDone(id, completed) {
  const t = state.loose[id]
  if (!t) return Promise.resolve()
  set({ loose: { ...state.loose, [id]: { ...t, completed } } })
  return updateTodayTask(id, { completed }).catch((err) => {
    console.error('today: could not tick the task', err)
    return loadToday()
  })
}

/** Takes one of the day's own tasks off the list, which deletes it. */
export function removeOwnTask(id) {
  const { [id]: _, ...loose } = state.loose
  return write(state.order.filter((x) => x !== ownKey(id)), false, { loose })
}

/** Answers the morning question: bring the last list's unfinished over, or not. */
export function answerOffer(accept) {
  const offer = state.offer
  if (!accept || !offer) return write(state.order, true)
  const have = new Set(state.order)
  const extra = [
    ...(offer.taskIds || []).map(entryKey),
    ...(offer.loose || []).map((t) => ownKey(t.id)),
  ].filter((k) => !have.has(k))
  const loose = { ...state.loose }
  for (const t of offer.loose || []) loose[t.id] = { id: t.id, title: t.title, completed: false }
  return write([...state.order, ...extra], true, { loose })
}

/* ---- the day turning over --------------------------------------------- */

let watching = false
function watchDay() {
  if (watching || typeof window === 'undefined') return
  watching = true
  const check = () => { if (dayKey() !== state.day) loadToday() }
  window.addEventListener('focus', check)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check() })
  setInterval(check, 60000)
}

function subscribe(fn) {
  listeners.add(fn)
  if (!state.loaded) loadToday()
  watchDay()
  return () => listeners.delete(fn)
}

const snapshot = () => state

/** { day, order, loose, taskIds, offer, loaded } — re-renders when any of it changes. */
export function useToday() {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
