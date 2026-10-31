const express = require('express');
const Listing = require('../models/Listing');
const CityFetch = require('../models/CityFetch');
const { upsertListing } = require('../ingest/lib/upsert');
const { mayTriggerFetch, requireKey, HEADER: KEY_HEADER } = require('../middleware/ingestAuth');
const { consumeUiBudget } = require('../middleware/uiBudget');

const zillow = require('../ingest/zillow');
const airbnb = require('../ingest/airbnb');
const redfin = require('../ingest/redfin');
const furnishedfinder = require('../ingest/furnishedfinder');
const facebook = require('../ingest/facebook');
const { sweepArea } = require('../lib/sweepArea');

const router = express.Router();

// ─── On-demand cache policy ────────────────────────────────────────────
// Data is pulled when someone searches, not on a schedule: a search for a city
// older than this re-scrapes it. Lower = fresher, but every re-scrape spends
// HasData credits and ~$0.40 of Apify credit, so set CACHE_TTL_HOURS with the
// plan's budget in mind.
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_HOURS) || 24) * 60 * 60 * 1000;
const FETCH_BUDGET_MS = 20_000;               // how long a user waits, at most

// ─── Metro search ──────────────────────────────────────────────────────
// Searching a city by name alone orphans its suburbs: a Denver scrape returns
// listings in Aurora, which are then invisible to a Denver search AND register
// as an uncached city of their own. Radius search on the 2dsphere index fixes
// both at once.
const DEFAULT_RADIUS_KM = 40;                 // ~25 miles, a metro commute
const MAX_RADIUS_KM = 160;
const EARTH_RADIUS_KM = 6378.1;

// Seed centroids so radius search works on the first request for these cities,
// before any listing exists to average. Everything else derives its centroid
// from the listings actually ingested — no geocoding dependency required.
const CITY_SEEDS = {
  'seattle|WA':  [-122.3321, 47.6062],
  'portland|OR': [-122.6765, 45.5152],
  'denver|CO':   [-104.9903, 39.7392],
  'austin|TX':   [-97.7431, 30.2672],
  'boise|ID':    [-116.2023, 43.6150],
  'tucson|AZ':   [-110.9747, 32.2226],
};

// ─── Two tiers, split by how long they take ────────────────────────────
// FAST sources return rows inline and finish in ~5s, so the request waits for
// them. FurnishedFinder goes through an Apify actor that spends most of half a
// minute pulling a container image before it scrapes anything — waiting on
// that would make every cold search feel broken.
const FAST_SOURCES = [
  ['Zillow', zillow],
  ['Airbnb', airbnb],
  ['Redfin', redfin],
];

// Apify actors: ~30s of container pull before they scrape anything, so they
// cannot sit on a user's request.
//
// Facebook Marketplace used to be excluded: the old crawlerbros actor took
// ~199s for 25 listings (2026-08-27). Apify's own actor, which replaced it in
// 2026-10, does 20 listings with details in well under a minute, so it now runs
// on demand like FurnishedFinder. It is capped at 20 because it is the priciest
// source (~$0.25 per city); ON_DEMAND_FACEBOOK=false turns it off to save the
// Apify credit for FurnishedFinder, the source with real short-lease data.
const SLOW_SOURCES = [
  ['FurnishedFinder', furnishedfinder, { maxItems: 100 }],
  ...(process.env.ON_DEMAND_FACEBOOK === 'false'
    ? []
    : [['FacebookMarketplace', facebook, { maxItems: 20 }]]),
];

// Sources scrape a metro, not a city limit — Seattle returns Kent and Everett —
// so the post-scrape sweep covers a little more than the search radius.
const SWEEP_RADIUS_KM = 60;

// After a source has just returned listings for a city, retire that source's
// listings there that it has not shown for a week. Never throws: it runs after
// the user's data is already saved and must not turn a good fetch into an error.
async function sweepAfterFetch(location, platforms) {
  if (platforms.length === 0) return;
  try {
    const centroid = await resolveCentroid(location);
    const retired = await sweepArea({ coordinates: centroid?.coordinates, radiusKm: SWEEP_RADIUS_KM, platforms });
    if (retired > 0) {
      console.log(`[sweep] ${location.city}, ${location.state} — retired ${retired} listing(s) gone from ${platforms.join(', ')}`);
    }
  } catch (err) {
    console.error(`[sweep] ${location.city} failed (continuing): ${err.message}`);
  }
}

// In-flight fetches, keyed by city. Without this, ten users searching a cold
// "Austin, TX" at once fire thirty scrapes and pay thirty times for one result.
// They now all await the same promise.
const inFlight = new Map();

// The detached tier gets its own tracker. It outlives the request that started
// it, so it cannot share the fast tier's lifecycle.
const slowInFlight = new Map();

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Accepts ?city=Austin&state=TX and ?city=Austin,%20TX alike.
function parseLocation(cityParam, stateParam) {
  const raw = String(cityParam || '').trim();
  if (!raw) return null;

  if (stateParam) {
    return { city: raw, state: String(stateParam).trim().toUpperCase() };
  }

  const [city, state] = raw.split(',').map((s) => s.trim());
  return { city, state: state ? state.toUpperCase() : '' };
}

// Cities are stored as the source spells them ("Seattle"), so match without
// case sensitivity and anchor it — a bare substring match would let "York"
// pull back every listing in New York.
function cityMatcher(city) {
  return new RegExp(`^${escapeRegex(city)}$`, 'i');
}

// "Seattle" and "Seattle, WA" are the same city and must share one cache
// entry — otherwise each spelling scrapes and pays separately. If a state was
// omitted but we have fetched this city before with one, adopt it: it unifies
// the cache key and gives the scrapers a more precise keyword.
async function resolveLocation(location) {
  if (location.state) return location;

  const known = await CityFetch.findOne({
    city:  location.city.toLowerCase(),
    state: { $ne: '' },
  }).sort({ lastFetchedAt: -1 });

  return known ? { city: location.city, state: known.state } : location;
}

// Where is this city, in [longitude, latitude]?
//
// Three sources, cheapest first — deliberately no geocoding package. Once a
// city has been scraped once we already hold hundreds of coordinates for it,
// which is a better centroid than any external lookup and costs nothing.
//
//   1. the centroid stored on the fetch log
//   2. the seed table, for a city we have never ingested
//   3. the median of that city's own listings, then cached back to the log
async function resolveCentroid({ city, state }) {
  const key = `${city.toLowerCase()}|${state}`;

  const log = await CityFetch.findOne({ city: city.toLowerCase(), state });
  if (log?.centroid?.coordinates?.length === 2) {
    return { coordinates: log.centroid.coordinates, source: 'cached' };
  }

  if (CITY_SEEDS[key]) return { coordinates: CITY_SEEDS[key], source: 'seed' };

  // Median, not mean: one listing mis-geocoded to the middle of the ocean
  // would drag an average far enough to break the whole radius.
  const points = await Listing.find({ city: cityMatcher(city) })
    .select('location.coordinates')
    .limit(500)
    .lean();

  if (points.length === 0) return null;

  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  const coordinates = [
    median(points.map((p) => p.location.coordinates[0])),
    median(points.map((p) => p.location.coordinates[1])),
  ];

  // Persist so the next search skips the aggregation entirely.
  await CityFetch.updateOne(
    { city: city.toLowerCase(), state },
    { $set: { centroid: { type: 'Point', coordinates } } },
    { upsert: false }
  );

  return { coordinates, source: 'derived' };
}

// Cache warmth is decided ONLY by the fetch log — never by how many listings
// survive in the collection.
//
// Listing count is the wrong signal because the sweep legitimately empties a
// city: if nobody searched Denver for a week its listings go stale and get
// deactivated, and a count-based rule would then re-scrape for 15 credits on
// the next search even though we fetched two hours ago. Zero active listings
// after a recent fetch means the city is genuinely empty, not that the cache
// is cold. The count is still reported for observability; it just does not vote.
async function isCityCold({ city, state }) {
  const [count, log] = await Promise.all([
    Listing.countDocuments({ city: cityMatcher(city), isActive: true }),
    CityFetch.findOne({ city: city.toLowerCase(), state }),
  ]);

  if (!log) return { cold: true, reason: 'never fetched', count };

  const lastFetchedAt = log.lastFetchedAt;
  if (Date.now() - lastFetchedAt.getTime() > CACHE_TTL_MS) {
    return { cold: true, reason: 'stale', count, lastFetchedAt };
  }

  // One exception to "the log is the truth": a fetch where EVERY source failed
  // proves nothing about the city. Without this, a single window of expired
  // HasData credits would mark a city warm-and-empty for a full day.
  const failed = log.lastResult?.failed || [];
  if (failed.length >= FAST_SOURCES.length) {
    return { cold: true, reason: 'last fetch failed on every source', count, lastFetchedAt };
  }

  return { cold: false, reason: 'fresh', count, lastFetchedAt };
}

// ─── The detached tier ─────────────────────────────────────────────────
// Fire and forget. Nothing awaits this: it writes to MongoDB through the same
// upsertListing path as every other source, so its listings land the moment
// the Apify run finishes, whether or not any request is still open.
//
// The promise is never returned to a request handler, which makes error
// handling load-bearing rather than tidy — an un-awaited rejection is an
// unhandledRejection, and Node terminates the process on those by default.
// Every branch below resolves.
function startSlowFetch({ city, state }) {
  // Both slow actors need city AND state as separate values and throw without
  // both, so a stateless search skips this tier rather than paying for runs
  // that cannot succeed.
  if (!state) {
    console.warn(`[detached] skipping slow sources for "${city}" — no state supplied`);
    return;
  }

  for (const [name, mod, options] of SLOW_SOURCES) {
    // Tracked per SOURCE, not per city. The two actors finish independently,
    // so one key per city would let whichever returned last overwrite the
    // other's result — and would stop the second from starting at all.
    const key = `${cacheKey({ city, state })}|${name}`;
    if (slowInFlight.has(key)) continue;

    const startedAt = Date.now();
    slowInFlight.set(key, { startedAt, source: name });

    const record = (patch) =>
      CityFetch.updateOne(
        { city: city.toLowerCase(), state },
        { $set: { [`slowFetch.${name}`]: { source: name, startedAt: new Date(startedAt), ...patch } } },
        { upsert: true }
      ).catch((err) => console.error(`[detached] ${name}: could not record status:`, err.message));

    record({ status: 'running' });

    mod
      .ingestCity(city, state, { ...options, quiet: true })
      .then((result) => {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(
          `[detached] ${name} ${city}, ${state} — +${result.created} new, ` +
          `${result.updated} refreshed, ${result.skipped} skipped, ${elapsed}s`
        );
        if (result.created + result.updated > 0) sweepAfterFetch({ city, state }, [name]);
        return record({
          status: 'complete',
          finishedAt: new Date(),
          created: result.created,
          updated: result.updated,
        });
      })
      .catch((err) => {
        console.error(`[detached] ${name} failed for ${city}, ${state}: ${err.message}`);
        return record({ status: 'failed', finishedAt: new Date(), error: err.message });
      })
      .finally(() => slowInFlight.delete(key));
  }
}

// Aggregate across every slow source, plus the per-source detail.
// `status` stays a single string because the frontend polls it directly:
// running if ANY source is still working.
function slowFetchState(location) {
  const prefix = `${cacheKey(location)}|`;
  const sources = {};

  for (const [key, entry] of slowInFlight) {
    if (!key.startsWith(prefix)) continue;
    sources[entry.source] = { status: 'running', elapsedMs: Date.now() - entry.startedAt };
  }

  if (Object.keys(sources).length === 0) return null;
  return { status: 'running', sources };
}

// Runs the fast sources for one city. Deliberately allSettled, not all: if
// Zillow returns 402 because credits ran out, the user should still get the
// Airbnb and Redfin results rather than a 500.
async function fetchCity({ city, state }) {
  const started = Date.now();

  // Started BEFORE the fast tier is awaited, not after. The container pull is
  // the bulk of its runtime, so overlapping it with the ~5s fast tier is free.
  startSlowFetch({ city, state });

  const settled = await Promise.allSettled(
    FAST_SOURCES.map(([, mod]) => mod.ingestCity(city, state, { quiet: true }))
  );

  const result = { created: 0, updated: 0, failed: [] };
  const returnedListings = []; // sources that proved alive, so may be swept

  settled.forEach((outcome, i) => {
    const [name] = FAST_SOURCES[i];
    if (outcome.status === 'fulfilled') {
      result.created += outcome.value?.created || 0;
      result.updated += outcome.value?.updated || 0;
      if ((outcome.value?.created || 0) + (outcome.value?.updated || 0) > 0) returnedListings.push(name);
    } else {
      result.failed.push(name);
      console.warn(`[on-demand] ${name} failed for ${city}: ${outcome.reason?.message}`);
    }
  });

  // Record the ATTEMPT regardless of yield, so a city with no inventory is not
  // re-scraped on every subsequent search.
  await CityFetch.findOneAndUpdate(
    { city: city.toLowerCase(), state },
    {
      $set: { lastFetchedAt: new Date(), lastResult: result },
      $inc: { fetchCount: 1 },
    },
    { upsert: true, new: true }
  );

  await sweepAfterFetch({ city, state }, returnedListings);

  const elapsedMs = Date.now() - started;
  console.log(
    `[on-demand] ${city}${state ? ', ' + state : ''} — ` +
    `+${result.created} new, ${result.updated} refreshed, ${elapsedMs}ms` +
    (result.failed.length ? ` (failed: ${result.failed.join(', ')})` : '')
  );

  return { ...result, elapsedMs };
}

function cacheKey({ city, state }) {
  return `${city.toLowerCase()}|${state}`;
}

// What, if anything, is currently being fetched for this city. Lets a polling
// client tell "still working" apart from "finished and found nothing".
function fetchState(location) {
  const entry = inFlight.get(cacheKey(location));
  if (!entry) return { inProgress: false };
  return { inProgress: true, elapsedMs: Date.now() - entry.startedAt };
}

// Starts a background fetch, or joins the one already running. Never rejects:
// the returned promise is deliberately not awaited by the request handler, and
// an un-awaited rejection is an unhandledRejection that can take the process
// down. Every failure path resolves to a result object instead.
function startFetch(location) {
  const key = cacheKey(location);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const startedAt = Date.now();
  const promise = fetchCity(location)
    .catch((err) => {
      console.error(`[on-demand] ${location.city} fetch failed outright:`, err.message);
      return { created: 0, updated: 0, failed: ['*'], error: err.message };
    })
    .finally(() => inFlight.delete(key));

  const entry = { promise, startedAt };
  inFlight.set(key, entry);
  return entry;
}

// Optional grace period. The default is not to wait at all, but a UI wanting a
// populated first paint for a brand-new city can ask for a few seconds via
// ?wait=. Either way the fetch continues in the background afterwards.
async function waitUpTo(promise, ms) {
  if (ms <= 0) return { timedOut: true };

  let timer;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });

  const outcome = await Promise.race([promise.then((value) => ({ value })), budget]);
  clearTimeout(timer);
  return outcome;
}

// ─── Ranking ───────────────────────────────────────────────────────────
// "Best" for an intern is not "cheapest". A $600 room on a 12-month lease is
// useless to someone here for a summer, so lease length dominates the score
// and price is only a tiebreaker.
//
// Unknown lease ranks BETWEEN confirmed-short and confirmed-long: it might
// work, so it should not be buried, but it must not outrank a listing that
// actually publishes a 30-day minimum. Most of the catalogue is unknown, so
// getting this order wrong would bury the entire reason the product exists.
const LEASE_SHORT_DAYS = 31;
const LEASE_MEDIUM_DAYS = 92;
const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Great-circle distance in km from the office to each listing, computed in the
// pipeline. $geoNear would do this natively, but it must be the first stage and
// cannot be combined with the $geoWithin that radius and map-area search use.
function distanceKmExpr([officeLng, officeLat]) {
  const toRad = (v) => ({ $degreesToRadians: v });
  const lng = { $arrayElemAt: ['$location.coordinates', 0] };
  const lat = { $arrayElemAt: ['$location.coordinates', 1] };
  const dLat = { $subtract: [toRad(lat), toRad(officeLat)] };
  const dLng = { $subtract: [toRad(lng), toRad(officeLng)] };
  const halfChord = {
    $add: [
      { $pow: [{ $sin: { $divide: [dLat, 2] } }, 2] },
      { $multiply: [Math.cos(officeLat * Math.PI / 180), { $cos: toRad(lat) }, { $pow: [{ $sin: { $divide: [dLng, 2] } }, 2] }] },
    ],
  };
  return { $multiply: [2 * EARTH_RADIUS_KM, { $asin: { $sqrt: { $min: [halfChord, 1] } } }] };
}

function rankingStages({ office } = {}) {
  return [
    {
      $addFields: {
        // Programs that publish no price sort after every priced listing under
        // "Price: low to high" — BSON puts null FIRST in an ascending sort.
        _priceSort: { $ifNull: ['$pricePerMonth', Number.MAX_SAFE_INTEGER] },
        ...(office ? { _distanceKm: distanceKmExpr(office) } : {}),
      },
    },
    {
      $addFields: {
        _leaseScore: {
          $switch: {
            branches: [
              // Null MUST be tested first: in BSON ordering null sorts below
              // every number, so { $lte: [null, 31] } is true and an unknown
              // lease would otherwise score as if it were a 30-day minimum.
              { case: { $eq: [{ $ifNull: ['$minimumLeaseDays', null] }, null] }, then: 1 },
              { case: { $lte: ['$minimumLeaseDays', LEASE_SHORT_DAYS] }, then: 3 },
              { case: { $lte: ['$minimumLeaseDays', LEASE_MEDIUM_DAYS] }, then: 2 },
            ],
            default: 0, // 12-month leases sink
          },
        },
        _freshScore: {
          $cond: [{ $gte: ['$lastSeenAt', new Date(Date.now() - FRESH_WINDOW_MS)] }, 1, 0],
        },
      },
    },
    {
      $addFields: {
        _score: {
          $add: [
            { $multiply: ['$_leaseScore', 4] },        // lease dominates
            { $cond: ['$isFurnished', 2, 0] },         // interns don't ship furniture
            '$_freshScore',                            // recently confirmed live
          ],
        },
      },
    },
  ];
}

// _id is the final key in every sort. Without a unique tiebreaker, documents
// with equal scores can be returned in a different order per query, which makes
// page 2 silently repeat or skip listings from page 1.
const SORT_MODES = {
  best:    { _score: -1, _priceSort: 1, _id: 1 },
  price:   { _priceSort: 1, _id: 1 },
  newest:  { firstSeenAt: -1, _id: 1 },
  // Only meaningful with ?office=; without it the route falls back to best.
  commute: { _distanceKm: 1, _id: 1 },
};

// ?office=lng,lat — where the intern works. Validated here because it feeds
// trigonometry in the pipeline, where a bad value fails the whole query.
function parseOffice(raw) {
  if (!raw) return null;
  const point = String(raw).split(',').map(Number);
  if (point.length !== 2 || !point.every(Number.isFinite)) return null;
  const [lng, lat] = point;
  return Math.abs(lng) <= 180 && Math.abs(lat) <= 90 ? point : null;
}

// ?moveIn=YYYY-MM-DD&moveOut=YYYY-MM-DD — the internship dates.
function parseStay(moveIn, moveOut) {
  const start = moveIn ? new Date(`${moveIn}T00:00:00Z`) : null;
  const end = moveOut ? new Date(`${moveOut}T00:00:00Z`) : null;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  return { start, end, nights: Math.round((end - start) / (24 * 60 * 60 * 1000)) };
}

// Airbnb's availableFrom/availableTo are the 30-night window we SEARCHED, not
// the host's real availability, so they say nothing about a stay months away.
const PLATFORMS_WITHOUT_REAL_DATES = ['Airbnb'];
const MILES_TO_KM = 1.609344;

// ─── Query building ────────────────────────────────────────────────────
// ?bounds=west,south,east,north in degrees. Rejected rather than clamped when
// malformed or wider than a hemisphere: a GeoJSON polygon that wide is
// ambiguous about which side of the globe it encloses.
function parseBounds(raw) {
  if (!raw) return null;
  const box = String(raw).split(',').map(Number);
  if (box.length !== 4 || !box.every(Number.isFinite)) return null;

  const [w, s, e, n] = box;
  if (w >= e || s >= n || e - w >= 180 || s < -90 || n > 90) return null;
  return box;
}

// Minimal shape for map pins — the map plots every match, not just one page,
// so it must not haul images and amenity arrays for hundreds of listings.
const PIN_PROJECTION = {
  _id: 1, location: 1, pricePerMonth: 1, minimumLeaseDays: 1, bedrooms: 1,
  spaceType: 1, originalPlatform: 1, _score: 1, _distanceKm: 1,
};
const MAX_PINS = 500;

function buildQuery(params, location, centroid, radiusKm) {
  const {
    minPrice, maxPrice, minBedrooms, isFurnished, spaceType,
    propertyType, maxMinimumLeaseDays, platform, enriched,
  } = params;

  const query = { isActive: true };

  // The visible map rectangle wins over the city radius: once the user drags
  // the map, the viewport is the search area — the same model as Zillow's
  // "search as I move the map".
  const box = parseBounds(params.bounds);
  if (box) {
    const [w, s, e, n] = box;
    query.location = {
      $geoWithin: {
        $geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
      },
    };
  } else if (location) {
    if (centroid && radiusKm > 0) {
      // $geoWithin/$centerSphere rather than $near: it imposes no implicit
      // sort, and unlike $near it composes with $and, which the lease filter
      // below needs. Radius is in radians — hence the division by Earth's.
      query.location = {
        $geoWithin: { $centerSphere: [centroid.coordinates, radiusKm / EARTH_RADIUS_KM] },
      };
    } else {
      // No centroid yet (a city we have never ingested), or radiusKm=0 for a
      // deliberate exact-city search.
      query.city = cityMatcher(location.city);
    }
  }
  if (platform) query.originalPlatform = platform;
  if (enriched === 'false') query.enrichedAt = null;
  if (enriched === 'true') query.enrichedAt = { $ne: null };

  if (minPrice) query.pricePerMonth = { ...query.pricePerMonth, $gte: Number(minPrice) };
  if (maxPrice) query.pricePerMonth = { ...query.pricePerMonth, $lte: Number(maxPrice) };
  if (minBedrooms) query.bedrooms = { $gte: Number(minBedrooms) };
  if (isFurnished !== undefined) query.isFurnished = isFurnished === 'true';
  if (spaceType) query.spaceType = spaceType;
  if (propertyType) query.propertyType = propertyType;

  // Treat an absent minimumLeaseDays as UNRESTRICTED, not as a non-match.
  // Redfin and Airbnb search endpoints never expose lease length, so a plain
  // { $lte: X } would filter out most of the database on the one query interns
  // care about most. In MongoDB, { field: null } also matches missing fields.
  if (maxMinimumLeaseDays) {
    query.$and = [
      ...(query.$and || []),
      {
        $or: [
          { minimumLeaseDays: { $lte: Number(maxMinimumLeaseDays) } },
          { minimumLeaseDays: null },
        ],
      },
    ];
  }

  // Internship dates. A listing fits when it is free by move-in, stays free
  // through move-out, and its minimum stay is no longer than the internship.
  // As with lease length, an unknown value never excludes a listing — most
  // sources publish no end date, and hiding them would empty the results.
  const stay = parseStay(params.moveIn, params.moveOut);
  if (stay) {
    const realDates = { originalPlatform: { $in: PLATFORMS_WITHOUT_REAL_DATES } };
    query.$and = [
      ...(query.$and || []),
      { $or: [realDates, { availableFrom: { $lte: stay.start } }, { availableFrom: null }] },
      { $or: [realDates, { availableTo: { $gte: stay.end } }, { availableTo: null }] },
      { $or: [{ minimumLeaseDays: { $lte: stay.nights } }, { minimumLeaseDays: null }] },
    ];
  }

  return query;
}

// ─── GET /api/listings/status — poll a background fetch ────────────────
//
// Cheap counterpart to the search: tells a client whether a city's fetch is
// still running, so "still working" is distinguishable from "finished, found
// nothing". Declared before GET / so the path is not shadowed.
router.get('/status', async (req, res) => {
  try {
    const parsed = parseLocation(req.query.city, req.query.state);
    if (!parsed) return res.status(400).json({ error: 'city is required' });

    const location = await resolveLocation(parsed);
    const [{ cold, reason, count }, log] = await Promise.all([
      isCityCold(location),
      CityFetch.findOne({ city: location.city.toLowerCase(), state: location.state }).lean(),
    ]);

    // Live in-memory state wins PER SOURCE; the persisted record fills in how
    // each of the others last ended, and is the only answer after a restart.
    const live = slowFetchState(location);
    const persisted = (log?.slowFetch && typeof log.slowFetch === 'object') ? log.slowFetch : {};
    const sources = { ...persisted, ...(live?.sources || {}) };

    const slowFetch = {
      // A single string, because the frontend polls this directly: running if
      // ANY slow source is still working.
      status: live ? 'running' : (Object.keys(sources).length > 0 ? 'complete' : 'idle'),
      sources,
    };

    res.json({
      city:  location.city,
      state: location.state || null,
      count,
      cache: cold ? `miss (${reason})` : 'hit',
      fetch: fetchState(location),
      // The detached tier (FurnishedFinder + Facebook Marketplace). Poll this:
      // when status flips from "running" to "complete", re-issue the search
      // with noFetch=true and the new listings will be there.
      slowFetch,
      retryAfterMs: slowFetch.status === 'running' ? 5000 : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/listings — search, populating the cache on demand ────────
//
//   /api/listings?city=Austin&state=TX&maxPrice=2000&maxMinimumLeaseDays=90
//
// A miss starts a live scrape of every source for that city IN THE BACKGROUND
// and responds immediately with whatever the cache holds. meta.fetch says
// whether one is running; poll GET /status or re-issue the search to pick up
// the results.
//
// Triggering that scrape costs HasData credits, so it requires the
// x-aggregator-key header. Without it the search still works — it is simply
// served from cache and can never spend money.
//
//   ?wait=3000     block up to 3s for a populated first paint (default 0)
//   ?noFetch=true  cache only, never triggers a scrape — use for pagination
router.get('/', async (req, res) => {
  try {
    const parsed = parseLocation(req.query.city, req.query.state);
    const location = parsed ? await resolveLocation(parsed) : null;
    const pinsView = req.query.view === 'pins';
    const limit = Math.min(Number(req.query.limit) || 50, pinsView ? MAX_PINS : 200);

    // Opt-in grace period, capped. Default 0 — the fetch runs in the background
    // and the response goes out immediately.
    const wait = Math.min(Math.max(Number(req.query.wait) || 0, 0), FETCH_BUDGET_MS);

    const meta = { city: location?.city || null, cache: 'not-applicable' };

    if (location && req.query.noFetch !== 'true') {
      const { cold, reason, count, lastFetchedAt } = await isCityCold(location);
      meta.cache = cold ? `miss (${reason})` : 'hit';
      meta.cachedCount = count;
      meta.lastFetchedAt = lastFetchedAt || null;

      if (cold) {
        // Two ways to earn a fetch:
        //   1. the aggregator key — unmetered, for the CLI and server-to-server
        //   2. the UI budget — unauthenticated but capped, so the browser can
        //      populate a new city without ever holding the key
        // Budget is consumed only here, at the moment a scrape actually starts.
        const auth = mayTriggerFetch(req);
        const permit = auth.allowed ? auth : consumeUiBudget(req);

        if (!permit.allowed) {
          meta.fetch = {
            status: 'not-authorized',
            reason: permit.reason,
            hint: `Send ${KEY_HEADER}, or wait for the budget window to reset.`,
          };
        } else {
          meta.fetchAuthorizedVia = auth.allowed ? 'key' : 'ui-budget';
          // Fire and forget. Stale-while-revalidate falls out of this: a city
          // with plenty of listings that is merely past its TTL serves instantly
          // from cache and refreshes behind the request.
          const { promise } = startFetch(location);
          const outcome = await waitUpTo(promise, wait);

          meta.fetch = outcome.timedOut
            ? { status: 'in-progress', ...fetchState(location), retryAfterMs: 5000 }
            : { status: 'complete', result: outcome.value };
        }
      } else {
        meta.fetch = { status: 'idle' };
      }

      // The detached tier outlives this request either way, so report it
      // whenever one is running — including on a cache hit, where a previous
      // request's FurnishedFinder run may still be in flight.
      const slow = slowFetchState(location);
      if (slow) meta.slowFetch = { ...slow, retryAfterMs: 5000 };
    } else if (location) {
      meta.cache = 'bypassed';
      meta.fetch = fetchState(location);
    }

    // Metro radius. radiusKm=0 opts back into exact-city matching.
    const requestedRadius = req.query.radiusKm !== undefined
      ? Number(req.query.radiusKm)
      : DEFAULT_RADIUS_KM;
    const radiusKm = Math.min(Math.max(Number.isFinite(requestedRadius) ? requestedRadius : DEFAULT_RADIUS_KM, 0), MAX_RADIUS_KM);

    let centroid = null;
    if (location && radiusKm > 0) {
      centroid = await resolveCentroid(location);
      meta.search = centroid
        ? { mode: 'radius', radiusKm, centroid: centroid.coordinates, centroidFrom: centroid.source }
        : { mode: 'city-name', note: 'no centroid known yet; radius search begins after the first ingest' };
    } else if (location) {
      meta.search = { mode: 'city-name', note: 'radiusKm=0 requested' };
    }

    const query = buildQuery(req.query, location, centroid, radiusKm);

    // Commute: distance from the intern's office, optional cap in miles.
    const office = parseOffice(req.query.office);
    const maxCommuteMiles = Number(req.query.maxCommuteMiles);
    const commuteStages = office && maxCommuteMiles > 0
      ? [{ $match: { _distanceKm: { $lte: maxCommuteMiles * MILES_TO_KM } } }]
      : [];

    const sortName = req.query.sort === 'commute' && !office ? 'best' : req.query.sort;
    const sort = SORT_MODES[sortName] || SORT_MODES.best;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    // $facet runs the page and the total count over one $match, so pagination
    // costs a single round trip rather than a query plus a countDocuments.
    const [facet] = await Listing.aggregate([
      { $match: query },
      ...rankingStages({ office }),
      ...commuteStages,
      {
        $facet: {
          rows: [
            { $sort: sort },
            { $skip: skip },
            { $limit: limit },
            // rawSource is the entire original scraped payload — tens of KB per
            // listing. It has no business crossing the wire to a browser.
            { $project: pinsView ? PIN_PROJECTION : { rawSource: 0, _leaseScore: 0, _freshScore: 0, _priceSort: 0 } },
          ],
          total: [{ $count: 'n' }],
        },
      },
    ]);

    const listings = facet.rows;
    const total = facet.total[0]?.n || 0;

    meta.sort = sortName && SORT_MODES[sortName] ? sortName : 'best';
    meta.page = {
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
      hasMore: skip + listings.length < total,
    };

    res.json({ count: listings.length, total, meta, listings });
  } catch (err) {
    console.error('[search] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/listings/:id — one listing, for the detail view ──────────
// A map pin carries only the pin projection, so opening it needs the rest.
router.get('/:id', async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id).select('-rawSource').lean();
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    res.json(listing);
  } catch (err) {
    if (err.name === 'CastError') return res.status(404).json({ error: 'Listing not found' });
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/listings — create a listing ─────────────────────────────
//
// ?upsert=true refreshes an existing listing instead of returning 409. Opt-in:
// without it the endpoint keeps strict-create semantics for every other caller.
//   201 = created · 200 = refreshed · 409 = exists (non-upsert mode)
router.post('/', requireKey, async (req, res) => {
  const upsert = req.query.upsert === 'true';

  try {
    if (!upsert) {
      const listing = await Listing.create(req.body);
      return res.status(201).json(listing);
    }

    const { status, listing, previousPrice } = await upsertListing(req.body);
    if (previousPrice != null) res.set('X-Previous-Price', String(previousPrice));
    return res.status(status === 'created' ? 201 : 200).json(listing);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Listing already exists', keyValue: err.keyValue });
    }
    if (err.name === 'ValidationError' || err.name === 'CastError') {
      return res.status(400).json({ error: 'Validation failed', details: err.errors || err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/listings/:id — apply enrichment ────────────────────────
//
// Whitelisted on purpose. Enrichment must never rewrite identity or location:
// originalPlatform/originalId are the dedupe key, and letting a detail call
// move a listing's coordinates would silently corrupt geo search.
const ENRICHABLE_FIELDS = new Set([
  'minimumLeaseDays', 'availableFrom', 'availableTo', 'isFurnished',
  'hasInUnitLaundry', 'hasAirConditioning', 'hasParking', 'petsAllowed',
  'amenitiesRaw', 'depositAmount', 'utilitiesIncluded', 'squareFeet',
  'bedrooms', 'bathrooms', 'enrichedAt',
]);

router.patch('/:id', requireKey, async (req, res) => {
  try {
    const updates = {};
    const rejected = [];

    for (const [key, value] of Object.entries(req.body)) {
      if (ENRICHABLE_FIELDS.has(key)) updates[key] = value;
      else rejected.push(key);
    }

    if (rejected.length > 0) {
      return res.status(400).json({
        error: 'Non-enrichable fields rejected',
        rejected,
        allowed: [...ENRICHABLE_FIELDS],
      });
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No enrichable fields supplied' });
    }

    updates.lastSeenAt = new Date();

    const listing = await Listing.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    res.json(listing);
  } catch (err) {
    if (err.name === 'ValidationError' || err.name === 'CastError') {
      return res.status(400).json({ error: 'Validation failed', details: err.errors || err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
