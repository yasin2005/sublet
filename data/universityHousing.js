// University SUMMER INTERN HOUSING PROGRAMS — curated by hand.
//
// Only universities that run a program dedicated to summer interns belong
// here: a named intern housing program with its own page. General summer
// housing (for a school's own students, conference guests, or anyone with a
// campus affiliation) does not qualify, even when interns happen to be allowed.
// Every entry must name its program in `programName` and link the program's
// page in `sourceUrl`; ingest/university.js refuses an entry without both.
//
// No API or scraper covers these: each university posts its program on its own
// page, usually once a year, often with the rates in a PDF or an image. So this
// is a reviewed list rather than an ingest, and every entry carries the page it
// came from and the date it was checked. Re-check each spring, when universities
// post the coming summer's rates, and update `checkedOn`.
//
// Facts below are quoted from each university's own page as of `checkedOn`.
// `nightlyRate` / `weeklyRate` are what the university quotes; pricePerMonth is
// derived from them (30 nights, or 52/12 weeks) so these listings sort and
// filter alongside ordinary rentals. null means the university does not
// publish a price, and the UI says so rather than guessing.
//
// `eligibility` drives the label on each card:
//   'open'        students from any college may apply, not just this school's
//   'restricted'  only this university's own students
//
// Deliberately NOT listed (checked 2026-10-31):
//   University of Denver   — has an intern program, but it is paused for summer 2026
//   University of Arizona  — general summer lodging (students, faculty, researchers);
//                            interns may stay, but there is no intern program
//   Boise State            — summer housing for its own students only
//   UT Austin              — summer housing limited to continuing UT students
//   UW–Madison             — summer housing requires enrolment in Summer Term

const CHECKED_ON = '2026-10-31';

module.exports = [
  {
    id: 'uw-seattle-mercer-court',
    programName: 'Seattle Intern Housing',
    university: 'University of Washington',
    name: 'Mercer Court intern housing',
    address: '3925 Adams Ln NE, Seattle, WA 98105',
    city: 'Seattle', state: 'WA', zipCode: '98105',
    coordinates: [-122.317102, 47.654712],
    season: 'Summer 2027 — from June 20, through late August',
    availableFrom: '2027-06-20',
    nightlyRate: 78,
    priceText: '$78/night (room, shared bath) · $83 private bath · $97.25 studio with kitchenette',
    minimumStayNights: 28,
    spaceType: 'Private Room',
    propertyType: 'Apartment',
    eligibility: 'open',
    eligibilityText: 'Registered students at any accredited college or university, 18 or older.',
    includes: ['Fully furnished', 'Free Wi-Fi', 'Laundry in every building', 'Full kitchen in the apartment', 'Linens not included'],
    terms: '$350 prepayment holds the room; balance due before check-in.',
    hasInUnitLaundry: false,
    applyUrl: 'https://washington.irisregistration.com/Form/7564',
    sourceUrl: 'https://hfs.uw.edu/seattle-intern-housing',
  },
  {
    id: 'uw-seattle-terry-hall',
    programName: 'Seattle Intern Housing',
    university: 'University of Washington',
    name: 'Terry Hall intern housing',
    address: '1035 NE Campus Pkwy, Seattle, WA 98105',
    city: 'Seattle', state: 'WA', zipCode: '98105',
    coordinates: [-122.31707, 47.65573],
    season: 'Summer 2027 — from June 20, through late August',
    availableFrom: '2027-06-20',
    nightlyRate: 73,
    priceText: '$73/night (room, private bath) · $97.25 studio with kitchenette',
    minimumStayNights: 28,
    spaceType: 'Private Room',
    propertyType: 'Residence Hall',
    eligibility: 'open',
    eligibilityText: 'Registered students at any accredited college or university, 18 or older.',
    includes: ['Fully furnished', 'Private bathroom', 'Microwave and fridge', 'Free Wi-Fi', 'Laundry in the building'],
    terms: '$350 prepayment holds the room; balance due before check-in.',
    applyUrl: 'https://washington.irisregistration.com/Form/7564',
    sourceUrl: 'https://hfs.uw.edu/seattle-intern-housing',
  },
  {
    id: 'seattle-university',
    programName: 'Internship Housing',
    university: 'Seattle University',
    name: 'Seattle University intern housing (Murphy Apartments, Yobi)',
    address: '901 12th Ave, Seattle, WA 98122',
    city: 'Seattle', state: 'WA', zipCode: '98122',
    coordinates: [-122.318706, 47.609014],
    season: 'Summer — dates not published',
    nightlyRate: null,
    priceText: 'Rates not published — ask the university. 10% off stays of 42+ nights.',
    minimumStayNights: null,
    spaceType: 'Private Room',
    propertyType: 'Apartment',
    eligibility: 'open',
    eligibilityText: 'University and college students with a summer internship.',
    includes: ['Private or shared rooms', 'Linens provided', 'Free Wi-Fi', 'Gym and parking passes available'],
    terms: 'Contact SUconferences@seattleu.edu.',
    applyUrl: 'https://www.internhousinghub.com/Seattle-University',
    sourceUrl: 'https://www.seattleu.edu/event-sales/intern-housing',
  },
  {
    id: 'psu-broadway-hall',
    programName: 'Summer Intern Housing',
    university: 'Portland State University',
    name: 'Broadway Hall intern housing',
    address: '1977 SW 6th Ave, Portland, OR 97201',
    city: 'Portland', state: 'OR', zipCode: '97201',
    coordinates: [-122.684132, 45.509399],
    season: 'Summer 2027 — June 17 to September 4; registration opens winter 2027',
    availableFrom: '2027-06-17',
    availableTo: '2027-09-04',
    nightlyRate: 64,
    priceText: '$64/night (studio, single) · $43/night per person (studio, double)',
    minimumStayNights: 28,
    spaceType: 'Entire Place',
    propertyType: 'Residence Hall',
    eligibility: 'open',
    eligibilityText: 'College students with an internship in Portland — you do not need to be a PSU student.',
    includes: ['Furnished studio', 'Private bathroom', 'Kitchenette', 'All utilities and Wi-Fi', 'Laundry on alternate floors'],
    terms: '$400 deposit when the contract is signed; no application fee.',
    utilitiesIncluded: true,
    applyUrl: 'https://www.pdx.edu/housing/summer-intern-housing',
    sourceUrl: 'https://www.pdx.edu/housing/summer-intern-housing',
  },
  {
    id: 'university-of-portland',
    programName: 'Intern Housing Program',
    university: 'University of Portland',
    name: 'University of Portland intern housing',
    address: '5000 N Willamette Blvd, Portland, OR 97203',
    city: 'Portland', state: 'OR', zipCode: '97203',
    coordinates: [-122.731063, 45.570725],
    season: 'Summer 2026 rates — May 10 to August 9 (2027 not yet posted)',
    availableFrom: '2026-05-10',
    availableTo: '2026-08-09',
    weeklyRate: 350,
    priceText: '$350/week, single (any part of a week counts as a week)',
    minimumStayNights: 7,
    spaceType: 'Private Room',
    propertyType: 'Apartment',
    eligibility: 'open',
    eligibilityText: 'Students enrolled at any accredited college with a Portland internship, 18 or older. Not for current UP students.',
    includes: ['Furnished apartment', 'Air-conditioned', 'Elevator', 'Next to the gym and two bus lines downtown'],
    terms: '$55 non-refundable application fee and a deposit of 40% of the stay.',
    hasAirConditioning: true,
    applyUrl: 'https://cvent.me/EOLnQm',
    sourceUrl: 'https://ww1.up.edu/conferences/intern-housing/',
  },
  {
    id: 'cu-denver-lynx-crossing',
    programName: 'Summer Intern Housing',
    university: 'University of Colorado Denver',
    name: 'Lynx Crossing summer intern housing',
    address: '318 Walnut St, Denver, CO 80204',
    city: 'Denver', state: 'CO', zipCode: '80204',
    coordinates: [-105.012353, 39.742194],
    season: 'Summer 2026 rates (2027 not yet posted)',
    nightlyRate: null,
    priceText: 'Rates are posted as an image on the university page — email summerhousing@ucdenver.edu for a rate sheet.',
    minimumStayNights: null,
    spaceType: 'Private Room',
    propertyType: 'Residence Hall',
    eligibility: 'open',
    eligibilityText: 'Summer interns near downtown Denver. Your employer may need to register as a sponsoring organization.',
    includes: ['Several floor plans to choose from'],
    terms: 'Phone 303-315-5272.',
    applyUrl: 'https://www.ucdenver.edu/housing-and-dining/summer/summer-intern-housing',
    sourceUrl: 'https://www.ucdenver.edu/housing-and-dining/summer/summer-intern-housing',
  },
  {
    id: 'cu-boulder-williams-village',
    programName: 'Intern Lodging Program',
    university: 'University of Colorado Boulder',
    name: 'Intern Lodging Program — Williams Village',
    address: 'Williams Village, 30th St & Baseline Rd, Boulder, CO 80310',
    city: 'Boulder', state: 'CO', zipCode: '80310',
    coordinates: [-105.25264, 39.99915],
    season: 'Summer 2026 rates — early May to early August (2027 dates to come)',
    nightlyRate: 66.4,
    priceText: '$66.40/night (single, semi-private bath) · $49.50/night per person (double)',
    minimumStayNights: 30,
    spaceType: 'Private Room',
    propertyType: 'Residence Hall',
    eligibility: 'open',
    eligibilityText: 'Interns 18+ with an internship at CU Boulder or in the Boulder/Denver area (confirmation letter and background check required).',
    includes: ['Utilities and Wi-Fi', 'Parking included', 'Laundry on site', 'Rec center access', 'Bring your own linens'],
    terms: '$350 deposit, partly refundable after inspection.',
    utilitiesIncluded: true,
    hasParking: true,
    applyUrl: 'https://www.colorado.edu/conferenceservices/internship-lodging',
    sourceUrl: 'https://www.colorado.edu/conferenceservices/internship-lodging',
  },
].map((entry) => ({ ...entry, checkedOn: CHECKED_ON }));
