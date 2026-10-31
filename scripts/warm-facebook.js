require('dotenv').config();

const mongoose = require('mongoose');
const CityFetch = require('../models/CityFetch');
const facebook = require('../ingest/facebook');

// Pre-warms Facebook Marketplace for the cities people actually search.
//
// Facebook is the one source that cannot ride on a live request: it fetches a
// detail page per listing (~6.5s each), so a 40-item run takes 4-5 minutes.
// Measured on Tucson 2026-08-27: 199s for 25 listings, 164s of it detail pages.
// Turning details off drops that to 21s but returns zero usable rows, because
// coordinates exist ONLY on detail pages and every record then fails
// pre-flight. There is no setting that makes it both fast and useful.
//
// So it runs here instead, on a schedule, where four minutes costs nobody
// anything. Its inventory — private rooms and sublets — is also the least
// time-sensitive of the five sources.
//
// Cron:
//   30 3 * * *  cd /path/to/housing-search && node scripts/warm-facebook.js >> warm.log 2>&1

const DEFAULT_CITIES = 10;
const DEFAULT_MAX_ITEMS = 40;
const DEFAULT_DELAY_MS = 20_000;

// Skip a city warmed recently. A nightly cron would otherwise re-scrape cities
// a manual run already covered hours earlier.
const DEFAULT_MIN_AGE_HOURS = 20;

const HOUR_MS = 60 * 60 * 1000;

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };

  return {
    cities:       Number(valueOf('cities')) || DEFAULT_CITIES,
    maxItems:     Number(valueOf('maxItems')) || DEFAULT_MAX_ITEMS,
    delayMs:      valueOf('delay') !== undefined ? Number(valueOf('delay')) : DEFAULT_DELAY_MS,
    minAgeHours:  valueOf('minAgeHours') !== undefined ? Number(valueOf('minAgeHours')) : DEFAULT_MIN_AGE_HOURS,
    only:         valueOf('city'),
    onlyState:    valueOf('state'),
    dryRun:       args.includes('--dry-run'),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Demand order. fetchCount is incremented every time a live search triggers a
// fetch for that city, so it is a real popularity signal rather than a guess
// about which markets matter.
async function pickCities({ cities, minAgeHours, only, onlyState }) {
  if (only) {
    return [{ city: only, state: (onlyState || '').toUpperCase(), fetchCount: 0, slowFetch: {} }];
  }

  const candidates = await CityFetch.find({ state: { $ne: '' } })
    .sort({ fetchCount: -1, lastFetchedAt: -1 })
    .limit(cities * 3) // over-fetch, since some will be filtered as too recent
    .lean();

  const cutoff = Date.now() - minAgeHours * HOUR_MS;
  const due = [];

  for (const entry of candidates) {
    const last = entry.slowFetch?.FacebookMarketplace?.finishedAt;
    if (last && new Date(last).getTime() > cutoff) continue; // warmed recently
    due.push(entry);
    if (due.length >= cities) break;
  }

  return due;
}

// Mirror the live path's bookkeeping so GET /api/listings/status reports
// pre-warmed runs exactly as it reports on-demand ones.
async function record(city, state, patch, startedAt) {
  return CityFetch.updateOne(
    { city: city.toLowerCase(), state },
    {
      $set: {
        'slowFetch.FacebookMarketplace': {
          source: 'FacebookMarketplace',
          startedAt: new Date(startedAt),
          ...patch,
        },
      },
    },
    { upsert: true }
  ).catch((err) => console.error(`  ! could not record status: ${err.message}`));
}

async function run(options) {
  await mongoose.connect(process.env.MONGO_URI);

  const targets = await pickCities(options);

  if (targets.length === 0) {
    console.log('Nothing due — every popular city was warmed within the last ' +
      `${options.minAgeHours}h. Use --minAgeHours=0 to force.`);
    return 0;
  }

  console.log(`Warming Facebook Marketplace for ${targets.length} city/cities ` +
    `(maxItems=${options.maxItems}, delay=${options.delayMs / 1000}s between runs)\n`);

  for (const [i, entry] of targets.entries()) {
    console.log(`  ${entry.city}, ${entry.state}  (searched ${entry.fetchCount}x)`);
  }
  console.log('');

  if (options.dryRun) {
    console.log('DRY RUN — no runs started, nothing written.');
    return 0;
  }

  let created = 0;
  let failed = 0;

  for (const [index, entry] of targets.entries()) {
    const { city, state } = entry;
    const startedAt = Date.now();

    process.stdout.write(`[${index + 1}/${targets.length}] ${city}, ${state} ... `);
    await record(city, state, { status: 'running' }, startedAt);

    try {
      const result = await facebook.ingestCity(city, state, {
        maxItems: options.maxItems,
        quiet: true,
      });

      created += result.created;
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(`+${result.created} new, ${result.updated} refreshed, ${result.skipped} skipped, ${elapsed}s`);

      await record(city, state, {
        status: 'complete',
        finishedAt: new Date(),
        created: result.created,
        updated: result.updated,
      }, startedAt);
    } catch (err) {
      failed++;
      console.log(`FAILED — ${err.message.split('\n')[0]}`);
      await record(city, state, {
        status: 'failed',
        finishedAt: new Date(),
        error: err.message,
      }, startedAt);
    }

    // Facebook blocks aggressively and the actor shares one residential proxy
    // pool. Spacing the runs out matters more here than for any other source.
    if (index < targets.length - 1 && options.delayMs > 0) {
      await sleep(options.delayMs);
    }
  }

  console.log(`\nDone. ${created} new listing(s) across ${targets.length} city/cities · ${failed} failed.`);

  // A single city failing is normal for this source; every city failing means
  // the token, the actor, or Facebook itself has changed.
  return failed === targets.length ? 1 : 0;
}

if (require.main === module) {
  run(parseArgs(process.argv))
    .then(async (code) => {
      await mongoose.connection.close();
      process.exit(code);
    })
    .catch(async (err) => {
      console.error('✗ Warm run failed:', err.message);
      await mongoose.connection.close().catch(() => {});
      process.exit(1);
    });
}

module.exports = { run, pickCities, parseArgs };
