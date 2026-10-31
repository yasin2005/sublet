const mongoose = require('mongoose');

// Records that we HAVE fetched a city, separately from what we found.
//
// The obvious staleness check — "is the newest listing for this city older
// than 24h?" — cannot answer the question for a city with zero listings.
// A search for a small town, or a typo, would find nothing, conclude the cache
// is cold, and re-scrape all three sources on every single request. This
// collection is what stops a misspelled city from costing 15 credits per
// keystroke.
const cityFetchSchema = new mongoose.Schema(
  {
    city:  { type: String, required: true }, // stored lowercase for matching
    state: { type: String, default: '' },    // '' when the user gave none

    lastFetchedAt: { type: Date, required: true, default: Date.now },

    // Metro centre for radius search, in GeoJSON [longitude, latitude].
    // Seeded for known cities, otherwise derived from the median of the
    // listings we ingested — no geocoding service in the loop.
    centroid: {
      type:        { type: String, enum: ['Point'] },
      coordinates: { type: [Number] },
    },

    // What the last fetch actually produced, per source. Useful for spotting a
    // source that has quietly started returning nothing.
    lastResult: {
      created: { type: Number, default: 0 },
      updated: { type: Number, default: 0 },
      failed:  { type: [String], default: [] },
    },

    // Total live fetches triggered for this city — a cheap demand signal for
    // deciding what is worth pre-warming on a schedule later.
    fetchCount: { type: Number, default: 0 },

    // The detached tier, keyed BY SOURCE NAME:
    //   { FurnishedFinder: {...}, FacebookMarketplace: {...} }
    //
    // Both slow sources are Apify actors that spend ~30s pulling a container
    // before scraping, so neither can sit on a user's request. They finish
    // independently, so a single shared status object would let whichever
    // returned last overwrite the other's result.
    //
    // Recorded here as well as in memory so a poll still answers correctly
    // after a restart, and so the frontend can tell "still running" from
    // "finished, found nothing".
    slowFetch: { type: mongoose.Schema.Types.Mixed, default: {} },

  },
  { timestamps: true }
);

cityFetchSchema.index({ city: 1, state: 1 }, { unique: true });

module.exports = mongoose.model('CityFetch', cityFetchSchema);
