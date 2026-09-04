/**
 * ics.js — enough of RFC 5545 to render a class timetable.
 *
 * Scope is deliberate. A registrar export is a narrow slice of iCalendar: a
 * handful of VEVENTs, each a weekly RRULE with BYDAY and UNTIL, plus EXDATEs for
 * the term's holidays. That is what this reads. Anything it does not understand
 * is skipped rather than guessed at, so a stranger .ics degrades to "fewer
 * events" instead of "wrong events".
 *
 * TIMEZONES. The export stamps every time `TZID=America/New_York`, and this
 * reads those as plain wall-clock local time — no conversion. That is the right
 * answer for the only reader there is: a 09:30 class should say 09:30 on the
 * screen of the person walking to it. It is also the only honest option without
 * shipping a tz database. The consequence, stated plainly: open this from
 * another timezone and the times still read as campus times, not yours.
 */

const DAY_CODE = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/* A term is ~60 meetings per series. These are runaway guards for a malformed
   rule (a missing UNTIL and COUNT would otherwise loop forever), not limits
   anyone should reach. */
const MAX_OCCURRENCES = 400;
const MAX_WEEKS = 520;

/* ------------------------------------------------------------------ parsing */

/** RFC 5545 folds long lines; a continuation begins with a space or a tab. */
function unfold(text) {
  return String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
}

/** Split at the first colon that is not inside a quoted parameter value. */
function splitAtColon(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) return [line.slice(0, i), line.slice(i + 1)];
  }
  return [line, ''];
}

/** `DTSTART;TZID=America/New_York` → { name: 'DTSTART', params: {TZID: '...'} } */
function parseName(left) {
  const bits = [];
  let buf = '';
  let quoted = false;
  for (let i = 0; i < left.length; i += 1) {
    const c = left[i];
    if (c === '"') { quoted = !quoted; buf += c; }
    else if (c === ';' && !quoted) { bits.push(buf); buf = ''; }
    else buf += c;
  }
  bits.push(buf);

  const params = {};
  for (let i = 1; i < bits.length; i += 1) {
    const eq = bits[i].indexOf('=');
    if (eq === -1) continue;
    params[bits[i].slice(0, eq).toUpperCase()] = bits[i].slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: bits[0].toUpperCase(), params };
}

/** iCalendar escapes commas, semicolons, newlines and backslashes in TEXT. */
function unescapeText(v) {
  return String(v).replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/**
 * `20260903T093000` → a local Date. A trailing Z means UTC and is converted;
 * everything else — including TZID-stamped values — is read as wall clock.
 */
function parseStamp(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d, hh = '0', mi = '0', ss = '0', z] = m;
  const n = (s) => parseInt(s, 10);
  const date = z
    ? new Date(Date.UTC(n(y), n(mo) - 1, n(d), n(hh), n(mi), n(ss)))
    : new Date(n(y), n(mo) - 1, n(d), n(hh), n(mi), n(ss));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `FREQ=WEEKLY;BYDAY=TU,TH` → { FREQ: 'WEEKLY', BYDAY: 'TU,TH' } */
function parseRule(value) {
  const out = {};
  for (const part of String(value).split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return out;
}

/* -------------------------------------------------------------- recurrence */

function startOfWeek(date, weekStart) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - weekStart + 7) % 7));
  return d;
}

/**
 * Expand one event into its occurrences.
 *
 * Only FREQ=WEEKLY recurs — that is every rule a class schedule uses. Anything
 * else yields the single starting occurrence, which is strictly better than
 * dropping the event or inventing a pattern for it.
 */
function expand(start, durationMs, rule, exdates) {
  const at = (date) => ({ start: date, end: new Date(date.getTime() + durationMs) });
  if (!rule || rule.FREQ !== 'WEEKLY') return [at(start)];

  const days = rule.BYDAY
    ? rule.BYDAY.split(',')
        .map((code) => DAY_CODE[code.trim().slice(-2).toUpperCase()])
        .filter((d) => d !== undefined)
        .sort((a, b) => a - b)
    : [start.getDay()];
  if (!days.length) return [at(start)];

  const interval = Math.max(1, parseInt(rule.INTERVAL, 10) || 1);
  const until = rule.UNTIL ? parseStamp(rule.UNTIL) : null;
  const count = rule.COUNT ? parseInt(rule.COUNT, 10) : null;
  const weekStart = DAY_CODE[String(rule.WKST || 'MO').toUpperCase()] ?? 1;

  const hh = start.getHours();
  const mi = start.getMinutes();
  const out = [];
  const cursor = startOfWeek(start, weekStart);

  for (let w = 0; w < MAX_WEEKS; w += 1) {
    for (const day of days) {
      const d = new Date(cursor);
      d.setDate(d.getDate() + ((day - weekStart + 7) % 7));
      d.setHours(hh, mi, 0, 0);

      if (d < start) continue;                       // the rule starts at DTSTART
      if (until && d > until) return out;
      if (exdates.has(d.getTime())) continue;
      out.push(at(d));
      if (count && out.length >= count) return out;
      if (out.length >= MAX_OCCURRENCES) return out;
    }
    cursor.setDate(cursor.getDate() + 7 * interval);
    if (until && cursor > until) break;
    if (!until && !count && w > 60) break;           // unbounded rule: one year
  }
  return out;
}

/* ----------------------------------------------------------------- the API */

/**
 * Read an .ics into a flat, sorted list of meetings.
 *
 * Returns `{ calendarName, series, meetings }`:
 *   series   — one entry per VEVENT, the repeating pattern (a course meeting)
 *   meetings — every individual occurrence, ascending, each linked to its series
 */
export function parseCalendar(text) {
  const lines = unfold(text).split('\n');
  const series = [];
  let calendarName = '';
  let current = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    /* Normally `BEGIN:VEVENT` is alone on its line. This export is malformed:
       the whole VTIMEZONE block is crammed into X-WR-CALDESC with its newlines
       stripped, so the first event's BEGIN is fused to the tail of that line and
       a strict reader silently loses one course. Matching the suffix costs a
       theoretical false positive on a property whose value ends in exactly this
       text; dropping a class does not stay theoretical. */
    if (line === 'BEGIN:VEVENT' || line.endsWith('BEGIN:VEVENT')) {
      current = { exdates: new Set() };
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current && current.start) series.push(current);
      current = null;
      continue;
    }

    const [left, value] = splitAtColon(line);
    const { name } = parseName(left);

    if (!current) {
      if (name === 'X-WR-CALNAME') calendarName = unescapeText(value).trim();
      continue;
    }

    switch (name) {
      case 'DTSTART': current.start = parseStamp(value); break;
      case 'DTEND': current.end = parseStamp(value); break;
      case 'SUMMARY': current.summary = unescapeText(value).trim(); break;
      case 'LOCATION': current.location = unescapeText(value).trim(); break;
      case 'UID': current.uid = value.trim(); break;
      case 'STATUS': current.status = value.trim(); break;
      case 'RRULE': current.rule = parseRule(value); break;
      case 'EXDATE':
        // May repeat, and may carry several comma-separated values on one line.
        for (const one of value.split(',')) {
          const d = parseStamp(one);
          if (d) current.exdates.add(d.getTime());
        }
        break;
      default: break;
    }
  }

  const meetings = [];
  const out = series
    .filter((e) => e.start && e.status !== 'CANCELLED')
    .map((e, i) => {
      const durationMs = e.end && e.end > e.start ? e.end - e.start : 60 * 60 * 1000;
      const occurrences = expand(e.start, durationMs, e.rule, e.exdates);
      const record = {
        // UID can be missing or duplicated across exports; the index cannot.
        id: e.uid ? `${e.uid}#${i}` : `s${i}`,
        summary: e.summary || 'Untitled',
        location: e.location || '',
        days: [...new Set(occurrences.map((o) => o.start.getDay()))].sort((a, b) => a - b),
        startMinutes: e.start.getHours() * 60 + e.start.getMinutes(),
        durationMin: Math.round(durationMs / 60000),
        first: occurrences.length ? occurrences[0].start : e.start,
        last: occurrences.length ? occurrences[occurrences.length - 1].end : e.end,
        count: occurrences.length,
      };
      occurrences.forEach((o, n) => {
        meetings.push({
          seriesId: record.id,
          summary: record.summary,
          location: record.location,
          start: o.start,
          end: o.end,
          // Stamped here rather than derived later: the flat list is sorted
          // across every series, so "which meeting of this course is this" is
          // only cheap to know while the series is still in hand.
          seriesIndex: n + 1,
          seriesCount: occurrences.length,
        });
      });
      return record;
    });

  meetings.sort((a, b) => a.start - b.start);
  return { calendarName, series: out, meetings };
}

/* ------------------------------------------------------------ small helpers */

export const MINUTES_IN_DAY = 24 * 60;

export function minutesOf(date) {
  return date.getHours() * 60 + date.getMinutes();
}

export function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(ts, n) {
  const d = startOfDay(ts);
  d.setDate(d.getDate() + n);
  return d;
}

/** Monday-based, to match the timetable and the rest of the app's week. */
export function weekStartOf(ts) {
  const d = startOfDay(ts);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/** `545` → `9:05`, in the 12-hour form the campus uses. */
export function fmtTime(date) {
  const h = date.getHours();
  const m = date.getMinutes();
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}
