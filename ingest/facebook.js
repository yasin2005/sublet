const mongoose = require('mongoose');
const { ensureConnection } = require('./lib/db');
const {
  parsePriceNumber,
  toNumber,
  matchPropertyType,
  inferPropertyDetails,
  runIngest,
  parseCliArgs,
  handleFatal,
} = require('./lib/pipeline');

// ─── STATUS: probed 2026-08-27 (Seattle, WA — run RQfrcxndTsSkYljre).
// ─── Mapping corrected against that payload. Yield was 3 usable of 5.
//
// Every source so far contradicted its own documentation in at least one field
// that would have silently corrupted data. This one is the least like the
// others, so assume it is worse:
//
//   * no city/state input — it takes Facebook Marketplace URLs, so the city
//     has to be turned into a URL slug, and Facebook's slugs are idiosyncratic
//     ("nyc", not "newyork")
//   * output is snake_case and nested, unlike every other source
//   * coordinates arrive ONLY when includeListingDetails is on
//   * listings are free text with no structured beds/baths/lease fields
//
// RELIABILITY, honestly: this is the most fragile source in the project.
// Facebook actively blocks automated collection and their terms prohibit it,
// the actor needs residential proxies to work at all, and seller fields stay
// empty without authenticated cookies. Expect it to break more often than the
// other four and to return messier data when it works.

// crawlerbros/facebook-marketplace-scraper was unpublished 2026-10. Apify's own
// actor replaces it: ~12K users and a ~100% 30-day success rate, versus a
// single-developer actor that can vanish overnight. Its payload is camelCase
// (listingPrice, listingPhotos, itemUrl) where the old one was snake_case, so
// every reader below accepts both.
const ACTOR_ID = process.env.FACEBOOK_ACTOR_ID || 'apify/facebook-marketplace-scraper';
const APIFY_TOKEN = process.env.APIFY_TOKEN;

const PROBE_ITEMS = 5;
const DEFAULT_ITEMS = 100;

// Marketplace rentals live under their own category path, which is far more
// precise than a text search for "apartment" and avoids pulling in furniture.
const RENTAL_CATEGORY = 'propertyrentals';

// Facebook city slugs do not follow from the city name. Seeded for the cities
// already in the catalogue; anything else falls back to a stripped lowercase
// guess, which is right often enough to be worth trying and wrong often enough
// that a probe should confirm it before a bulk run.
const CITY_SLUGS = {
  'seattle|WA':  'seattle',
  'portland|OR': 'portland',
  'denver|CO':   'denver',
  'austin|TX':   'austin',
  'boise|ID':    'boise',
  'tucson|AZ':   'tucson',
  'madison|WI':  'madison',
  'new york|NY': 'nyc',
  'san francisco|CA': 'sanfrancisco',
  'los angeles|CA':   'la',
};

function citySlug(city, state) {
  const key = `${String(city).toLowerCase()}|${String(state).toUpperCase()}`;
  return CITY_SLUGS[key] || String(city).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildMarketplaceUrl(city, state) {
  if (!city) throw new Error('Facebook Marketplace needs a city');
  return `https://www.facebook.com/marketplace/${citySlug(city, state)}/${RENTAL_CATEGORY}`;
}

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

// ─── Fetch ─────────────────────────────────────────────────────────────
// Actor input (published):
//   startUrls              array, REQUIRED — marketplace URLs
//   resultsLimit           integer, default 50
//   includeListingDetails  boolean, default false
//   proxyConfiguration     object, residential recommended
function buildActorInput({ city, state, maxItems = DEFAULT_ITEMS }) {
  return {
    startUrls: [{ url: buildMarketplaceUrl(city, state) }],
    resultsLimit: Math.max(Number(maxItems) || DEFAULT_ITEMS, 1),

    // Kept on. The docs say coordinates need this, and although the probe
    // showed them arriving on `location` instead, details are also what
    // populate custom_title — the only semi-structured field this source has,
    // and the basis for space type and bed/bath counts.
    includeListingDetails: true,

    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
  };
}

// A listing that is sold, pending or delisted is not inventory. Filtering here
// rather than in the normalizer keeps them out of the skip tally, where they
// would look like mapping failures.
function isLiveListing(raw) {
  if (raw.is_sold === true || raw.is_pending === true || raw.is_hidden === true) return false;
  if (raw.isSold === true || raw.isPending === true || raw.isHidden === true) return false;
  if (raw.is_live === false || raw.isLive === false) return false;
  // The rentals category also carries offices and retail space. They have
  // plausible rents, so the price band below cannot catch them.
  if (COMMERCIAL_RE.test(listingTitle(raw))) return false;
  if (COMMERCIAL_DESCRIPTION_RE.test(descriptionText(raw))) return false;
  return true;
}

// Many business listings carry a homely title ("Private room for rent") and
// only say what they are in the description. Phrases here must be ones a home
// listing would never use — "near a hair salon" must not match.
const COMMERCIAL_DESCRIPTION_RE = /\b(hair salon in|salon suites?|beauty (suites?|studio)|for barbers|hairstylists|lash techs|nail salon|timeshare|your next event|event space|office space)\b/i;

function descriptionText(raw) {
  if (typeof raw.description?.text === 'string') return raw.description.text;
  if (typeof raw.description === 'string') return raw.description;
  if (typeof raw.redacted_description === 'string') return raw.redacted_description;
  return '';
}

const COMMERCIAL_RE = /\b(commercial|office|retail|warehouse|storage unit|parking spot|garage for rent|salon|barber|booth rental|treatment room|suite for lease|business space)\b/i;

const listingTitle = (raw) => raw.listingTitle ?? raw.marketplace_listing_title ?? '';
const listingPrice = (raw) => raw.listingPrice ?? raw.listing_price ?? null;

async function fetchFacebookListings(options) {
  const client = getClient();
  const input = buildActorInput(options);

  const run = await client.actor(ACTOR_ID).call(input);

  if (run.status !== 'SUCCEEDED') {
    let tail = '';
    try {
      const log = await client.run(run.id).log().get();
      tail = String(log || '').trim().split('\n').slice(-12).join('\n');
    } catch { /* the log is a nicety */ }

    throw new Error(
      `Apify run ${run.status} (actor ${ACTOR_ID}, run ${run.id})\n` +
      `Input sent: ${JSON.stringify(input)}\n` +
      (tail ? `Last log lines:\n${tail}` : 'No log available.')
    );
  }

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return items.filter(isLiveListing);
}

// ─── Price sanity ──────────────────────────────────────────────────────
// Marketplace prices are typed by hand into a free-text field, so they are the
// least trustworthy in the project: "$1" placeholders meant to mean "message
// me", weekly and nightly rates entered as if monthly, and outright sale
// prices posted in the rentals category. A band is cruder than parsing, but
// unlike the other sources there is no structured field to appeal to.
const MIN_PLAUSIBLE_RENT = 250;
const MAX_PLAUSIBLE_RENT = 20000;

function plausibleRent(value) {
  if (value == null) return null;
  return value >= MIN_PLAUSIBLE_RENT && value <= MAX_PLAUSIBLE_RENT ? value : null;
}

// ─── Property type ─────────────────────────────────────────────────────
const PROPERTY_TYPE_PATTERNS = [
  [/townhouse|townhome/, 'Townhouse'],
  [/condo/, 'Condo'],
  [/house|home|duplex|cottage/, 'House'],
  [/apartment|apt|studio|loft|unit/, 'Apartment'],
];

function inferFacebookPropertyType(raw) {
  return matchPropertyType(listingText(raw), PROPERTY_TYPE_PATTERNS);
}

// `custom_title` is the one semi-structured field Marketplace gives us:
//   "1 bed · 1 bath"  ·  "4 beds · 3 baths"  ·  "Studio · 1 bath"  ·  "Private Room"
// It is far more reliable than the free-text title, and crucially it is in
// ENGLISH even when the listing is not — a probe returned "Habitación privada
// en alquiler" whose custom_title still read "Private Room".
//
// `redacted_description` is NOT usable: the actor serializes it wrongly and
// every record in the probe contained the literal string "[object Object]".
// Feeding that to the shared text inference would be noise at best.
//
// The Apify actor has no custom_title; its equivalent is the "Unit Details"
// section of `details` ("House", "Studio", "2 beds · 1 bath"), and its
// description is an object { text }.
function detailLabels(raw) {
  if (!Array.isArray(raw.details)) return '';
  return raw.details
    .filter((section) => section?.section_type === 'UNIT_INCLUDES')
    .flatMap((section) => section.pdp_fields || [])
    .map((field) => field?.display_label)
    .filter(Boolean)
    .join(' · ');
}

function listingText(raw) {
  let description = '';
  if (typeof raw.redacted_description === 'string' && raw.redacted_description !== '[object Object]') {
    description = raw.redacted_description;
  } else if (typeof raw.description?.text === 'string') {
    description = raw.description.text;
  } else if (typeof raw.description === 'string') {
    description = raw.description;
  }
  return [raw.custom_title, detailLabels(raw), listingTitle(raw), description].filter(Boolean).join(' · ');
}

function inferBedsBaths(raw) {
  const text = listingText(raw).toLowerCase();

  const beds = text.match(/(\d+)\s*(?:bed(?:room)?s?|br\b|bd\b)/);
  const baths = text.match(/(\d+(?:\.\d)?)\s*(?:bath(?:room)?s?|ba\b)/);

  return {
    // "Studio" means zero separate bedrooms, which is information, not absence.
    bedrooms: beds ? toNumber(beds[1]) : (/\bstudio\b/.test(text) ? 0 : null),
    bathrooms: baths ? toNumber(baths[1]) : null,
  };
}

// Marketplace labels room rentals explicitly in custom_title, which is the
// only trustworthy space-type signal here.
function inferFacebookSpaceType(raw) {
  const text = listingText(raw).toLowerCase();

  if (/\bshared room\b|\bshared bedroom\b/.test(text)) return 'Shared Room';
  if (/\bprivate room\b|\broom for rent\b|\bhabitaci/.test(text)) return 'Private Room';
  return inferPropertyDetails(raw).spaceType;
}

// `primary_listing_photo` is NOT a URL string despite the name. It is an array
// of GraphQL photo nodes:
//   [{ __typename: 'Photo', image: { uri: 'https://...' }, id: '...' }]
// and the __typename varies ('Photo', 'ProductImage',
// 'CatalogMarketplaceEnhancementTransformedImage'), so only `image.uri` is
// dependable. Passing the raw value through made Mongoose reject EVERY record
// in the first live run with a CastError on images.0 — 25 of 25 — which then
// aborted the whole ingest.
function extractImages(raw) {
  // The Apify actor sends the full gallery as listingPhotos, in the same node
  // shape; its primaryListingPhoto is a single node with photo_image_url.
  if (Array.isArray(raw.listingPhotos) && raw.listingPhotos.length > 0) {
    return raw.listingPhotos.map((node) => node?.image?.uri).filter((uri) => typeof uri === 'string' && uri.length > 0);
  }
  if (raw.primaryListingPhoto?.photo_image_url) return [raw.primaryListingPhoto.photo_image_url];

  const source = raw.primary_listing_photo;
  const nodes = Array.isArray(source) ? source : (source ? [source] : []);

  return nodes
    .map((node) => (typeof node === 'string' ? node : node?.image?.uri))
    // Some nodes carry an empty uri, which is not a usable image.
    .filter((uri) => typeof uri === 'string' && uri.length > 0);
}

// ─── Normalize raw → Listing schema ────────────────────────────────────
// TODO: confirm every field below against a live payload before a bulk run.
function normalizeFacebook(raw, context = {}) {
  const location = raw.location || {};
  const geocode = location.reverse_geocode || {};
  const detailed = location.reverse_geocode_detailed || {};

  const inferred = inferPropertyDetails(raw);
  const { bedrooms, bathrooms } = inferBedsBaths(raw);

  const price = listingPrice(raw);
  const rawPrice = parsePriceNumber(price?.amount ?? price?.formatted_amount);

  // Coordinates are on `location`, NOT on the documented `item_location` —
  // which is absent from every record the probe returned. Reading the
  // documented field would have dropped 100% of this source at pre-flight.
  const latitude = location.latitude ?? raw.item_location?.latitude ?? null;
  const longitude = location.longitude ?? raw.item_location?.longitude ?? null;

  return {
    originalPlatform: 'FacebookMarketplace',
    originalId:       String(raw.id),
    rawSource:        raw,

    // Marketplace shows an approximate area, not a street address. The
    // reverse-geocoded city is frequently blank (3/5 populated in the probe),
    // so fall back to the city that was searched — without it these listings
    // are invisible to every city-name query and to the sweep's grouping.
    address:  null,
    city:     geocode.city || detailed.city || context.city || null,
    zipCode:  detailed.postal_code || null,
    location: {
      type:        'Point',
      coordinates: [longitude, latitude],
    },

    // Anything outside a plausible rent band becomes null, which the pre-flight
    // then skips. The probe found 2 of 5 listings in the Rentals category
    // carrying sale prices ($86,000 and $660,000) — this band is what stops
    // those from landing in the catalogue as rentals.
    pricePerMonth: plausibleRent(rawPrice),

    ...inferred,
    spaceType:    inferFacebookSpaceType(raw),
    propertyType: inferFacebookPropertyType(raw),
    bedrooms,
    bathrooms,
    squareFeet: null,

    // No lease field exists on Marketplace. Sublets are common here, so the
    // text often says "3 month sublet" — worth an extractor later, but not
    // worth guessing at now.
    minimumLeaseDays: null,
    availableFrom:    raw.creation_time ? new Date(raw.creation_time * 1000) : new Date(),

    // NOT facebookUrl: that is the search page the listing was found on, so
    // every listing would link to the same results page.
    listingUrl: raw.itemUrl ?? raw.listingUrl ??
      (raw.id ? `https://www.facebook.com/marketplace/item/${raw.id}` : null),
    images: extractImages(raw),
  };
}

// ─── Entry point ───────────────────────────────────────────────────────
async function ingestCity(city, state, { maxItems, limit, dryRun = false, quiet = false } = {}) {
  if (!city) throw new Error('ingestCity requires a city');
  await ensureConnection();

  const cap = maxItems ?? limit ?? DEFAULT_ITEMS;

  return runIngest({
    label:     `"${city}${state ? ', ' + state : ''}" rentals from Apify/FacebookMarketplace`,
    pages:     1,
    dryRun,
    quiet,
    fetchPage: async () => ({
      raws: await fetchFacebookListings({ city, state, maxItems: cap }),
      context: { city, state },
    }),
    normalize: normalizeFacebook,
    describeSkip: (raw, gaps) => {
      if (gaps.includes('no coordinates')) {
        return 'no item_location — the listing detail page did not resolve';
      }
      if (gaps.includes('no parseable price')) {
        return 'price missing or outside the plausible-rent band';
      }
      return null;
    },
  });
}

// ─── probe() — run this FIRST ──────────────────────────────────────────
//   node ingest/facebook.js --probe --city="Seattle" --state="WA"
async function probe(city, state, maxItems = PROBE_ITEMS) {
  console.log(`URL that will be scraped:\n  ${buildMarketplaceUrl(city, state)}\n`);

  const items = await fetchFacebookListings({ city, state, maxItems });
  console.log(`Actor returned ${items.length} live listing(s).\n`);

  if (items.length === 0) {
    console.log('Nothing returned. Most likely causes, in order:');
    console.log('  1. the city slug is wrong — check the URL above opens in a browser');
    console.log('  2. Facebook blocked the run (residential proxy may still be rate-limited)');
    console.log('  3. the rentals category genuinely has no live listings there');
    return;
  }

  const presence = {};
  for (const item of items) {
    for (const key of Object.keys(item)) presence[key] = (presence[key] || 0) + 1;
  }
  console.log('FIELD PRESENCE across sample:');
  for (const [key, n] of Object.entries(presence).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key.padEnd(34)} ${n}/${items.length}`);
  }

  const coords = items.filter((i) => i.item_location?.latitude != null).length;
  console.log(`\nitem_location present on ${coords}/${items.length}.`);
  console.log('  ^ anything without coordinates is dropped by the pre-flight.');
  console.log('    If this is 0, includeListingDetails is not doing its job and');
  console.log('    the source will ingest nothing.');

  console.log('\nPrices:', items.map((i) => listingPrice(i)?.formatted_amount ?? listingPrice(i)?.amount ?? '—').join(', '));
  console.log('  ^ watch for "$1" placeholders and sale prices in the rentals category.');

  const trimmed = { ...items[0] };
  if (Array.isArray(trimmed.photos)) trimmed.photos = [`[${trimmed.photos.length} photos]`];
  console.log('\nRAW #1:\n', JSON.stringify(trimmed, null, 2));

  console.log('\nNORMALIZED #1:\n', JSON.stringify(
    { ...normalizeFacebook(items[0]), rawSource: '[omitted]' }, null, 2
  ));
}

async function printInputSchema() {
  const client = getClient();
  const actor = await client.actor(ACTOR_ID).get();
  if (!actor) throw new Error(`Actor ${ACTOR_ID} not found, or the token cannot see it.`);

  const buildId = actor.taggedBuilds?.latest?.buildId;
  if (!buildId) return console.log('No tagged latest build; cannot read the input schema.');

  const build = await client.build(buildId).get();
  const schema = build?.actorDefinition?.input;
  if (!schema) return console.log('This build publishes no input schema.');

  console.log(`Input schema for ${ACTOR_ID}:\n`);
  const required = new Set(schema.required || []);
  for (const [field, spec] of Object.entries(schema.properties || {})) {
    const flag = required.has(field) ? 'REQUIRED' : 'optional';
    const dflt = spec.default !== undefined ? `  default=${JSON.stringify(spec.default)}` : '';
    console.log(`  ${field.padEnd(24)} ${String(spec.type).padEnd(8)} ${flag}${dflt}`);
  }
}

if (require.main === module) {
  const args = parseCliArgs(process.argv);
  const [kwCity, kwState] = (args.keyword || '').split(',').map((s) => s.trim());
  const city = args.city || kwCity;
  const state = args.state || kwState;

  let task;
  if (process.argv.includes('--schema')) task = printInputSchema();
  else if (process.argv.includes('--probe')) task = probe(city, state, args.limit || PROBE_ITEMS);
  else task = ingestCity(city, state, { maxItems: args.limit, dryRun: args.dryRun });

  task.then(() => mongoose.connection.close()).catch(handleFatal);
}

module.exports = {
  ingestCity,
  fetchFacebookListings,
  normalizeFacebook,
  buildActorInput,
  buildMarketplaceUrl,
  citySlug,
  isLiveListing,
  extractImages,
  inferFacebookSpaceType,
  listingText,
  plausibleRent,
  inferBedsBaths,
  inferFacebookPropertyType,
  probe,
  printInputSchema,
};
