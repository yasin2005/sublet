/* Sublet — map + list search UI.
 *
 * Three things make this more than a fetch-and-render:
 *
 * 1. Cold cities fill in behind the page. A city nobody has searched yet
 *    responds immediately with nothing, while the server scrapes Zillow,
 *    Redfin and Airbnb (one at a time — the HasData plan allows a single
 *    concurrent request) and then FurnishedFinder in a detached run. The page
 *    polls /status and reloads as each tier lands, keeping the user's page.
 *
 * 2. The map and the list are two views of one query. The list is paged; the
 *    map plots every match through the lightweight ?view=pins projection.
 *    Dragging the map turns the viewport into the search area.
 *
 * 3. Every search increments the epoch. Anything that comes back tagged with an
 *    older value is discarded, so a slow earlier search can never overwrite the
 *    results of a newer one.
 *
 * No key is sent from here. Anything in this file is readable by every
 * visitor, so the server allows unauthenticated fetches under a per-IP and
 * site-wide budget instead.
 */

const PAGE_SIZE = 24;
const MAX_PINS = 500;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 150 * 1000;
const SHORT_LEASE_DAYS = 92;   // "fits a summer" — matches the server's medium tier
const US_CENTER = [-98.35, 39.5]; // [lng, lat], as MapLibre expects

const $ = (id) => document.getElementById(id);
const form = $('search-form');
const whereInput = $('where');
const sortSelect = $('sort');
const results = $('results');
const heading = $('heading');
const summary = $('summary');
const progress = $('progress');
const progressText = $('progress-text');
const empty = $('empty');
const pager = $('pager');
const layout = document.querySelector('.layout');
const moveSearch = $('move-search');
const searchArea = $('search-area');
const resetButton = $('reset-filters');
const detail = $('detail');
const detailBody = $('detail-body');

const FILTER_DEFAULTS = {
  maxLease: '', minPrice: '', maxPrice: '', minBedrooms: '',
  propertyType: '', spaceType: '', isFurnished: '', platform: '',
  moveIn: '', moveOut: '', maxCommuteMiles: '',
};

const state = {
  city: '',
  state: '',
  filters: { ...FILTER_DEFAULTS },
  sort: 'best',
  page: 1,
  bounds: null,        // "w,s,e,n" once the user has moved the map
  total: 0,
  totalPages: 1,
  updatedAt: null,     // when the city was last scraped, for "updated 3 hours ago"
  office: null,        // { label, coordinates: [lng, lat] } — where the intern works
};

let epoch = 0;
let pollTimer = null;
let fitPending = false;        // fit the map to the pins once they first arrive
let userMovedMap = false;      // set by a real gesture, so our own fitBounds never counts
const listingsById = new Map();
const photoIndex = new Map();

// ─── Formatting ────────────────────────────────────────────────────────

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));

const money = (n) => `$${Number(n).toLocaleString()}`;

function shortMoney(n) {
  if (n < 1000) return `$${n}`;
  const k = n / 1000;
  return `$${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}K`;
}

const PLATFORM_NAMES = { FacebookMarketplace: 'Facebook Marketplace', University: 'University intern housing' };
const platformName = (p) => PLATFORM_NAMES[p] || p;

const isUniversity = (l) => l.originalPlatform === 'University';

// University programs may publish no rate; never print "$null".
const priceHtml = (l, unit = '/mo') =>
  l.pricePerMonth != null ? `${money(l.pricePerMonth)}<small>${unit}</small>` : '<span class="no-price">Rates not published</span>';

// ─── Commute ───────────────────────────────────────────────────────────
// The server returns straight-line distance to the office (_distanceKm).
// Walk and bike times are ESTIMATES: straight-line distance stretched by a
// typical street-grid detour, at steady walking and cycling speeds. Real
// transit and driving times need a routing service with timetables, so the
// detail view links out to Google Maps for those instead of guessing.
const KM_PER_MILE = 1.609344;
const DETOUR_FACTOR = 1.3;
const WALK_KMH = 5;
const BIKE_KMH = 15;

const minutesAt = (km, kmh) => Math.max(1, Math.round((km * DETOUR_FACTOR / kmh) * 60));

function milesText(km) {
  const miles = km / KM_PER_MILE;
  return miles < 10 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`;
}

// One short phrase for a card: walking if it is a reasonable walk, else biking.
function commuteSummary(km) {
  const walk = minutesAt(km, WALK_KMH);
  return walk <= 30
    ? `${milesText(km)} to office, about ${walk} min walk`
    : `${milesText(km)} to office, about ${minutesAt(km, BIKE_KMH)} min by bike`;
}

function haversineKm([lng1, lat1], [lng2, lat2]) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * 6378.1 * Math.asin(Math.sqrt(Math.min(a, 1)));
}

function directionsUrl(l, mode) {
  const [lng, lat] = l.location.coordinates;
  const [oLng, oLat] = state.office.coordinates;
  return `https://www.google.com/maps/dir/?api=1&origin=${lat},${lng}&destination=${oLat},${oLng}&travelmode=${mode}`;
}

function leaseFit(days) {
  if (days == null) return 'unknown';
  return days <= SHORT_LEASE_DAYS ? 'fit' : 'long';
}

function leaseLabel(days) {
  // null is genuinely unknown, not "no minimum" — say so rather than implying
  // a short stay is allowed. Most of the catalogue is in this state.
  if (days == null) return 'Lease not listed';
  if (days < 28) return `${days}-night minimum`;
  const months = Math.max(Math.round(days / 30), 1);
  return `${months}-month minimum`;
}

function specsHtml(l) {
  const parts = [];
  if (l.bedrooms === 0) parts.push('<span><b>Studio</b></span>');
  else if (l.bedrooms != null) parts.push(`<span><b>${l.bedrooms}</b> bd</span>`);
  if (l.bathrooms != null) parts.push(`<span><b>${l.bathrooms}</b> ba</span>`);
  if (l.squareFeet) parts.push(`<span><b>${Number(l.squareFeet).toLocaleString()}</b> sqft</span>`);
  parts.push(`<span>${escapeHtml(l.spaceType === 'Entire Place' ? l.propertyType : l.spaceType)}</span>`);
  return `<div class="specs">${parts.join('')}</div>`;
}

// Edge's Tracking Prevention blocks Airbnb's and Facebook's image CDNs on a
// third-party page, so those photos go through the server's /img relay.
// Everything else loads directly. Keep in step with routes/images.js.
const RELAYED_IMAGE_HOSTS = ['.muscache.com', '.fbcdn.net'];

function photoSrc(url) {
  try {
    const { hostname } = new URL(url);
    return RELAYED_IMAGE_HOSTS.some((suffix) => hostname.endsWith(suffix)) ? `/img?u=${encodeURIComponent(url)}` : url;
  } catch {
    return url;
  }
}

const withPhotoSrcs = (l) => ({ ...l, images: (l.images || []).map(photoSrc) });

const whereText = (l) => l.address || [l.city, l.zipCode].filter(Boolean).join(' ') || 'Exact location shared after booking';

// ─── Map ───────────────────────────────────────────────────────────────
// MapLibre GL with MapTiler vector tiles — the same stack Ohana runs. Vector
// tiles keep labels sharp at every zoom and let the map glide rather than
// step between zoom levels.
//
// The MapTiler key reaches the page from the server (.env MAPTILER_API_KEY).
// It is a browser key by design: restrict it to your domains in the MapTiler
// dashboard. Without one the map falls back to OpenStreetMap's raster tiles,
// which are fine for local development but not allowed for a public site.
//
// NOTE: MapLibre zoom levels run one lower than Leaflet's for the same view
// (512px tiles, not 256px), and every coordinate here is [lng, lat].

const { maptilerKey = '', maptilerStyle = 'streets-v2' } = window.SUBLET_CONFIG || {};

const OSM_FALLBACK_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

const map = new maplibregl.Map({
  container: 'map',
  style: maptilerKey
    ? `https://api.maptiler.com/maps/${encodeURIComponent(maptilerStyle)}/style.json?key=${encodeURIComponent(maptilerKey)}`
    : OSM_FALLBACK_STYLE,
  center: US_CENTER,
  zoom: 3,
  dragRotate: false,      // a rental map has no use for bearing or pitch
  pitchWithRotate: false,
  touchPitch: false,
  attributionControl: { compact: true },
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

// MapTiler's free plan requires its logo on the map.
if (maptilerKey) {
  const logo = document.createElement('a');
  logo.className = 'maptiler-logo';
  logo.href = 'https://www.maptiler.com';
  logo.target = '_blank';
  logo.rel = 'noopener';
  logo.innerHTML = '<img src="https://api.maptiler.com/resources/logo.svg" alt="MapTiler">';
  map.getContainer().appendChild(logo);
}

const markersById = new Map();

function moveMapTo(fn) {
  userMovedMap = false;
  fn();
}

// Prices only once the map is close enough to read them; see .is-zoomed-out.
const PRICE_LABEL_MIN_ZOOM = 11;
const mapPane = document.querySelector('.map-pane');
const syncPinDetail = () => mapPane.classList.toggle('is-zoomed-out', map.getZoom() < PRICE_LABEL_MIN_ZOOM);
map.on('zoomend', syncPinDetail);
syncPinDetail();

function fitToPins() {
  if (markersById.size === 0) return;
  const bounds = new maplibregl.LngLatBounds();
  for (const marker of markersById.values()) bounds.extend(marker.getLngLat());
  moveMapTo(() => map.fitBounds(bounds, { padding: 30, maxZoom: 13, animate: false }));
}

function renderPins(pins) {
  for (const marker of markersById.values()) marker.remove();
  markersById.clear();

  for (const pin of pins) {
    const [lng, lat] = pin.location?.coordinates || [];
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;

    const fit = leaseFit(pin.minimumLeaseDays);
    const university = isUniversity(pin);
    const el = document.createElement('div');
    el.className = university ? 'pin pin--university' : `pin pin--${fit}`;
    el.innerHTML = `<span>${pin.pricePerMonth != null ? shortMoney(pin.pricePerMonth) : 'Campus'}</span>`;
    // University programs, then confirmed short leases, draw on top.
    el.style.zIndex = university ? '3' : fit === 'fit' ? '2' : '1';
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      openDetail(pin._id);
    });
    el.addEventListener('mouseenter', () => setHot(pin._id, true));
    el.addEventListener('mouseleave', () => setHot(pin._id, false));

    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([lng, lat]).addTo(map);
    markersById.set(pin._id, marker);
  }

  // A hidden map (the mobile list view) has no size, so fitting it now would
  // aim at the wrong place. The fit waits until the map is shown.
  if (fitPending && markersById.size > 0 && mapEl.offsetWidth > 0) {
    fitPending = false;
    fitToPins();
  }
}

let officeMarker = null;

function renderOfficeMarker() {
  officeMarker?.remove();
  officeMarker = null;
  if (!state.office) return;

  const el = document.createElement('div');
  el.className = 'office-pin';
  el.title = state.office.label;
  el.innerHTML = '<span>Your office</span>';
  // Above every listing pin, so it is never buried in a dense neighbourhood.
  el.style.zIndex = '10';
  officeMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
    .setLngLat(state.office.coordinates)
    .addTo(map);
}

function setHot(id, on) {
  markersById.get(id)?.getElement()?.classList.toggle('is-hot', on);
  results.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.toggle('is-hot', on);
}

// Only a gesture on the map makes a move the user's. A time window after our
// own fitBounds was tried first and failed on slow first loads, where a late
// moveend landed outside it and silently swapped the city search for a
// map-area search.
const mapEl = map.getContainer();
for (const type of ['pointerdown', 'wheel', 'keydown']) {
  mapEl.addEventListener(type, () => { userMovedMap = true; }, { passive: true });
}

map.on('moveend', () => {
  if (!userMovedMap || !state.city) return;
  userMovedMap = false;
  if (moveSearch.checked) searchThisArea();
  else searchArea.hidden = false;
});

function searchThisArea() {
  const b = map.getBounds();
  state.bounds = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(5)).join(',');
  state.page = 1;
  searchArea.hidden = true;
  runSearch({ fresh: false });
}

searchArea.addEventListener('click', searchThisArea);

// ─── Rendering the list ────────────────────────────────────────────────

// Distance line, only once the intern has set an office.
const commuteLine = (l) =>
  l._distanceKm != null ? `<div class="card__commute">${escapeHtml(commuteSummary(l._distanceKm))}</div>` : '';

// University programs have no photos and their value is in the rules — who
// may apply and for which season — so they get their own card.
function universityCardHtml(l) {
  const u = l.university || {};
  return `
    <article class="card card--university" data-id="${escapeHtml(l._id)}" tabindex="0"
             aria-label="${escapeHtml(u.programName)} at ${escapeHtml(u.name)}">
      <div class="card__photo card__campus">
        <span class="campus__kicker">University intern housing</span>
        <span class="campus__name">${escapeHtml(u.name)}</span>
        <span class="campus__program">${escapeHtml(u.programName)}</span>
      </div>
      <div class="card__body">
        <div class="card__price">${priceHtml(l)}</div>
        <div class="specs"><span>${escapeHtml(l.propertyType)}</span><span>${escapeHtml(l.spaceType)}</span></div>
        <div class="card__addr">${escapeHtml(u.season || '')}</div>
        ${commuteLine(l)}
        <div class="card__foot">
          <span class="eligibility eligibility--${escapeHtml(u.eligibility || 'open')}">
            ${u.eligibility === 'restricted' ? 'Own students only' : 'Open to students from any college'}
          </span>
        </div>
      </div>
    </article>`;
}

function cardHtml(l) {
  if (isUniversity(l)) return universityCardHtml(l);

  const images = l.images || [];
  const photo = images[0]
    ? `<img src="${escapeHtml(images[0])}" alt="" loading="lazy">
       ${images.length > 1 ? `
         <button type="button" class="card__nav card__nav--prev" data-step="-1" aria-label="Previous photo">‹</button>
         <button type="button" class="card__nav card__nav--next" data-step="1" aria-label="Next photo">›</button>
         <span class="card__count">1 / ${images.length}</span>` : ''}`
    : '<div class="none">No photos</div>';

  const fit = leaseFit(l.minimumLeaseDays);
  const extra = l.isFurnished ? ', furnished' : '';

  return `
    <article class="card" data-id="${escapeHtml(l._id)}" tabindex="0"
             aria-label="${escapeHtml(l.pricePerMonth != null ? `${money(l.pricePerMonth)} a month` : 'Price not listed')}, ${escapeHtml(whereText(l))}">
      <div class="card__photo">${photo}</div>
      <div class="card__body">
        <div class="card__price">${priceHtml(l, `/mo${extra}`)}</div>
        ${specsHtml(l)}
        <div class="card__addr">${escapeHtml(whereText(l))}</div>
        ${commuteLine(l)}
        <div class="card__foot">
          <span class="lease lease--${fit}">${leaseLabel(l.minimumLeaseDays)}</span>
          <span class="card__source">${escapeHtml(platformName(l.originalPlatform))}</span>
        </div>
      </div>
    </article>`;
}

function skeletonHtml(n = 6) {
  return Array.from({ length: n }, () => `
    <div class="card skeleton" aria-hidden="true">
      <div class="card__photo"></div>
      <div class="card__body"><div class="bar" style="width:40%"></div><div class="bar" style="width:70%"></div><div class="bar" style="width:55%"></div></div>
    </div>`).join('');
}

function renderList(rawListings) {
  const listings = rawListings.map(withPhotoSrcs);
  for (const l of listings) listingsById.set(l._id, l);
  results.innerHTML = listings.map(cardHtml).join('');
}

function timeAgo(date) {
  const minutes = Math.round((Date.now() - new Date(date).getTime()) / 60000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

function renderHeader(meta) {
  // Only a search response that checked the cache carries lastFetchedAt;
  // paging and filtering keep the value from the search that did.
  if (meta?.lastFetchedAt) state.updatedAt = meta.lastFetchedAt;

  const place = state.city ? `${state.city}${state.state ? ', ' + state.state : ''}` : '';
  heading.textContent = state.bounds
    ? 'Rentals in this map area'
    : place ? `Rentals near ${place}` : 'Find a place for your internship';

  const n = state.total;
  summary.innerHTML = n === 0
    ? 'No matches yet'
    : `<strong>${n.toLocaleString()}</strong> ${n === 1 ? 'rental' : 'rentals'}` +
      (meta?.search?.mode === 'radius' && !state.bounds ? ` within ${Math.round(meta.search.radiusKm * 0.621)} miles` : '') +
      (state.updatedAt && !pollTimer ? `, updated ${timeAgo(state.updatedAt)}` : '');
}

function renderPager() {
  const { page, totalPages } = state;
  pager.hidden = totalPages <= 1;
  if (pager.hidden) return (pager.innerHTML = '');

  // First, last, and a window around the current page.
  const pages = new Set([1, totalPages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= totalPages));
  const sorted = [...pages].sort((a, b) => a - b);

  let html = `<button type="button" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>`;
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) html += '<span>…</span>';
    html += `<button type="button" data-page="${p}" ${p === page ? 'aria-current="page"' : ''}>${p}</button>`;
  });
  html += `<button type="button" data-page="${page + 1}" ${page === totalPages ? 'disabled' : ''} aria-label="Next page">›</button>`;
  pager.innerHTML = html;
}

function showEmpty(title, body) {
  empty.innerHTML = `<strong>${escapeHtml(title)}</strong>${escapeHtml(body)}`;
  empty.hidden = false;
}

function showProgress(text) {
  progress.hidden = !text;
  progressText.textContent = text || '';
}

// ─── Fetching ──────────────────────────────────────────────────────────

function queryFor({ pins = false, noFetch = true } = {}) {
  const q = new URLSearchParams();
  if (state.city) q.set('city', state.city);
  if (state.state) q.set('state', state.state);
  if (state.bounds) q.set('bounds', state.bounds);

  const f = state.filters;
  if (f.maxLease) q.set('maxMinimumLeaseDays', f.maxLease);
  for (const key of ['minPrice', 'maxPrice', 'minBedrooms', 'propertyType', 'spaceType', 'isFurnished', 'platform']) {
    if (f[key]) q.set(key, f[key]);
  }
  // Dates only as a pair; the server ignores half a stay.
  if (f.moveIn && f.moveOut) {
    q.set('moveIn', f.moveIn);
    q.set('moveOut', f.moveOut);
  }
  if (state.office) {
    q.set('office', state.office.coordinates.map((n) => n.toFixed(5)).join(','));
    if (f.maxCommuteMiles) q.set('maxCommuteMiles', f.maxCommuteMiles);
  }

  q.set('sort', state.sort);
  if (pins) {
    q.set('view', 'pins');
    q.set('limit', String(MAX_PINS));
  } else {
    q.set('page', String(state.page));
    q.set('limit', String(PAGE_SIZE));
  }
  // Only the first request for a city may start a scrape. Every follow-up —
  // paging, filtering, panning — reads the cache and spends nothing.
  if (noFetch) q.set('noFetch', 'true');
  return q;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json();
}

// fresh = a new city search, which may trigger a live scrape.
async function runSearch({ fresh }) {
  const forEpoch = ++epoch;
  if (fresh) stopPolling();
  syncUrl();
  empty.hidden = true;

  if (!state.city && !state.bounds) return;

  if (fresh) {
    results.innerHTML = skeletonHtml();
    pager.hidden = true;
  }

  try {
    const [list, pins] = await Promise.all([
      getJson(`/api/listings?${queryFor({ noFetch: !fresh })}`),
      getJson(`/api/listings?${queryFor({ pins: true })}`),
    ]);
    if (forEpoch !== epoch) return;

    state.total = list.total;
    state.totalPages = list.meta.page.totalPages;

    renderPins(pins.listings);
    renderHeader(list.meta);
    renderPager();

    // A noFetch request reports a running scrape as fetch.inProgress rather
    // than status "in-progress", so accept either.
    const fetchStatus = list.meta.fetch?.status;
    const fastRunning = fetchStatus === 'in-progress' || Boolean(list.meta.fetch?.inProgress);
    const scraping = fastRunning || list.meta.slowFetch?.status === 'running';

    if (list.listings.length === 0 && scraping) {
      results.innerHTML = skeletonHtml();
    } else {
      renderList(list.listings);
    }

    if (fresh && !markersById.size && list.meta.search?.centroid) {
      const [lng, lat] = list.meta.search.centroid;
      moveMapTo(() => map.jumpTo({ center: [lng, lat], zoom: 10 }));
    }

    if (scraping) {
      startPolling(forEpoch, fastRunning);
    } else if (list.total === 0) {
      if (fetchStatus === 'not-authorized') {
        showEmpty(`${state.city} hasn't been searched yet.`,
          ` Live searches are paused for now — ${list.meta.fetch.reason}. Try again later.`);
      } else if (activeFilterCount() > 0) {
        showEmpty('No rentals match these filters.', ' Try a longer lease, a higher max price, or reset the filters.');
      } else {
        showEmpty(`No rentals found${state.bounds ? ' in this area' : ` near ${state.city}`}.`,
          state.bounds ? ' Zoom out or drag the map to look somewhere else.' : ' Check the spelling, or try a nearby larger city.');
      }
    }
  } catch (error) {
    if (forEpoch !== epoch) return;
    results.innerHTML = '';
    showEmpty('Search failed.', ` ${error.message}. Check that the server is running, then try again.`);
  }
}

// ─── Polling a cold city ───────────────────────────────────────────────

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  showProgress('');
}

function startPolling(forEpoch, fastRunning) {
  stopPolling();
  const startedAt = Date.now();
  let fastWasRunning = fastRunning;

  showProgress(fastRunning
    ? `Pulling listings for ${state.city} from Zillow, Redfin and Airbnb. This takes about 20 seconds.`
    : 'Checking for more furnished places…');

  pollTimer = setInterval(async () => {
    if (forEpoch !== epoch || Date.now() - startedAt > POLL_TIMEOUT_MS) return stopPolling();

    let status;
    try {
      status = await getJson(`/api/listings/status?${new URLSearchParams({ city: state.city, state: state.state })}`);
    } catch {
      return; // transient — the next tick retries
    }
    if (forEpoch !== epoch) return;

    const fastNow = Boolean(status.fetch?.inProgress);
    const slowNow = status.slowFetch?.status === 'running';

    if (fastWasRunning && !fastNow) {
      fastWasRunning = false;
      state.updatedAt = new Date().toISOString();
      fitPending = !state.bounds;
      refreshInPlace(forEpoch);
    }

    // Name only the sources actually running — Facebook can be switched off
    // on the server (ON_DEMAND_FACEBOOK=false).
    if (slowNow && !fastNow) {
      const running = Object.entries(status.slowFetch.sources || {})
        .filter(([, run]) => run?.status === 'running')
        .map(([name]) => platformName(name));
      showProgress(`Checking ${running.length ? running.join(' and ') : 'more sites'} for more places…`);
    }

    if (!fastNow && !slowNow) {
      stopPolling();
      refreshInPlace(forEpoch);
    }
  }, POLL_INTERVAL_MS);
}

// Reload the current page without bumping the epoch, so the poll that called
// it stays valid and the user keeps their place.
async function refreshInPlace(forEpoch) {
  try {
    const [list, pins] = await Promise.all([
      getJson(`/api/listings?${queryFor()}`),
      getJson(`/api/listings?${queryFor({ pins: true })}`),
    ]);
    if (forEpoch !== epoch) return;

    state.total = list.total;
    state.totalPages = list.meta.page.totalPages;
    renderList(list.listings);
    renderPins(pins.listings);
    renderHeader(list.meta);
    renderPager();

    empty.hidden = true;
    if (list.total === 0 && !pollTimer) {
      showEmpty(`No rentals found near ${state.city}.`, ' The sites we search had nothing listed here. Try a nearby larger city.');
    }
  } catch {
    // Leave what is on screen; the next poll or search will retry.
  }
}

// ─── Detail dialog ─────────────────────────────────────────────────────

async function openDetail(id) {
  let listing = listingsById.get(id);
  if (!listing) {
    try {
      listing = withPhotoSrcs(await getJson(`/api/listings/${encodeURIComponent(id)}`));
      listingsById.set(id, listing);
    } catch (error) {
      return;
    }
  }

  // A listing opened from a pin was fetched on its own, without the search's
  // _distanceKm, so work the distance out here — same formula as the server.
  if (state.office && listing._distanceKm == null && listing.location?.coordinates) {
    listing = { ...listing, _distanceKm: haversineKm(listing.location.coordinates, state.office.coordinates) };
  }

  detailBody.innerHTML = detailHtml(listing);
  if (!detail.open) detail.showModal();
  detail.scrollTop = 0;
  setHot(id, true);
  detail.addEventListener('close', () => setHot(id, false), { once: true });
}

function galleryHtml(images) {
  if (images.length === 0) return '<div class="gallery gallery--single"><div class="none">No photos</div></div>';
  if (images.length < 3) {
    return `<div class="gallery gallery--single"><img id="gallery-main" src="${escapeHtml(images[0])}" alt=""></div>`;
  }
  return `
    <div class="gallery">
      <img id="gallery-main" src="${escapeHtml(images[0])}" alt="">
      <div class="gallery__side">
        <img src="${escapeHtml(images[1])}" alt="" data-src="${escapeHtml(images[1])}">
        <img src="${escapeHtml(images[2])}" alt="" data-src="${escapeHtml(images[2])}">
      </div>
    </div>`;
}

const yesNo = (v) => (v ? 'Yes' : 'Not listed');

// Availability and "checked on" values are calendar dates stored as UTC
// midnight. Formatting them in the viewer's zone would show the day before
// anywhere west of Greenwich — June 20 would read June 19 across the US.
function formatDate(value) {
  if (!value) return null;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// Distance and estimates for any listing, once an office is set. Transit and
// driving open in Google Maps, which has the timetables and traffic we lack.
function commuteSectionHtml(l) {
  if (!state.office || l._distanceKm == null || !l.location?.coordinates) return '';
  const km = l._distanceKm;
  return `
    <h2>Commute to your office</h2>
    <p class="commute__to">${escapeHtml(state.office.label)}</p>
    <dl class="facts">
      <div><dt>Distance</dt><dd>${milesText(km)} straight line</dd></div>
      <div><dt>Walking</dt><dd>about ${minutesAt(km, WALK_KMH)} min</dd></div>
      <div><dt>Biking</dt><dd>about ${minutesAt(km, BIKE_KMH)} min</dd></div>
    </dl>
    <p class="commute__links">
      <a href="${escapeHtml(directionsUrl(l, 'transit'))}" target="_blank" rel="noopener noreferrer">Transit time on Google Maps</a>
      <a href="${escapeHtml(directionsUrl(l, 'driving'))}" target="_blank" rel="noopener noreferrer">Driving time on Google Maps</a>
    </p>
    <p class="panel__note">Walk and bike times are estimates from distance.${l.address ? '' : ' This listing\'s location is approximate until you book.'}</p>`;
}

function universityDetailHtml(l) {
  const u = l.university || {};
  const checked = u.checkedOn ? formatDate(u.checkedOn) : null;
  const facts = [
    ['Season', u.season],
    ['Rate', u.priceText],
    ['Minimum stay', l.minimumLeaseDays ? `${l.minimumLeaseDays} nights` : 'Not stated'],
    ['Room', `${l.spaceType}, ${l.propertyType.toLowerCase()}`],
  ];

  return `
    <div class="campus-hero">
      <span class="campus__kicker">University intern housing</span>
      <p class="campus-hero__name" id="detail-price">${escapeHtml(u.name)}</p>
      <p class="campus-hero__program">${escapeHtml(u.programName)}</p>
    </div>
    <div class="detail__main">
      <div>
        <p class="detail__price">${priceHtml(l)}</p>
        <p class="detail__addr">${escapeHtml(l.address || '')}</p>

        <h2>Who can apply</h2>
        <p>${escapeHtml(u.eligibilityText || 'Not stated')}</p>

        <h2>Program details</h2>
        <dl class="facts facts--wide">
          ${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v || 'Not stated')}</dd></div>`).join('')}
        </dl>

        ${u.includes?.length ? `
          <h2>Included</h2>
          <ul class="amenities">${u.includes.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>` : ''}
        ${u.terms ? `<h2>Booking terms</h2><p>${escapeHtml(u.terms)}</p>` : ''}

        ${commuteSectionHtml(l)}
      </div>

      <aside class="side-card">
        <span class="eligibility eligibility--${escapeHtml(u.eligibility || 'open')}">
          ${u.eligibility === 'restricted' ? 'Own students only' : 'Open to students from any college'}
        </span>
        <p>Details are from the university's page${checked ? `, checked ${escapeHtml(checked)}` : ''}. Rates and dates change each year, so confirm before you apply.</p>
        <a class="cta" href="${escapeHtml(u.applyUrl || u.sourceUrl)}" target="_blank" rel="noopener noreferrer">Apply on the university site</a>
        <a class="cta cta--quiet" href="${escapeHtml(u.sourceUrl)}" target="_blank" rel="noopener noreferrer">Read the program page</a>
      </aside>
    </div>`;
}

function detailHtml(l) {
  if (isUniversity(l)) return universityDetailHtml(l);

  const images = (l.images || []).slice(0, 40);
  const fit = leaseFit(l.minimumLeaseDays);
  const pets = [l.petsAllowed?.cats && 'Cats', l.petsAllowed?.dogsSmall && 'Small dogs', l.petsAllowed?.dogsLarge && 'Large dogs']
    .filter(Boolean).join(', ');
  const from = formatDate(l.availableFrom);
  const to = formatDate(l.availableTo);

  const facts = [
    ['Space', l.spaceType],
    ['Home type', l.propertyType],
    ['Furnished', yesNo(l.isFurnished)],
    ['In-unit laundry', yesNo(l.hasInUnitLaundry)],
    ['Air conditioning', yesNo(l.hasAirConditioning)],
    ['Parking', yesNo(l.hasParking)],
    ['Pets', pets || 'Not listed'],
    ['Utilities included', yesNo(l.utilitiesIncluded)],
    ['Deposit', l.depositAmount ? money(l.depositAmount) : 'Not listed'],
    ['Square feet', l.squareFeet ? Number(l.squareFeet).toLocaleString() : 'Not listed'],
  ];

  const thumbs = images.length > 1
    ? `<div class="thumbs">${images.map((src, i) => `
        <button type="button" data-src="${escapeHtml(src)}" ${i === 0 ? 'aria-current="true"' : ''} aria-label="Photo ${i + 1}">
          <img src="${escapeHtml(src)}" alt="" loading="lazy">
        </button>`).join('')}</div>`
    : '';

  const amenities = (l.amenitiesRaw || []).slice(0, 30);

  return `
    ${galleryHtml(images)}
    ${thumbs}
    <div class="detail__main">
      <div>
        <p class="detail__price" id="detail-price">${priceHtml(l)}</p>
        <p class="detail__addr">${escapeHtml(whereText(l))}</p>
        ${specsHtml(l)}

        <h2>Facts and features</h2>
        <dl class="facts">
          ${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}
        </dl>

        ${amenities.length ? `
          <h2>Amenities</h2>
          <ul class="amenities">${amenities.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>` : ''}

        ${commuteSectionHtml(l)}
      </div>

      <aside class="side-card">
        <span class="lease lease--${fit}">${leaseLabel(l.minimumLeaseDays)}</span>
        <p>${from ? `Available ${escapeHtml(from)}${to ? ` to ${escapeHtml(to)}` : ''}.` : 'Availability not listed.'}
           ${fit === 'unknown' ? ' Ask the landlord about a short-term lease before you apply.' : ''}</p>
        <a class="cta" href="${escapeHtml(l.listingUrl)}" target="_blank" rel="noopener noreferrer">
          Open on ${escapeHtml(platformName(l.originalPlatform))}
        </a>
      </aside>
    </div>`;
}

detailBody.addEventListener('click', (event) => {
  const source = event.target.closest('[data-src]');
  if (!source) return;
  const main = $('gallery-main');
  if (main) main.src = source.dataset.src;
  detailBody.querySelectorAll('.thumbs button').forEach((b) =>
    b.setAttribute('aria-current', String(b.dataset.src === source.dataset.src)));
});

$('detail-close').addEventListener('click', () => detail.close());
detail.addEventListener('click', (event) => {
  if (event.target === detail) detail.close(); // backdrop click
});

// ─── Cards: hover sync, photo stepping, opening ────────────────────────

results.addEventListener('click', (event) => {
  const card = event.target.closest('.card[data-id]');
  if (!card) return;

  const nav = event.target.closest('.card__nav');
  if (nav) {
    const listing = listingsById.get(card.dataset.id);
    const images = listing?.images || [];
    const next = ((photoIndex.get(card.dataset.id) || 0) + Number(nav.dataset.step) + images.length) % images.length;
    photoIndex.set(card.dataset.id, next);
    card.querySelector('img').src = images[next];
    card.querySelector('.card__count').textContent = `${next + 1} / ${images.length}`;
    return;
  }

  openDetail(card.dataset.id);
});

results.addEventListener('keydown', (event) => {
  const card = event.target.closest('.card[data-id]');
  if (card && event.target === card && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    openDetail(card.dataset.id);
  }
});

results.addEventListener('mouseover', (event) => {
  const card = event.target.closest('.card[data-id]');
  if (card && !card.contains(event.relatedTarget)) setHot(card.dataset.id, true);
});
results.addEventListener('mouseout', (event) => {
  const card = event.target.closest('.card[data-id]');
  if (card && !card.contains(event.relatedTarget)) setHot(card.dataset.id, false);
});

pager.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-page]');
  if (!button || button.disabled) return;
  state.page = Number(button.dataset.page);
  document.querySelector('.list-pane').scrollTop = 0;
  runSearch({ fresh: false });
});

// ─── Filters ───────────────────────────────────────────────────────────

const MORE_KEYS = ['spaceType', 'isFurnished', 'platform'];

function activeFilterCount() {
  return Object.entries(state.filters).filter(([, v]) => v !== '').length;
}

function pillLabels() {
  const f = state.filters;
  const leaseNames = { 30: 'Up to 1 month', 90: 'Up to 3 months', 180: 'Up to 6 months' };

  let price = 'Price';
  if (f.minPrice && f.maxPrice) price = `${shortMoney(+f.minPrice)}–${shortMoney(+f.maxPrice)}`;
  else if (f.maxPrice) price = `Up to ${shortMoney(+f.maxPrice)}`;
  else if (f.minPrice) price = `${shortMoney(+f.minPrice)}+`;

  const moreCount = MORE_KEYS.filter((k) => f[k]).length;

  const shortDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const hasDates = Boolean(f.moveIn && f.moveOut);
  let trip = 'Your internship';
  if (hasDates) trip = `${shortDate(f.moveIn)} – ${shortDate(f.moveOut)}`;
  if (state.office) trip = hasDates ? `${trip}, office set` : 'Office set';

  return {
    trip:  [trip, hasDates || Boolean(state.office)],
    lease: [f.maxLease ? leaseNames[f.maxLease] : 'Lease', Boolean(f.maxLease)],
    price: [price, Boolean(f.minPrice || f.maxPrice)],
    beds:  [f.minBedrooms ? `${f.minBedrooms}+ beds` : 'Beds', Boolean(f.minBedrooms)],
    type:  [f.propertyType || 'Home type', Boolean(f.propertyType)],
    more:  [moreCount ? `More (${moreCount})` : 'More', moreCount > 0],
  };
}

function syncFilterUi() {
  const labels = pillLabels();
  document.querySelectorAll('.filter').forEach((el) => {
    const [label, set] = labels[el.dataset.filter];
    const pill = el.querySelector('.pill');
    pill.textContent = label;
    pill.classList.toggle('is-set', set);
  });

  document.querySelectorAll('.choices').forEach((group) => {
    const value = state.filters[group.dataset.name] ?? '';
    group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)));
  });

  $('minPrice').value = state.filters.minPrice;
  $('maxPrice').value = state.filters.maxPrice;
  $('moveIn').value = state.filters.moveIn;
  $('moveOut').value = state.filters.moveOut;
  $('office').value = state.office?.label || '';

  // "Closest to office" means nothing until there is an office.
  const commuteOption = sortSelect.querySelector('option[value="commute"]');
  commuteOption.hidden = !state.office;
  if (!state.office && state.sort === 'commute') {
    state.sort = 'best';
    sortSelect.value = 'best';
  }

  resetButton.hidden = activeFilterCount() === 0 && !state.office;
}

// ─── Your internship: dates and office ─────────────────────────────────

const officeStatus = $('office-status');

// MapTiler's geocoder, biased toward wherever the map is looking, so "400
// Broad St" finds the one in the city being searched.
async function geocodeOffice(text) {
  if (!maptilerKey) throw new Error('Office search needs MAPTILER_API_KEY in .env.');
  const { lng, lat } = map.getCenter();
  const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(text)}.json` +
    `?key=${encodeURIComponent(maptilerKey)}&limit=1&country=us&proximity=${lng},${lat}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Address lookup failed (${response.status}).`);
  const feature = (await response.json()).features?.[0];
  if (!feature) throw new Error(`Couldn't find "${text}". Try adding the city.`);
  return { label: feature.place_name, coordinates: feature.center };
}

document.querySelector('[data-apply="trip"]').addEventListener('click', async () => {
  const moveIn = $('moveIn').value;
  const moveOut = $('moveOut').value;
  if ((moveIn || moveOut) && !(moveIn && moveOut)) {
    officeStatus.textContent = 'Add both a move-in and a move-out date.';
    return;
  }
  if (moveIn && moveOut && moveOut <= moveIn) {
    officeStatus.textContent = 'Move-out has to be after move-in.';
    return;
  }

  const officeText = $('office').value.trim();
  if (!officeText) {
    state.office = null;
  } else if (officeText !== state.office?.label) {
    officeStatus.textContent = 'Finding your office…';
    try {
      state.office = await geocodeOffice(officeText);
    } catch (error) {
      officeStatus.textContent = error.message;
      return;
    }
  }

  officeStatus.textContent = state.office ? `Using ${state.office.label}` : '';
  state.filters.moveIn = moveIn;
  state.filters.moveOut = moveOut;
  // Sorting by commute is the point of setting an office, so switch to it.
  if (state.office && state.sort === 'best') {
    state.sort = 'commute';
    sortSelect.value = 'commute';
  }
  renderOfficeMarker();
  closePanels();
  applyFilters();
});

document.querySelector('[data-clear="trip"]').addEventListener('click', () => {
  state.filters.moveIn = '';
  state.filters.moveOut = '';
  state.filters.maxCommuteMiles = '';
  state.office = null;
  officeStatus.textContent = '';
  renderOfficeMarker();
  closePanels();
  applyFilters();
});

$('office').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') document.querySelector('[data-apply="trip"]').click();
});

function closePanels(except) {
  document.querySelectorAll('.filter').forEach((el) => {
    if (el === except) return;
    el.querySelector('.panel').hidden = true;
    el.querySelector('.pill').setAttribute('aria-expanded', 'false');
  });
}

function applyFilters() {
  state.page = 1;
  syncFilterUi();
  runSearch({ fresh: false });
}

document.querySelectorAll('.filter').forEach((el) => {
  const pill = el.querySelector('.pill');
  const panel = el.querySelector('.panel');
  pill.addEventListener('click', () => {
    const open = panel.hidden;
    closePanels(el);
    panel.hidden = !open;
    pill.setAttribute('aria-expanded', String(open));
  });
});

document.querySelectorAll('.choices').forEach((group) => {
  group.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button) return;
    state.filters[group.dataset.name] = button.dataset.value;
    // Single-choice panels close on pick; the multi-section "More" stays open.
    if (!group.closest('.panel--wide')) closePanels();
    applyFilters();
  });
});

document.querySelector('[data-apply="price"]').addEventListener('click', () => {
  let min = $('minPrice').value;
  let max = $('maxPrice').value;
  if (min && max && Number(min) > Number(max)) [min, max] = [max, min];
  state.filters.minPrice = min;
  state.filters.maxPrice = max;
  closePanels();
  applyFilters();
});

['minPrice', 'maxPrice'].forEach((id) => $(id).addEventListener('keydown', (event) => {
  if (event.key === 'Enter') document.querySelector('[data-apply="price"]').click();
}));

resetButton.addEventListener('click', () => {
  state.filters = { ...FILTER_DEFAULTS };
  state.office = null;
  renderOfficeMarker();
  applyFilters();
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.filter')) closePanels();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePanels();
});

sortSelect.addEventListener('change', () => {
  state.sort = sortSelect.value;
  state.page = 1;
  runSearch({ fresh: false });
});

// ─── City search ───────────────────────────────────────────────────────

function parseWhere(text) {
  const [city, region] = text.split(',').map((s) => s.trim());
  return { city: city || '', state: (region || '').toUpperCase().slice(0, 2) };
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const { city, state: region } = parseWhere(whereInput.value);
  if (!city) return;

  if (!region) {
    showEmpty('Add a state to your search.', ' For example "Austin, TX" — several cities share a name.');
    whereInput.focus();
    return;
  }

  state.city = city;
  state.state = region;
  state.bounds = null;
  state.page = 1;
  state.updatedAt = null;
  searchArea.hidden = true;
  fitPending = true;
  for (const marker of markersById.values()) marker.remove();
  markersById.clear();
  runSearch({ fresh: true });
});

// ─── URL state, so a search survives a reload and can be shared ────────

function syncUrl() {
  const q = new URLSearchParams();
  if (state.city) q.set('where', `${state.city}${state.state ? ', ' + state.state : ''}`);
  for (const [k, v] of Object.entries(state.filters)) if (v) q.set(k, v);
  if (state.office) {
    q.set('office', state.office.coordinates.map((n) => n.toFixed(5)).join(','));
    q.set('officeLabel', state.office.label);
  }
  if (state.sort !== 'best') q.set('sort', state.sort);
  if (state.page > 1) q.set('page', String(state.page));
  history.replaceState(null, '', q.toString() ? `?${q}` : location.pathname);
}

function restoreFromUrl() {
  const q = new URLSearchParams(location.search);
  for (const key of Object.keys(FILTER_DEFAULTS)) state.filters[key] = q.get(key) || '';

  // A shared link carries the office as coordinates, so it needs no lookup.
  const officePoint = (q.get('office') || '').split(',').map(Number);
  if (officePoint.length === 2 && officePoint.every(Number.isFinite)) {
    state.office = { label: q.get('officeLabel') || 'Your office', coordinates: officePoint };
    renderOfficeMarker();
  }

  state.sort = ['best', 'price', 'newest', 'commute'].includes(q.get('sort')) ? q.get('sort') : 'best';
  sortSelect.value = state.sort;
  syncFilterUi();

  const where = q.get('where');
  if (where) {
    whereInput.value = where;
    form.requestSubmit();
  }
}

// ─── Mobile map/list toggle ────────────────────────────────────────────

$('view-toggle').addEventListener('click', (event) => {
  const toMap = layout.dataset.view === 'list';
  layout.dataset.view = toMap ? 'map' : 'list';
  event.currentTarget.textContent = toMap ? 'List' : 'Map';
  if (toMap) {
    map.resize();
    if (fitPending) {
      fitPending = false;
      fitToPins();
    }
  }
});

// No point polling a tab nobody is looking at — but pick up where it left off
// when the user comes back, or a cold city would never fill in.
let resumeOnVisible = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden && pollTimer) {
    stopPolling();
    resumeOnVisible = true;
  } else if (!document.hidden && resumeOnVisible) {
    resumeOnVisible = false;
    runSearch({ fresh: false });
  }
});

restoreFromUrl();
