// University summer intern housing — the curated list and its loader.
//
// The list is hand-maintained, so these tests guard the two ways it can go
// wrong silently: an entry that is not actually an intern program slipping in,
// and a rate turned into a wrong monthly figure.
const Listing = require('../../models/Listing');
const uni = require('../../ingest/university');
const programs = require('../../data/universityHousing');
const { createSuite } = require('../helpers/suite');

const s = createSuite('university');

// ── Every curated entry is valid and is a named intern program ────────
for (const p of programs) {
  const doc = new Listing(uni.normalizeProgram(p));
  const err = doc.validateSync();
  s.check(`${p.id} passes the schema`, !err, err ? Object.keys(err.errors).join(', ') : undefined);
  s.check(`${p.id} names its intern program`, /intern/i.test(p.programName), p.programName);
  s.check(`${p.id} links an official page`, /^https:\/\//.test(p.sourceUrl), p.sourceUrl);
}
s.equal('ids are unique', new Set(programs.map((p) => p.id)).size, programs.length);

// ── The guard: general summer housing cannot be added by mistake ──────
const rejects = (entry) => { try { uni.normalizeProgram(entry); return false; } catch { return true; } };
s.check('rejects an entry with no programName', rejects({ id: 'x', university: 'U', sourceUrl: 'https://x', coordinates: [0, 0] }));
s.check('rejects an entry with no sourceUrl', rejects({ id: 'x', university: 'U', programName: 'Intern Housing', coordinates: [0, 0] }));

// Programs this project deliberately excluded must stay out.
const ids = programs.map((p) => p.id).join(' ');
s.check('University of Arizona (general lodging) is not listed', !/arizona/.test(ids));
s.check('Boise State (own students only) is not listed', !/boise/.test(ids));

// ── Monthly price from the quoted rate ────────────────────────────────
s.equal('$78/night -> $2,340/mo', uni.monthlyFrom({ nightlyRate: 78 }), 2340);
s.equal('$66.40/night -> $1,992/mo', uni.monthlyFrom({ nightlyRate: 66.4 }), 1992);
s.equal('$350/week -> $1,517/mo', uni.monthlyFrom({ weeklyRate: 350 }), 1517);
s.equal('no published rate -> null, never a guess', uni.monthlyFrom({}), null);

// ── A program with no price is still a valid listing; a rental is not ─
const noPrice = new Listing(uni.normalizeProgram(programs.find((p) => p.nightlyRate == null && p.weeklyRate == null)));
s.check('university program may have no price', !noPrice.validateSync());
const rental = new Listing({ ...uni.normalizeProgram(programs[0]), originalPlatform: 'Zillow', pricePerMonth: undefined });
s.check('a scraped rental still requires a price', Boolean(rental.validateSync()?.errors?.pricePerMonth));

module.exports = { run: () => s.result() };
if (require.main === module) process.exit(s.report().failed > 0 ? 1 : 0);
