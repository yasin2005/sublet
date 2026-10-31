// Runs the app against a MongoDB that lives inside the project, for when the
// Atlas cluster in .env is unreachable (deleted, paused, or offline).
//
//   npm run dev:local
//
// The first run downloads a mongod binary (~100MB, cached afterwards). Data is
// written to .data/db, so listings survive restarts like a real database would.
// Set MONGO_URI back to a working Atlas URI and use `npm start` for the real
// thing — nothing else in the app knows this script exists.

const fs = require('fs');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');

const DB_PATH = path.join(__dirname, '..', '.data', 'db');
const PORT = 27027; // fixed, so `node ingest/zillow.js` can reuse it via LOCAL_MONGO_URI

async function main() {
  fs.mkdirSync(DB_PATH, { recursive: true });

  const mongod = await MongoMemoryServer.create({
    instance: { dbPath: DB_PATH, port: PORT, storageEngine: 'wiredTiger' },
  });

  // Set BEFORE server.js loads: dotenv never overrides an existing variable,
  // so the Atlas URI in .env is ignored for this process only.
  process.env.MONGO_URI = mongod.getUri('housing-search');
  console.log(`Local MongoDB running at ${process.env.MONGO_URI} (data in .data/db)`);

  const shutdown = async () => {
    await mongod.stop({ doCleanup: false }); // keep the data directory
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  require('../server');
}

main().catch((err) => {
  console.error('Could not start local MongoDB:', err.message);
  process.exit(1);
});
