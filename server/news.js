import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import nlp from 'compromise';
import { db } from './db.js';

// Public world-news RSS feeds — no API key, no signup. Fetched server-side both
// because most outlets don't send CORS headers and because it lets one process
// cache for every client. Feeds are fetched with allSettled, so a single outlet
// going down (or blocking us) just thins the wire instead of emptying it.
const FEEDS = [
  { source: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { source: 'AL JAZEERA', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { source: 'GUARDIAN', url: 'https://www.theguardian.com/world/rss' },
  { source: 'NPR', url: 'https://feeds.npr.org/1004/rss.xml' },
];

// Outlets rate-limit and some block unknown clients; identify ourselves honestly.
const UA = 'case-file/0.1 (personal project)';

const HEADLINE_TTL_MS = 5 * 60 * 1000;
const MAX_HEADLINES = 60;

const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });

let cache = { at: 0, items: [] };
let inFlight = null;

export function headlineKey(title) {
  return createHash('sha1').update(title.trim().toLowerCase()).digest('hex').slice(0, 16);
}

function textOf(value) {
  if (value == null) return '';
  // fast-xml-parser hands back a string for plain/CDATA text, but an object when
  // the element carried attributes (its text then lives under #text).
  if (typeof value === 'object') return String(value['#text'] ?? '').trim();
  return String(value).trim();
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchFeed({ source, url }) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`${source} responded ${res.status}`);

  const parsed = parser.parse(await res.text());
  const channel = parsed?.rss?.channel ?? {};
  const rawItems = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];

  return rawItems.map(item => {
    const title = textOf(item.title);
    const published = Date.parse(textOf(item.pubDate));
    return {
      id: headlineKey(title),
      title,
      source,
      url: textOf(item.link),
      summary: stripTags(textOf(item.description)).slice(0, 240),
      publishedAt: Number.isNaN(published) ? null : published,
    };
  }).filter(item => item.title);
}

async function refreshHeadlines() {
  const settled = await Promise.allSettled(FEEDS.map(fetchFeed));

  const items = [];
  const seen = new Set();
  settled.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.warn(`[wire] ${FEEDS[i].source} failed:`, result.reason?.message ?? result.reason);
      return;
    }
    for (const item of result.value) {
      if (seen.has(item.id)) continue;   // same story syndicated across outlets
      seen.add(item.id);
      items.push(item);
    }
  });

  // Undated items sort last rather than to the top, where a missing pubDate would
  // otherwise read as "just in".
  items.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  return items.slice(0, MAX_HEADLINES);
}

export async function getHeadlines() {
  if (Date.now() - cache.at < HEADLINE_TTL_MS && cache.items.length) return cache.items;
  // Collapse concurrent misses onto one upstream refresh.
  if (inFlight) return inFlight;

  inFlight = refreshHeadlines()
    .then(items => {
      if (items.length) cache = { at: Date.now(), items };
      return cache.items;
    })
    .catch(err => {
      console.warn('[wire] refresh failed:', err.message);
      return cache.items;   // serve stale rather than blanking the wire
    })
    .finally(() => { inFlight = null; });

  return inFlight;
}

// ---------- place extraction (local NLP, no API key / network call) ----------

// compromise ships with a built-in gazetteer of countries, regions, and major
// cities, so this runs entirely offline — no rate limits, no model to go stale
// or get pulled from a free tier.
function extractPlace(title) {
  const places = nlp(title).places().out('array');
  // Headlines usually lead with their most relevant place; a story that names
  // several (e.g. "Jordan ... Iran ... US") is treated as being about the first.
  return places[0] ?? null;
}

// ---------- geocoding (Nominatim) ----------

// Nominatim's usage policy allows at most 1 request/second, so every lookup goes
// through one serialised chain rather than firing off in parallel.
let geocodeChain = Promise.resolve();
let lastGeocodeAt = 0;

function serialise(fn) {
  const run = geocodeChain.then(async () => {
    const wait = 1100 - (Date.now() - lastGeocodeAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastGeocodeAt = Date.now();
    return fn();
  });
  // Keep the chain alive even if this link rejects, so one failure doesn't wedge
  // every later lookup.
  geocodeChain = run.catch(() => {});
  return run;
}

// How tight to frame the shot. A city deserves a close, pitched view; a country
// needs to be pulled way back or the fly-to lands on an arbitrary centroid.
const ZOOM_BY_TYPE = {
  city: 11.5, town: 12, village: 13, hamlet: 13,
  suburb: 13, neighbourhood: 13.5, borough: 12.5, municipality: 11.5,
  county: 8, state: 7, province: 7, region: 6.5, island: 8,
  country: 4.5, continent: 3,
};

function labelFor(displayName, fallback) {
  const parts = displayName.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return fallback;
  if (parts.length === 1) return parts[0];
  // "Kyoto, Kyoto Prefecture, Japan" reads better as "Kyoto, Japan"
  return `${parts[0]}, ${parts[parts.length - 1]}`;
}

async function geocode(place) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', place);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  // Without this, Nominatim replies in the place's local language/script
  // (e.g. "Україна" instead of "Ukraine").
  url.searchParams.set('accept-language', 'en');

  const res = await serialise(() => fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  }));

  if (!res.ok) throw new Error(`Nominatim responded ${res.status}`);

  const [hit] = await res.json();
  if (!hit) return null;

  const kind = hit.addresstype || hit.type;
  return {
    lat: Number(hit.lat),
    lng: Number(hit.lon),
    zoom: ZOOM_BY_TYPE[kind] ?? 9,
    label: labelFor(hit.display_name ?? '', place),
  };
}

// ---------- resolve: cache -> extract -> geocode ----------

const selectPlace = db.prepare('SELECT * FROM headline_places WHERE headline_key = ?');
const insertPlace = db.prepare(`
  INSERT INTO headline_places (headline_key, place, lat, lng, zoom, label, resolved_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(headline_key) DO UPDATE SET
    place = excluded.place, lat = excluded.lat, lng = excluded.lng,
    zoom = excluded.zoom, label = excluded.label, resolved_at = excluded.resolved_at
`);

export async function resolveHeadlineLocation(title) {
  const key = headlineKey(title);

  const cached = selectPlace.get(key);
  if (cached) {
    if (cached.lat == null) return { located: false, cached: true };
    return {
      located: true,
      cached: true,
      place: cached.place,
      target: { lat: cached.lat, lng: cached.lng, zoom: cached.zoom, label: cached.label },
    };
  }

  const place = await extractPlace(title);
  const target = place ? await geocode(place) : null;

  insertPlace.run(
    key,
    place,
    target?.lat ?? null,
    target?.lng ?? null,
    target?.zoom ?? null,
    target?.label ?? null,
    Date.now(),
  );

  if (!target) return { located: false, cached: false, place };
  return { located: true, cached: false, place, target };
}