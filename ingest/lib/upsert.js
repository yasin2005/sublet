const Listing = require('../../models/Listing');

// Single implementation of "write a normalized listing", shared by the HTTP
// POST route and by the ingestors writing straight through Mongoose. Two
// copies of these rules would drift, and the cost of drift here is silently
// destroying enrichment data that cost real credits to obtain.

// Identity and provenance: never rewritten by a re-ingest. firstSeenAt in
// particular must survive — it is how long we have known about a listing,
// which a later run has no business resetting.
const IMMUTABLE_ON_REFRESH = [
  'originalPlatform', 'originalId', 'firstSeenAt', '_id', 'createdAt', 'updatedAt',
];

// Fields a /property enrichment call owns once it has run. A search-endpoint
// re-ingest knows strictly less about these — it sends minimumLeaseDays: null
// and availableFrom: <today> — so letting it write them would erase the
// enrichment pass every time an ingester re-runs.
const ENRICHMENT_OWNED = [
  'minimumLeaseDays', 'availableFrom', 'availableTo', 'depositAmount',
  'petsAllowed', 'utilitiesIncluded', 'isFurnished', 'hasInUnitLaundry',
  'hasAirConditioning', 'hasParking', 'enrichedAt',
];

function buildRefresh(incoming, existing) {
  const updates = { ...incoming };

  for (const field of IMMUTABLE_ON_REFRESH) delete updates[field];

  // Never let a re-ingest null out a value we already have. Sources routinely
  // omit fields they returned last time.
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) delete updates[key];
  }

  if (existing.enrichedAt) {
    for (const field of ENRICHMENT_OWNED) delete updates[field];
  }

  // The listing was just seen in live results, so it is demonstrably active.
  updates.lastSeenAt = new Date();
  updates.isActive = true;

  return updates;
}

// Optimistic create, falling back to refresh on the unique-index collision.
// Doing it in that order means the common case (a genuinely new listing) is a
// single round trip, and the duplicate-key error doubles as the lock against
// two concurrent ingests creating the same listing twice.
async function upsertListing(doc) {
  try {
    const created = await Listing.create(doc);
    return { status: 'created', listing: created, previousPrice: null };
  } catch (err) {
    if (err.code !== 11000) throw err;
  }

  const existing = await Listing.findOne({
    originalPlatform: doc.originalPlatform,
    originalId:       doc.originalId,
  });

  // Lost a race against a delete between the insert and the lookup.
  if (!existing) throw new Error(`Listing ${doc.originalPlatform}/${doc.originalId} vanished mid-upsert`);

  const previousPrice = existing.pricePerMonth;
  const listing = await Listing.findByIdAndUpdate(
    existing._id,
    { $set: buildRefresh(doc, existing) },
    { new: true, runValidators: true }
  );

  return { status: 'updated', listing, previousPrice };
}

module.exports = { upsertListing, buildRefresh, IMMUTABLE_ON_REFRESH, ENRICHMENT_OWNED };
