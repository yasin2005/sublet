// Rules that decide what gets written and what gets skipped.
process.env.HASDATA_API_KEY = 'offline-test';

const zillow = require('../../ingest/zillow');
const airbnb = require('../../ingest/airbnb');
const { buildRefresh } = require('../../ingest/lib/upsert');
const { createSuite } = require('../helpers/suite');

const s = createSuite('ingest-rules');

// ── Zillow building cards ─────────────────────────────────────────────
// A real unit always has a numeric zpid. Apartment-complex cards are keyed by
// a lat-lng pair and carry no price, beds or type at all — skipping them is
// correct, and labelling them keeps the run log honest.
s.equal('coord id + homedetails url', zillow.isBuildingCard({ id: '47.617672--122.352394', url: 'https://www.zillow.com/homedetails/x/' }), true);
s.equal('coord id + /b/building/ url', zillow.isBuildingCard({ id: '47.60192--122.316414', url: 'https://www.zillow.com/b/building/47.60192,-122.316414_ll/' }), true);
s.equal('zpid + /apartments/ url', zillow.isBuildingCard({ id: '48920082', url: 'https://www.zillow.com/apartments/seattle-wa/ivy-ridge/' }), true);
s.equal('real unit: zpid + homedetails', zillow.isBuildingCard({ id: '2098671999', url: 'https://www.zillow.com/homedetails/209-Hancock-St/2098671999_zpid/' }), false);
s.equal('negative-latitude coord id', zillow.isBuildingCard({ id: '-33.86--151.20', url: 'https://www.zillow.com/x/' }), true);
s.equal('no id at all', zillow.isBuildingCard({ url: 'https://www.zillow.com/homedetails/x/' }), false);

s.check(
  'skip reason names the complex card',
  (zillow.describeZillowSkip({ id: '47.617672--122.352394', url: 'https://www.zillow.com/homedetails/x/' }, ['no parseable price']) || '').startsWith('apartment-complex')
);
s.equal('non-building falls through to the raw gap list', zillow.describeZillowSkip({ id: '2098671999', url: 'u' }, ['no coordinates']), null);

// ── Airbnb minimum-stay derivation ────────────────────────────────────
// Airbnb only returns listings bookable for the requested window, so the search
// window is a PROVEN UPPER BOUND on the minimum stay. It must never be invented
// when no window was given.
const raw = { id: '1', latitude: 47.6, longitude: -122.3, title: 'Apartment in Queen Anne', price: { discountedPrice: '$3,281', qualifier: 'monthly' } };
s.equal('30-night search -> 30d', airbnb.normalizeAirbnb(raw, { nights: 30, city: 'Seattle' }).minimumLeaseDays, 30);
s.equal('60-night search -> 60d', airbnb.normalizeAirbnb(raw, { nights: 60, city: 'Seattle' }).minimumLeaseDays, 60);
s.equal('no nights in context -> null', airbnb.normalizeAirbnb(raw, { city: 'Seattle' }).minimumLeaseDays, null);
s.equal('no context at all -> null', airbnb.normalizeAirbnb(raw).minimumLeaseDays, null);

// ── Upsert refresh rules ──────────────────────────────────────────────
// These protect enrichment data that costs 5 credits per listing to obtain.
// A search-endpoint re-ingest knows strictly LESS than a /property call.
const enrichedDoc = { enrichedAt: new Date('2026-08-27'), pricePerMonth: 3900 };
const reingest = {
  originalPlatform: 'Zillow', originalId: '48920082',
  firstSeenAt: new Date('2030-01-01'),        // must not reset provenance
  pricePerMonth: 4050,                        // must be refreshed
  minimumLeaseDays: null,                     // must NOT wipe the enriched 365
  availableFrom: new Date('2026-12-31'),      // must NOT overwrite the real date
  isFurnished: false,
  city: 'Seattle',
  bedrooms: null,                             // null must never clobber
};

const refreshed = buildRefresh(reingest, enrichedDoc);
s.check('identity is stripped', !('originalPlatform' in refreshed) && !('originalId' in refreshed));
s.check('firstSeenAt is stripped', !('firstSeenAt' in refreshed));
s.equal('price IS refreshed', refreshed.pricePerMonth, 4050);
s.check('minimumLeaseDays is protected', !('minimumLeaseDays' in refreshed));
s.check('availableFrom is protected', !('availableFrom' in refreshed));
s.check('isFurnished is protected once enriched', !('isFurnished' in refreshed));
s.check('null bedrooms never clobbers', !('bedrooms' in refreshed));
s.equal('city still refreshes', refreshed.city, 'Seattle');
s.equal('isActive forced true', refreshed.isActive, true);
s.check('lastSeenAt advanced', refreshed.lastSeenAt instanceof Date);

// An UN-enriched listing lets ingest write those same fields freely.
const plain = buildRefresh({ ...reingest, minimumLeaseDays: 90 }, { pricePerMonth: 3900 });
s.equal('un-enriched listing accepts a lease term', plain.minimumLeaseDays, 90);
s.check('un-enriched listing accepts isFurnished', 'isFurnished' in plain);

module.exports = { run: () => s.result() };
if (require.main === module) process.exit(s.report().failed > 0 ? 1 : 0);
