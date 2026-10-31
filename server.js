require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const { resetStuckFetches } = require('./lib/bootCleanup');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Views ─────────────────────────────────────────────────────────────
// The UI is served by the same Express app as the API, so the browser talks to
// /api/listings same-origin — no proxy, no CORS, no build step.
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.render('index'));

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/listings', require('./routes/listings'));
app.use('/img', require('./routes/images').router);

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('MONGO_URI missing — set it in .env');
  process.exit(1);
}

// Not fatal: the API still serves cached search results without it. But every
// cache miss becomes unfillable, so the aggregator quietly stops growing —
// worth shouting about at boot rather than discovering days later.
if (!process.env.AGGREGATOR_API_KEY) {
  console.warn(
    '\n⚠  AGGREGATOR_API_KEY missing — set it in .env\n' +
    '   Live scrapes are DISABLED until it is set (fail-closed).\n' +
    '   Searches still work, but no cache miss can ever be filled.\n'
  );
} else if (process.env.AGGREGATOR_API_KEY.length < 24) {
  console.warn('⚠  AGGREGATOR_API_KEY is short — it guards real spending, use 32+ random chars.');
}

mongoose
  .connect(MONGO_URI)
  .then(async () => {
    console.log('Connected to MongoDB');

    // Bury any detached run orphaned by a previous restart before serving
    // traffic — otherwise /status keeps telling clients to poll a run that
    // no longer exists. Never fatal: a failed cleanup should not stop the API.
    await resetStuckFetches().catch((err) =>
      console.error('Boot cleanup failed (continuing):', err.message)
    );

    app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });







