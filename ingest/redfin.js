const mongoose = require('mongoose');
const { ensureConnection } = require('./lib/db');
const {
  hasDataFetch,
  parsePriceNumber,
  toNumber,
  matchPropertyType,
  inferPropertyDetails,
  collectAmenities,
  runIngest,
  parseCliArgs,
  handleFatal,
} = require('./lib/pipeline');

const ENDPOINT = 'https://api.hasdata.com/scrape/redfin/listing';

// ─── Property type ─────────────────────────────────────────────────────
// HEADS UP: unlike Zillow, this mapping is not confirmed against a live
// payload — HasData documents Redfin's request params but not its response
// fields. These patterns cover Redfin's own website vocabulary ("Single
// Family Residential", "Condo/Co-op", "Multi-Family (2-4 Unit)"). Run with
// --dry-run first and tighten if the real values differ.
const PROPERTY_TYPE_PATTERNS = [
  [/townhouse|townhome/, 'Townhouse'],
  [/singlefamily|^house$|^home$/, 'House'],
  [/manufactured|mobile|ranch/, 'House'],
  [/condo|coop/, 'Condo'],
  [/apartment|multifamily/, 'Apartment'],
];

function mapPropertyType(propertyType) {
  return matchPropertyType(propertyType, PROPERTY_TYPE_PATTERNS);
}

// Live payloads carry NO propertyType field at all, but the Redfin URL encodes
// it as the path segment before the id:
//   /WA/Seattle/Park-Hill/apartment/2081811  ->  apartment
//   /WA/Seattle/123-Pine-St/home/184234123   ->  home
// A weak signal, but a real one — better than defaulting everything to
// 'Apartment' and calling every rental house an apartment.
function propertyTypeFromUrl(url) {
  const match = String(url || '').match(/\/(apartment|home|house|condo|townhouse)\/\d+/i);
  return match ? match[1] : null;
}

// ─── Address ───────────────────────────────────────────────────────────
// Redfin's address may arrive as a nested object (like Zillow) or as a flat
// string. Handle both so a shape change does not null out every address.
function readAddress(raw) {
  if (raw.address && typeof raw.address === 'object') {
    const a = raw.address;
    return {
      // Prefer addressRaw — it is the only form that carries the zip.
      full:    raw.addressRaw || [a.street, a.city, a.state].filter(Boolean).join(', ') || null,
      city:    a.city || null,
      zipCode: a.zipcode || a.zipCode || null,
    };
  }

  return {
    full:    raw.address || raw.addressRaw || raw.streetLine || null,
    city:    raw.city || null,
    zipCode: raw.zipcode || raw.zipCode || raw.postalCode || null,
  };
}

// ─── Fetch ─────────────────────────────────────────────────────────────
async function fetchRedfinListings({ keyword, type = 'forRent', page = 1, ...filters }) {
  return hasDataFetch(ENDPOINT, { keyword, type, page, ...filters });
}

// ─── Normalize raw → Listing schema ────────────────────────────────────
function normalizeRedfin(raw) {
  const address = readAddress(raw);
  const amenitiesRaw = collectAmenities(raw);

  // Same treatment as Zillow: read spaceType, furnishing, and amenity flags
  // out of the payload rather than assuming an unfurnished whole unit.
  const inferred = inferPropertyDetails(raw);

  const images = Array.isArray(raw.photos)
    ? raw.photos.filter(Boolean)
    : [raw.image || raw.photo].filter(Boolean);

  // Redfin rentals often quote a range across a building's units.
  const latitude  = raw.latitude  ?? raw.latLong?.latitude  ?? null;
  const longitude = raw.longitude ?? raw.latLong?.longitude ?? null;

  return {
    // Source tracking
    originalPlatform: 'Redfin',
    originalId:       String(raw.id ?? raw.mlsId ?? raw.propertyId),
    rawSource:        raw,

    // Location — GeoJSON is [longitude, latitude], NOT [lat, lng]
    address:  address.full,
    city:     address.city,
    zipCode:  address.zipCode,
    location: {
      type:        'Point',
      coordinates: [longitude, latitude],
    },

    // Financials — arrives as { min, max } across a building's units
    pricePerMonth: parsePriceNumber(raw.price),

    // Property details — beds/baths/area are ranges too, so they must be
    // unwrapped. Passing { min, max } straight into a Number field makes
    // Mongoose throw a CastError on every single listing.
    propertyType: mapPropertyType(raw.propertyType ?? raw.homeType ?? propertyTypeFromUrl(raw.url)),
    bedrooms:     toNumber(raw.beds  ?? raw.bedrooms),
    bathrooms:    toNumber(raw.baths ?? raw.bathrooms),
    squareFeet:   toNumber(raw.area  ?? raw.sqft ?? raw.squareFeet),

    // spaceType + isFurnished + amenity flags, all inferred from the payload
    ...inferred,
    amenitiesRaw,

    // Lease terms — not exposed by the search endpoint
    minimumLeaseDays: null,
    availableFrom:    new Date(), // fallback: assume "available now"

    listingUrl: raw.url || raw.detailUrl || null,
    images,
  };
}

// ─── Entry point ───────────────────────────────────────────────────────
async function ingestCity(city, state, { pages = 1, dryRun = false, quiet = false } = {}) {
  if (!city) throw new Error('ingestCity requires a city');
  await ensureConnection();

  const keyword = state ? `${city}, ${state}` : city;

  return runIngest({
    label:     `"${keyword}" rentals from HasData/Redfin`,
    pages,
    dryRun,
    quiet,
    fetchPage: async (page) => ({ raws: await fetchRedfinListings({ keyword, page }) }),
    normalize: normalizeRedfin,
  });
}

if (require.main === module) {
  const { keyword, pages, dryRun } = parseCliArgs(process.argv);
  const [city, state] = (keyword || 'Seattle, WA').split(',').map((s) => s.trim());

  ingestCity(city, state, { pages, dryRun })
    .then(() => mongoose.connection.close())
    .catch(handleFatal);
}

module.exports = { ingestCity, fetchRedfinListings, normalizeRedfin, mapPropertyType };
