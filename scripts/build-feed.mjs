/* Daily discovery-feed builder (pivot 2026-07-01: the hub is the app's sole
   online-refreshed surface). Pulls from an ALLOWLIST of keyless, structured
   agency/Wikimedia APIs — never scraping, never social media — normalizes to
   the feed schema below, and writes state/feed/latest.json (dev) or a path
   given as argv[2] (the future solar-explorer-feed repo's GitHub Action).

   Editorial rules are enforced HERE, in the only choke point (the client
   renders whatever the feed says via textContent):
   - every entry MUST carry sourceUrl + sourceName, else it is dropped
   - per-category entry caps; plain-text sanitization (tags stripped, len cap)
   - earthquakes below MAG_FLOOR are dropped (no everyday-tremor noise)
   - fail closed: a source that errors contributes nothing; if EVERY source
     fails the script exits non-zero so a scheduler never publishes an empty
     feed over a good one.
   Run: node scripts/build-feed.mjs [outfile] */
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_FILE = process.argv[2] ?? join(ROOT, 'state', 'feed', 'latest.json')

const UA = 'SolarExplorerDiscoveryFeed/1.0 (educational app; contact via repo)'
const FETCH_TIMEOUT_MS = 15000
const SUMMARY_MAX_CHARS = 280
const SCHEMA_VERSION = 1

// --- Source caps + floors (editorial, not technical) ------------------------
const MAG_FLOOR = 5.5 // USGS: significant quakes only
const QUAKE_CAP = 4
const EVENT_CAP = 4 // EONET natural events (wildfires, storms, volcanoes...)
const LAUNCH_CAP = 3 // Launch Library 2 upcoming launches
const ONTHISDAY_CAP = 3 // Wikimedia on-this-day, science/space-leaning

// EONET categories worth showing a curious explorer (allowlist, not blocklist).
const EONET_CATEGORIES = new Set(['volcanoes', 'wildfires', 'severeStorms', 'seaLakeIce'])
// Singular per-event labels — EONET's plural category titles ("Wildfires")
// read wrong on a single event's card (critique 2026-07-02).
const EONET_CATEGORY_LABEL = {
  volcanoes: 'Volcano',
  wildfires: 'Wildfire',
  severeStorms: 'Severe storm',
  seaLakeIce: 'Sea/lake ice event',
}

/* Summary date formatters, pinned to UTC so the published feed reads the same
   everywhere (critique 2026-07-02: summaries must add information the title
   lacks — the when/where — instead of echoing the title). */
const WHEN_UTC = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
})
const SINCE_UTC = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

/** '<formatted> UTC' for a parseable timestamp, null otherwise — callers fall
    back to a dateless phrase rather than printing 'Invalid Date'. */
function whenUTC(iso) {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : `${WHEN_UTC.format(d)} UTC`
}

/** Plain text only: strip any markup a source sneaks in, collapse whitespace,
    cap length at a sentence boundary where possible. */
function sanitize(text) {
  const plain = String(text ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= SUMMARY_MAX_CHARS) return plain
  const cut = plain.slice(0, SUMMARY_MAX_CHARS)
  const lastStop = cut.lastIndexOf('. ')
  return lastStop > SUMMARY_MAX_CHARS / 2 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

/** Every entry passes this gate or is dropped — the source-URL rule is the
    same fact-grounding discipline as content/ (CLAUDE.md gate 3.2). */
function validEntry(e) {
  return Boolean(e.id && e.title && e.summary && e.sourceUrl && e.sourceName && e.category)
}

// --- Sources (each returns entries; each failure is isolated) ---------------

async function usgsQuakes() {
  const data = await getJson(
    'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_day.geojson'
  )
  return (data.features ?? [])
    .filter((f) => (f.properties?.mag ?? 0) >= MAG_FLOOR && f.geometry?.coordinates)
    .slice(0, QUAKE_CAP)
    .map((f) => ({
      id: `usgs-${f.id}`,
      date: new Date(f.properties.time).toISOString(),
      category: 'earthquake',
      title: `M${f.properties.mag.toFixed(1)} earthquake — ${f.properties.place}`,
      summary: sanitize(
        `A magnitude ${f.properties.mag.toFixed(1)} earthquake struck ${f.properties.place}.`
      ),
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      bodyId: 'earth',
      sourceName: 'USGS',
      sourceUrl: f.properties.url,
      magnitude: f.properties.mag,
      kidSuitable: true,
    }))
}

async function eonetEvents() {
  const data = await getJson('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=30')
  const out = []
  for (const ev of data.events ?? []) {
    const cat = ev.categories?.[0]
    const geo = ev.geometry?.at(-1)
    if (!cat || !EONET_CATEGORIES.has(cat.id) || !geo) continue
    const [lon, lat] = Array.isArray(geo.coordinates?.[0])
      ? geo.coordinates[0][0] // polygons: first vertex is anchor enough for a pin
      : geo.coordinates
    // Summary adds what the title lacks: event kind + how long it's been
    // tracked (first geometry = first observation) — critique 2026-07-02.
    const label = EONET_CATEGORY_LABEL[cat.id] ?? cat.title
    const firstSeen = ev.geometry?.[0]?.date
    const since = firstSeen && !Number.isNaN(new Date(firstSeen).getTime())
      ? SINCE_UTC.format(new Date(firstSeen))
      : null
    out.push({
      id: `eonet-${ev.id}`,
      date: geo.date ?? new Date().toISOString(),
      category: 'natural-event',
      title: sanitize(ev.title),
      summary: sanitize(
        since ? `${label} — ongoing, tracked since ${since}.` : `${label} — ongoing event.`
      ),
      lat,
      lon,
      bodyId: 'earth',
      sourceName: 'NASA EONET',
      sourceUrl: ev.link ?? `https://eonet.gsfc.nasa.gov/api/v3/events/${ev.id}`,
      kidSuitable: true,
    })
    if (out.length >= EVENT_CAP) break
  }
  return out
}

async function upcomingLaunches() {
  // mode=normal (not list): list mode omits the pad object, losing lat/lon —
  // and a launch pin on the globe is half the point. 1 call/day is far inside
  // LL2's free 15/hr budget.
  const data = await getJson(
    `https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=${LAUNCH_CAP}&mode=normal`
  )
  return (data.results ?? []).slice(0, LAUNCH_CAP).map((l) => {
    // Summary adds the when + where the title lacks instead of echoing
    // '<rocket> | <mission>' back (critique 2026-07-02). Mission name only
    // when the title doesn't already carry it.
    const padLoc = l.pad?.location?.name ?? l.location ?? 'Earth'
    const when = whenUTC(l.net)
    const mission = l.mission?.name
    const missionPart =
      mission && !String(l.name ?? '').includes(mission) ? ` — mission: ${mission}` : ''
    return {
      id: `ll2-${l.id}`,
      date: l.net,
      category: 'launch',
      title: sanitize(l.name),
      summary: sanitize(
        when
          ? `Lifts off ${when} from ${padLoc}${missionPart}.`
          : `Lifts off from ${padLoc}${missionPart}.`
      ),
      lat: l.pad?.latitude != null ? Number(l.pad.latitude) : null,
      lon: l.pad?.longitude != null ? Number(l.pad.longitude) : null,
      bodyId: 'earth',
      sourceName: 'Launch Library 2',
      sourceUrl: `https://spacelaunchnow.me/launch/${l.slug ?? l.id}`,
      startsAt: l.net,
      kidSuitable: true,
    }
  })
}

async function onThisDay() {
  const now = new Date()
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(now.getUTCDate()).padStart(2, '0')
  const data = await getJson(
    `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${mm}/${dd}`
  )
  // Lean toward science/space/exploration stories. Editorial tone gate: this
  // is a discovery hub, not a news ticker — violent-history items are dropped
  // entirely (not merely flagged), so a thin science day yields fewer entries
  // rather than grim ones.
  const SPACE_RX = /space|nasa|moon|mars|planet|astronom|rocket|satellite|telescope|cosmonaut|astronaut|eclipse|comet|discover|invent|science|physic/i
  const GRIM_RX = /kill|death|dead|massacre|stampede|war|attack|bomb|terror|assassin|execut|disaster|crash/i
  const events = (data.events ?? []).filter((e) => !GRIM_RX.test(e.text))
  const picked = [
    ...events.filter((e) => SPACE_RX.test(e.text)),
    ...events.filter((e) => !SPACE_RX.test(e.text)),
  ].slice(0, ONTHISDAY_CAP)
  return picked.map((e, i) => {
    const page = e.pages?.[0]
    return {
      id: `otd-${mm}${dd}-${e.year}-${i}`,
      date: now.toISOString(),
      category: 'on-this-day',
      title: sanitize(`${e.year}: ${e.text}`),
      summary: sanitize(page?.extract ?? e.text),
      lat: null,
      lon: null,
      bodyId: 'earth',
      sourceName: 'Wikipedia',
      sourceUrl: page?.content_urls?.desktop?.page ?? 'https://en.wikipedia.org/wiki/Portal:Current_events',
      kidSuitable: true,
    }
  })
}

// --- Assemble ---------------------------------------------------------------

const SOURCES = [
  ['usgs', usgsQuakes],
  ['eonet', eonetEvents],
  ['launches', upcomingLaunches],
  ['on-this-day', onThisDay],
]

const entries = []
let okSources = 0
for (const [name, fn] of SOURCES) {
  try {
    const got = (await fn()).filter(validEntry)
    entries.push(...got)
    okSources++
    console.log(`${name}: ${got.length} entries`)
  } catch (err) {
    console.error(`${name}: FAILED (${err.message}) — contributing nothing`)
  }
}

if (okSources === 0) {
  console.error('all sources failed — refusing to write an empty feed')
  process.exit(1)
}

const feed = {
  schemaVersion: SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  date: new Date().toISOString().slice(0, 10),
  entries,
}

mkdirSync(dirname(OUT_FILE), { recursive: true })
writeFileSync(OUT_FILE, JSON.stringify(feed, null, 2))
console.log(`wrote ${OUT_FILE}: ${entries.length} entries from ${okSources}/${SOURCES.length} sources`)
