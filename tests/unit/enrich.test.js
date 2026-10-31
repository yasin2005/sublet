// Lease-term extraction from Zillow's /property endpoint.
//
// Zillow returns TWO incompatible detail shapes and handling only the first
// silently yields nothing for roughly half the inventory — which is exactly
// what the first enrichment run did before these cases existed:
//
//   /homedetails/...  leaseTerm: "1 Year", rentalCosts.leaseDuration: 12
//   /apartments/...   floorPlans[].leaseTerm: "Available months 6,7,8,...,13"
process.env.HASDATA_API_KEY = 'offline-test';

const enrich = require('../../ingest/enrich');
const { createSuite } = require('../helpers/suite');

const s = createSuite('enrich');

// ── Single-unit shape ─────────────────────────────────────────────────
s.equal('leaseDuration 12 -> 365d', enrich.extractMinimumLeaseDays({ rentalCosts: { leaseDuration: 12 } }, '1'), 365);
s.equal('leaseDuration 6 -> 183d', enrich.extractMinimumLeaseDays({ rentalCosts: { leaseDuration: 6 } }, '1'), 183);
s.equal('leaseDuration 1 -> 30d', enrich.extractMinimumLeaseDays({ rentalCosts: { leaseDuration: 1 } }, '1'), 30);
s.equal('"1 Year" -> 365d', enrich.extractMinimumLeaseDays({ leaseTerm: '1 Year' }, '1'), 365);
s.equal('"6 Months" -> 183d', enrich.extractMinimumLeaseDays({ leaseTerm: '6 Months' }, '1'), 183);
s.equal('"Month To Month" -> 30d', enrich.extractMinimumLeaseDays({ leaseTerm: 'Month To Month' }, '1'), 30);
s.equal('resoData.leaseTerm fallback', enrich.extractMinimumLeaseDays({ resoData: { leaseTerm: '2 Years' } }, '1'), 731);
s.equal('numeric field beats the string', enrich.extractMinimumLeaseDays({ rentalCosts: { leaseDuration: 6 }, leaseTerm: '1 Year' }, '1'), 183);

// ── Building shape: the real Vesper Apartments payload ────────────────
const vesper = {
  floorPlans: [{
    id: '2069976414', name: '1BD/1BA', beds: 1, baths: 1, area: 647, minPrice: 1895,
    leaseTerm: 'Available months 6,7,8,9,10,11,12,13',
    availableFrom: '2026-10-06T07:00:00.000Z',
    allowedPets: ['Cats', 'Dogs', 'Small Dogs'],
    units: [{
      id: '2069976414', unitNumber: 'A-403', area: 647, price: 1895,
      depositsAndFees: 500, availableFrom: '2026-10-06T07:00:00.000Z', beds: 1, baths: 1,
    }],
  }],
  petPolicies: ['Cats', 'SmallDogs', 'LargeDogs'],
  atAGlanceFacts: ['Apartment building', '1 bed', 'Pet-friendly', 'Garage parking'],
  rentalCosts: { applicationsAcceptedType: 'NOT_ELIGIBLE', pricesByBeds: [{ beds: 1, minPrice: 1895 }] },
};

// The SHORTEST offered term is the minimum — that is the whole point of the field.
s.equal('building: shortest of 6..13 -> 183d', enrich.extractMinimumLeaseDays(vesper, '2069976414'), 183);
s.check('floor plan matched by id', enrich.findFloorPlan(vesper, '2069976414') !== null);
s.check('matched via nested unit id', enrich.findFloorPlan({ floorPlans: [{ id: 'XX', units: [{ id: '99' }] }] }, '99') !== null);
s.equal('building-wide fallback when our id is unknown', enrich.extractMinimumLeaseDays(vesper, 'nope'), 183);
s.equal(
  'min across multiple floor plans',
  enrich.extractMinimumLeaseDays({ floorPlans: [{ leaseTerm: 'Available months 12' }, { leaseTerm: 'Available months 3,6' }] }, 'x'),
  91
);

// ── Extras that ride along on the same call ───────────────────────────
const extras = enrich.extractExtras(vesper, '2069976414');
s.check('availableFrom taken from the unit', extras.availableFrom.startsWith('2026-10-06'), extras.availableFrom);
s.equal('depositAmount', extras.depositAmount, 500);
s.equal('hasParking from atAGlanceFacts', extras.hasParking, true);
s.equal('pets: cats', extras.petsAllowed.cats, true);
s.equal('pets: small dogs', extras.petsAllowed.dogsSmall, true);
s.equal('pets: large dogs (petPolicies is explicit)', extras.petsAllowed.dogsLarge, true);

// A bare "Dogs" with no size qualifier means both sizes are welcome.
s.equal('bare "Dogs" -> both sizes', JSON.stringify(enrich.mapPets(['Cats', 'Dogs'])), JSON.stringify({ cats: true, dogsSmall: true, dogsLarge: true }));
s.equal('cats only -> no dogs', JSON.stringify(enrich.mapPets(['Cats'])), JSON.stringify({ cats: true, dogsSmall: false, dogsLarge: false }));
s.equal('empty pet list -> null', enrich.mapPets([]), null);

s.equal('resoData.furnished true is picked up', enrich.extractExtras({ resoData: { furnished: true } }, '1').isFurnished, true);
s.equal('resoData.furnished false is picked up', enrich.extractExtras({ resoData: { furnished: false } }, '1').isFurnished, false);
s.check('absent furnished key omits the field', !('isFurnished' in enrich.extractExtras({}, '1')));
s.check('unparseable date is omitted', !('availableFrom' in enrich.extractExtras({ availableFrom: 'not a date' }, '1')));

// ── Negatives: never invent a lease term ──────────────────────────────
s.equal('no lease info anywhere -> null', enrich.extractMinimumLeaseDays({ status: 'FOR_RENT' }, '1'), null);
s.equal('"Negotiable" -> null', enrich.extractMinimumLeaseDays({ leaseTerm: 'Negotiable' }, '1'), null);
s.equal('leaseDuration 0 is ignored', enrich.extractMinimumLeaseDays({ rentalCosts: { leaseDuration: 0 } }, '1'), null);
s.equal('rentalCosts without leaseDuration -> null', enrich.extractMinimumLeaseDays({ rentalCosts: { pricesByBeds: [] } }, '1'), null);
s.equal('no extras -> empty object', JSON.stringify(enrich.extractExtras({}, '1')), '{}');

module.exports = { run: () => s.result() };
if (require.main === module) process.exit(s.report().failed > 0 ? 1 : 0);
