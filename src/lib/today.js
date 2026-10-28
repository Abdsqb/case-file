/**
 * today.js — the one copy of today's to-do list in the browser.
 *
 * Two places read it: the Today toggle on every entry row, and the window
 * Shift+T opens. They must never disagree about whether an entry is on the
 * list, so neither keeps its own; both subscribe here.
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
import { getToday, saveToday } from './api.js'

const listeners = new Set()
let state = { day: dayKey(), taskIds: [], offer: null, loaded: false }

/** The local calendar day, as the server keys it. */
export function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function set(next) {
  state = { ...state, ...next }
  for (const fn of listeners) fn()
}

let loading = null
/** Fetches today's list. Called on first use and whenever the day turns. */
export function loadToday() {
  const day = dayKey()
  if (loading && loading.day === day) return loading.promise
  // A new day starts empty on screen too, not with yesterday's list showing.
  if (state.day !== day) set({ day, taskIds: [], offer: null })
  const promise = getToday(day)
    .then((res) => {
      if (dayKey() !== day) return
      set({ day, taskIds: res.taskIds || [], offer: res.offer || null, loaded: true })
    })
    .catch((err) => {
      console.error('today: could not load', err)
      set({ day, loaded: true })
    })
    .finally(() => { if (loading && loading.promise === promise) loading = null })
  loading = { day, promise }
  return promise
}

function write(taskIds, decided = false) {
  const day = state.day
  set({ taskIds, ...(decided ? { offer: null } : {}) })
  return saveToday(day, taskIds, decided).catch((err) => {
    console.error('today: could not save', err)
    return loadToday()
  })
}

/** Adds the entry to the end of today's list, or takes it off. */
export function toggleToday(taskId) {
  const ids = state.taskIds
  return write(ids.includes(taskId) ? ids.filter((id) => id !== taskId) : [...ids, taskId])
}

export function removeFromToday(taskId) {
  return write(state.taskIds.filter((id) => id !== taskId))
}

/** Puts the list in this order (the window's drag and arrow keys). */
export function reorderToday(taskIds) {
  return write(taskIds)
}

/** Answers the morning question: bring yesterday's unfinished over, or not. */
export function answerOffer(accept) {
  const extra = accept && state.offer ? state.offer.taskIds.filter((id) => !state.taskIds.includes(id)) : []
  return write([...state.taskIds, ...extra], true)
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

/** { day, taskIds, offer, loaded } — re-renders when any of it changes. */
export function useToday() {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
