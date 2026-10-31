const Listing = require('../models/Listing');

// The on-demand counterpart of scripts/sweep.js: right after a search has
// re-scraped a city, retire that city's listings that the sources have stopped
// returning. Without it, nothing retires a rented-out listing unless someone
// remembers to run the sweep by hand.
//
// "Not returned this time" is NOT enough to retire a listing. Each source
// returns one page — FurnishedFinder 100 of ~1,500 in a big city — so a listing
// outside today's page is not gone. The rule is the sweep's: not seen for
// STALE_AFTER_DAYS.
//
// The dead man's switch is per source instead of global: only platforms that
// JUST returned listings are swept. A source that failed, ran out of credits,
// or silently changed shape and returned nothing proves nothing about its old
// listings, so it is left alone.
const STALE_AFTER_DAYS = 7;
const EARTH_RADIUS_KM = 6378.1;
const DAY_MS = 24 * 60 * 60 * 1000;

async function sweepArea({ coordinates, radiusKm, platforms, days = STALE_AFTER_DAYS }) {
  if (!coordinates || platforms.length === 0) return 0;

  const result = await Listing.updateMany(
    {
      isActive: true,
      originalPlatform: { $in: platforms },
      lastSeenAt: { $lt: new Date(Date.now() - days * DAY_MS) },
      location: { $geoWithin: { $centerSphere: [coordinates, radiusKm / EARTH_RADIUS_KM] } },
    },
    { $set: { isActive: false } }
  );

  return result.modifiedCount;
}

module.exports = { sweepArea, STALE_AFTER_DAYS };
