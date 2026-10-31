// Facebook Marketplace mapping.
//
// Fixtures reflect the LIVE payload from run RQfrcxndTsSkYljre (Seattle, WA,
// 2026-08-27), not the actor's published docs — which were wrong about both
// coordinates and city, the two fields that decide whether a listing survives
// pre-flight at all.
process.env.HASDATA_API_KEY = 'offline-test';

const Listing = require('../../models/Listing');
const fb = require('../../ingest/facebook');
const { findBlockingGaps } = require('../../ingest/lib/pipeline');
const { createSuite } = require('../helpers/suite');

const s = createSuite('facebook');

// ── City slugs ────────────────────────────────────────────────────────
// Facebook's slugs do not follow from the city name, which is why they are
// seeded rather than derived.
s.equal('seeded slug', fb.citySlug('Seattle', 'WA'), 'seattle');
s.equal('New York is "nyc", not "newyork"', fb.citySlug('New York', 'NY'), 'nyc');
s.equal('San Francisco loses its space', fb.citySlug('San Francisco', 'CA'), 'sanfrancisco');
s.equal('unseeded city falls back to a stripped guess', fb.citySlug('Ann Arbor', 'MI'), 'annarbor');
s.equal('url targets the rentals category',
  fb.buildMarketplaceUrl('Seattle', 'WA'),
  'https://www.facebook.com/marketplace/seattle/propertyrentals');

// ── Actor input ───────────────────────────────────────────────────────
const input = fb.buildActorInput({ city: 'Seattle', state: 'WA', maxItems: 5 });
s.equal('startUrls carries the built url', input.startUrls[0].url, 'https://www.facebook.com/marketplace/seattle/propertyrentals');
s.equal('resultsLimit', input.resultsLimit, 5);
// Kept on: details are what populate custom_title, the only semi-structured
// field this source has and the basis for space type and bed/bath counts.
s.equal('includeListingDetails is forced on', input.includeListingDetails, true);
s.equal('residential proxy requested', input.proxyConfiguration.apifyProxyGroups[0], 'RESIDENTIAL');

// ── Live-listing filter ───────────────────────────────────────────────
s.equal('sold is not inventory', fb.isLiveListing({ is_sold: true }), false);
s.equal('pending is not inventory', fb.isLiveListing({ is_pending: true }), false);
s.equal('hidden is not inventory', fb.isLiveListing({ is_hidden: true }), false);
s.equal('is_live false is not inventory', fb.isLiveListing({ is_live: false }), false);
s.equal('a plain listing is live', fb.isLiveListing({ id: '1' }), true);

// ── Price sanity ──────────────────────────────────────────────────────
// Marketplace prices are hand-typed, so they are the least trustworthy in the
// project: "$1" means "message me", and sale prices get posted in the rentals
// category.
s.equal('normal rent passes', fb.plausibleRent(1450), 1450);
s.equal('$1 placeholder rejected', fb.plausibleRent(1), null);
s.equal('$0 rejected', fb.plausibleRent(0), null);
s.equal('sale price rejected', fb.plausibleRent(450000), null);
s.equal('band edges included', fb.plausibleRent(250), 250);
s.equal('null stays null', fb.plausibleRent(null), null);

// ── Beds/baths out of free text ───────────────────────────────────────
s.equal('"2 bed 1 bath"', JSON.stringify(fb.inferBedsBaths({ marketplace_listing_title: '2 bed 1 bath near campus' })), JSON.stringify({ bedrooms: 2, bathrooms: 1 }));
s.equal('"2br/1ba"', JSON.stringify(fb.inferBedsBaths({ marketplace_listing_title: 'Sublet 2br/1ba downtown' })), JSON.stringify({ bedrooms: 2, bathrooms: 1 }));
s.equal('"3 BR" with no bath stated', JSON.stringify(fb.inferBedsBaths({ marketplace_listing_title: '3 BR house' })), JSON.stringify({ bedrooms: 3, bathrooms: null }));
s.equal('half baths survive', fb.inferBedsBaths({ marketplace_listing_title: '2 bed 1.5 bath' }).bathrooms, 1.5);
s.equal('nothing stated -> nulls', JSON.stringify(fb.inferBedsBaths({ marketplace_listing_title: 'Cozy place' })), JSON.stringify({ bedrooms: null, bathrooms: null }));

// ── Property type from free text ──────────────────────────────────────
s.equal('studio -> Apartment', fb.inferFacebookPropertyType({ marketplace_listing_title: 'Studio near UW' }), 'Apartment');
s.equal('townhouse', fb.inferFacebookPropertyType({ marketplace_listing_title: 'Townhouse for rent' }), 'Townhouse');
s.equal('house', fb.inferFacebookPropertyType({ marketplace_listing_title: 'Whole house, 3 bed' }), 'House');
s.equal('unknown text defaults to Apartment', fb.inferFacebookPropertyType({ marketplace_listing_title: 'Nice place' }), 'Apartment');

// ── Full normalize, against the REAL payload shape ────────────────────
// Taken from run RQfrcxndTsSkYljre. The published docs were wrong about the
// two fields that matter most: coordinates are on `location`, not the
// documented `item_location` (absent from every record), and the city sits
// under location.reverse_geocode rather than location.city.
const sample = {
  id: '1234567890',
  listingUrl: 'https://www.facebook.com/marketplace/item/1234567890',
  marketplace_listing_title: 'Private room for rent',
  custom_title: 'Private Room',
  redacted_description: '[object Object]', // what the actor really sends
  listing_price: { amount: '1450.00', formatted_amount: '$1,450', currency: 'USD' },
  location: {
    latitude: 47.6205,
    longitude: -122.3493,
    reverse_geocode: { city: 'Seattle', state: 'WA' },
    reverse_geocode_detailed: { city: 'Seattle', state: 'WA', postal_code: '98122' },
  },
  // NOT a URL string despite the name — an array of GraphQL photo nodes.
  // The original fixture used a plain string, which is exactly why the unit
  // tests passed while every one of 25 live records failed with a CastError.
  primary_listing_photo: [
    { __typename: 'Photo', image: { uri: 'https://scontent.example/photo.jpg' }, id: '1' },
  ],
  creation_time: 1756000000,
  is_live: true,
  is_sold: false,
};

const n = fb.normalizeFacebook(sample, { city: 'Seattle', state: 'WA' });
const err = new Listing(n).validateSync();
s.check('mongoose accepts the document', !err, err ? Object.keys(err.errors).join(', ') : 'valid');
s.check('passes pre-flight', findBlockingGaps(n).length === 0, findBlockingGaps(n).join(', ') || 'no gaps');
s.equal('platform', n.originalPlatform, 'FacebookMarketplace');
s.equal('price', n.pricePerMonth, 1450);
s.equal('geojson is [lng, lat]', JSON.stringify(n.location.coordinates), JSON.stringify([-122.3493, 47.6205]));
s.equal('city from location', n.city, 'Seattle');
s.equal('address withheld', n.address, null);
s.equal('spaceType from custom_title', n.spaceType, 'Private Room');
s.equal('zip from reverse_geocode_detailed', n.zipCode, '98122');
s.equal('no lease data on Marketplace', n.minimumLeaseDays, null);
s.equal('image uri pulled out of the photo node', JSON.stringify(n.images), JSON.stringify(['https://scontent.example/photo.jpg']));

// ── primary_listing_photo shapes seen live ────────────────────────────
s.equal('ProductImage node', JSON.stringify(fb.extractImages({ primary_listing_photo: [{ __typename: 'ProductImage', image: { uri: 'https://a/1.jpg' } }] })), JSON.stringify(['https://a/1.jpg']));
s.equal('CatalogMarketplaceEnhancementTransformedImage node', JSON.stringify(fb.extractImages({ primary_listing_photo: [{ __typename: 'CatalogMarketplaceEnhancementTransformedImage', image: { uri: 'https://a/2.jpg' } }] })), JSON.stringify(['https://a/2.jpg']));
s.equal('empty uri is dropped, not stored as ""', JSON.stringify(fb.extractImages({ primary_listing_photo: [{ image: { uri: '' } }] })), JSON.stringify([]));
s.equal('missing field -> empty array', JSON.stringify(fb.extractImages({})), JSON.stringify([]));
s.equal('a bare string still works', JSON.stringify(fb.extractImages({ primary_listing_photo: 'https://a/3.jpg' })), JSON.stringify(['https://a/3.jpg']));
s.check('every extracted image is a string (Mongoose needs [String])',
  fb.extractImages({ primary_listing_photo: [{ image: { uri: 'https://a/4.jpg' } }, { image: { uri: '' } }] }).every((x) => typeof x === 'string'));
s.equal('creation_time is unix seconds', n.availableFrom.getUTCFullYear(), 2025);

// A $1 placeholder must be dropped, not ingested as a $1 rental.
const junk = fb.normalizeFacebook({ ...sample, id: '2', listing_price: { amount: '1' } });
s.equal('$1 listing gets a null price', junk.pricePerMonth, null);
s.check('and is therefore skipped by pre-flight', findBlockingGaps(junk).includes('no parseable price'));

// Missing coordinates is the failure mode that would drop the whole source.
const noCoords = fb.normalizeFacebook({ ...sample, id: '3', location: { reverse_geocode: {} } });
s.check('no coordinates is caught, not written', findBlockingGaps(noCoords).includes('no coordinates'));

// A blank reverse-geocode is common (2/5 in the probe); the searched city fills in.
const blankCity = fb.normalizeFacebook(
  { ...sample, id: '4', location: { latitude: 47.6, longitude: -122.3, reverse_geocode: { city: '' } } },
  { city: 'Seattle', state: 'WA' }
);
s.equal('blank geocode falls back to the searched city', blankCity.city, 'Seattle');
s.equal('no context and no geocode -> null', fb.normalizeFacebook({ ...sample, id: '5', location: { latitude: 1, longitude: 2, reverse_geocode: {} } }).city, null);

// custom_title is English even when the listing is not.
s.equal('Spanish listing, English custom_title',
  fb.inferFacebookSpaceType({ custom_title: 'Private Room', marketplace_listing_title: 'Habitacion privada en alquiler' }),
  'Private Room');
s.equal('"[object Object]" description is discarded',
  fb.listingText({ custom_title: 'Studio · 1 bath', redacted_description: '[object Object]' }),
  'Studio · 1 bath');
s.equal('studio implies zero bedrooms', fb.inferBedsBaths({ custom_title: 'Studio · 1 bath' }).bedrooms, 0);
s.equal('"4 beds · 3 baths"', JSON.stringify(fb.inferBedsBaths({ custom_title: '4 beds · 3 baths' })), JSON.stringify({ bedrooms: 4, bathrooms: 3 }));

// ── apify/facebook-marketplace-scraper (camelCase) ────────────────────
// Pinned to a real record (Seattle, WA — 2026-10-30), trimmed.
const apifyRaw = {
  facebookUrl: 'https://www.facebook.com/marketplace/seattle/propertyrentals',
  id: '3374599529364092',
  itemUrl: 'https://www.facebook.com/marketplace/item/3374599529364092/',
  listingPhotos: [
    { __typename: 'Photo', image: { uri: 'https://fb/1.jpg' } },
    { __typename: 'Photo', image: { uri: 'https://fb/2.jpg' } },
  ],
  listingPrice: { amount: '925.00', currency: 'USD' },
  location: { latitude: 47.35645, longitude: -122.15532, reverse_geocode_detailed: { city: 'Kent', state: 'WA', postal_code: '98042-9029' } },
  listingTitle: 'Studio 0 Baths - House',
  description: { text: 'Room for rent plus share of utilities usually averaging 150' },
  details: [
    { section_type: 'UNIT_INCLUDES', pdp_fields: [{ display_label: 'House' }, { display_label: 'Studio' }] },
    { section_type: 'UNIT_SUBTITLE', pdp_fields: [{ display_label: 'Kent, WA' }] },
  ],
  isHidden: false, isLive: true, isPending: false, isSold: false,
  primaryListingPhoto: { __typename: 'Photo', photo_image_url: 'https://fb/primary.jpg' },
};
const an = fb.normalizeFacebook(apifyRaw, { city: 'Seattle', state: 'WA' });

s.equal('camelCase price', an.pricePerMonth, 925);
s.equal('links to the item, not the search page', an.listingUrl, 'https://www.facebook.com/marketplace/item/3374599529364092/');
s.equal('full gallery from listingPhotos', JSON.stringify(an.images), JSON.stringify(['https://fb/1.jpg', 'https://fb/2.jpg']));
s.equal('primaryListingPhoto fallback', JSON.stringify(fb.extractImages({ primaryListingPhoto: { photo_image_url: 'https://fb/p.jpg' } })), JSON.stringify(['https://fb/p.jpg']));
s.equal('coordinates [lng, lat]', JSON.stringify(an.location.coordinates), JSON.stringify([-122.15532, 47.35645]));
s.equal('reverse-geocoded city', an.city, 'Kent');
s.equal('"Room for rent" in description -> Private Room', an.spaceType, 'Private Room');
s.equal('Studio from the details section', an.bedrooms, 0);
s.equal('House from the details section', an.propertyType, 'House');
s.equal('isSold is not inventory', fb.isLiveListing({ isSold: true }), false);
s.equal('isLive false is not inventory', fb.isLiveListing({ isLive: false }), false);
s.equal('commercial space is not a rental', fb.isLiveListing({ listingTitle: 'COMMERCIAL SPACE FOR LEASE' }), false);
s.equal('office is not a rental', fb.isLiveListing({ listingTitle: 'Downtown Everett Office with Sink & Cabinets' }), false);
s.equal('a live apifyRaw listing passes', fb.isLiveListing(apifyRaw), true);
s.equal('salon suite is not a rental', fb.isLiveListing({ listingTitle: 'Salon suite available - Hair By Heidi' }), false);
s.equal('"studio apartment" is still a rental', fb.isLiveListing({ listingTitle: 'Studio apartment near UW' }), true);
s.equal('homely title, salon description', fb.isLiveListing({ listingTitle: 'Private room for rent', description: { text: 'Hair Salon in Seattle’s Wallingford neighborhood, private room rental.' } }), false);
s.equal('event venue', fb.isLiveListing({ listingTitle: 'Spacious Ranch-Style Space', description: { text: 'Looking for a spacious and private place for your next event?' } }), false);
s.equal('a home near a salon is still a rental', fb.isLiveListing({ listingTitle: 'Private room for rent', description: { text: 'Quiet room, walk to a hair salon, cafes and the bus.' } }), true);

module.exports = { run: () => s.result() };
if (require.main === module) process.exit(s.report().failed > 0 ? 1 : 0);
