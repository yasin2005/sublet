// FurnishedFinder mapping, pinned to a real Apify payload.
//
// The actor's published documentation was wrong in both directions, so every
// assertion here is against a record the actor actually returned
// (Seattle, WA — 2026-08-27, run zeeRgRypaz4Zxdxnj). The docs promised
// spaceDescription / houseRules / bedList / fees / avgRating and a top-level
// utilitiesIncluded that do not exist, and omitted propertyTypeClass,
// laundryType, availableOnDate and isAvailableNow, which do.
process.env.HASDATA_API_KEY = 'offline-test';

const Listing = require('../../models/Listing');
const ff = require('../../ingest/furnishedfinder');
const { findBlockingGaps } = require('../../ingest/lib/pipeline');
const { createSuite } = require('../helpers/suite');

const s = createSuite('furnishedfinder');

const live = {
  id: '1030806_1',
  url: 'https://www.furnishedfinder.com/property/1030806_1',
  title: 'Fremont Living Made Easy - Furnished Condo with Parking & AC',
  propertyType: 'Condo',
  city: 'Seattle',
  state: 'WA',
  latitude: 47.65436,
  longitude: -122.357504,
  monthlyPrice: 2950,
  monthlyPriceText: '$2,950/month',
  bedrooms: 1,
  bathrooms: 1,
  scrapedAt: '2026-08-27T09:01:18.171668+00:00',
  propertyTypeClass: 'entire_unit',
  laundryType: 'IN_UNIT',
  availableOnDate: 'Available: Sep. 13, 2026',
  isAvailableNow: false,
  isRegionMatch: true,
  isGoodResponder: false,
  minimumStayDays: 30,
  photos: ['a.jpg', 'b.jpg'],
  amenities: [
    'airConditioning', 'coveredParking', 'freeParkingOnPremises',
    'utilitiesIncluded', 'washeranddryer', 'kitchen', 'heating',
  ],
  inputUrl: 'https://www.furnishedfinder.com/housing/us--wa--seattle',
  sourceType: 'structured',
};

const n = ff.normalizeFurnishedFinder(live);

// ── Schema conformance ────────────────────────────────────────────────
const err = new Listing(n).validateSync();
s.check('mongoose accepts the document', !err, err ? Object.keys(err.errors).join(', ') : 'valid');
s.check('passes pre-flight', findBlockingGaps(n).length === 0, findBlockingGaps(n).join(', ') || 'no gaps');

// ── The reason this source exists ─────────────────────────────────────
// Confirmed DAYS, not months: the live sample returned 30, 30, 30, 90, 30.
s.equal('minimumLeaseDays is read as days', n.minimumLeaseDays, 30);
s.equal('a 90-day minimum survives', ff.normalizeFurnishedFinder({ ...live, minimumStayDays: 90 }).minimumLeaseDays, 90);
s.equal('absent minimumStayDays -> null, never invented', ff.normalizeFurnishedFinder({ ...live, minimumStayDays: undefined }).minimumLeaseDays, null);

// ── Core mapping ──────────────────────────────────────────────────────
s.equal('platform', n.originalPlatform, 'FurnishedFinder');
s.equal('originalId keeps its underscore form', n.originalId, '1030806_1');
s.equal('price from monthlyPrice', n.pricePerMonth, 2950);
s.equal('price falls back to monthlyPriceText', ff.normalizeFurnishedFinder({ ...live, monthlyPrice: undefined }).pricePerMonth, 2950);
s.equal('geojson is [lng, lat]', JSON.stringify(n.location.coordinates), JSON.stringify([-122.357504, 47.65436]));
s.equal('propertyType', n.propertyType, 'Condo');
s.equal('bedrooms', n.bedrooms, 1);
s.equal('address withheld by the platform', n.address, null);
s.equal('isFurnished hardcoded true', n.isFurnished, true);

// ── propertyTypeClass beats text inference ────────────────────────────
s.equal('entire_unit', n.spaceType, 'Entire Place');
s.equal('private_room', ff.resolveSpaceType({ propertyTypeClass: 'private_room' }), 'Private Room');
s.equal('shared_room', ff.resolveSpaceType({ propertyTypeClass: 'shared_room' }), 'Shared Room');
s.equal('unknown class falls back to inference', ff.resolveSpaceType({ propertyTypeClass: 'weird', title: 'Private room for rent' }), 'Private Room');
s.equal('missing class falls back to inference', ff.resolveSpaceType({ title: 'Shared room in a house' }), 'Shared Room');

// ── camelCase amenity tokens ──────────────────────────────────────────
// The shared text inference is tuned for prose and matches none of these:
// /\bair conditioning\b/ never matches "airConditioning".
s.equal('airConditioning token', n.hasAirConditioning, true);
s.equal('parking token', n.hasParking, true);
s.equal('laundryType IN_UNIT', n.hasInUnitLaundry, true);
s.equal('utilitiesIncluded is a TOKEN, not a top-level field', n.utilitiesIncluded, true);
s.equal('laundryType SHARED is not in-unit', ff.amenityFlags({ laundryType: 'SHARED', amenities: [] }).hasInUnitLaundry, false);
s.equal('washeranddryer token alone', ff.amenityFlags({ amenities: ['washeranddryer'] }).hasInUnitLaundry, true);
s.equal('no amenities -> all false', JSON.stringify(ff.amenityFlags({})), JSON.stringify({ hasAirConditioning: false, hasParking: false, hasInUnitLaundry: false, utilitiesIncluded: false }));

// ── availableOnDate is a display string, not a timestamp ──────────────
s.equal('parses "Available: Sep. 13, 2026"', n.availableFrom.toISOString().slice(0, 10), '2026-09-13');
s.check('isAvailableNow short-circuits to now', ff.parseAvailability({ isAvailableNow: true }) instanceof Date);
s.check('unparseable date falls back to now', ff.parseAvailability({ availableOnDate: 'whenever' }) instanceof Date);

// ── Actor input: the failure that started this ────────────────────────
s.equal('city and state become the site search URL', JSON.stringify(ff.buildActorInput({ city: 'Seattle', state: 'wa', maxItems: 5 }).urls), JSON.stringify(['https://www.furnishedfinder.com/housing/us--wa--seattle']));
s.equal('multi-word and punctuated cities slug cleanly', ff.searchUrl('St. Louis', 'MO'), 'https://www.furnishedfinder.com/housing/us--mo--st-louis');
s.equal('paid add-ons stay off', JSON.stringify([ff.buildActorInput({ city: 'X', state: 'Y' }).listingDetails, ff.buildActorInput({ city: 'X', state: 'Y' }).hostInfo]), JSON.stringify([false, false]));
s.equal('maxItems clamped to the actor ceiling', ff.buildActorInput({ city: 'X', state: 'Y', maxItems: 99999 }).maxItems, 1000);
s.equal('maxItems floors at 1', ff.buildActorInput({ city: 'X', state: 'Y', maxItems: 0 }).maxItems, 100);
s.check('missing state throws rather than sending a bad run', (() => {
  try { ff.buildActorInput({ city: 'Seattle' }); return false; } catch { return true; }
})());
s.check('undeclared fields are not sent', !('keyword' in ff.buildActorInput({ city: 'X', state: 'Y' })));

// ── datascrapers/furnishedfinder payload (2026-10) ────────────────────
// Pinned to a real record (Tucson, AZ — 2026-10-30), trimmed. Same facts as
// the old actor under different names.
const gql = {
  propertyType: 'Room - House',
  propertyTypeClass: 'room',
  approxLocation: { latitude: 32.260176781596364, longitude: -110.89665269033918, __typename: 'LatLng' },
  name: 'Furnished Private Room with Ensuite Bath & Separate Entrance - Near TMC',
  listingId: '1054886_1',
  laundryType: 'SHARED',
  encodedLocationName: 'us--az--tucson',
  availableOnDate: 'Available',
  isAvailableNow: true,
  minimumStayInDays: 30,
  photos: [{ url: 'https://staticproperties.furnishedfinder.com/1054886/1/a.jpg', isFeatured: true, __typename: 'Image' }],
  rentAmount: { amount: '900.00', currency: 'USD', __typename: 'Money' },
  bedroomCount: 1,
  bathroomCount: 1,
  amenities: ['airConditioning', 'freeParkingOnPremises', 'utilitiesIncluded', 'washeranddryeronpremises'],
  url: 'https://www.furnishedfinder.com/property/1054886_1',
};
const g = ff.normalizeFurnishedFinder(gql, { city: 'Tucson', state: 'AZ' });
const gErr = new Listing(g).validateSync();

s.check('new payload: mongoose accepts it', !gErr, gErr ? Object.keys(gErr.errors).join(', ') : 'valid');
s.check('new payload: passes pre-flight', findBlockingGaps(g).length === 0, findBlockingGaps(g).join(', ') || 'no gaps');
s.equal('listingId keeps the old id form, so rows refresh', g.originalId, '1054886_1');
s.equal('rentAmount.amount string', g.pricePerMonth, 900);
s.equal('approxLocation -> [lng, lat]', JSON.stringify(g.location.coordinates), JSON.stringify([-110.89665269033918, 32.260176781596364]));
s.equal('minimumStayInDays', g.minimumLeaseDays, 30);
s.equal('bedroomCount', g.bedrooms, 1);
s.equal('"room" class -> Private Room', g.spaceType, 'Private Room');
s.equal('"Room - House" -> House', g.propertyType, 'House');
s.equal('photos as { url } objects', JSON.stringify(g.images), JSON.stringify(['https://staticproperties.furnishedfinder.com/1054886/1/a.jpg']));
s.equal('city from the search context', g.city, 'Tucson');
s.equal('shared laundry on premises is not in-unit', g.hasInUnitLaundry, false);
s.equal('no url -> built from listingId', ff.normalizeFurnishedFinder({ ...gql, url: undefined }).listingUrl, 'https://www.furnishedfinder.com/property/1054886_1');

module.exports = { run: () => s.result() };
if (require.main === module) process.exit(s.report().failed > 0 ? 1 : 0);
