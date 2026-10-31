const mongoose = require('mongoose');

// The ingestors now write through Mongoose directly, so they need a live
// connection whether they were started from the CLI or called in-process by
// the search route. In-process the server has already connected, and
// reconnecting would be wasteful, so this is a no-op there.
async function ensureConnection() {
  // 1 = connected, 2 = connecting
  if (mongoose.connection.readyState === 1) return;
  if (mongoose.connection.readyState === 2) {
    await new Promise((resolve, reject) => {
      mongoose.connection.once('connected', resolve);
      mongoose.connection.once('error', reject);
    });
    return;
  }

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI missing — set it in .env');
  await mongoose.connect(uri);
}

module.exports = { ensureConnection };
