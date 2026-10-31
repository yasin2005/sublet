const mongoose = require('mongoose');
const Listing = require('../models/Listing');
const { ensureConnection } = require('./lib/db');
const { upsertListing } = require('./lib/upsert');
const programs = require('../data/universityHousing');

// Loads the curated university programs (data/universityHousing.js) into the
// catalogue as ordinary listings, so they appear on the map, in search, and in
// every filter alongside scraped rentals.
//
// Runs at every server boot. It is local data, so it costs nothing, and running
// it keeps lastSeenAt fresh. Unlike the scraped sources, the curated file is
// the whole truth: a program removed from the file is deactivated here, and
// nothing else retires one (scripts/sweep.js and the per-city sweep both skip
// this platform).

const PLATFORM = 'University';
const NIGHTS_PER_MONTH = 30;
const WEEKS_PER_MONTH = 52 / 12;

function monthlyFrom({ nightlyRate, weeklyRate }) {
  if (nightlyRate != null) return Math.round(nightlyRate * NIGHTS_PER_MONTH);
  if (weeklyRate != null) return Math.round(weeklyRate * WEEKS_PER_MONTH);
  return null;
}

// Only dedicated summer intern housing programs belong in the catalogue (see
// the header of data/universityHousing.js). An entry without a named program
// and its page is most likely general summer housing added by mistake.
function assertInternProgram(p) {
  const missing = ['id', 'university', 'programName', 'sourceUrl', 'coordinates'].filter((k) => !p[k]);
  if (missing.length > 0) {
    throw new Error(`University entry "${p.id || p.university || '?'}" is missing ${missing.join(', ')} — only named summer intern housing programs may be listed`);
  }
}

function normalizeProgram(p) {
  assertInternProgram(p);
  return {
    originalPlatform: PLATFORM,
    originalId: p.id,
    address: p.address,
    neighborhood: p.university,
    city: p.city,
    zipCode: p.zipCode,
    location: { type: 'Point', coordinates: p.coordinates },

    pricePerMonth: monthlyFrom(p),
    utilitiesIncluded: Boolean(p.utilitiesIncluded),

    spaceType: p.spaceType,
    propertyType: p.propertyType,
    bedrooms: null,
    bathrooms: null,

    // Every program here furnishes its rooms — it is the point of intern housing.
    isFurnished: true,
    hasInUnitLaundry: Boolean(p.hasInUnitLaundry),
    hasAirConditioning: Boolean(p.hasAirConditioning),
    hasParking: Boolean(p.hasParking),

    minimumLeaseDays: p.minimumStayNights ?? null,
    availableFrom: p.availableFrom ? new Date(p.availableFrom) : new Date(),
    availableTo: p.availableTo ? new Date(p.availableTo) : undefined,

    amenitiesRaw: p.includes || [],
    listingUrl: p.sourceUrl,
    images: [],

    university: {
      name: p.university,
      programName: p.programName,
      season: p.season,
      priceText: p.priceText,
      eligibility: p.eligibility,
      eligibilityText: p.eligibilityText,
      includes: p.includes,
      terms: p.terms,
      applyUrl: p.applyUrl,
      sourceUrl: p.sourceUrl,
      checkedOn: new Date(p.checkedOn),
    },
  };
}

async function syncUniversityHousing({ quiet = false } = {}) {
  await ensureConnection();

  let created = 0;
  let updated = 0;
  for (const program of programs) {
    const { status } = await upsertListing(normalizeProgram(program));
    if (status === 'created') created++;
    else updated++;
  }

  const retired = await Listing.updateMany(
    { originalPlatform: PLATFORM, isActive: true, originalId: { $nin: programs.map((p) => p.id) } },
    { $set: { isActive: false } }
  );

  if (!quiet || created > 0 || retired.modifiedCount > 0) {
    console.log(
      `University housing: ${programs.length} programs (+${created} new, ${updated} refreshed` +
      (retired.modifiedCount ? `, ${retired.modifiedCount} retired` : '') + ')'
    );
  }
  return { created, updated, retired: retired.modifiedCount };
}

if (require.main === module) {
  require('dotenv').config();
  syncUniversityHousing()
    .then(() => mongoose.connection.close())
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { syncUniversityHousing, normalizeProgram, monthlyFrom, PLATFORM };
