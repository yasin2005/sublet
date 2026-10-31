// Text inference: does it find real signals WITHOUT firing on lookalikes?
// The false-positive cases matter more than the true positives — "shared
// laundry" in an entire apartment must never read as a shared ROOM.
process.env.HASDATA_API_KEY = 'offline-test';

const { inferPropertyDetails } = require('../../ingest/lib/pipeline');
const Listing = require('../../models/Listing');

const results = [];
const check = (name, pass, detail) =>
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' -> ' + detail : ''}`);

const spaceOf = (payload) => inferPropertyDetails(payload).spaceType;
const furnOf = (payload) => inferPropertyDetails(payload).isFurnished;

// ══ TRUE POSITIVES: room inventory we must stop discarding ═════════════
const shouldBeShared = [
  { description: 'Shared room in a 3bd house, great for students' },
  { description: 'Roommate wanted for summer sublease' },
  { title: 'Share a bedroom near campus' },
  { description: 'Room to share, utilities included' },
];
for (const p of shouldBeShared) {
  check(`Shared Room: "${(p.description || p.title).slice(0, 40)}"`, spaceOf(p) === 'Shared Room', spaceOf(p));
}

const shouldBePrivate = [
  { description: 'Private room in quiet home, June-August' },
  { description: 'Room for rent, $900/mo, near light rail' },
  { title: 'Rooms for rent in Capitol Hill' },
  { description: 'Private bedroom with own bath' },
  { description: 'Sublet a room for the summer' },
];
for (const p of shouldBePrivate) {
  check(`Private Room: "${(p.description || p.title).slice(0, 40)}"`, spaceOf(p) === 'Private Room', spaceOf(p));
}

// ══ FALSE POSITIVES: the reason a bare /shared/ match is unusable ═══════
// Every one of these is an ENTIRE unit that a loose regex would mislabel.
const mustStayEntirePlace = [
  { description: 'Bright 2bd with shared laundry in the building' },
  { description: 'Townhome with shared walls, private entrance' },
  { description: 'Single family home, shared driveway with neighbor' },
  { description: 'Condo with shared outdoor space and rooftop deck' },
  { description: 'Spacious living room in a bright corner apartment' },
  { description: 'Large room in a newly renovated 1bd' },
  { description: 'Shared amenities include gym and pool' },
  { description: 'Shared bathroom between the two bedrooms' },
  { description: '3 bedrooms available for a family' },
];
for (const p of mustStayEntirePlace) {
  check(`Entire Place: "${p.description.slice(0, 45)}"`, spaceOf(p) === 'Entire Place', spaceOf(p));
}

// ══ FURNISHING, including the negation and noise-key traps ═════════════
check('furnished: "Fully furnished"', furnOf({ description: 'Fully furnished, move-in ready' }) === true);
check('furnished: "unfurnished" -> false', furnOf({ description: 'Large unfurnished unit' }) === false);
check('furnished: "unfurnished but can be furnished" -> true',
  furnOf({ description: 'Comes unfurnished but can be furnished on request' }) === true);

// These three are why the noisy keys get stripped before scanning.
check('furnished: URL slug does NOT trigger',
  furnOf({ url: 'https://www.zillow.com/furnished-apartments/seattle-wa/', description: 'Nice 1bd' }) === false,
  String(furnOf({ url: 'https://www.zillow.com/furnished-apartments/seattle-wa/', description: 'Nice 1bd' })));
check('furnished: brokerName does NOT trigger',
  furnOf({ brokerName: 'Furnished Finder Realty', description: 'Nice 1bd' }) === false,
  String(furnOf({ brokerName: 'Furnished Finder Realty', description: 'Nice 1bd' })));
check('furnished: photo filename does NOT trigger',
  furnOf({ photos: ['https://cdn.example.com/furnished-living-room.jpg'], description: 'Nice 1bd' }) === false,
  String(furnOf({ photos: ['https://cdn.example.com/furnished-living-room.jpg'], description: 'Nice 1bd' })));
check('shared: URL slug does NOT trigger spaceType',
  spaceOf({ url: 'https://redfin.com/b/shared-room-seattle', description: 'Whole 2bd unit' }) === 'Entire Place',
  spaceOf({ url: 'https://redfin.com/b/shared-room-seattle', description: 'Whole 2bd unit' }));

// ══ AMENITY FLAGS ══════════════════════════════════════════════════════
const amen = (p) => inferPropertyDetails(p);
check('A/C: "Central air"', amen({ description: 'Central air and heat' }).hasAirConditioning === true);
check('A/C: "A/C"', amen({ amenities: ['A/C', 'Dishwasher'] }).hasAirConditioning === true);
check('A/C: absent -> false', amen({ description: 'Cozy 1bd' }).hasAirConditioning === false);
check('laundry: "In-unit laundry"', amen({ amenities: ['In-unit laundry'] }).hasInUnitLaundry === true);
check('laundry: "washer/dryer"', amen({ description: 'Has washer/dryer' }).hasInUnitLaundry === true);
check('laundry: "shared laundry" -> false', amen({ description: 'Shared laundry on site' }).hasInUnitLaundry === false,
  String(amen({ description: 'Shared laundry on site' }).hasInUnitLaundry));
check('parking: "garage"', amen({ description: 'One car garage' }).hasParking === true);
check('parking: "No parking" -> false', amen({ description: 'No parking available' }).hasParking === false,
  String(amen({ description: 'No parking available' }).hasParking));

// ══ Inferred spaceType values must satisfy the schema enum ═════════════
for (const st of ['Entire Place', 'Private Room', 'Shared Room']) {
  const doc = new Listing({
    originalPlatform: 'Zillow', originalId: 'x',
    location: { type: 'Point', coordinates: [-122, 47] },
    pricePerMonth: 1000, spaceType: st, propertyType: 'Apartment',
    availableFrom: new Date(), listingUrl: 'https://x',
  });
  const err = doc.validateSync();
  check(`enum accepts "${st}"`, !err, err ? Object.keys(err.errors).join(',') : 'valid');
}

// -- exports ---------------------------------------------------------
const failed = results.filter((r) => r.startsWith('FAIL')).length;
const summary = { name: 'inference', passed: results.length - failed, failed, lines: results };

module.exports = { run: () => summary };

if (require.main === module) {
  console.log(results.join('\n'));
  console.log(`\n${summary.passed}/${results.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}
