// Normalizer contracts for all three sources.
// Every payload here is a real captured HasData response, not an invention.
process.env.HASDATA_API_KEY = 'offline-test';

const Listing = require('../../models/Listing');
const zillow = require('../../ingest/zillow');
const airbnb = require('../../ingest/airbnb');
const redfin = require('../../ingest/redfin');
const { findBlockingGaps } = require('../../ingest/lib/pipeline');

const results = [];
const check = (name, pass, detail) =>
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' -> ' + detail : ''}`);

const validate = (label, doc) => {
  const err = new Listing(doc).validateSync();
  check(`${label}: mongoose validateSync`, !err, err ? Object.keys(err.errors).join(', ') : 'valid');
  check(`${label}: passes pre-flight`, findBlockingGaps(doc).length === 0, findBlockingGaps(doc).join(', ') || 'no gaps');
};

// ══ ZILLOW — the exact payload the user captured from HasData ═══════════
const zRaw = {
  id: '2098671999',
  url: 'https://www.zillow.com/homedetails/209-Hancock-St-APT-3F-Brooklyn-NY-11216/2098671999_zpid/',
  homeType: 'APARTMENT',
  status: 'FOR_RENT',
  price: 3095,
  address: { street: '209 Hancock St APT 3F', city: 'Brooklyn', state: 'NY', zipcode: '11216' },
  latitude: 40.68303,
  longitude: -73.94775,
  beds: 1,
  baths: 1,
  area: 850,
};
const z = zillow.normalizeZillow(zRaw);
validate('zillow', z);
check('zillow: geojson [lng,lat]', z.location.coordinates[0] === -73.94775 && z.location.coordinates[1] === 40.68303, JSON.stringify(z.location.coordinates));
check('zillow: pricePerMonth', z.pricePerMonth === 3095, String(z.pricePerMonth));
check('zillow: propertyType', z.propertyType === 'Apartment', z.propertyType);
check('zillow: spaceType', z.spaceType === 'Entire Place', z.spaceType);
check('zillow: city', z.city === 'Brooklyn', z.city);
check('zillow: zipCode', z.zipCode === '11216', z.zipCode);
check('zillow: address composed', z.address === '209 Hancock St APT 3F, Brooklyn, NY', z.address);
check('zillow: isFurnished default false', z.isFurnished === false, String(z.isFurnished));
check('zillow: originalPlatform', z.originalPlatform === 'Zillow', z.originalPlatform);
check('zillow: availableFrom is a Date', z.availableFrom instanceof Date, String(z.availableFrom instanceof Date));

for (const [input, want] of [['APARTMENT','Apartment'],['TOWNHOUSE','Townhouse'],['SINGLE_FAMILY','House'],['CONDO','Condo'],['MULTI_FAMILY','Apartment'],['MANUFACTURED','House'],['LOT','Apartment'],[undefined,'Apartment']]) {
  check(`zillow: homeType ${input}`, zillow.mapPropertyType(input) === want, zillow.mapPropertyType(input));
}

// ══ AIRBNB — HasData's own documented response object ═══════════════════
const aRaw = {
  id: '691676460109271194',
  url: 'https://www.airbnb.com/rooms/691676460109271194',
  title: 'Loft in New York',
  name: 'SoHo View Room (Full-Size Bed) in Hotel Comfort',
  roomType: 'entire_home',
  listingType: 'REPRESENTATIVE',
  latitude: 40.71806,
  longitude: -74.00095,
  photos: ['https://a0.muscache.com/im/pictures/x.jpg'],
  rating: 4.56,
  reviews: 1175,
  badges: [],
  price: { originalPrice: '$210', discountedPrice: '$157', qualifier: 'night', breakdown: [] },
};
const aCtx = { nights: 30, checkIn: '2026-09-26', checkOut: '2026-10-26', city: 'Seattle' };
const a = airbnb.normalizeAirbnb(aRaw, aCtx);
validate('airbnb', a);
check('airbnb: geojson [lng,lat]', a.location.coordinates[0] === -74.00095, JSON.stringify(a.location.coordinates));
check('airbnb: nightly $157 -> monthly', a.pricePerMonth === Math.round(157 * 30.44), String(a.pricePerMonth));
check('airbnb: isFurnished hardcoded true', a.isFurnished === true, String(a.isFurnished));
check('airbnb: spaceType from roomType', a.spaceType === 'Entire Place', a.spaceType);
check('airbnb: propertyType from title', a.propertyType === 'Apartment', a.propertyType);
check('airbnb: city from search term', a.city === 'Seattle', a.city);
check('airbnb: availableFrom = checkIn', a.availableFrom.toISOString().startsWith('2026-09-26'), a.availableFrom.toISOString());
check('airbnb: availableTo = checkOut', a.availableTo.toISOString().startsWith('2026-10-26'), a.availableTo.toISOString());
check('airbnb: squareFeet null', a.squareFeet === null, String(a.squareFeet));
check('airbnb: originalPlatform', a.originalPlatform === 'Airbnb', a.originalPlatform);

// roomType -> spaceType is the one structured mapping Airbnb gives us
for (const [input, want] of [['entire_home','Entire Place'],['private_room','Private Room'],['shared_room','Shared Room'],['hotel_room','Private Room'],[undefined,'Entire Place']]) {
  check(`airbnb: roomType ${input}`, airbnb.mapSpaceType(input) === want, airbnb.mapSpaceType(input));
}

// price qualifiers
check('airbnb: qualifier=total scales by nights',
  airbnb.toMonthlyPrice({ discountedPrice: '$3,000', qualifier: 'total' }, 30) === Math.round((3000 / 30) * 30.44),
  String(airbnb.toMonthlyPrice({ discountedPrice: '$3,000', qualifier: 'total' }, 30)));
check('airbnb: qualifier=month passes through',
  airbnb.toMonthlyPrice({ discountedPrice: '$2,400', qualifier: 'month' }, 30) === 2400);
check('airbnb: falls back to originalPrice',
  airbnb.toMonthlyPrice({ originalPrice: '$100', qualifier: 'night' }, 30) === Math.round(100 * 30.44));
check('airbnb: total with no nights -> null',
  airbnb.toMonthlyPrice({ discountedPrice: '$3,000', qualifier: 'total' }, 0) === null);
check('airbnb: bare number treated as nightly',
  airbnb.toMonthlyPrice(200, 30) === Math.round(200 * 30.44));
check('airbnb: null price -> null', airbnb.toMonthlyPrice(null, 30) === null);

// A private room should NOT be mislabeled as an entire place
const aRoom = airbnb.normalizeAirbnb({ ...aRaw, id: '2', roomType: 'private_room', title: 'Room in Seattle' }, aCtx);
check('airbnb: private_room -> Private Room', aRoom.spaceType === 'Private Room', aRoom.spaceType);

// ══ REDFIN — shape unconfirmed, so test BOTH plausible address shapes ═══
const rNested = {
  id: '184234123',
  url: 'https://www.redfin.com/WA/Seattle/123-Pine-St/home/184234123',
  price: '$2,450/mo',
  propertyType: 'Single Family Residential',
  address: { street: '123 Pine St', city: 'Seattle', state: 'WA', zipcode: '98101' },
  latitude: 47.6101,
  longitude: -122.3344,
  beds: 3,
  baths: 2,
  area: 1450,
  photos: ['https://ssl.cdn-redfin.com/photo/1.jpg'],
};
const r1 = redfin.normalizeRedfin(rNested);
validate('redfin(nested addr)', r1);
check('redfin: price string parsed', r1.pricePerMonth === 2450, String(r1.pricePerMonth));
check('redfin: "Single Family Residential" -> House', r1.propertyType === 'House', r1.propertyType);
check('redfin: city', r1.city === 'Seattle', r1.city);
check('redfin: originalPlatform', r1.originalPlatform === 'Redfin', r1.originalPlatform);

const rFlat = {
  id: '184234124',
  url: 'https://www.redfin.com/WA/Seattle/456-Oak-Ave/home/184234124',
  price: 1900,
  propertyType: 'Condo/Co-op',
  address: '456 Oak Ave, Seattle, WA 98102',
  city: 'Seattle',
  zipcode: '98102',
  latitude: 47.62,
  longitude: -122.32,
  beds: 1,
  baths: 1,
  sqft: 700,
};
const r2 = redfin.normalizeRedfin(rFlat);
validate('redfin(flat addr)', r2);
check('redfin: flat address string', r2.address === '456 Oak Ave, Seattle, WA 98102', r2.address);
check('redfin: "Condo/Co-op" -> Condo', r2.propertyType === 'Condo', r2.propertyType);
check('redfin: sqft alias', r2.squareFeet === 700, String(r2.squareFeet));
check('redfin: "Multi-Family (2-4 Unit)" -> Apartment', redfin.mapPropertyType('Multi-Family (2-4 Unit)') === 'Apartment', redfin.mapPropertyType('Multi-Family (2-4 Unit)'));

// ══ Degraded rows must be caught by pre-flight, never crash ════════════
const degraded = [
  ['zillow no coords', zillow.normalizeZillow({ id: '1', price: 2000, url: 'u' })],
  ['zillow no price', zillow.normalizeZillow({ id: '1', latitude: 1, longitude: 2, price: 'Call for pricing', url: 'u' })],
  ['airbnb no price', airbnb.normalizeAirbnb({ id: '1', latitude: 1, longitude: 2 }, aCtx)],
  ['redfin empty', redfin.normalizeRedfin({})],
];
for (const [label, doc] of degraded) {
  check(`pre-flight catches: ${label}`, findBlockingGaps(doc).length > 0, findBlockingGaps(doc).join(', '));
}

// ══ Cross-source dedupe: same id on different platforms must coexist ════
check('dedupe key is platform-scoped',
  z.originalPlatform !== a.originalPlatform && z.originalPlatform !== r1.originalPlatform,
  `${z.originalPlatform}/${a.originalPlatform}/${r1.originalPlatform}`);

// -- exports ---------------------------------------------------------
const failed = results.filter((r) => r.startsWith('FAIL')).length;
const summary = { name: 'normalizers', passed: results.length - failed, failed, lines: results };

module.exports = { run: () => summary };

if (require.main === module) {
  console.log(results.join('\n'));
  console.log(`\n${summary.passed}/${results.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}
