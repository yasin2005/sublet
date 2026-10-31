const mongoose = require('mongoose');

const listingSchema = new mongoose.Schema(
  {
    // ─── Source tracking ────────────────────────────────────────────────
    originalPlatform: { type: String, required: true }, // e.g. "Zillow", "FurnishedFinder"
    originalId: { type: String, required: true },       // platform-native listing id

    // ─── Freshness ──────────────────────────────────────────────────────
    firstSeenAt: { type: Date, required: true, default: Date.now },
    lastSeenAt:  { type: Date, required: true, default: Date.now },
    isActive:    { type: Boolean, required: true, default: true },

    // ─── Location ───────────────────────────────────────────────────────
    address:      { type: String },
    neighborhood: { type: String },
    city:         { type: String },
    zipCode:      { type: String },
    location: {
      // GeoJSON — note coordinates order is [longitude, latitude]
      type:        { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true },
    },

    // ─── Financials ─────────────────────────────────────────────────────
    // Required for every scraped source. University programs are the one
    // exception: several publish no rate at all, and inventing one would be
    // worse than saying "ask the university".
    pricePerMonth: {
      type: Number,
      required: function () { return this.originalPlatform !== 'University'; },
    },
    utilitiesIncluded: { type: Boolean, default: false },
    depositAmount:     { type: Number },

    // ─── Property details ───────────────────────────────────────────────
    spaceType: {
      type: String,
      enum: ['Entire Place', 'Private Room', 'Shared Room'],
      required: true,
    },
    propertyType: {
      type: String,
      enum: ['Apartment', 'House', 'Townhouse', 'Condo', 'Residence Hall'],
      required: true,
    },
    bedrooms:   { type: Number }, // nullable — unstructured sources often omit this; studios may report null
    bathrooms:  { type: Number }, // nullable — same reason
    squareFeet: { type: Number },

    // ─── Amenity flags (top-level for fast, indexable filtering) ────────
    isFurnished:        { type: Boolean, default: false },
    hasInUnitLaundry:   { type: Boolean, default: false },
    hasAirConditioning: { type: Boolean, default: false },
    hasParking:         { type: Boolean, default: false },

    // ─── Pets ───────────────────────────────────────────────────────────
    petsAllowed: {
      dogsSmall: { type: Boolean, default: false },
      dogsLarge: { type: Boolean, default: false },
      cats:      { type: Boolean, default: false },
    },

    // ─── Lease terms ────────────────────────────────────────────────────
    minimumLeaseDays: { type: Number }, // nullable — FB Marketplace / uni boards often bury this in free text
    availableFrom:    { type: Date, required: true },
    availableTo:      { type: Date }, // nullable — many listings have no fixed end date

    // ─── Everything else ────────────────────────────────────────────────
    amenitiesRaw: { type: [String], default: [] }, // fallback for non-normalized amenities
    listingUrl:   { type: String, required: true },
    images:       { type: [String], default: [] },

    // ─── University housing programs (originalPlatform 'University') ────
    // Curated in data/universityHousing.js. Kept as its own block because these
    // are programs with rules, not listings: who may apply, which season the
    // quoted rate is for, and the page it was checked against.
    university: {
      name:            { type: String },  // "University of Washington"
      programName:     { type: String },  // "Seattle Intern Housing" — the intern program itself
      season:          { type: String },  // "Summer 2027 — from June 20 …"
      priceText:       { type: String },  // the rate exactly as the university quotes it
      eligibility:     { type: String, enum: ['open', 'restricted'] },
      eligibilityText: { type: String },
      includes:        { type: [String], default: undefined },
      terms:           { type: String },
      applyUrl:        { type: String },
      sourceUrl:       { type: String },
      checkedOn:       { type: Date },
    },

    // ─── Escape hatch: original scraped payload ─────────────────────────
    rawSource: { type: mongoose.Schema.Types.Mixed },

    // Set once a /property detail call has been made for this listing.
    // Marks the ATTEMPT, not success: a Zillow listing whose page has no
    // lease term must not be re-fetched on every run at 5 credits a time.
    enrichedAt: { type: Date },

    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true } // adds createdAt / updatedAt
);

// Prevent duplicate ingestion of the same listing from the same source
listingSchema.index({ originalPlatform: 1, originalId: 1 }, { unique: true });

// Enable proximity queries ("within X meters of these coordinates")
listingSchema.index({ location: '2dsphere' });

// The on-demand cache checks "how many active listings does this city have?"
// on every search, so it must not be a collection scan.
// NOTE: the route matches city case-insensitively via regex, which cannot use
// this index. At real volume, switch both the index and the query to a
// collation ({ locale: 'en', strength: 2 }) so the match is index-backed.
listingSchema.index({ city: 1, isActive: 1 });

module.exports = mongoose.model('Listing', listingSchema);
