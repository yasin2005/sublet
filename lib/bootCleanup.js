const CityFetch = require('../models/CityFetch');

// A detached FurnishedFinder run lives only in the process that started it.
// If the server restarts mid-run, the Apify job finishes on Apify's side but
// nothing is left here to receive the results — and the CityFetch record sits
// at status "running" forever, so /status tells the frontend to keep polling
// something that will never complete.
//
// Any record still marked running at boot is by definition orphaned: the
// process that owned it is gone.
//
// NOTE: this assumes ONE server instance. Behind a load balancer, a booting
// instance would wrongly bury a sibling's live run — there, gate on an age
// threshold (startedAt older than ~15 minutes) or move the tracker to Redis.
async function resetStuckFetches() {
  // slowFetch is a map keyed by source, so the running runs cannot be found
  // with a fixed dotted path — read the candidates and rewrite them.
  const stuck = await CityFetch.find({ slowFetch: { $ne: null } }).lean();

  let cleared = 0;
  let legacy = 0;

  for (const doc of stuck) {
    const slow = doc.slowFetch || {};

    // Pre-multi-source documents stored a single flat run here. Those are
    // unreadable under the new shape, and this is a disposable cache, so drop
    // them — the city simply re-fetches on its next miss.
    if (typeof slow.status === 'string') {
      await CityFetch.updateOne({ _id: doc._id }, { $set: { slowFetch: {} } });
      legacy++;
      continue;
    }

    const updates = {};
    for (const [source, run] of Object.entries(slow)) {
      if (run && run.status === 'running') {
        updates[`slowFetch.${source}.status`] = 'failed';
        updates[`slowFetch.${source}.finishedAt`] = new Date();
        updates[`slowFetch.${source}.error`] = 'server restarted while the run was in flight';
      }
    }

    if (Object.keys(updates).length > 0) {
      await CityFetch.updateOne({ _id: doc._id }, { $set: updates });
      cleared++;
    }
  }

  if (cleared > 0) {
    console.warn(
      `⚠  Cleared orphaned detached run(s) on ${cleared} city record(s) left "running" by a restart.
` +
      '   Those cities will re-fetch on their next cache miss.'
    );
  }
  if (legacy > 0) {
    console.log(`Retired ${legacy} legacy single-source slowFetch record(s).`);
  }

  return cleared;
}

module.exports = { resetStuckFetches };
