// Regression tests pinned to the exact payloads the live APIs returned on
// 2026-08-27. If a source changes shape, these fail before the data is corrupted.
process.env.HASDATA_API_KEY = 'offline-test';

const Listing = require('../../models/Listing');
const zillow = require('../../ingest/zillow');
const airbnb = require('../../ingest/airbnb');
const redfin = require('../../ingest/redfin');
const { findBlockingGaps } = require('../../ingest/lib/pipeline');

const results = [];
const check = (name, pass, detail) =>
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' -> ' + detail : ''}`);

function validate(label, doc) {
  const err = new Listing(doc).validateSync();
  check(`${label}: mongoose accepts`, !err, err ? Object.keys(err.errors).join(', ') : 'valid');
  const gaps = findBlockingGaps(doc);
  check(`${label}: would be INGESTED (not skipped)`, gaps.length === 0, gaps.join(', ') || 'no gaps');
}

// ══ ZILLOW — live payload, 3640 Densmore Ave N ═════════════════════════
const zLive = {
  id: '48920082',
  url: 'https://www.zillow.com/homedetails/3640-Densmore-Ave-N-Seattle-WA-98103/48920082_zpid/',
  homeType: 'SINGLE_FAMILY',
  image: 'https://photos.zillowstatic.com/fp/29536a879f25bafb3e502b4a47d22ba5-p_e.jpg',
  status: 'FOR_RENT',
  currency: '$',
  price: 3900,
  zestimate: 883900,
  rentZestimate: 3161,
  daysOnZillow: 0,
  area: 1040,
  addressRaw: '3640 Densmore Ave N, Seattle, WA 98103',
  address: { street: '3640 Densmore Ave N', city: 'Seattle', state: 'WA', zipcode: '98103' },
  latitude: 47.65173,
  longitude: -122.337135,
  beds: 2,
  baths: 1,
  mediaDetails: { has3DModel: false, hasVideo: false },
  photos: ['https://photos.zillowstatic.com/fp/a.jpg', 'https://photos.zillowstatic.com/fp/b.jpg'],
};
const z = zillow.normalizeZillow(zLive);
validate('zillow LIVE', z);
check('zillow: SINGLE_FAMILY -> House', z.propertyType === 'House', z.propertyType);
check('zillow: price 3900', z.pricePerMonth === 3900, String(z.pricePerMonth));
check('zillow: beds 2', z.bedrooms === 2, String(z.bedrooms));
check('zillow: sqft 1040', z.squareFeet === 1040, String(z.squareFeet));
check('zillow: coords [lng,lat]', z.location.coordinates[0] === -122.337135, JSON.stringify(z.location.coordinates));
check('zillow: zestimate did NOT leak into price', z.pricePerMonth !== 883900, String(z.pricePerMonth));

// ══ AIRBNB — live payload, qualifier is "monthly" not "night" ══════════
const aLive = {
  id: '38962977',
  url: 'https://www.airbnb.com/rooms/38962977',
  title: 'Apartment in Queen Anne',
  latitude: 47.64172,
  longitude: -122.35739,
  description: '1BR Queen Anne ADU',
  photos: ['https://a0.muscache.com/im/pictures/x.jpg'],
  rating: 4.89,
  reviews: 9,
  price: {
    originalPrice: '$3,742',
    discountedPrice: '$3,281',
    qualifier: 'monthly',
    breakdown: [
      { description: 'Average monthly price', price: '$3,742.00' },
      { description: 'Monthly stay discount', price: '-$357.00' },
      { description: 'Airbnb monthly stay savings', price: '-$104.94' },
    ],
  },
};
const aCtx = { nights: 30, checkIn: '2026-09-26', checkOut: '2026-10-26', city: 'Seattle' };
const a = airbnb.normalizeAirbnb(aLive, aCtx);
validate('airbnb LIVE', a);
check('airbnb: "monthly" NOT multiplied by 30.44', a.pricePerMonth === 3281, String(a.pricePerMonth));
check('airbnb: used discounted not original', a.pricePerMonth !== 3742, String(a.pricePerMonth));
check('airbnb: isFurnished true', a.isFurnished === true, String(a.isFurnished));
check('airbnb: no roomType -> Entire Place from title', a.spaceType === 'Entire Place', a.spaceType);

// The regression that matters: roomType is ABSENT from live payloads.
check('airbnb: "Room in Seattle" -> Private Room',
  airbnb.resolveSpaceType({ title: 'Room in Seattle' }) === 'Private Room',
  airbnb.resolveSpaceType({ title: 'Room in Seattle' }));
check('airbnb: "Shared room in Ballard" -> Shared Room',
  airbnb.resolveSpaceType({ title: 'Shared room in Ballard' }) === 'Shared Room',
  airbnb.resolveSpaceType({ title: 'Shared room in Ballard' }));
check('airbnb: "Private room in Fremont" -> Private Room',
  airbnb.resolveSpaceType({ title: 'Private room in Fremont' }) === 'Private Room',
  airbnb.resolveSpaceType({ title: 'Private room in Fremont' }));
check('airbnb: "Condo in Belltown" -> Entire Place',
  airbnb.resolveSpaceType({ title: 'Condo in Belltown' }) === 'Entire Place',
  airbnb.resolveSpaceType({ title: 'Condo in Belltown' }));
// Must not be fooled by a room mentioned mid-title
check('airbnb: "Loft with game room in Ballard" -> Entire Place',
  airbnb.resolveSpaceType({ title: 'Loft with game room in Ballard' }) === 'Entire Place',
  airbnb.resolveSpaceType({ title: 'Loft with game room in Ballard' }));
// Structured roomType still wins when present
check('airbnb: roomType overrides title',
  airbnb.resolveSpaceType({ roomType: 'private_room', title: 'Apartment in Queen Anne' }) === 'Private Room');
// Nightly pricing must still scale (shorter searches return per-night)
check('airbnb: nightly still scales',
  airbnb.toMonthlyPrice({ discountedPrice: '$157', qualifier: 'night' }, 30) === Math.round(157 * 30.44));

// ══ REDFIN — live payload, Park Hill: EVERYTHING is a {min,max} range ══
const rLive = {
  id: '2081811',
  propertyName: 'Park Hill',
  url: 'https://www.redfin.com/WA/Seattle/Park-Hill/apartment/2081811',
  image: 'https://ssl.cdn-redfin.com/photo/rent/x/islphoto/genIsl.0_5.jpg',
  status: 'FOR_RENT',
  area:  { min: 497, max: 1163 },
  beds:  { min: 1, max: 2 },
  baths: { min: 1, max: 2 },
  availableUnits: 0,
  currency: 'USD',
  price: { min: 1420, max: 2900 },
  addressRaw: '12511 69th Ave S, Seattle, WA 98178',
  address: { street: '12511 69th Ave S', city: 'Seattle', state: 'WA', zipcode: '98178' },
  latitude: 47.4897616,
  longitude: -122.2482846,
  description: 'Welcome to your new home at Park Hill Apartments in Seattle, Washington!...',
  agentEmail: 'stop@rent.com',
  agentPhone: '2537854530',
  photos: ['https://ssl.cdn-redfin.com/photo/rent/x/islphoto/genIsl.0_5.jpg'],
};
const r = redfin.normalizeRedfin(rLive);
validate('redfin LIVE', r);
check('redfin: price range -> min 1420', r.pricePerMonth === 1420, String(r.pricePerMonth));
check('redfin: beds range -> 1 (number, not object)', r.bedrooms === 1, JSON.stringify(r.bedrooms));
check('redfin: baths range -> 1 (number, not object)', r.bathrooms === 1, JSON.stringify(r.bathrooms));
check('redfin: area range -> 497 (number, not object)', r.squareFeet === 497, JSON.stringify(r.squareFeet));
check('redfin: addressRaw keeps the zip', r.address === '12511 69th Ave S, Seattle, WA 98178', r.address);
check('redfin: zipCode', r.zipCode === '98178', r.zipCode);
check('redfin: propertyType from URL /apartment/', r.propertyType === 'Apartment', r.propertyType);
check('redfin: coords [lng,lat]', r.location.coordinates[0] === -122.2482846, JSON.stringify(r.location.coordinates));

// URL-derived property type across Redfin's URL shapes
check('redfin: /home/ -> House',
  redfin.normalizeRedfin({ ...rLive, url: 'https://www.redfin.com/WA/Seattle/123-Pine/home/999' }).propertyType === 'House',
  redfin.normalizeRedfin({ ...rLive, url: 'https://www.redfin.com/WA/Seattle/123-Pine/home/999' }).propertyType);
// An explicit propertyType field must still win over the URL guess
check('redfin: explicit propertyType wins over URL',
  redfin.normalizeRedfin({ ...rLive, propertyType: 'Townhouse' }).propertyType === 'Townhouse',
  redfin.normalizeRedfin({ ...rLive, propertyType: 'Townhouse' }).propertyType);
// Ranges collapsed to a single value must not become NaN
check('redfin: null beds stays null',
  redfin.normalizeRedfin({ ...rLive, beds: null }).bedrooms === null,
  String(redfin.normalizeRedfin({ ...rLive, beds: null }).bedrooms));
check('redfin: empty range object -> null',
  redfin.normalizeRedfin({ ...rLive, beds: {} }).bedrooms === null,
  String(redfin.normalizeRedfin({ ...rLive, beds: {} }).bedrooms));

// The agent email must not trip the furnishing/room scanners
check('redfin: agentEmail stop@rent.com does not set Private Room',
  r.spaceType === 'Entire Place', r.spaceType);

// -- exports ---------------------------------------------------------
const failed = results.filter((r) => r.startsWith('FAIL')).length;
const summary = { name: 'live-payloads', passed: results.length - failed, failed, lines: results };

module.exports = { run: () => summary };

if (require.main === module) {
  console.log(results.join('\n'));
  console.log(`\n${summary.passed}/${results.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}
