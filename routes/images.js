const express = require('express');

// Same-origin relay for listing photos whose CDN the browser refuses to load.
//
// Edge's default Tracking Prevention classifies Airbnb's image CDN
// (muscache.com) and Facebook's (fbcdn.net) as trackers when they appear on a
// third-party page, so every Airbnb and Facebook photo rendered blank there —
// ERR_BLOCKED_BY_CLIENT. Served from our own origin they are ordinary images.
//
// Allowlisted by host suffix, so this can never be used as an open proxy to
// fetch arbitrary URLs from the server's network position.
const ALLOWED_HOST_SUFFIXES = ['.muscache.com', '.fbcdn.net'];
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

const router = express.Router();

function isAllowed(url) {
  return url.protocol === 'https:' && ALLOWED_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix));
}

router.get('/', async (req, res) => {
  let target;
  try {
    target = new URL(String(req.query.u || ''));
  } catch {
    return res.status(400).json({ error: 'u must be an absolute image URL' });
  }
  if (!isAllowed(target)) return res.status(403).json({ error: 'image host not allowed' });

  try {
    const upstream = await fetch(target, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'image/*' },
    });

    const type = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !type.startsWith('image/')) {
      return res.status(upstream.ok ? 415 : upstream.status).end();
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length > MAX_BYTES) return res.status(413).end();

    res.set('Content-Type', type);
    // Listing photos never change under the same URL. Facebook's are signed
    // and expire after a few weeks, so cap at a day rather than forever.
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(body);
  } catch (err) {
    res.status(502).json({ error: `image fetch failed: ${err.message}` });
  }
});

module.exports = { router, ALLOWED_HOST_SUFFIXES };
