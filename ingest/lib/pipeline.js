require('dotenv').config();

// Shared ingestion machinery. Every source module supplies only the two
// things that are genuinely source-specific — how to FETCH a page, and how to
// NORMALIZE one raw record — and hands them to runIngest().
//
// This is the "same architecture" made literal: one loop, one set of
// 201/409/400 semantics, one place to fix a bug. Adding FurnishedFinder or
// Facebook Marketplace later means writing a fetch + a normalizer, nothing else.

const { upsertListing } = require('./upsert');

const HASDATA_API_KEY = process.env.HASDATA_API_KEY;

// ─── HasData concurrency gate ──────────────────────────────────────────
// The HasData plan caps concurrent requests (1 on the current plan). The
// search route fires Zillow, Airbnb and Redfin together, so without a gate
// two of the three get 429 concurrency_limit — and Zillow, the primary
// source, was routinely the one that lost. Requests queue here instead.
// Raise HASDATA_CONCURRENCY if the plan is upgraded.
const HASDATA_CONCURRENCY = Math.max(Number(process.env.HASDATA_CONCURRENCY) || 1, 1);
const HASDATA_MAX_RETRIES = 3;

let hasDataActive = 0;
const hasDataQueue = [];

async function withHasDataSlot(task) {
  if (hasDataActive >= HASDATA_CONCURRENCY) {
    await new Promise((resolve) => hasDataQueue.push(resolve));
  }
  hasDataActive++;
  try {
    return await task();
  } finally {
    hasDataActive--;
    hasDataQueue.shift()?.();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── HasData request wrapper ───────────────────────────────────────────
// All HasData scrapers share one auth scheme and one error vocabulary, so
// the failure messages live here rather than in triplicate.
//
// A 429 can still happen when another process (the CLI, enrich, a second
// server) holds the account's slot, so it is retried with backoff rather
// than failing the source outright.
async function hasDataFetchRaw(endpoint, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withHasDataSlot(() => hasDataRequest(endpoint, params));
    } catch (err) {
      if (err.status !== 429 || attempt >= HASDATA_MAX_RETRIES) throw err;
      await sleep(2000 * (attempt + 1));
    }
  }
}

async function hasDataRequest(endpoint, params) {
  if (!HASDATA_API_KEY) {
    throw new Error('HASDATA_API_KEY missing — add it to .env');
  }

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.append(key, String(value));
    }
  }

  const res = await fetch(`${endpoint}?${search}`, {
    headers: {
      'x-api-key': HASDATA_API_KEY,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(`HasData rejected the API key (${res.status}). Check HASDATA_API_KEY in .env — ${body}`);
    }
    if (res.status === 402) {
      throw new Error(`HasData credits exhausted (402). Top up at app.hasdata.com — ${body}`);
    }
    if (res.status === 422) {
      throw new Error(`HasData rejected the query params (422). Usually a missing required param — ${body}`);
    }
    if (res.status === 429) {
      const err = new Error(`HasData rate limit hit (429). Slow the loop down or retry later — ${body}`);
      err.status = 429;
      throw err;
    }
    throw new Error(`HasData fetch failed: ${res.status} ${res.statusText} — ${body}`);
  }

  return res.json();
}

// Most callers only want the listings array. Airbnb also needs the envelope
// (it paginates by opaque nextPageToken), so it uses hasDataFetchRaw directly.
function extractListings(data) {
  // Documented shape is { requestMetadata, properties: [...] } — stay defensive.
  return Array.isArray(data) ? data : (data.properties || data.listings || data.results || []);
}

async function hasDataFetch(endpoint, params) {
  return extractListings(await hasDataFetchRaw(endpoint, params));
}

// ─── Shared price parsing ──────────────────────────────────────────────
// Prices arrive as numbers on some sources and strings on others:
//   2500 · "$2,500/mo" · "$1,800 - $2,400/mo" · "$2,500+/mo" · "From $1,995"
// For a range we take the LOWER bound: it is what a maxPrice filter should
// match against, and it mirrors how the sites themselves sort.
// Redfin returns BUILDING-level ranges rather than unit values:
//   "price": { "min": 1420, "max": 2900 }, "beds": { "min": 1, "max": 2 }
// Unwrap to the min, consistent with the lower-bound rule above — the cheapest
// unit in a complex is also its smallest, so min price and min beds describe
// the same unit. The full range stays in rawSource.
function unwrapRange(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value.min ?? value.max ?? null;
  }
  return value;
}

function parsePriceNumber(raw) {
  const value = unwrapRange(raw);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;

  const matches = value.replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) return null;

  const n = Number(matches[0]);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// For plain numeric fields (beds/baths/sqft) that may also arrive as ranges.
// Anything unparseable becomes null rather than NaN, which Mongoose rejects.
function toNumber(raw) {
  const value = unwrapRange(raw);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ─── Shared property-type matching ─────────────────────────────────────
// Each source has its own vocabulary, but they all need the same thing:
// try patterns in order, fall back to 'Apartment' (most common urban rental).
// Ordered list, not a lookup table — Redfin sends "Single Family Residential"
// and Zillow sends "SINGLE_FAMILY", so substring matching beats exact keys.
function matchPropertyType(rawType, patterns) {
  if (!rawType) return 'Apartment';
  const text = String(rawType).toLowerCase().replace(/[^a-z]/g, '');

  for (const [pattern, mapped] of patterns) {
    if (pattern.test(text)) return mapped;
  }
  return 'Apartment';
}

// ─── Inferring details the search endpoints do not structure ───────────
// Zillow and Redfin bury furnishing and room-share signals in free text, so
// we scan the whole raw payload rather than hardcoding defaults.
//
// Two guards make this safe to run over an entire JSON blob:
//
// 1. Noisy keys are stripped first. URLs and image paths are full of slugs
//    like /furnished-apartments-seattle/, and broker names like "Furnished
//    Finder Realty" would flag every one of their listings as furnished.
// 2. Room phrases must be specific. A bare /shared/ match is unusable —
//    "shared laundry", "shared walls", "shared driveway" and "shared outdoor
//    space" appear in a large share of ordinary whole-unit listings, and any
//    one of them would mislabel an entire apartment as a Shared Room.
const NOISE_KEYS = new Set([
  'url', 'detailUrl', 'virtualTourUrl', 'photos', 'photo', 'image', 'images',
  'imgSrc', 'brokerName', 'agentName', 'listingAgent', 'attributionInfo',
  'id', 'zpid', 'mlsId', 'propertyId',
]);

function buildHaystack(raw) {
  // The replacer drops noisy keys at every nesting level.
  return JSON.stringify(raw, (key, value) => (NOISE_KEYS.has(key) ? undefined : value)) || '';
}

// The noun after "shared" has to be a sleeping space. Anything looser matches
// "shared laundry" / "shared walls" / "shared driveway".
const SHARED_ROOM_RE = /\bshared\s+(room|bedroom|bed)\b|\bshare\s+a\s+(room|bedroom)\b|\broom\s+to\s+share\b|\broommate\s+wanted\b/i;

// Deliberately narrow. An earlier "room in a" branch matched "spacious room in
// a bright apartment" — a description of an ENTIRE unit — so only phrases that
// name the room itself as the thing being rented count.
const PRIVATE_ROOM_RE = /\bprivate\s+(room|bedroom)\b|\brooms?\s+for\s+rent\b|\broom\s+rental\b|\bsublet\s+a\s+room\b/i;

const AMENITY_PATTERNS = {
  hasInUnitLaundry:   /\bin.?unit laundry\b|\bwasher\s*(and|\/|&)?\s*dryer\b|\bw\/d in unit\b|\blaundry in unit\b|\bin.?unit w\/?d\b/i,
  hasAirConditioning: /\bair conditioning\b|\bcentral air\b|\bair.?conditioned\b|\bhvac\b|\ba\/c\b/i,
  hasParking:         /\bparking\b|\bgarage\b|\bcarport\b/i,
};

// "No parking" and "street parking only" are the common inversions.
const NEGATED_PARKING_RE = /\bno\s+(on.?site\s+)?parking\b|\bparking\s+not\s+(included|available)\b/i;

function inferPropertyDetails(raw) {
  const haystack = buildHaystack(raw);

  // "unfurnished" contains "furnished" — remove the negation before testing,
  // so "unfurnished" reads false while "unfurnished, can be furnished" reads true.
  const furnishText = haystack.replace(/\bunfurnished\b/gi, '');
  const isFurnished = /\bfurnished\b/i.test(furnishText);

  // Shared is checked first: it is the more specific claim of the two.
  let spaceType = 'Entire Place';
  if (SHARED_ROOM_RE.test(haystack)) spaceType = 'Shared Room';
  else if (PRIVATE_ROOM_RE.test(haystack)) spaceType = 'Private Room';

  const flags = {};
  for (const [flag, re] of Object.entries(AMENITY_PATTERNS)) {
    flags[flag] = re.test(haystack);
  }
  if (flags.hasParking && NEGATED_PARKING_RE.test(haystack)) flags.hasParking = false;

  return { isFurnished, spaceType, ...flags };
}

// Real amenity arrays, when a payload carries them, kept verbatim as a
// fallback for anything the flags above do not capture.
function collectAmenities(raw) {
  const list = [];
  for (const pool of [raw.amenities, raw.features, raw.tags, raw.homeFacts]) {
    if (Array.isArray(pool)) {
      for (const item of pool) {
        if (typeof item === 'string') list.push(item);
        else if (item && typeof item === 'object') {
          const label = item.factLabel || item.label || item.name;
          const value = item.factValue || item.value;
          if (label) list.push(value ? `${label}: ${value}` : String(label));
        }
      }
    } else if (typeof pool === 'string') {
      list.push(pool);
    }
  }
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
}

// ─── Pre-flight: catch missing SOURCE data before we POST ──────────────
// A 400 from our own API means the *mapping* is wrong, and should be loud.
// A listing the source never geocoded, or a card quoting "Call for pricing",
// is a data-quality skip — not a bug worth crashing a 40-item run over.
function findBlockingGaps(n) {
  const gaps = [];
  if (!n.originalId || n.originalId === 'undefined' || n.originalId === 'null') gaps.push('no id');
  if (n.pricePerMonth == null) gaps.push('no parseable price');
  if (!n.listingUrl) gaps.push('no listing url');

  const [lng, lat] = n.location?.coordinates || [];
  if (typeof lat !== 'number' || typeof lng !== 'number') gaps.push('no coordinates');

  return gaps;
}

// ─── The ingest loop ───────────────────────────────────────────────────
// fetchPage(page) -> { raws, context }   (context is passed to normalize)
// normalize(raw, context) -> a Listing-shaped object
// describeSkip(raw, gaps) is optional: a source can explain WHY a record is
// unusable when the bare gap list would be misleading. Zillow uses it to name
// building cards, which are skipped correctly but look like a failure at a
// glance when 80 of them scroll past as "no parseable price".
async function runIngest({ label, fetchPage, normalize, pages = 1, dryRun = false, describeSkip, quiet = false }) {
  let created = 0;
  let updated = 0;
  let priceChanges = 0;
  let skipped = 0;

  // Log the first few of each distinct reason, then summarize the rest.
  const skipTally = {};
  const SKIP_LOG_CAP = 3;

  const noteSkip = (id, reason) => {
    skipped++;
    skipTally[reason] = (skipTally[reason] || 0) + 1;
    if (!quiet && skipTally[reason] <= SKIP_LOG_CAP) {
      console.warn(`  ! Skipping ${id}: ${reason}`);
    } else if (!quiet && skipTally[reason] === SKIP_LOG_CAP + 1) {
      console.warn(`  ! ...further "${reason}" skips summarized below`);
    }
  };

  for (let page = 1; page <= pages; page++) {
    if (!quiet) console.log(`Fetching ${label} (page ${page})...`);
    const { raws, context = {} } = await fetchPage(page);
    console.log(`Received ${raws.length} raw listings.\n`);

    if (raws.length === 0) break;

    // First real run: eyeball the payload before trusting the mapping.
    if (dryRun) {
      console.log('── DRY RUN — nothing will be POSTed ────────────────────');
      console.log('Raw listing #1:\n', JSON.stringify(raws[0], null, 2));
      console.log(
        '\nNormalized #1:\n',
        JSON.stringify({ ...normalize(raws[0], context), rawSource: '[omitted]' }, null, 2)
      );
      return { created, updated, priceChanges, skipped };
    }

    for (const raw of raws) {
      let normalized;
      try {
        normalized = normalize(raw, context);
      } catch (err) {
        noteSkip(raw?.id, `normalization error — ${err.message}`);
        continue;
      }

      const gaps = findBlockingGaps(normalized);
      if (gaps.length > 0) {
        noteSkip(normalized.originalId, describeSkip?.(raw, gaps) || gaps.join(', '));
        continue;
      }

      // Direct Mongoose write — no HTTP hop. The search route calls ingestors
      // in-process, so round-tripping through our own API would add latency to
      // a request a user is already waiting on.
      const where = normalized.address || normalized.city || 'location withheld';

      try {
        const { status, previousPrice } = await upsertListing(normalized);

        if (status === 'created') {
          created++;
          if (!quiet) console.log(`  ✓ Created ${normalized.originalId} — $${normalized.pricePerMonth}/mo — ${where}`);
        } else {
          updated++;
          // Only announce a refresh that actually moved the asking price —
          // otherwise every re-run prints the entire catalogue back at you.
          if (previousPrice != null && previousPrice !== normalized.pricePerMonth) {
            priceChanges++;
            const arrow = normalized.pricePerMonth > previousPrice ? '↑' : '↓';
            if (!quiet) console.log(`  ${arrow} ${normalized.originalId} — $${previousPrice} → $${normalized.pricePerMonth}/mo — ${where}`);
          }
        }
      } catch (err) {
        // A validation failure means the MAPPING is wrong — loud, always.
        if (err.name === 'ValidationError' || err.name === 'CastError') {
          console.error('\n✗ SCHEMA VALIDATION FAILED');
          console.error('Payload:', JSON.stringify({ ...normalized, rawSource: '[omitted]' }, null, 2));
          console.error('Details:', JSON.stringify(err.errors || err.message, null, 2));
          throw new Error(`Schema validation failed for ${normalized.originalId} — see logs above`);
        }
        throw err;
      }
    }
  }

  console.log(
    `\nDone. Created: ${created} · Refreshed: ${updated}` +
    (priceChanges > 0 ? ` (${priceChanges} price change${priceChanges === 1 ? '' : 's'})` : '') +
    ` · Incomplete skipped: ${skipped}`
  );

  if (skipped > 0) {
    console.log('\nSkip breakdown:');
    for (const [reason, count] of Object.entries(skipTally).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)} × ${reason}`);
    }
  }

  return { created, updated, priceChanges, skipped, skipTally };
}

// ─── CLI plumbing shared by every source module ────────────────────────
function parseCliArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };

  return {
    keyword: valueOf('keyword'),
    // Some sources (FurnishedFinder) require city and state as separate
    // values rather than one combined search string.
    city:    valueOf('city'),
    state:   valueOf('state'),
    pages:   valueOf('pages') ? Number(valueOf('pages')) : 1,
    limit:   valueOf('limit') ? Number(valueOf('limit')) : undefined,
    checkIn: valueOf('checkIn'),
    nights:  valueOf('nights') ? Number(valueOf('nights')) : undefined,
    dryRun:  args.includes('--dry-run'),
  };
}

function handleFatal(err) {
  if (err.cause?.code === 'ECONNREFUSED' || err.code === 'ECONNREFUSED') {
    console.error('\n✗ Could not reach MongoDB — check MONGO_URI in .env');
  } else {
    console.error(err.message);
  }
  process.exit(1);
}

module.exports = {
  hasDataFetch,
  hasDataFetchRaw,
  extractListings,
  parsePriceNumber,
  toNumber,
  unwrapRange,
  matchPropertyType,
  inferPropertyDetails,
  collectAmenities,
  findBlockingGaps,
  runIngest,
  parseCliArgs,
  handleFatal,
};
