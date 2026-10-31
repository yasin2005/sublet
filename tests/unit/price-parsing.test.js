// Price parsing across every shape the three sources actually emit.
//
// This file exists because a deliberately injected bug — taking the UPPER
// bound of a price range instead of the lower — passed the entire suite
// undetected. Range handling is the single most consequential rule in the
// normalizer: it decides what a user's maxPrice filter compares against, and
// it silently produces plausible-looking wrong numbers when broken.
process.env.HASDATA_API_KEY = 'offline-test';

const { parsePriceNumber, toNumber, unwrapRange } = require('../../ingest/lib/pipeline');
const { createSuite } = require('../helpers/suite');

const s = createSuite('price-parsing');

// ── Ranges take the LOWER bound ───────────────────────────────────────
// A maxPrice filter should match a building if ANY unit in it qualifies, and
// the site itself sorts on the cheapest unit.
s.equal('string range -> lower bound', parsePriceNumber('$1,800 - $2,400/mo'), 1800);
s.equal('en-dash range -> lower bound', parsePriceNumber('$1,800 – $2,400'), 1800);
s.equal('three numbers -> first', parsePriceNumber('$1,200 - $1,800 - $2,400'), 1200);
s.equal('object range -> min', parsePriceNumber({ min: 1420, max: 2900 }), 1420);
s.equal('object with only max', parsePriceNumber({ max: 2900 }), 2900);
s.equal('empty object -> null', parsePriceNumber({}), null);

// ── Single values, decorated every way the sites decorate them ────────
s.equal('plain number', parsePriceNumber(2500), 2500);
s.equal('currency + comma + period', parsePriceNumber('$2,500/mo'), 2500);
s.equal('trailing plus', parsePriceNumber('$2,500+/mo'), 2500);
s.equal('leading words', parsePriceNumber('From $1,995'), 1995);
s.equal('decimal is rounded', parsePriceNumber('$1,995.75'), 1996);
s.equal('no separators', parsePriceNumber('2500'), 2500);

// ── Non-prices must never become a number ─────────────────────────────
s.equal('"Call for pricing" -> null', parsePriceNumber('Call for pricing'), null);
s.equal('null -> null', parsePriceNumber(null), null);
s.equal('undefined -> null', parsePriceNumber(undefined), null);
s.equal('empty string -> null', parsePriceNumber(''), null);
s.equal('NaN -> null', parsePriceNumber(NaN), null);
s.equal('array -> null', parsePriceNumber([1, 2]), null);

// ── toNumber: beds/baths/sqft, same range problem ─────────────────────
s.equal('beds range -> min', toNumber({ min: 1, max: 2 }), 1);
s.equal('area range -> min', toNumber({ min: 497, max: 1163 }), 497);
s.equal('plain number passes', toNumber(3), 3);
s.equal('zero is preserved, not nulled', toNumber(0), 0);
s.equal('numeric string', toNumber('2'), 2);
s.equal('null -> null', toNumber(null), null);
s.equal('empty string -> null', toNumber(''), null);
s.equal('empty object -> null', toNumber({}), null);
s.check('never returns NaN', !Number.isNaN(toNumber('abc')));

// ── unwrapRange in isolation ──────────────────────────────────────────
s.equal('unwrap prefers min', unwrapRange({ min: 5, max: 9 }), 5);
s.equal('unwrap passes scalars through', unwrapRange(7), 7);
s.equal('unwrap leaves arrays alone', JSON.stringify(unwrapRange([1, 2])), '[1,2]');

module.exports = { run: () => s.result() };
if (require.main === module) process.exit(s.report().failed > 0 ? 1 : 0);
