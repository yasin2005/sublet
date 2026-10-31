require('dotenv').config();

const { hasDataFetchRaw, handleFatal } = require('./lib/pipeline');

const API_URL = `http://localhost:${process.env.PORT || 3000}/api/listings`;

// PATCH is a write, so it now requires the aggregator key. Reads (the
// candidate query below) stay open and need no header.
const AGGREGATOR_KEY = process.env.AGGREGATOR_API_KEY;
const ZILLOW_PROPERTY = 'https://api.hasdata.com/scrape/zillow/property';

// Zillow reports lease length in months; our schema stores days.
const DAYS_PER_MONTH = 30.44;

// Each /property call costs 5 credits, so the default run is capped. Raise it
// deliberately with --limit once a small batch looks right.
const DEFAULT_LIMIT = 10;
const CREDITS_PER_CALL = 5;

// ─── Which sources can actually be enriched ────────────────────────────
// Probed 2026-08-27 against live payloads:
//   Zillow /property  -> leaseTerm, rentalCosts.leaseDuration, resoData.furnished, availableFrom
//   Redfin /property  -> amenities, petPolicies, floorPlans — but NO lease term
//   Airbnb /property  -> no minimum-nights field of any kind
// Only Zillow is wired up here. Calling the others for lease terms would burn
// credits for data that is not in the response.
const SUPPORTED_PLATFORMS = ['Zillow'];

// ─── Lease term parsing ────────────────────────────────────────────────
// Preferred source is the numeric rentalCosts.leaseDuration (months). The
// leaseTerm string is the fallback, and it is free text: "1 Year",
// "6 Months", "Month To Month", "Negotiable".
// Zillow returns TWO different property shapes, confirmed by probe:
//
//   /homedetails/...  single unit
//     leaseTerm: "1 Year", rentalCosts.leaseDuration: 12, resoData, availableFrom
//
//   /apartments/...   building/complex
//     no leaseTerm at top level; it lives per floor plan as
//     floorPlans[].leaseTerm: "Available months 6,7,8,9,10,11,12,13"
//
// Both must be handled or roughly half of Zillow enrichment silently yields
// nothing — which is exactly what the first run did.
function leaseTermToMonths(leaseTerm) {
  if (typeof leaseTerm !== 'string') return null;

  // Building shape: an explicit list of offered lease lengths. The SHORTEST
  // is the minimum term, which is the whole point of the field for interns.
  const offered = leaseTerm.match(/available\s+months?\s+([\d,\s]+)/i);
  if (offered) {
    const months = offered[1]
      .split(/[,\s]+/)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    if (months.length > 0) return Math.min(...months);
  }

  if (/month\s*to\s*month|monthly/i.test(leaseTerm)) return 1;

  const years = leaseTerm.match(/(\d+(?:\.\d+)?)\s*year/i);
  if (years) return Number(years[1]) * 12;

  const months = leaseTerm.match(/(\d+(?:\.\d+)?)\s*month/i);
  if (months) return Number(months[1]);

  // "Negotiable", "Contact for details" — no usable number.
  return null;
}

// Our originalId is the floor-plan id on building pages, so the exact unit
// can be located rather than guessed at.
function findFloorPlan(property, originalId) {
  const plans = Array.isArray(property?.floorPlans) ? property.floorPlans : [];
  if (plans.length === 0) return null;

  const id = String(originalId);
  return (
    plans.find((p) => String(p.id) === id) ||
    plans.find((p) => Array.isArray(p.units) && p.units.some((u) => String(u.id) === id)) ||
    null
  );
}

function extractMinimumLeaseDays(property, originalId) {
  // ── Single-unit shape ──
  const duration = property?.rentalCosts?.leaseDuration;
  if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
    return Math.round(duration * DAYS_PER_MONTH);
  }

  const direct =
    leaseTermToMonths(property?.leaseTerm) ??
    leaseTermToMonths(property?.resoData?.leaseTerm);
  if (direct != null) return Math.round(direct * DAYS_PER_MONTH);

  // ── Building shape: our exact floor plan ──
  const plan = findFloorPlan(property, originalId);
  const planMonths = leaseTermToMonths(plan?.leaseTerm);
  if (planMonths != null) return Math.round(planMonths * DAYS_PER_MONTH);

  // ── Building fallback: shortest term any floor plan offers ──
  // Still a true statement about the building when our unit cannot be matched.
  const plans = Array.isArray(property?.floorPlans) ? property.floorPlans : [];
  const allMonths = plans.map((p) => leaseTermToMonths(p?.leaseTerm)).filter((n) => n != null);
  if (allMonths.length > 0) return Math.round(Math.min(...allMonths) * DAYS_PER_MONTH);

  return null;
}

// ─── Pets ──────────────────────────────────────────────────────────────
// Two vocabularies appear: petPolicies ["Cats","SmallDogs","LargeDogs"] and
// allowedPets ["Cats","Dogs","Small Dogs"]. petPolicies is preferred — it
// distinguishes dog sizes explicitly instead of leaving a bare "Dogs".
function mapPets(list) {
  if (!Array.isArray(list) || list.length === 0) return null;

  const text = list.join(' | ');
  const hasDogs = /\bdogs?\b/i.test(text);
  const sized = /small\s*dogs?|large\s*dogs?/i.test(text);

  return {
    cats:      /\bcats?\b/i.test(text),
    // A bare "Dogs" with no size qualifier means both sizes are welcome.
    dogsSmall: /small\s*dogs?/i.test(text) || (hasDogs && !sized),
    dogsLarge: /large\s*dogs?/i.test(text) || (hasDogs && !sized),
  };
}

// ─── Other fields the same call gives us for free ──────────────────────
function extractExtras(property, originalId) {
  const extras = {};
  const plan = findFloorPlan(property, originalId);
  const unit =
    plan?.units?.find((u) => String(u.id) === String(originalId)) || plan?.units?.[0] || null;

  // resoData.furnished is a real boolean — strictly better than our text scan.
  const furnished = property?.resoData?.furnished;
  if (typeof furnished === 'boolean') extras.isFurnished = furnished;

  // A real availability date, replacing the "assume available now" fallback.
  // Unit-level is most specific, then floor plan, then the property itself.
  const availableFrom = unit?.availableFrom || plan?.availableFrom || property?.availableFrom;
  if (availableFrom) {
    const date = new Date(availableFrom);
    if (!Number.isNaN(date.getTime())) extras.availableFrom = date.toISOString();
  }

  const deposit = unit?.depositsAndFees;
  if (typeof deposit === 'number' && Number.isFinite(deposit)) extras.depositAmount = deposit;

  const pets = mapPets(property?.petPolicies) || mapPets(unit?.allowedPets || plan?.allowedPets);
  if (pets) extras.petsAllowed = pets;

  // atAGlanceFacts is a flat list like ["Apartment building","Garage parking"].
  const facts = Array.isArray(property?.atAGlanceFacts) ? property.atAGlanceFacts.join(' | ') : '';
  if (/\bparking\b|\bgarage\b|\bcarport\b/i.test(facts)) extras.hasParking = true;

  return extras;
}

// ─── Fetch candidates ──────────────────────────────────────────────────
async function fetchCandidates({ platform, limit, force }) {
  const params = new URLSearchParams({ platform, limit: String(limit) });
  // --force re-fetches listings already marked, for when the extractor has
  // improved since they were processed.
  if (!force) params.set('enriched', 'false');

  const res = await fetch(`${API_URL}?${params}`);
  if (!res.ok) throw new Error(`Failed to list candidates: ${res.status} ${await res.text()}`);

  const { listings } = await res.json();
  return listings;
}

async function patchListing(id, updates) {
  const res = await fetch(`${API_URL}/${id}`, {
    method:  'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-aggregator-key': AGGREGATOR_KEY || '',
    },
    body:    JSON.stringify(updates),
  });

  if (res.status === 401) {
    throw new Error('PATCH refused (401) — set AGGREGATOR_API_KEY in .env to match the server');
  }
  if (res.status === 404) throw new Error(`Listing ${id} not found`);
  if (res.status === 400) {
    const body = await res.json();
    throw new Error(`PATCH rejected for ${id}: ${JSON.stringify(body)}`);
  }
  if (!res.ok) throw new Error(`PATCH failed for ${id}: ${res.status} ${await res.text()}`);

  return res.json();
}

// ─── Main ──────────────────────────────────────────────────────────────
async function run({ platform = 'Zillow', limit = DEFAULT_LIMIT, dryRun = false, force = false } = {}) {
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    throw new Error(
      `${platform} has no lease-term data in its /property response — supported: ${SUPPORTED_PLATFORMS.join(', ')}`
    );
  }

  if (!AGGREGATOR_KEY) {
    throw new Error(
      'AGGREGATOR_API_KEY missing — every PATCH would be refused after paying for the fetches. Set it in .env.'
    );
  }

  const candidates = await fetchCandidates({ platform, limit, force });
  console.log(`${candidates.length} ${force ? '' : 'un-enriched '}${platform} listing(s) queued.`);
  console.log(`Budget: up to ${candidates.length * CREDITS_PER_CALL} HasData credits.\n`);

  if (candidates.length === 0) return { enriched: 0, withLeaseTerm: 0, failed: 0 };

  let enriched = 0;
  let withLeaseTerm = 0;
  let failed = 0;

  for (const listing of candidates) {
    const label = `${listing.originalId} — ${listing.address || listing.city}`;

    let property;
    try {
      const body = await hasDataFetchRaw(ZILLOW_PROPERTY, { url: listing.listingUrl });
      property = body.property || body;
    } catch (err) {
      failed++;
      console.warn(`  ! ${label}: fetch failed — ${err.message}`);
      continue;
    }

    const minimumLeaseDays = extractMinimumLeaseDays(property, listing.originalId);
    const extras = extractExtras(property, listing.originalId);

    // enrichedAt is always set, even when no lease term was found — that is
    // the whole point of the marker, so this listing is not re-fetched.
    const updates = { ...extras, enrichedAt: new Date().toISOString() };
    if (minimumLeaseDays != null) updates.minimumLeaseDays = minimumLeaseDays;

    if (dryRun) {
      console.log(`  · ${label}`);
      console.log(`      leaseTerm: ${JSON.stringify(property?.leaseTerm)} · leaseDuration: ${JSON.stringify(property?.rentalCosts?.leaseDuration)}`);
      console.log(`      would set: ${JSON.stringify(updates)}`);
      if (minimumLeaseDays != null) withLeaseTerm++;
      enriched++;
      continue;
    }

    try {
      await patchListing(listing._id, updates);
      enriched++;
      if (minimumLeaseDays != null) {
        withLeaseTerm++;
        const months = (minimumLeaseDays / DAYS_PER_MONTH).toFixed(0);
        console.log(`  ✓ ${label} — ${minimumLeaseDays}d (~${months}mo)`);
      } else {
        console.log(`  ~ ${label} — no lease term published (marked, will not re-fetch)`);
      }
    } catch (err) {
      failed++;
      console.warn(`  ! ${label}: ${err.message}`);
    }
  }

  console.log(
    `\nDone. Enriched: ${enriched} · With lease term: ${withLeaseTerm} · Failed: ${failed}` +
    `\nCredits spent: ~${(enriched + failed) * CREDITS_PER_CALL}`
  );
  return { enriched, withLeaseTerm, failed };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const valueOf = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };

  run({
    platform: valueOf('platform') || 'Zillow',
    limit:    valueOf('limit') ? Number(valueOf('limit')) : DEFAULT_LIMIT,
    dryRun:   args.includes('--dry-run'),
    force:    args.includes('--force'),
  }).catch(handleFatal);
}

module.exports = {
  extractMinimumLeaseDays,
  extractExtras,
  leaseTermToMonths,
  findFloorPlan,
  mapPets,
  run,
};
