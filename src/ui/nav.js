/**
 * nav.js — the app's screens, in one place.
 *
 * The sidebar, the phone's tab bar and the corner wheel all read this list
 * and these icons, so a screen added here turns up in all three.
 */

import { CalendarDays, ChartColumn, Folder, LayoutGrid, ListTodo, NotebookPen, Route, SlidersHorizontal } from 'lucide-react';

/* The screens, in the order the sidebar lists them. `short` is the phone's
   tab label, where a whole word does not fit. */
export const NAV = [
  { id: 'dashboard', label: 'Dashboard', short: 'Home' },
  { id: 'cases', label: 'Case files', short: 'Cases' },
  { id: 'reporting', label: 'Reporting', short: 'Reports' },
  { id: 'calendar', label: 'Calendar', short: 'Calendar' },
  { id: 'plan', label: 'Plan', short: 'Plan' },
  { id: 'settings', label: 'Settings', short: 'Settings' },
];

export const ICONS = {
  dashboard: LayoutGrid,
  cases: Folder,
  reporting: ChartColumn,
  calendar: CalendarDays,
  plan: Route,
  settings: SlidersHorizontal,
  today: ListTodo,
  notes: NotebookPen,
};

/* The phone's tab bar: the four screens a thumb wants most. The rest are a
   hold of the to-do button away (the corner wheel), or in the drawer. */
export const PHONE_TABS = ['dashboard', 'cases', 'calendar', 'plan'];
