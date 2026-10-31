require('dotenv').config();
const mongoose = require('mongoose');
const Listing = require('./models/Listing');

const BASE = process.env.TEST_API_URL || 'http://localhost:3000/api/listings';

// POST is guarded — internal writers must present the aggregator key.
const WRITE_HEADERS = {
  'Content-Type': 'application/json',
  'x-aggregator-key': process.env.AGGREGATOR_API_KEY || '',
};
const TEST_PLATFORM = 'TEST_MOCK';

// ── Mock payloads: each simulates a different source's data shape ──────
const mocks = [
  // 1) Zillow-shaped: complete, 12-month min lease — should FAIL intern filter
  {
    originalPlatform: TEST_PLATFORM,
    originalId: 'zillow-shape-1',
    address: '123 Pine St, Seattle, WA',
    city: 'Seattle',
    neighborhood: 'Capitol Hill',
    location: { coordinates: [-122.3196, 47.6205] },
    pricePerMonth: 2200,
    spaceType: 'Entire Place',
    propertyType: 'Apartment',
    bedrooms: 1,
    bathrooms: 1,
    isFurnished: false,
    minimumLeaseDays: 365,
    availableFrom: '2026-09-01',
    listingUrl: 'https://example.com/zillow-1',
  },

  // 2) FurnishedFinder-shaped: 60-day min, furnished — should PASS intern filter
  {
    originalPlatform: TEST_PLATFORM,
    originalId: 'ff-shape-2',
    address: '456 Terry Ave, Seattle, WA',
    city: 'Seattle',
    neighborhood: 'South Lake Union',
    location: { coordinates: [-122.3345, 47.6205] },
    pricePerMonth: 1800,
    spaceType: 'Entire Place',
    propertyType: 'Apartment',
    bedrooms: 0,
    bathrooms: 1,
    isFurnished: true,
    minimumLeaseDays: 60,
    availableFrom: '2026-06-01',
    availableTo: '2026-08-31',
    listingUrl: 'https://example.com/ff-2',
  },

  // 3) Airbnb-shaped: no address (privacy), no availableTo (open-ended) — should PASS
  {
    originalPlatform: TEST_PLATFORM,
    originalId: 'airbnb-shape-3',
    neighborhood: 'Mission District',
    city: 'San Francisco',
    location: { coordinates: [-122.4194, 37.7599] },
    pricePerMonth: 2400,
    spaceType: 'Private Room',
    propertyType: 'House',
    bedrooms: 1,
    bathrooms: 1,
    isFurnished: true,
    minimumLeaseDays: 30,
    availableFrom: '2026-06-01',
    listingUrl: 'https://example.com/airbnb-3',
  },

  // 4) University-board-shaped: missing bedrooms/bathrooms/minimumLeaseDays
  //    — should be DROPPED by the conservative null-lease policy
  {
    originalPlatform: TEST_PLATFORM,
    originalId: 'uni-shape-4',
    address: '789 College Park Dr, College Park, MD',
    city: 'College Park',
    location: { coordinates: [-76.9378, 38.9897] },
    pricePerMonth: 1200,
    spaceType: 'Private Room',
    propertyType: 'House',
    isFurnished: true,
    availableFrom: '2026-06-01',
    listingUrl: 'https://example.com/uni-4',
  },
];

// ── HTTP helpers ───────────────────────────────────────────────────────
async function post(payload) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: WRITE_HEADERS,
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function get(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(qs ? `${BASE}?${qs}` : BASE);
  return { status: res.status, body: await res.json() };
}

function check(name, condition, extra = '') {
  const mark = condition ? '✓ PASS' : '✗ FAIL';
  console.log(`  ${mark}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!condition) process.exitCode = 1;
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  // Pre-clean in case a previous run left data behind
  await Listing.deleteMany({ originalPlatform: TEST_PLATFORM });

  console.log('\n1. POST all mock listings:');
  for (const mock of mocks) {
    const { status } = await post(mock);
    check(`POST ${mock.originalId} → 201`, status === 201);
  }

  console.log('\n2. Dedup check:');
  const dup = await post(mocks[0]);
  check('Duplicate POST → 409', dup.status === 409);

  console.log('\n3. Filter tests:');
  {
    const { body } = await get({ maxMinimumLeaseDays: 90 });
    const ids = body.listings.map((l) => l.originalId).sort();
    const expected = ['airbnb-shape-3', 'ff-shape-2'];
    check(
      'maxMinimumLeaseDays=90 → only short-lease mocks (excludes 12-mo and null-lease)',
      JSON.stringify(ids) === JSON.stringify(expected),
      `got: ${JSON.stringify(ids)}`,
    );
  }
  {
    const { body } = await get({ city: 'Seattle' });
    check('city=Seattle → 2 listings', body.count === 2, `got ${body.count}`);
  }
  {
    const { body } = await get({ isFurnished: 'true' });
    check('isFurnished=true → 3 listings', body.count === 3, `got ${body.count}`);
  }
  {
    const { body } = await get({ spaceType: 'Private Room' });
    check('spaceType=Private Room → 2 listings', body.count === 2, `got ${body.count}`);
  }
  {
    const { body } = await get();
    check('No filter → all 4 listings', body.count === 4, `got ${body.count}`);
  }

  console.log('\n4. Teardown:');
  const { deletedCount } = await Listing.deleteMany({ originalPlatform: TEST_PLATFORM });
  check(`Deleted ${deletedCount} TEST_MOCK listings`, deletedCount === 4);

  const remaining = await Listing.countDocuments({ originalPlatform: TEST_PLATFORM });
  check('Zero TEST_MOCK listings remain in DB', remaining === 0);

  await mongoose.disconnect();
  console.log(`\nDone. Exit code: ${process.exitCode || 0}`);
}

main().catch(async (err) => {
  if (err.cause?.code === 'ECONNREFUSED' || err.code === 'ECONNREFUSED') {
    console.error('\n✗ Could not connect to the API server at ' + BASE);
    console.error('  Start the server first: `npm run dev` in another terminal.');
  } else {
    console.error('Test script crashed:', err);
  }
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch {}
});
