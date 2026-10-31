require('dotenv').config();

const mongoose = require('mongoose');
const CityFetch = require('../models/CityFetch');
const { ensureConnection } = require('../ingest/lib/db');

const zillow = require('../ingest/zillow');
const airbnb = require('../ingest/airbnb');
const redfin = require('../ingest/redfin');
const furnishedfinder = require('../ingest/furnishedfinder');
const facebook = require('../ingest/facebook');

// Re-scrapes every city the site has ever fetched, from every source.
//
//   npm run refresh                       all cities, all sources
//   npm run refresh -- --only="austin"    one city
//   npm run refresh -- --skip-facebook    leave out the priciest source
//   npm run refresh -- --dry-run          print the plan, spend nothing
//
// Intended for cron alongside the sweep, so searches hit a warm cache:
//   0 3 * * *  cd /path/to/housing-search && node scripts/refresh-cities.js >> refresh.log 2>&1
//
// COST, per city, at the defaults:
//   HasData   3 requests (Zillow, Airbnb, Redfin) — queued one at a time by
//             the gate in ingest/lib/pipeline.js, since the plan allows one
//   Apify     FurnishedFinder ~100 listings (~$0.15) + Facebook ~20 listings
//             with details (~$0.25). The free plan is $5/month, so Facebook is
//             capped low; raise --facebook-items on a paid plan.

const DEFAULT_FF_ITEMS = 100;
const DEFAULT_FB_ITEMS = 20;

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };

  return {
    only:          valueOf('only')?.toLowerCase(),
    ffItems:       Number(valueOf('ff-items')) || DEFAULT_FF_ITEMS,
    fbItems:       Number(valueOf('facebook-items')) || DEFAULT_FB_ITEMS,
    skipFacebook:  args.includes('--skip-facebook'),
    dryRun:        args.includes('--dry-run'),
  };
}

// CityFetch stores cities lowercased for matching; scrapers and Listing.city
// want the spelling a person would type.
const titleCase = (s) => s.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());

async function refreshCity(log, opts) {
  const city = titleCase(log.city);
  const { state } = log;

  const sources = [
    ['Zillow',  () => zillow.ingestCity(city, state, { quiet: true })],
    ['Airbnb',  () => airbnb.ingestCity(city, state, { quiet: true })],
    ['Redfin',  () => redfin.ingestCity(city, state, { quiet: true })],
  ];
  // Both Apify sources need a state; every logged city should have one.
  if (state) {
    sources.push(['FurnishedFinder', () => furnishedfinder.ingestCity(city, state, { maxItems: opts.ffItems, quiet: true })]);
    if (!opts.skipFacebook) {
      sources.push(['FacebookMarketplace', () => facebook.ingestCity(city, state, { maxItems: opts.fbItems, quiet: true })]);
    }
  }

  const started = Date.now();
  const settled = await Promise.allSettled(sources.map(([, run]) => run()));

  const result = { created: 0, updated: 0, failed: [] };
  const lines = [];
  settled.forEach((outcome, i) => {
    const [name] = sources[i];
    if (outcome.status === 'fulfilled') {
      const { created = 0, updated = 0, skipped = 0 } = outcome.value || {};
      result.created += created;
      result.updated += updated;
      lines.push(`    ${name.padEnd(20)} +${created} new, ${updated} refreshed, ${skipped} skipped`);
    } else {
      result.failed.push(name);
      lines.push(`    ${name.padEnd(20)} FAILED — ${String(outcome.reason?.message).split('\n')[0]}`);
    }
  });

  // Only the three HasData sources decide cache warmth (routes/listings.js
  // treats "every fast source failed" as cold), so record those as lastResult.
  const fastFailed = result.failed.filter((n) => ['Zillow', 'Airbnb', 'Redfin'].includes(n));
  await CityFetch.updateOne(
    { _id: log._id },
    {
      $set: {
        lastFetchedAt: new Date(),
        lastResult: { created: result.created, updated: result.updated, failed: fastFailed },
      },
      $inc: { fetchCount: 1 },
    }
  );

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\n${city}, ${state} — +${result.created} new, ${result.updated} refreshed in ${secs}s`);
  console.log(lines.join('\n'));
  return result;
}

async function main() {
  const opts = parseArgs(process.argv);
  await ensureConnection();

  const filter = opts.only ? { city: opts.only } : {};
  const cities = await CityFetch.find(filter).sort({ fetchCount: -1 }).lean();

  if (cities.length === 0) {
    console.log(opts.only ? `No fetched city named "${opts.only}".` : 'No cities have been fetched yet.');
    return;
  }

  console.log(
    `Refreshing ${cities.length} city/cities: ${cities.map((c) => `${titleCase(c.city)}, ${c.state}`).join(' · ')}\n` +
    `FurnishedFinder ${opts.ffItems}/city · Facebook ${opts.skipFacebook ? 'skipped' : `${opts.fbItems}/city`}`
  );
  if (opts.dryRun) return console.log('\n--dry-run: nothing fetched.');

  // One city at a time. The HasData gate already serializes those calls, and
  // running every city's Apify actors at once would only trip the account's
  // memory limit on the free plan.
  let created = 0;
  let updated = 0;
  const failures = [];
  for (const log of cities) {
    const result = await refreshCity(log, opts);
    created += result.created;
    updated += result.updated;
    for (const name of result.failed) failures.push(`${titleCase(log.city)}/${name}`);
  }

  console.log(`\nDone. +${created} new, ${updated} refreshed across ${cities.length} cities.`);
  if (failures.length) console.log(`Failed: ${failures.join(', ')}`);
  console.log('Run `npm run sweep` next to retire listings that were not seen again.');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close());
