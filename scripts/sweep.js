require('dotenv').config();

const mongoose = require('mongoose');
const Listing = require('../models/Listing');

// Deactivates listings we have not seen in a while.
//
// Rentals fill within days. Without this the catalogue silently becomes a
// graveyard and users contact landlords about places that are already gone.
//
// Intended for cron:
//   0 4 * * *  cd /path/to/housing-search && node scripts/sweep.js >> sweep.log 2>&1

const STALE_AFTER_DAYS = 7;

// Dead man's switch threshold. If NOTHING in the entire database has been seen
// more recently than this, the ingest pipeline is broken — and a sweep run
// against a frozen database would deactivate the whole catalogue.
const PIPELINE_DEAD_AFTER_HOURS = 48;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };

  return {
    days:          Number(valueOf('days')) || STALE_AFTER_DAYS,
    maxStaleHours: Number(valueOf('max-stale-hours')) || PIPELINE_DEAD_AFTER_HOURS,
    dryRun:        args.includes('--dry-run'),
    force:         args.includes('--force'),
  };
}

function ago(date) {
  const hours = (Date.now() - date.getTime()) / HOUR_MS;
  if (hours < 48) return `${hours.toFixed(1)}h ago`;
  return `${(hours / 24).toFixed(1)}d ago`;
}

// ─── Dead man's switch ─────────────────────────────────────────────────
// The premise of this sweep is "not seen recently means gone". That premise
// only holds while ingestion is actually running. If the pipeline has stalled —
// expired HasData credits, a changed response shape, a dead cron — then every
// listing looks stale for reasons that have nothing to do with availability,
// and sweeping would wipe the catalogue in one pass.
//
// So: prove the pipeline is alive before trusting staleness at all.
async function pipelineIsAlive(maxStaleHours) {
  const total = await Listing.countDocuments();

  // An empty database has no newest listing to check. Nothing to sweep either,
  // so this is a clean no-op rather than a failure.
  if (total === 0) {
    return { alive: false, empty: true, total, message: 'database is empty — nothing to sweep' };
  }

  const [newest] = await Listing.find().sort({ lastSeenAt: -1 }).limit(1).select('lastSeenAt');
  const age = Date.now() - newest.lastSeenAt.getTime();

  if (age > maxStaleHours * HOUR_MS) {
    return {
      alive: false,
      empty: false,
      total,
      newestSeenAt: newest.lastSeenAt,
      message:
        `newest listing in the ENTIRE database was seen ${ago(newest.lastSeenAt)}, ` +
        `beyond the ${maxStaleHours}h threshold`,
    };
  }

  return { alive: true, empty: false, total, newestSeenAt: newest.lastSeenAt };
}

async function run({ days, maxStaleHours, dryRun, force }) {
  await mongoose.connect(process.env.MONGO_URI);

  const health = await pipelineIsAlive(maxStaleHours);

  if (health.empty) {
    console.log(`✓ ${health.message}`);
    return 0;
  }

  if (!health.alive) {
    console.error('\n✗ ABORTED — INGEST PIPELINE LOOKS DEAD');
    console.error(`  ${health.message}.`);
    console.error('  Sweeping now would deactivate the entire catalogue.\n');
    console.error('  Check, in order:');
    console.error('    1. HasData credits    — a 402 stops every ingest silently');
    console.error('    2. Ingest cron/jobs   — is anything actually running?');
    console.error('    3. Source payloads    — a changed shape skips every record');
    console.error('\n  Re-run once ingestion is confirmed healthy.');
    console.error('  To override deliberately: --force\n');

    if (!force) return 1;
    console.warn('  --force given: proceeding despite a dead-looking pipeline.\n');
  }

  const cutoff = new Date(Date.now() - days * DAY_MS);

  const filter = { isActive: true, lastSeenAt: { $lt: cutoff } };
  const candidates = await Listing.countDocuments(filter);

  console.log(`Pipeline alive — newest listing seen ${ago(health.newestSeenAt)}.`);
  console.log(`Database: ${health.total} listings.`);
  console.log(`Cutoff:   ${cutoff.toISOString()} (${days} days)`);
  console.log(`Stale:    ${candidates} active listing(s) past the cutoff.\n`);

  if (candidates === 0) {
    console.log('✓ Nothing to deactivate.');
    return 0;
  }

  // Where the stale listings are — a whole city going at once is normal under
  // on-demand caching (nobody searched it), but it is worth seeing.
  const byCity = await Listing.aggregate([
    { $match: filter },
    { $group: { _id: { city: '$city', platform: '$originalPlatform' }, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 15 },
  ]);

  for (const row of byCity) {
    console.log(`  ${String(row.n).padStart(4)} × ${row._id.city || '(no city)'} · ${row._id.platform}`);
  }
  console.log('');

  if (dryRun) {
    console.log(`DRY RUN — would deactivate ${candidates} listing(s). Nothing written.`);
    return 0;
  }

  const result = await Listing.updateMany(filter, { $set: { isActive: false } });
  console.log(`✓ Deactivated ${result.modifiedCount} listing(s).`);

  const remaining = await Listing.countDocuments({ isActive: true });
  console.log(`  ${remaining} listing(s) still active.`);

  return 0;
}

if (require.main === module) {
  const options = parseArgs(process.argv);

  run(options)
    .then(async (code) => {
      await mongoose.connection.close();
      process.exit(code);
    })
    .catch(async (err) => {
      console.error('✗ Sweep failed:', err.message);
      await mongoose.connection.close().catch(() => {});
      process.exit(1);
    });
}

module.exports = { run, pipelineIsAlive, parseArgs };
