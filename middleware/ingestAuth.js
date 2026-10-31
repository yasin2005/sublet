const crypto = require('crypto');

// Gate on the one thing that costs money: triggering a live scrape.
//
// This is deliberately NOT a 401 gate. An unkeyed request is still a valid
// search — it just cannot spend credits, so it is served from cache only.
// Reading the cache is free; filling it is not.

const HEADER = 'x-aggregator-key';

// Constant-time comparison. Hashing both sides first fixes them to 32 bytes,
// so this leaks neither the key's content nor its length via timing.
function secretsMatch(provided, expected) {
  const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(digest(provided), digest(expected));
}

// Fails CLOSED. If AGGREGATOR_API_KEY is unset or empty, nothing is authorized
// to spend credits — a missing config must never silently reopen the hole this
// exists to close.
function mayTriggerFetch(req) {
  const expected = process.env.AGGREGATOR_API_KEY;
  if (!expected) return { allowed: false, reason: 'server has no AGGREGATOR_API_KEY configured' };

  const provided = req.get(HEADER);
  if (!provided) return { allowed: false, reason: `missing ${HEADER} header` };

  if (!secretsMatch(provided, expected)) return { allowed: false, reason: 'invalid key' };

  return { allowed: true, reason: 'authorized' };
}

// Express middleware for endpoints that WRITE. Unlike search — which degrades
// gracefully to cache-only — there is no meaningful partial version of a
// write, so an unkeyed request is refused outright.
//
// 401 vs 403 is deliberate: 401 means "no valid credential presented", which
// is exactly the case here. 403 would imply the caller is known but forbidden.
function requireKey(req, res, next) {
  const { allowed, reason } = mayTriggerFetch(req);
  if (allowed) return next();

  return res.status(401).json({
    error: 'Unauthorized',
    reason,
    hint: `This endpoint writes to the catalogue. Send the ${HEADER} header.`,
  });
}

module.exports = { mayTriggerFetch, requireKey, HEADER };
