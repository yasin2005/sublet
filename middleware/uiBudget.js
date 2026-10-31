// Lets the browser trigger a cold-city fetch WITHOUT holding the aggregator key.
//
// The key cannot ship to the browser: anything in public/js is readable by
// every visitor, so putting it there would hand out permission to spend our
// HasData and Apify credits. But if the UI can never trigger a fetch, no city
// the CLI has not already warmed will ever work for a real user.
//
// So the browser path is unauthenticated but BUDGETED. Two independent caps:
//
//   per-IP    stops one person from walking a list of cities
//   global    stops a distributed flood from draining the account overnight
//
// A cached search is free and unmetered — only a request that would actually
// start a scrape consumes budget.
//
// This is in-memory, so it resets on restart and is per-process. That is
// acceptable for a single instance; behind a load balancer it needs Redis.

const PER_IP_HOURLY = Number(process.env.UI_FETCH_PER_IP_HOURLY || 5);
const GLOBAL_DAILY = Number(process.env.UI_FETCH_DAILY_MAX || 50);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const perIp = new Map();  // ip -> number[] (timestamps)
let globalHits = [];      // timestamps

function prune(times, windowMs) {
  const cutoff = Date.now() - windowMs;
  return times.filter((t) => t > cutoff);
}

function clientIp(req) {
  // trust proxy is not enabled, so req.ip is the socket address in dev.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// Reports remaining budget WITHOUT consuming it.
function peekUiBudget(req) {
  const ip = clientIp(req);
  const ipHits = prune(perIp.get(ip) || [], HOUR_MS);
  const dayHits = prune(globalHits, DAY_MS);

  return {
    ipRemaining:     Math.max(PER_IP_HOURLY - ipHits.length, 0),
    globalRemaining: Math.max(GLOBAL_DAILY - dayHits.length, 0),
  };
}

// Consumes one unit if budget allows. Call this ONLY at the moment a fetch is
// actually about to start — never on a cache hit.
function consumeUiBudget(req) {
  const ip = clientIp(req);
  const now = Date.now();

  const ipHits = prune(perIp.get(ip) || [], HOUR_MS);
  globalHits = prune(globalHits, DAY_MS);

  if (globalHits.length >= GLOBAL_DAILY) {
    return {
      allowed: false,
      reason: `daily site-wide fetch budget reached (${GLOBAL_DAILY}); cached results only until it resets`,
    };
  }

  if (ipHits.length >= PER_IP_HOURLY) {
    return {
      allowed: false,
      reason: `hourly limit reached for this address (${PER_IP_HOURLY} new cities/hour)`,
    };
  }

  ipHits.push(now);
  perIp.set(ip, ipHits);
  globalHits.push(now);

  return { allowed: true, reason: 'within UI budget' };
}

module.exports = { consumeUiBudget, peekUiBudget, PER_IP_HOURLY, GLOBAL_DAILY };
