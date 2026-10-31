const mongoose = require('mongoose');
const { ensureConnection } = require('./lib/db');
const {
  hasDataFetch,
  parsePriceNumber,
  matchPropertyType,
  inferPropertyDetails,
  collectAmenities,
  runIngest,
  parseCliArgs,
  handleFatal,
} = require('./lib/pipeline');

const ENDPOINT = 'https://api.hasdata.com/scrape/zillow/listing';

// ─── Property type ─────────────────────────────────────────────────────
// Confirmed from a live payload: Zillow sends SCREAMING_SNAKE via `homeType`
// ("APARTMENT", "TOWNHOUSE", "SINGLE_FAMILY"). Ordered patterns rather than
// exact keys so "APARTMENT_CONDO" and "Single Family" both land correctly.
const PROPERTY_TYPE_PATTERNS = [
  [/townhouse|townhome/, 'Townhouse'],
  [/singlefamily|^house$|^home$/, 'House'],
  [/manufactured|mobile/, 'House'],
  [/condo|coop/, 'Condo'],       // co-ops behave like condos for our filters
  [/apartment|multifamily/, 'Apartment'],
];

function mapPropertyType(homeType) {
  return matchPropertyType(homeType, PROPERTY_TYPE_PATTERNS);
}

// ─── Fetch ─────────────────────────────────────────────────────────────
async function fetchZillowListings({ keyword, type = 'forRent', page = 1, ...filters }) {
  return hasDataFetch(ENDPOINT, { keyword, type, page, ...filters });
}

// ─── Normalize raw → Listing schema ────────────────────────────────────
function normalizeZillow(raw) {
  const address = raw.address || {};
  const amenitiesRaw = collectAmenities(raw);

  // spaceType and isFurnished are read out of the payload text, not assumed.
  // Room-for-rent and sublet inventory does exist on Zillow, and defaulting
  // it to a furnished-false entire place is how that data gets lost.
  const inferred = inferPropertyDetails(raw);

  const images = Array.isArray(raw.photos) ? raw.photos.filter(Boolean) : [raw.image].filter(Boolean);

  return {
    // Source tracking
    originalPlatform: 'Zillow',
    originalId:       String(raw.id ?? raw.zpid),
    rawSource:        raw,

    // Location — GeoJSON is [longitude, latitude], NOT [lat, lng]
    address:
      raw.addressRaw ||
      [address.street, address.city, address.state].filter(Boolean).join(', ') ||
      null,
    city:    address.city || null,
    zipCode: address.zipcode || address.zipCode || null,
    location: {
      type:        'Point',
      coordinates: [raw.longitude, raw.latitude],
    },

    // Financials — numeric on the rental payload, but building cards can
    // quote "$1,800 - $2,400/mo", so parse rather than trust.
    pricePerMonth: parsePriceNumber(raw.price),

    // Property details
    propertyType: mapPropertyType(raw.homeType ?? raw.propertyType),
    bedrooms:     raw.beds  ?? null,
    bathrooms:    raw.baths ?? null,
    squareFeet:   raw.area  ?? raw.livingArea ?? null,

    // spaceType + isFurnished + amenity flags, all inferred from the payload
    ...inferred,
    amenitiesRaw,

    // Lease terms — the search endpoint exposes neither
    minimumLeaseDays: null,
    availableFrom:    new Date(), // fallback: assume "available now"

    listingUrl: raw.url || raw.detailUrl || null,
    images,
  };
}

// ─── Skip diagnosis ────────────────────────────────────────────────────
// Roughly half of every Zillow rental page is an apartment-COMPLEX card
// rather than a unit:
//   /b/building/47.60192,-122.316414_ll/   (id is a lat-lng pair, not a zpid)
//   /apartments/seattle-wa/ivy-ridge-apartments/
// These carry no price, beds, baths, area, or homeType — the fields are
// absent from the payload, not merely null. Skipping them is correct; the
// only way to price them is the /scrape/zillow/property endpoint, one call
// per building. Naming them keeps the run log honest.
const BUILDING_URL_RE = /\/b\/building\/|\/apartments\//i;

// A real unit always has a numeric zpid. Building cards are keyed by their
// lat-lng instead ("47.617672--122.352394"), which catches the complexes whose
// URL uses neither of the two patterns above.
const COORDINATE_ID_RE = /^-?\d+\.\d+--?\d+\.\d+$/;

function isBuildingCard(raw) {
  return COORDINATE_ID_RE.test(String(raw.id ?? '')) || BUILDING_URL_RE.test(raw.url || '');
}

function describeZillowSkip(raw, gaps) {
  if (gaps.includes('no parseable price') && isBuildingCard(raw)) {
    return 'apartment-complex card — Zillow omits unit pricing in search results';
  }
  return null; // fall back to the raw gap list
}

// ─── Entry point ───────────────────────────────────────────────────────
// The search route calls this in-process for on-demand ingestion, so it must
// be a plain async function: no CLI parsing, no process.exit, and it returns
// counts rather than printing them.
async function ingestCity(city, state, { pages = 1, dryRun = false, quiet = false } = {}) {
  if (!city) throw new Error('ingestCity requires a city');
  await ensureConnection();

  const keyword = state ? `${city}, ${state}` : city;

  return runIngest({
    label:        `"${keyword}" rentals from HasData/Zillow`,
    pages,
    dryRun,
    quiet,
    fetchPage:    async (page) => ({ raws: await fetchZillowListings({ keyword, page }) }),
    normalize:    normalizeZillow,
    describeSkip: describeZillowSkip,
  });
}

if (require.main === module) {
  const { keyword, pages, dryRun } = parseCliArgs(process.argv);
  const [city, state] = (keyword || 'Seattle, WA').split(',').map((s) => s.trim());

  ingestCity(city, state, { pages, dryRun })
    .then(() => mongoose.connection.close())
    .catch(handleFatal);
}

module.exports = {
  ingestCity,
  fetchZillowListings,
  normalizeZillow,
  mapPropertyType,
  isBuildingCard,
  describeZillowSkip,
};
