/**
 * nav.js — the app's screens, in one place.
 *
 * The sidebar, the phone's tab bar and the corner wheel all read this list
 * and these icons, so a screen added here turns up in all three.
 */

import { CalendarDays, ChartColumn, Folder, GraduationCap, LayoutGrid, ListTodo, NotebookPen, Route, SlidersHorizontal } from 'lucide-react';

/* The screens, in the order the sidebar lists them. `short` is the phone's
   tab label, where a whole word does not fit. */
export const NAV = [
  { id: 'dashboard', label: 'Dashboard', short: 'Home' },
  { id: 'cases', label: 'Case files', short: 'Cases' },
  { id: 'reporting', label: 'Reporting', short: 'Reports' },
  { id: 'calendar', label: 'Calendar', short: 'Calendar' },
  { id: 'studyplan', label: 'Study plan', short: 'Degree' },
  { id: 'plan', label: 'Plan', short: 'Plan' },
  { id: 'settings', label: 'Settings', short: 'Settings' },
];

export const ICONS = {
  dashboard: LayoutGrid,
  cases: Folder,
  reporting: ChartColumn,
  calendar: CalendarDays,
  studyplan: GraduationCap,
  plan: Route,
  settings: SlidersHorizontal,
  today: ListTodo,
  notes: NotebookPen,
};

/* Each case's colour, as a Linear team has one: hashed from its id, so it is
   the same everywhere it is drawn (the sidebar, Up next, …) and on every
   device. */
const CASE_COLORS = ['#6C78E6', '#4EA7FC', '#4CB782', '#F2C94C', '#F2994A', '#EB5757', '#BB87FC', '#26B5CE'];
export function caseColor(id) {
  const s = String(id ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return CASE_COLORS[Math.abs(h) % CASE_COLORS.length];
}
