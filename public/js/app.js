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
const US_CENTER = [39.5, -98.35];

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

const PLATFORM_NAMES = { FacebookMarketplace: 'Facebook Marketplace' };
const platformName = (p) => PLATFORM_NAMES[p] || p;

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

const map = L.map('map', { zoomControl: true }).setView(US_CENTER, 4);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const pinLayer = L.layerGroup().addTo(map);
const markersById = new Map();

function moveMapTo(fn) {
  userMovedMap = false;
  fn();
}

// Prices only once the map is close enough to read them; see .is-zoomed-out.
const PRICE_LABEL_MIN_ZOOM = 12;
const mapPane = document.querySelector('.map-pane');
const syncPinDetail = () => mapPane.classList.toggle('is-zoomed-out', map.getZoom() < PRICE_LABEL_MIN_ZOOM);
map.on('zoomend', syncPinDetail);
syncPinDetail();

function fitToPins() {
  if (markersById.size === 0) return;
  const bounds = L.latLngBounds([...markersById.values()].map((m) => m.getLatLng()));
  moveMapTo(() => map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14, animate: false }));
}

function renderPins(pins) {
  pinLayer.clearLayers();
  markersById.clear();

  for (const pin of pins) {
    const [lng, lat] = pin.location?.coordinates || [];
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;

    const marker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: `pin pin--${leaseFit(pin.minimumLeaseDays)}`,
        html: `<span>${shortMoney(pin.pricePerMonth)}</span>`,
        iconSize: [0, 0],
      }),
      keyboard: false,
      // Confirmed short leases draw on top of everything else.
      zIndexOffset: leaseFit(pin.minimumLeaseDays) === 'fit' ? 500 : 0,
    });
    marker.on('click', () => openDetail(pin._id));
    marker.on('mouseover', () => setHot(pin._id, true));
    marker.on('mouseout', () => setHot(pin._id, false));
    marker.addTo(pinLayer);
    markersById.set(pin._id, marker);
  }

  // A hidden map (the mobile list view) has no size, so fitting it now would
  // aim at the wrong place. The fit waits until the map is shown.
  if (fitPending && markersById.size > 0 && mapEl.offsetWidth > 0) {
    fitPending = false;
    fitToPins();
  }
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

function cardHtml(l) {
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
             aria-label="${escapeHtml(money(l.pricePerMonth))} a month, ${escapeHtml(whereText(l))}">
      <div class="card__photo">${photo}</div>
      <div class="card__body">
        <div class="card__price">${money(l.pricePerMonth)}<small>/mo${extra}</small></div>
        ${specsHtml(l)}
        <div class="card__addr">${escapeHtml(whereText(l))}</div>
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
      moveMapTo(() => map.setView([lat, lng], 11, { animate: false }));
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

function formatDate(value) {
  if (!value) return null;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function detailHtml(l) {
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
        <p class="detail__price" id="detail-price">${money(l.pricePerMonth)}<small>/mo</small></p>
        <p class="detail__addr">${escapeHtml(whereText(l))}</p>
        ${specsHtml(l)}

        <h2>Facts and features</h2>
        <dl class="facts">
          ${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}
        </dl>

        ${amenities.length ? `
          <h2>Amenities</h2>
          <ul class="amenities">${amenities.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>` : ''}
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

  return {
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
  resetButton.hidden = activeFilterCount() === 0;
}

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
  pinLayer.clearLayers();
  markersById.clear();
  runSearch({ fresh: true });
});

// ─── URL state, so a search survives a reload and can be shared ────────

function syncUrl() {
  const q = new URLSearchParams();
  if (state.city) q.set('where', `${state.city}${state.state ? ', ' + state.state : ''}`);
  for (const [k, v] of Object.entries(state.filters)) if (v) q.set(k, v);
  if (state.sort !== 'best') q.set('sort', state.sort);
  if (state.page > 1) q.set('page', String(state.page));
  history.replaceState(null, '', q.toString() ? `?${q}` : location.pathname);
}

function restoreFromUrl() {
  const q = new URLSearchParams(location.search);
  for (const key of Object.keys(FILTER_DEFAULTS)) state.filters[key] = q.get(key) || '';
  state.sort = ['best', 'price', 'newest'].includes(q.get('sort')) ? q.get('sort') : 'best';
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
    map.invalidateSize();
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
