const mongoose = require('mongoose');
const { ensureConnection } = require('./lib/db');
const {
  hasDataFetchRaw,
  extractListings,
  parsePriceNumber,
  matchPropertyType,
  runIngest,
  parseCliArgs,
  handleFatal,
} = require('./lib/pipeline');

const ENDPOINT = 'https://api.hasdata.com/scrape/airbnb/listing';

// Airbnb quotes per night; our schema stores per month. 365.25/12 is the
// average month — using a flat 30 would understate rent by roughly a day
// every month, which compounds across every price filter in the app.
const DAYS_PER_MONTH = 30.44;

// ─── Space type — the one field Airbnb gets RIGHT ──────────────────────
// Airbnb's roomType is a real structured field, unlike Zillow/Redfin where
// we have to infer from text. It maps 1:1 onto our enum, so Airbnb is the
// only source that can populate 'Private Room' / 'Shared Room' reliably.
const ROOM_TYPE_MAP = {
  entire_home: 'Entire Place',
  private_room: 'Private Room',
  shared_room: 'Shared Room',
  hotel_room: 'Private Room', // a private room you do not share
};

function mapSpaceType(roomType) {
  if (!roomType) return 'Entire Place';
  return ROOM_TYPE_MAP[String(roomType).toLowerCase()] || 'Entire Place';
}

// ...except roomType is NOT always present. Live Seattle payloads omit it
// entirely, which would quietly label every private room an entire place —
// the exact mislabeling this source exists to avoid.
//
// The fallback uses Airbnb's title convention, "<Space> in <Area>":
//   "Apartment in Queen Anne" · "Room in Seattle" · "Shared room in Ballard"
// The leading noun is the space type, so it is a reliable signal here even
// though a bare "room" match would be far too loose on Zillow or Redfin.
function inferSpaceTypeFromTitle(raw) {
  const title = String(raw.title || raw.name || '').trim();

  if (/^shared\s+room\b/i.test(title)) return 'Shared Room';
  if (/^(private\s+)?room\b/i.test(title)) return 'Private Room';
  return 'Entire Place';
}

function resolveSpaceType(raw) {
  return raw.roomType ? mapSpaceType(raw.roomType) : inferSpaceTypeFromTitle(raw);
}

// ─── Property type ─────────────────────────────────────────────────────
// Airbnb has no propertyType field on search results, but `title` is
// consistently "<Property type> in <City>" ("Loft in New York"), so the
// first word is a genuine signal rather than a guess.
const PROPERTY_TYPE_PATTERNS = [
  [/townhouse|townhome/, 'Townhouse'],
  [/condo/, 'Condo'],
  [/house|home|cottage|cabin|villa|bungalow|guesthouse/, 'House'],
  [/apartment|loft|flat|condominium|studio|suite/, 'Apartment'],
];

function inferPropertyType(raw) {
  const title = raw.title || raw.name || '';
  // Only look at the part before " in <City>" so a city name never matches.
  const head = title.split(/\bin\b/i)[0];
  return matchPropertyType(head, PROPERTY_TYPE_PATTERNS);
}

// ─── Price — the field most likely to silently corrupt the DB ──────────
// Airbnb's price is a nested object of STRINGS, not a number:
//   { originalPrice: "$210", discountedPrice: "$157", qualifier: "night" }
// Prefer discountedPrice (what a guest actually pays), then scale to a month
// based on the qualifier. A "total" qualifier covers the whole search window,
// so it has to be divided by nights before scaling back up.
function toMonthlyPrice(price, nights) {
  if (price == null) return null;

  // Defensive: if a payload ever returns a bare number, treat it as nightly.
  if (typeof price === 'number' || typeof price === 'string') {
    const flat = parsePriceNumber(price);
    return flat == null ? null : Math.round(flat * DAYS_PER_MONTH);
  }

  const amount = parsePriceNumber(price.discountedPrice ?? price.originalPrice);
  if (amount == null) return null;

  const qualifier = String(price.qualifier || 'night').toLowerCase();

  if (qualifier.includes('total')) {
    if (!nights || nights <= 0) return null; // cannot scale a total without a window
    return Math.round((amount / nights) * DAYS_PER_MONTH);
  }

  if (qualifier.includes('month')) return Math.round(amount);
  if (qualifier.includes('week')) return Math.round((amount / 7) * DAYS_PER_MONTH);

  // Default and by far the common case: per night.
  return Math.round(amount * DAYS_PER_MONTH);
}

// ─── Date helpers ──────────────────────────────────────────────────────
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const out = new Date(date);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

// ─── Fetch ─────────────────────────────────────────────────────────────
// NOTE: this endpoint takes `location` (not `keyword`) and REQUIRES checkIn.
// Searching a ~30-night window matters beyond satisfying the API: Airbnb
// applies its monthly discount to long stays, so a 30-night search returns
// the rates an intern would actually pay, not inflated weekend pricing.
// Returns { raws, nextPageToken } — Airbnb paginates by opaque token, so the
// caller needs the envelope, not just the listings array.
async function fetchAirbnbListings({ location, checkIn, checkOut, adults = 1, nextPageToken }) {
  const body = await hasDataFetchRaw(ENDPOINT, { location, checkIn, checkOut, adults, nextPageToken });
  return {
    raws: extractListings(body),
    nextPageToken: body?.pagination?.nextPageToken ?? body?.nextPageToken ?? null,
  };
}

// ─── Normalize raw → Listing schema ────────────────────────────────────
function normalizeAirbnb(raw, context = {}) {
  const { nights, checkIn, checkOut, city } = context;
  const images = Array.isArray(raw.photos) ? raw.photos.filter(Boolean) : [];

  return {
    // Source tracking
    originalPlatform: 'Airbnb',
    originalId:       String(raw.id),
    rawSource:        raw,

    // Location — Airbnb withholds street addresses by design, so `address`
    // and `zipCode` stay null. City is carried over from the search term
    // because GET /api/listings?city= depends on it being populated.
    // `neighborhood` stays null on purpose: the title reads "Loft in New York",
    // and that trailing segment is the city/region, not a neighborhood. Storing
    // it here would put "New York" in the neighborhood field.
    address:      null,
    neighborhood: null,
    city:         city || null,
    zipCode:      null,
    location: {
      type:        'Point',
      coordinates: [raw.longitude, raw.latitude],
    },

    // Financials
    pricePerMonth: toMonthlyPrice(raw.price, nights),

    // Property details
    spaceType:    resolveSpaceType(raw),
    propertyType: inferPropertyType(raw),
    bedrooms:     raw.beds ?? null,  // absent from search results
    bathrooms:    raw.baths ?? null, // absent from search results
    squareFeet:   null,              // Airbnb never publishes square footage

    // Every Airbnb is furnished — this is the whole reason the source is
    // valuable for interns, and the one flag we can hardcode with confidence.
    isFurnished:        true,
    hasInUnitLaundry:   false, // in the /property amenities, not search
    hasAirConditioning: false,
    hasParking:         false,
    amenitiesRaw:       [],

    // Lease terms — checkIn/checkOut are real availability, not a fallback.
    //
    // minimumLeaseDays records the search window, which is a PROVEN UPPER
    // BOUND rather than an exact figure: Airbnb only returns listings that are
    // bookable for the requested window, so a listing appearing in a 30-night
    // search demonstrably accepts 30 nights. Its true minimum may be lower.
    //
    // That direction is the safe one for a `$lte` filter — an intern searching
    // "90 days or less" gets every listing that qualifies. The only cost is
    // that a listing with a true 2-night minimum records as 30, so a "7 days
    // or less" search would miss it. Airbnb has no minimum-nights field in
    // either its search or /property response, so this is the only signal
    // available, and leaving it null hid the one genuinely short-term source
    // behind "unknown".
    minimumLeaseDays: nights ?? null,
    availableFrom:    checkIn ? new Date(checkIn) : new Date(),
    availableTo:      checkOut ? new Date(checkOut) : undefined,

    listingUrl: raw.url || `https://www.airbnb.com/rooms/${raw.id}`,
    images,
  };
}

// ─── Entry point ───────────────────────────────────────────────────────
async function ingestCity(city, state, { nights = 30, checkIn, pages = 1, dryRun = false, quiet = false } = {}) {
  if (!city) throw new Error('ingestCity requires a city');
  await ensureConnection();

  const location = state ? `${city}, ${state}` : city;

  // Default to a 30-night stay a month out: far enough ahead to have real
  // inventory, long enough to trigger Airbnb monthly pricing.
  const start = checkIn ? new Date(checkIn) : addDays(new Date(), 30);
  const end = addDays(start, nights);

  const context = { nights, checkIn: isoDate(start), checkOut: isoDate(end), city };
  let nextPageToken;

  return runIngest({
    label: `"${location}" ${nights}-night stays from HasData/Airbnb (${context.checkIn} → ${context.checkOut})`,
    pages,
    dryRun,
    quiet,
    fetchPage: async (page) => {
      // Airbnb paginates by opaque token, not page number. Page 1 sends none;
      // every later page replays the token the previous response handed back.
      if (page > 1 && !nextPageToken) return { raws: [], context };

      const result = await fetchAirbnbListings({
        location,
        checkIn:  context.checkIn,
        checkOut: context.checkOut,
        nextPageToken,
      });
      nextPageToken = result.nextPageToken;
      return { raws: result.raws, context };
    },
    normalize: normalizeAirbnb,
  });
}

if (require.main === module) {
  const { keyword, pages, dryRun, checkIn, nights } = parseCliArgs(process.argv);
  const [city, state] = (keyword || 'Seattle, WA').split(',').map((s) => s.trim());

  ingestCity(city, state, { nights: nights || 30, checkIn, pages, dryRun })
    .then(() => mongoose.connection.close())
    .catch(handleFatal);
}

module.exports = {
  ingestCity,
  fetchAirbnbListings,
  normalizeAirbnb,
  toMonthlyPrice,
  mapSpaceType,
  resolveSpaceType,
  inferSpaceTypeFromTitle,
  inferPropertyType,
};
