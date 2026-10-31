const mongoose = require('mongoose');
const { ensureConnection } = require('./lib/db');
const {
  parsePriceNumber,
  toNumber,
  matchPropertyType,
  inferPropertyDetails,
  collectAmenities,
  runIngest,
  parseCliArgs,
  handleFatal,
} = require('./lib/pipeline');

// ─── STATUS: live. Mapping confirmed against a real payload (Seattle, WA,
// ─── 2026-08-27, run zeeRgRypaz4Zxdxnj).
//
// Wired into routes/listings.js as the SLOW tier: started but never awaited,
// because an Apify run spends ~30s pulling a container before it scrapes
// anything. Its listings reach MongoDB through the same upsertListing path as
// every other source, independent of whatever request kicked it off.
//
// WHY THIS SOURCE MATTERS
// Of the listings currently held, zero publish a lease term of 90 days or
// less. Zillow is annual-lease inventory, Redfin exposes no lease field at
// all, and Airbnb's 30-day figure is our search window rather than a published
// minimum. FurnishedFinder targets travelling nurses on month-to-month
// furnished stays — the closest existing market to an intern — and its output
// includes an explicit `minimumStayDays`. It is the first source that could
// make the product's core claim true.

// crawlerbros/furnished-finder-scraper was unpublished 2026-10. Replacement
// chosen by trial run (Tucson, AZ, 2026-10-30) over five candidates: this one
// returned coordinates, minimum stay, photos and a listing URL in ~19s. Two
// others returned nothing (Cloudflare) or no coordinates, which is fatal here.
// azzouzana/furnishedfinder-scraper returns the same payload and is the
// fallback if this one disappears too — the normalizer reads both.
const ACTOR_ID = process.env.FURNISHEDFINDER_ACTOR_ID || 'datascrapers/furnishedfinder';
const APIFY_TOKEN = process.env.APIFY_TOKEN;

// The actor's own default is 20; keep probes small so schema checks are cheap.
const PROBE_ITEMS = 5;
const DEFAULT_ITEMS = 100;
const MAX_ITEMS = 1000; // actor-enforced ceiling

// Loaded lazily so this module can be required (and unit-tested) on a machine
// with neither apify-client installed nor a token configured.
function getClient() {
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN missing — add it to .env');

  let ApifyClient;
  try {
    ({ ApifyClient } = require('apify-client'));
  } catch (err) {
    throw new Error('apify-client is not installed — run: npm install apify-client');
  }

  return new ApifyClient({ token: APIFY_TOKEN });
}

// ─── Property type ─────────────────────────────────────────────────────
const PROPERTY_TYPE_PATTERNS = [
  [/townhouse|townhome/, 'Townhouse'],
  [/singlefamily|^house$|^home$/, 'House'],
  [/condo|coop/, 'Condo'],
  [/apartment|multifamily|studio|loft/, 'Apartment'],
  [/house|home|cottage|duplex/, 'House'], // "Room - House", "Guest House"
];

function mapPropertyType(rawType) {
  // The actor may return propertyType as an array (it accepts one as input).
  const value = Array.isArray(rawType) ? rawType[0] : rawType;
  return matchPropertyType(value, PROPERTY_TYPE_PATTERNS);
}

// ─── Fetch ─────────────────────────────────────────────────────────────
// Actor input schema (published, datascrapers/furnishedfinder):
//   urls                 array of FurnishedFinder search URLs
//   maxItems             integer
//   minPrice, maxPrice   integer, optional
//   moveInDate           string, optional
//   listingDetails       boolean — per-listing detail fetch, billed separately
//   hostInfo             boolean — landlord contact, billed separately
//   proxyConfiguration   object, residential recommended by the actor
//
// Only the fields we actually need are sent. Passing extras an actor does not
// declare is a common way to trip its input validation.

// FurnishedFinder's own search URL: /housing/us--az--tucson. Built here rather
// than using the actor's free-text query so the city is never re-geocoded into
// a different one.
function searchUrl(city, state) {
  const slug = (value) => String(value).trim().toLowerCase()
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `https://www.furnishedfinder.com/housing/us--${slug(state)}--${slug(city)}`;
}

function buildActorInput({ city, state, maxItems, moveInDate, minPrice, maxPrice }) {
  if (!city || !state) {
    throw new Error(
      'FurnishedFinder needs city AND state as separate values ' +
      '(e.g. --city="Seattle" --state="WA") — the search URL is built from both.'
    );
  }

  const input = {
    urls: [searchUrl(city, state)],
    maxItems: Math.min(Math.max(Number(maxItems) || DEFAULT_ITEMS, 1), MAX_ITEMS),
    // Both add-ons are billed per listing and neither feeds a field we store.
    listingDetails: false,
    hostInfo: false,
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
  };

  if (moveInDate) input.moveInDate = moveInDate;
  if (minPrice != null) input.minPrice = Number(minPrice);
  if (maxPrice != null) input.maxPrice = Number(maxPrice);

  return input;
}

async function fetchFurnishedFinderListings(options) {
  const client = getClient();
  const input = buildActorInput(options);

  const run = await client.actor(ACTOR_ID).call(input);

  // .call() resolves when the run ENDS, successfully or not — a failed run is
  // not thrown, so it must be checked explicitly or it looks like zero results.
  if (run.status !== 'SUCCEEDED') {
    let tail = '';
    try {
      const log = await client.run(run.id).log().get();
      tail = String(log || '').trim().split('\n').slice(-12).join('\n');
    } catch { /* the log is a nicety, not worth failing over */ }

    throw new Error(
      `Apify run ${run.status} (actor ${ACTOR_ID}, run ${run.id})\n` +
      `Input sent: ${JSON.stringify(input)}\n` +
      (tail ? `Last log lines:\n${tail}` : 'No log available.')
    );
  }

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return items;
}

// ─── Space type — structured, like Airbnb's roomType ───────────────────
// `propertyTypeClass` is NOT in the published docs but is present on every
// live record. It beats text inference outright, and FurnishedFinder carries
// real private-room inventory that must not be flattened to 'Entire Place'.
const SPACE_CLASS_MAP = {
  entire_unit:  'Entire Place',
  private_room: 'Private Room',
  room:         'Private Room', // the current actors' name for a private room
  shared_room:  'Shared Room',
};

function resolveSpaceType(raw) {
  const mapped = SPACE_CLASS_MAP[String(raw.propertyTypeClass || '').toLowerCase()];
  if (mapped) return mapped;
  return inferPropertyDetails(raw).spaceType; // fallback if the field ever vanishes
}

// ─── Amenities — camelCase tokens, not prose ───────────────────────────
// Live records return machine tokens: "airConditioning", "coveredParking",
// "washeranddryer", "utilitiesIncluded". The shared text inference is tuned
// for human sentences and misses most of these — /\bair conditioning\b/ never
// matches "airConditioning" — so this source maps its own vocabulary.
function amenityFlags(raw) {
  const blob = (Array.isArray(raw.amenities) ? raw.amenities : []).join(' ').toLowerCase();

  return {
    hasAirConditioning: /airconditioning|centralair/.test(blob),
    hasParking:         /parking|garage|carport/.test(blob),
    // laundryType is its own structured field: "IN_UNIT" | "SHARED" | "NONE".
    // When present it wins — otherwise "washeranddryeronpremises" (a shared
    // machine in the building) would read as in-unit laundry.
    hasInUnitLaundry: raw.laundryType
      ? String(raw.laundryType).toUpperCase() === 'IN_UNIT'
      : /washeranddryer|washerdryer|inunitlaundry/.test(blob),
    utilitiesIncluded: /utilitiesincluded/.test(blob),
  };
}

// ─── Availability ──────────────────────────────────────────────────────
// `availableOnDate` is a display string ("Available: Sep. 13, 2026"), not a
// timestamp — and the documented `availableFrom` does not exist at all, so
// reading it would have silently dated every listing to the moment of ingest.
function parseAvailability(raw) {
  if (raw.isAvailableNow === true) return new Date();

  const text = String(raw.availableOnDate || '').replace(/^available:\s*/i, '').replace(/\./g, '');
  if (text) {
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return new Date(); // fall back to "available now"
}

// ─── Normalize raw → Listing schema ────────────────────────────────────
// Field names below are taken from a LIVE payload (Seattle, WA — 2026-08-27),
// not from the actor's published documentation, which was wrong in both
// directions: it omits propertyTypeClass, laundryType, availableOnDate,
// isAvailableNow and sourceType, and lists spaceDescription, houseRules,
// bedList, fees, avgRating and a top-level utilitiesIncluded that the actor
// does not return (the last is a token inside `amenities`).
//
// The actor also OMITS fields it cannot extract rather than sending null, so
// every access must tolerate absence.
//
// The 2026-10 actors return FurnishedFinder's search GraphQL nodes directly,
// with different names for the same facts: listingId, approxLocation,
// rentAmount { amount }, bedroomCount, minimumStayInDays, photos as { url }.
// Each read below takes either. listingId uses the same "1054886_1" form as
// the old id, so re-ingesting refreshes existing rows rather than duplicating.
function photoUrls(raw) {
  if (!Array.isArray(raw.photos)) return [];
  return raw.photos
    .map((photo) => (typeof photo === 'string' ? photo : photo?.url))
    .filter((url) => typeof url === 'string' && url.length > 0);
}

function normalizeFurnishedFinder(raw, context = {}) {
  const id = raw.id ?? raw.listingId;
  const geo = raw.approxLocation || {};

  return {
    originalPlatform: 'FurnishedFinder',
    originalId:       String(id),
    rawSource:        raw,

    // No street address in the output — FurnishedFinder withholds it publicly,
    // the same as Airbnb. City/state and coordinates are what we get.
    address:  null,
    // The new payload carries no city, only the searched slug, so fall back
    // to the city we asked for.
    city:     raw.city ?? context.city ?? null,
    zipCode:  null,
    location: {
      type:        'Point',
      coordinates: [raw.longitude ?? geo.longitude, raw.latitude ?? geo.latitude],
    },

    // monthlyPrice is numeric; monthlyPriceText ("$2,950/month") is the fallback.
    // rentAmount.amount is "2200.00" or "$2,200/month" depending on the actor.
    pricePerMonth: parsePriceNumber(raw.monthlyPrice ?? raw.monthlyPriceText ?? raw.rentAmount?.amount),

    spaceType:    resolveSpaceType(raw),
    propertyType: mapPropertyType(raw.propertyType),
    bedrooms:     toNumber(raw.bedrooms ?? raw.bedroomCount),
    bathrooms:    toNumber(raw.bathrooms ?? raw.bathroomCount),
    squareFeet:   null, // not published by this source

    ...amenityFlags(raw),
    isFurnished:  true, // the platform's entire premise, as with Airbnb
    amenitiesRaw: Array.isArray(raw.amenities) ? raw.amenities : collectAmenities(raw),

    // THE FIELD THIS SOURCE EXISTS FOR.
    // A stated minimum, unlike Airbnb's inferred upper bound. Confirmed as
    // DAYS against live data: the Seattle sample returned 30, 30, 30, 90, 30.
    minimumLeaseDays: toNumber(raw.minimumStayDays ?? raw.minimumStayInDays),

    availableFrom: parseAvailability(raw),

    // inputUrl is the search page, so it is only a last resort; the listing
    // id alone is enough to build the real property URL.
    listingUrl: raw.url ?? (id ? `https://www.furnishedfinder.com/property/${id}` : raw.inputUrl ?? null),
    images:     photoUrls(raw),
  };
}

// ─── Entry point ───────────────────────────────────────────────────────
// Same signature as the other three, so wiring this into SOURCES is one line.
async function ingestCity(city, state, { maxItems, limit, dryRun = false, quiet = false } = {}) {
  const cap = maxItems ?? limit ?? DEFAULT_ITEMS;
  if (!city || !state) {
    throw new Error('FurnishedFinder requires both city and state (e.g. "Seattle", "WA")');
  }
  await ensureConnection();

  return runIngest({
    label:     `"${city}, ${state}" furnished rentals from Apify/FurnishedFinder`,
    pages:     1, // the actor paginates internally; one call returns the dataset
    dryRun,
    quiet,
    fetchPage: async () => ({
      raws: await fetchFurnishedFinderListings({ city, state, maxItems: cap }),
      context: { city, state },
    }),
    normalize: normalizeFurnishedFinder,
  });
}

// ─── --schema — ask the actor what it accepts ──────────────────────────
// This is what would have prevented the city/state failure. Reads the input
// schema straight off the actor's current build.
async function printInputSchema() {
  const client = getClient();
  const actor = await client.actor(ACTOR_ID).get();
  if (!actor) throw new Error(`Actor ${ACTOR_ID} not found, or the token cannot see it.`);

  const buildId = actor.taggedBuilds?.latest?.buildId;
  if (!buildId) {
    console.log('No tagged latest build; cannot read the input schema.');
    return;
  }

  const build = await client.build(buildId).get();
  const schema = build?.actorDefinition?.input;
  if (!schema) {
    console.log('This build publishes no input schema.');
    return;
  }

  console.log(`Input schema for ${ACTOR_ID}:\n`);
  const required = new Set(schema.required || []);
  for (const [field, spec] of Object.entries(schema.properties || {})) {
    const flag = required.has(field) ? 'REQUIRED' : 'optional';
    const dflt = spec.default !== undefined ? `  default=${JSON.stringify(spec.default)}` : '';
    console.log(`  ${field.padEnd(20)} ${String(spec.type).padEnd(8)} ${flag}${dflt}`);
  }
}

// ─── --probe — read one real payload before trusting the mapping ───────
async function probe(city, state, maxItems = PROBE_ITEMS) {
  console.log(`Probing ${ACTOR_ID} for ${city}, ${state} (maxItems=${maxItems})...\n`);

  const items = await fetchFurnishedFinderListings({ city, state, maxItems });
  console.log(`Actor returned ${items.length} item(s).\n`);

  if (items.length === 0) {
    console.log('Nothing returned. The run succeeded, so the input was accepted —');
    console.log('either this city has no inventory or the search parameters are too narrow.');
    return;
  }

  // Which fields actually appear, and how consistently. The actor omits what it
  // cannot extract, so presence varies record to record.
  const presence = {};
  for (const item of items) {
    for (const key of Object.keys(item)) presence[key] = (presence[key] || 0) + 1;
  }
  console.log('FIELD PRESENCE across sample:');
  for (const [key, n] of Object.entries(presence).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key.padEnd(26)} ${n}/${items.length}`);
  }

  // The one field the whole source is for.
  console.log('\nminimumStayDays values:', items.map((i) => i.minimumStayDays ?? i.minimumStayInDays).join(', '));
  console.log('  ^ expect values around 30+. Anything like 1/3/6/12 means the');
  console.log('    field is MONTHS despite its name — fix before any bulk run.');

  const trimmed = { ...items[0] };
  if (Array.isArray(trimmed.photos)) trimmed.photos = [`[${trimmed.photos.length} photos]`];
  console.log('\nRAW #1:\n', JSON.stringify(trimmed, null, 2));

  console.log('\nNORMALIZED #1:\n', JSON.stringify(
    { ...normalizeFurnishedFinder(items[0]), rawSource: '[omitted]', images: '[omitted]' }, null, 2
  ));
}

if (require.main === module) {
  const args = parseCliArgs(process.argv);

  // --city/--state are the primary form; --keyword="Seattle, WA" still works.
  const [kwCity, kwState] = (args.keyword || '').split(',').map((s) => s.trim());
  const city = args.city || kwCity;
  const state = args.state || kwState;

  let task;
  if (process.argv.includes('--schema')) {
    task = printInputSchema();
  } else if (process.argv.includes('--probe')) {
    task = probe(city, state, args.limit || PROBE_ITEMS);
  } else {
    task = ingestCity(city, state, { limit: args.limit || DEFAULT_ITEMS, dryRun: args.dryRun });
  }

  task
    .then(() => mongoose.connection.close())
    .catch(handleFatal);
}

module.exports = {
  searchUrl,
  photoUrls,
  ingestCity,
  resolveSpaceType,
  amenityFlags,
  parseAvailability,
  fetchFurnishedFinderListings,
  normalizeFurnishedFinder,
  buildActorInput,
  mapPropertyType,
  probe,
  printInputSchema,
};
