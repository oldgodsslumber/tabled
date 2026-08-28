/* Tabled -- adversarial suite: LISTINGS, the US GEO-LOCK, and SELLER PROMOS.
 *
 * Every check here tries to do something the rules exist to refuse. A refusal
 * is a PASS; a write that lands is a finding.
 *
 * Targets (see firestore.rules):
 *   usPoint/usCountry/geoOk   -- the US bounding box, on users AND listings
 *   match /listings           -- zeroed counters on create, function-only
 *                                counters on update, the hidden/active/archived
 *                                read split
 *   .../gameEntries           -- hold & queue state is function-owned
 *   promoOk                   -- seller "buy N, get $X off" bounds (users)
 *   bumpListingCounter        -- functions/index.js, allowlisted counters only
 *
 * RUN
 *   firebase emulators:start --only auth,firestore,functions --project demo-tabled
 *   node test/attacks/listings.mjs
 */
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';

import {
  check, step, expectReject, summarize, results,
  makeUser, createListing, PROJECT, REGION, RUN,
  doc, getDoc, setDoc, updateDoc, collection, GeoPoint, serverTimestamp
} from '../harness.mjs';

/* The inverse of expectReject: for the cases that are supposed to WORK. A
 * geo-lock that refuses the Aleutians is as broken as one that accepts Paris,
 * and a promo rule nobody can satisfy is not a bound, it's an outage. */
async function expectAllow(name, promise) {
  try {
    await promise;
    check(name, true);
  } catch (err) {
    check(name, false, `${err.code || ''} ${err.message || ''}`.trim());
  }
}

/* An authenticated identity with NO profile document, so the users CREATE rule
 * (not update) is what gets exercised. makeUser writes a profile as part of
 * signing up, which would make every create-rule test an update-rule test. */
async function rawUser(label) {
  const app = initializeApp({ apiKey: 'fake-api-key', projectId: PROJECT },
    `raw-${label}-${RUN}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  const fns = getFunctions(app, REGION);
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);
  const cred = await createUserWithEmailAndPassword(
    auth, `raw-${label}-${RUN}@example.test`, 'password123');
  return {
    label, app, db, fns, uid: cred.user.uid, displayName: label,
    call: (n, p) => httpsCallable(fns, n)(p || {}).then((r) => r.data)
  };
}

/* The exact profile shape CloudBackend.ensureProfile writes, so that when a
 * create is refused it is refused for the field under test and not for drift. */
function profile(displayName, overrides) {
  return Object.assign({
    displayName, photoURL: null, bio: '', generalArea: 'Riverside, Jacksonville, FL',
    geoPoint: new GeoPoint(30.3322, -81.6557), geohash: 'djmpuytg1',
    countryCode: 'US', state: 'FL',
    createdAt: serverTimestamp(),
    tradeCount: 0, avgRating: null, reviewCount: 0,
    availabilityWindows: [], openReportCount: 0, restricted: false
  }, overrides || {});
}

/* Same for listings: harness.createListing's body, minus the sub-entries, so a
 * single field can be perturbed without changing anything else. */
function listingDoc(seller, overrides) {
  return Object.assign({
    sellerId: seller.uid, sellerName: seller.displayName, sellerPhoto: null,
    title: 'Attack listing', fulfillment: { pickup: true, inPersonAtEvent: false },
    locationLabel: 'Riverside, Jacksonville, FL',
    geoPoint: new GeoPoint(30.3322, -81.6557), geohash: 'djmpuytg1',
    countryCode: 'US', state: 'FL',
    acceptedPayment: { cash: true, paypal: false, venmo: false, trades: true },
    eventId: null, eventName: null, eventStartDate: null, eventEndDate: null,
    gameNames: ['Cascadia'], minPrice: 18, maxPrice: 18,
    categories: [], mechanics: [],
    status: 'active', createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    viewCount: 0, requestCount: 0, watchCount: 0, hotScore: 0, openReportCount: 0
  }, overrides || {});
}

const OUTSIDE = [
  ['Paris', 48.8566, 2.3522],
  ['Tokyo', 35.6762, 139.6503],
  ['Sao Paulo', -23.5505, -46.6333],
  ['London', 51.5072, -0.1276],
  ['Sydney', -33.8688, 151.2093]
];
/* Deliberately inside the box. Adak sits west of the antimeridian at negative
 * longitude; Attu is east of it at +173, which is why the rule carries a second
 * longitude range at all. Both must be ACCEPTED. */
const INSIDE = [
  ['Adak, Alaska (Aleutians, -176)', 51.88, -176.6581],
  ['Attu, Alaska (Aleutians, +173)', 52.83, 173.1806],
  ['Utqiagvik, Alaska (71.3N)', 71.2906, -156.7886],
  ['Honolulu', 21.3069, -157.8583]
];

async function main() {
  const users = [];

  step('Cast');
  const sam = await makeUser('lsam', 'Sam Seller');       // owns the listings
  const eve = await makeUser('leve', 'Eve Stranger');     // signed-in outsider
  users.push(sam, eve);
  check('seller and stranger exist', !!sam.uid && !!eve.uid, `${sam.uid} / ${eve.uid}`);

  /* ================= 1. geoOk on a USER profile ========================== */

  step('Geo-lock: user profiles');

  /* The regression this whole helper exists for: latlng coordinates are
     METHODS in Security Rules. Reading it back proves the write landed as a
     real GeoPoint rather than being silently dropped or coerced. */
  const samSnap = await getDoc(doc(sam.db, 'users', sam.uid));
  const gp = samSnap.data().geoPoint;
  check('a real GeoPoint round-trips through the users rule',
    gp instanceof GeoPoint && Math.abs(gp.latitude - 30.3322) < 1e-6
      && Math.abs(gp.longitude - (-81.6557)) < 1e-6,
    `${gp && gp.latitude},${gp && gp.longitude}`);

  for (const [name, lat, lng] of OUTSIDE) {
    const u = await rawUser(`geo${name.replace(/\W/g, '')}`);
    users.push(u);
    await expectReject(`profile CREATE with a ${name} geoPoint is refused`,
      setDoc(doc(u.db, 'users', u.uid), profile(name, { geoPoint: new GeoPoint(lat, lng) })),
      'permission-denied');
    await expectReject(`profile UPDATE to a ${name} geoPoint is refused`,
      updateDoc(doc(sam.db, 'users', sam.uid), { geoPoint: new GeoPoint(lat, lng) }),
      'permission-denied');
  }

  for (const [name, lat, lng] of INSIDE) {
    await expectAllow(`profile geoPoint at ${name} is ALLOWED (inside the box on purpose)`,
      updateDoc(doc(sam.db, 'users', sam.uid), { geoPoint: new GeoPoint(lat, lng) }));
  }
  /* Put Sam back where he started so later location assertions read sanely. */
  await updateDoc(doc(sam.db, 'users', sam.uid),
    { geoPoint: new GeoPoint(30.3322, -81.6557) });

  await expectAllow('a null geoPoint is ALLOWED (a profile has no area until set)',
    updateDoc(doc(sam.db, 'users', sam.uid), { geoPoint: null }));
  await expectAllow('restoring the real point works',
    updateDoc(doc(sam.db, 'users', sam.uid), { geoPoint: new GeoPoint(30.3322, -81.6557) }));

  /* usPoint() calls p.latitude(). A value that has no such method must make the
     rule DENY, not pass through. A map is the dangerous shape: it looks like a
     GeoPoint to a careless reader and to any client-side check. */
  await expectReject('geoPoint as a plain {latitude,longitude} MAP is refused',
    updateDoc(doc(sam.db, 'users', sam.uid),
      { geoPoint: { latitude: 30.3322, longitude: -81.6557 } }),
    'permission-denied');
  await expectReject('geoPoint as an out-of-box MAP is refused',
    updateDoc(doc(sam.db, 'users', sam.uid),
      { geoPoint: { latitude: 48.8566, longitude: 2.3522 } }),
    'permission-denied');
  await expectReject('geoPoint as a STRING is refused',
    updateDoc(doc(sam.db, 'users', sam.uid), { geoPoint: '30.3322,-81.6557' }),
    'permission-denied');
  await expectReject('geoPoint as a NUMBER is refused',
    updateDoc(doc(sam.db, 'users', sam.uid), { geoPoint: 30.3322 }),
    'permission-denied');
  await expectReject('geoPoint as an ARRAY is refused',
    updateDoc(doc(sam.db, 'users', sam.uid), { geoPoint: [30.3322, -81.6557] }),
    'permission-denied');

  step('Geo-lock: countryCode');
  for (const cc of ['CA', 'MX', 'FR', 'PR', 'GU', 'us', 'USA', '']) {
    await expectReject(`profile countryCode '${cc}' is refused`,
      updateDoc(doc(sam.db, 'users', sam.uid), { countryCode: cc }),
      'permission-denied');
  }
  await expectAllow('profile countryCode null is ALLOWED (no area set yet)',
    updateDoc(doc(sam.db, 'users', sam.uid), { countryCode: null }));
  await expectAllow("profile countryCode 'US' is ALLOWED",
    updateDoc(doc(sam.db, 'users', sam.uid), { countryCode: 'US' }));

  /* ================= 2. geoOk on a LISTING =============================== */

  step('Geo-lock: listings');

  for (const [name, lat, lng] of OUTSIDE) {
    await expectReject(`listing CREATE with a ${name} geoPoint is refused`,
      setDoc(doc(collection(sam.db, 'listings')),
        listingDoc(sam, { geoPoint: new GeoPoint(lat, lng) })),
      'permission-denied');
  }
  for (const cc of ['CA', 'MX', 'FR', 'us']) {
    await expectReject(`listing CREATE with countryCode '${cc}' is refused`,
      setDoc(doc(collection(sam.db, 'listings')), listingDoc(sam, { countryCode: cc })),
      'permission-denied');
  }
  await expectReject('listing CREATE with a MAP in geoPoint is refused',
    setDoc(doc(collection(sam.db, 'listings')),
      listingDoc(sam, { geoPoint: { latitude: 30.33, longitude: -81.65 } })),
    'permission-denied');

  const aleutian = doc(collection(sam.db, 'listings'));
  await expectAllow('listing in the Aleutians (+173) is ALLOWED',
    setDoc(aleutian, listingDoc(sam, {
      geoPoint: new GeoPoint(52.83, 173.1806), locationLabel: 'Attu Station, AK', state: 'AK'
    })));
  const aleutianSnap = await getDoc(aleutian);
  check('the Aleutian listing persisted with a real GeoPoint',
    aleutianSnap.exists() && aleutianSnap.data().geoPoint instanceof GeoPoint,
    aleutianSnap.exists() ? String(aleutianSnap.data().geoPoint.longitude) : 'missing');

  /* The listing built here is the punching bag for everything below. */
  const { listingId, entryIds } = await createListing(sam, 'Shelf cleanout', [
    { name: 'Cascadia', askingPrice: 18, condition: 'VG' },
    { name: 'Wingspan', askingPrice: 30, condition: 'LN' }
  ]);
  check('baseline listing created', !!listingId && entryIds.length === 2, listingId);

  await expectReject('an existing listing cannot be MOVED to Paris',
    updateDoc(doc(sam.db, 'listings', listingId), { geoPoint: new GeoPoint(48.8566, 2.3522) }),
    'permission-denied');
  await expectReject("an existing listing cannot be flipped to countryCode 'CA'",
    updateDoc(doc(sam.db, 'listings', listingId), { countryCode: 'CA' }),
    'permission-denied');

  /* ================= 3. listing create: zeroed counters ================== */

  step('Listing create pins every counter to zero');

  for (const field of ['viewCount', 'requestCount', 'hotScore', 'watchCount', 'openReportCount']) {
    await expectReject(`listing CREATE with ${field}: 500 is refused`,
      setDoc(doc(collection(sam.db, 'listings')), listingDoc(sam, { [field]: 500 })),
      'permission-denied');
    await expectReject(`listing CREATE with ${field}: 1 is refused`,
      setDoc(doc(collection(sam.db, 'listings')), listingDoc(sam, { [field]: 1 })),
      'permission-denied');
    await expectReject(`listing CREATE with ${field} MISSING is refused`,
      setDoc(doc(collection(sam.db, 'listings')), (() => {
        const d = listingDoc(sam); delete d[field]; return d;
      })()),
      'permission-denied');
  }
  await expectReject('listing CREATE with hotScore: 0.0001 is refused',
    setDoc(doc(collection(sam.db, 'listings')), listingDoc(sam, { hotScore: 0.0001 })),
    'permission-denied');
  await expectReject("listing CREATE with status 'hidden' is refused",
    setDoc(doc(collection(sam.db, 'listings')), listingDoc(sam, { status: 'hidden' })),
    'permission-denied');
  await expectReject("listing CREATE with status 'archived' is refused",
    setDoc(doc(collection(sam.db, 'listings')), listingDoc(sam, { status: 'archived' })),
    'permission-denied');
  await expectReject('a stranger cannot create a listing under the seller\'s id',
    setDoc(doc(collection(eve.db, 'listings')), listingDoc(sam)),
    'permission-denied');

  /* ================= 4. counters are function territory ================== */

  step('The seller cannot touch their own counters');

  for (const field of ['viewCount', 'requestCount', 'hotScore', 'watchCount', 'openReportCount']) {
    await expectReject(`seller cannot set ${field} on their own listing`,
      updateDoc(doc(sam.db, 'listings', listingId), { [field]: 9999 }),
      'permission-denied');
    /* Re-writing the same value is still a diff'd key: the rule uses
       affectedKeys(), which ignores value equality only when the value is
       byte-identical -- worth pinning either way. */
  }
  await expectReject('seller cannot hand their listing to someone else (sellerId)',
    updateDoc(doc(sam.db, 'listings', listingId), { sellerId: eve.uid }),
    'permission-denied');
  await expectReject('a stranger cannot write the seller\'s listing at all',
    updateDoc(doc(eve.db, 'listings', listingId), { title: 'hijacked' }),
    'permission-denied');
  await expectReject('a stranger cannot bump viewCount by a direct write',
    updateDoc(doc(eve.db, 'listings', listingId), { viewCount: 9999 }),
    'permission-denied');
  await expectReject('seller cannot set an unknown status',
    updateDoc(doc(sam.db, 'listings', listingId), { status: 'deleted' }),
    'permission-denied');
  await expectAllow('seller CAN edit their own title (control)',
    updateDoc(doc(sam.db, 'listings', listingId), { title: 'Shelf cleanout, updated' }));

  /* ================= 5. the hidden / active / archived read split ======== */

  step('hidden is a one-way door, and strangers cannot read it');

  await expectAllow('a stranger can read an ACTIVE listing',
    getDoc(doc(eve.db, 'listings', listingId)).then((s) => {
      if (!s.exists()) throw new Error('missing'); return s;
    }));

  const archived = doc(collection(sam.db, 'listings'));
  await setDoc(archived, listingDoc(sam, { title: 'Sold last month' }));
  await updateDoc(archived, { status: 'archived' });
  await expectAllow('a stranger can read an ARCHIVED listing (sold history is public)',
    getDoc(doc(eve.db, 'listings', archived.id)).then((s) => {
      if (!s.exists()) throw new Error('missing'); return s;
    }));

  const hiddenRef = doc(collection(sam.db, 'listings'));
  await setDoc(hiddenRef, listingDoc(sam, { title: 'Flagged item' }));
  await updateDoc(hiddenRef, { status: 'hidden' });
  const hiddenId = hiddenRef.id;

  await expectReject('a stranger CANNOT read a hidden listing',
    getDoc(doc(eve.db, 'listings', hiddenId)),
    'permission-denied');
  await expectAllow('the owner CAN still read their own hidden listing',
    getDoc(doc(sam.db, 'listings', hiddenId)).then((s) => {
      if (!s.exists()) throw new Error('missing'); return s;
    }));

  await expectReject('the owner cannot un-hide to active',
    updateDoc(doc(sam.db, 'listings', hiddenId), { status: 'active' }),
    'permission-denied');
  await expectReject('the owner cannot launder a hide into archived',
    updateDoc(doc(sam.db, 'listings', hiddenId), { status: 'archived' }),
    'permission-denied');
  await expectReject('the owner cannot un-hide by rewriting the whole doc',
    setDoc(doc(sam.db, 'listings', hiddenId), listingDoc(sam, { title: 'Flagged item' })),
    'permission-denied');
  await expectAllow('the owner CAN still edit a hidden listing while it stays hidden',
    updateDoc(doc(sam.db, 'listings', hiddenId), { title: 'Flagged item (edited)' }));

  /* Deleting is allowed by design (allow delete: if isUser(sellerId)) -- a hide
     is not a legal hold. Asserted so the suite states the intent rather than
     leaving it ambiguous. */
  await expectAllow('the owner CAN delete a hidden listing (deletion is not blocked by design)',
    (async () => {
      const tmp = doc(collection(sam.db, 'listings'));
      await setDoc(tmp, listingDoc(sam, { title: 'to hide then delete' }));
      await updateDoc(tmp, { status: 'hidden' });
      const { deleteDoc } = await import('firebase/firestore');
      return deleteDoc(tmp);
    })());

  /* ================= 6. gameEntries: hold & queue state ================== */

  step('gameEntries: hold and queue state is function-owned');

  const entry = doc(sam.db, 'listings', listingId, 'gameEntries', entryIds[0]);
  const eveEntry = doc(eve.db, 'listings', listingId, 'gameEntries', entryIds[0]);

  await expectReject('seller cannot mark their own entry SOLD directly',
    updateDoc(entry, { status: 'sold' }),
    'permission-denied');
  await expectReject('seller cannot set status to onHold',
    updateDoc(entry, { status: 'onHold' }),
    'permission-denied');
  await expectReject('seller cannot invent a currentHoldRequestId',
    updateDoc(entry, { currentHoldRequestId: 'req_fake' }),
    'permission-denied');
  await expectReject('seller cannot set holdExpiresAt',
    updateDoc(entry, { holdExpiresAt: new Date(Date.now() + 864e5) }),
    'permission-denied');
  await expectReject('seller cannot fake a queueCount',
    updateDoc(entry, { queueCount: 99 }),
    'permission-denied');
  await expectReject('seller cannot reassign an entry sellerId',
    updateDoc(entry, { sellerId: eve.uid }),
    'permission-denied');
  await expectAllow('seller CAN edit price/notes on their entry (control)',
    updateDoc(entry, { askingPrice: 20, notes: 'sleeved' }));

  await expectReject('a stranger cannot edit someone else\'s entry',
    updateDoc(eveEntry, { askingPrice: 1 }),
    'permission-denied');
  await expectReject('a stranger cannot mark someone else\'s entry sold',
    updateDoc(eveEntry, { status: 'sold' }),
    'permission-denied');
  await expectReject('a stranger cannot delete someone else\'s entry',
    (async () => {
      const { deleteDoc } = await import('firebase/firestore');
      return deleteDoc(eveEntry);
    })(),
    'permission-denied');

  await expectReject('an entry cannot be CREATED already sold',
    setDoc(doc(collection(sam.db, 'listings', listingId, 'gameEntries')), {
      sellerId: sam.uid, bggId: null, name: 'Pre-sold', condition: 'VG',
      categories: [], contents: [], tags: [], photos: [], askingPrice: 5,
      notes: '', order: 9, status: 'sold',
      currentHoldRequestId: null, holdExpiresAt: null, queueCount: 0
    }),
    'permission-denied');
  await expectReject('an entry cannot be CREATED with a queueCount',
    setDoc(doc(collection(sam.db, 'listings', listingId, 'gameEntries')), {
      sellerId: sam.uid, bggId: null, name: 'Pre-queued', condition: 'VG',
      categories: [], contents: [], tags: [], photos: [], askingPrice: 5,
      notes: '', order: 9, status: 'active',
      currentHoldRequestId: null, holdExpiresAt: null, queueCount: 7
    }),
    'permission-denied');
  await expectReject('an entry cannot be CREATED already held',
    setDoc(doc(collection(sam.db, 'listings', listingId, 'gameEntries')), {
      sellerId: sam.uid, bggId: null, name: 'Pre-held', condition: 'VG',
      categories: [], contents: [], tags: [], photos: [], askingPrice: 5,
      notes: '', order: 9, status: 'active',
      currentHoldRequestId: 'req_fake', holdExpiresAt: null, queueCount: 0
    }),
    'permission-denied');

  /* Entry ownership is checked against the entry's OWN sellerId, deliberately
     (the rule comment explains why: batch writes evaluate against pre-batch
     state, so the parent listing may not exist yet). The consequence is worth
     stating out loud, not assumed: can an outsider staple an entry of their own
     onto someone else's listing? */
  const injected = doc(collection(eve.db, 'listings', listingId, 'gameEntries'));
  let injectedOk = false;
  try {
    await setDoc(injected, {
      sellerId: eve.uid, bggId: null, name: 'INJECTED BY A STRANGER', condition: 'VG',
      categories: [], contents: [], tags: [], photos: [], askingPrice: 1,
      notes: 'not the seller\'s game', order: 99, status: 'active',
      currentHoldRequestId: null, holdExpiresAt: null, queueCount: 0
    });
    injectedOk = true;
  } catch (e) { /* refused -- the good outcome */ }
  check('a stranger cannot append a gameEntry to someone else\'s listing',
    !injectedOk,
    injectedOk
      ? `WROTE listings/${listingId}/gameEntries/${injected.id} as ${eve.uid}`
      : 'refused');

  /* If it landed, the blast radius is the part that matters: entry delete and
     update are both keyed to the ENTRY's sellerId, so the listing's actual
     owner has no rule that lets them take it back off their own listing. */
  if (injectedOk) {
    const ownersView = doc(sam.db, 'listings', listingId, 'gameEntries', injected.id);
    const publicRead = await getDoc(doc(eve.db, 'listings', listingId, 'gameEntries', injected.id));
    check('...and the injected entry does not show up on the victim\'s listing',
      !publicRead.exists(),
      publicRead.exists()
        ? `publicly readable as "${publicRead.data().name}"` : 'not readable');
    let removed = false;
    try {
      const { deleteDoc } = await import('firebase/firestore');
      await deleteDoc(ownersView);
      removed = true;
    } catch (e) { /* denied */ }
    check('...and the listing OWNER can remove it again',
      removed, removed ? 'deleted' : 'permission-denied: the owner cannot delete it');
  }

  /* ================= 7. promo bounds ===================================== */

  step('Seller promo bounds (promoOk)');

  const P = (o) => updateDoc(doc(sam.db, 'users', sam.uid), { promo: o });

  await expectAllow('a valid promo (buy 3, $10 off) is ALLOWED',
    P({ active: true, buyQty: 3, dollarsOff: 10 }));
  await expectAllow('promo at the lower bound (buy 2, $1 off) is ALLOWED',
    P({ active: true, buyQty: 2, dollarsOff: 1 }));
  await expectAllow('promo at the upper bound (buy 20, $500 off) is ALLOWED',
    P({ active: true, buyQty: 20, dollarsOff: 500 }));
  await expectAllow('an inactive promo is ALLOWED', P({ active: false, buyQty: 2, dollarsOff: 5 }));
  await expectAllow('a null promo is ALLOWED (no deal)', P(null));

  await expectReject('promo buyQty 1 is refused', P({ active: true, buyQty: 1, dollarsOff: 5 }),
    'permission-denied');
  await expectReject('promo buyQty 0 is refused', P({ active: true, buyQty: 0, dollarsOff: 5 }),
    'permission-denied');
  await expectReject('promo buyQty -3 is refused', P({ active: true, buyQty: -3, dollarsOff: 5 }),
    'permission-denied');
  await expectReject('promo buyQty 21 is refused', P({ active: true, buyQty: 21, dollarsOff: 5 }),
    'permission-denied');
  await expectReject('promo buyQty 999999 is refused',
    P({ active: true, buyQty: 999999, dollarsOff: 5 }), 'permission-denied');
  await expectReject('promo buyQty 2.5 (non-integer) is refused',
    P({ active: true, buyQty: 2.5, dollarsOff: 5 }), 'permission-denied');
  await expectReject('promo buyQty as a string is refused',
    P({ active: true, buyQty: '3', dollarsOff: 5 }), 'permission-denied');

  await expectReject('promo dollarsOff 0 is refused', P({ active: true, buyQty: 3, dollarsOff: 0 }),
    'permission-denied');
  await expectReject('promo dollarsOff -5 is refused',
    P({ active: true, buyQty: 3, dollarsOff: -5 }), 'permission-denied');
  await expectReject('promo dollarsOff 501 is refused',
    P({ active: true, buyQty: 3, dollarsOff: 501 }), 'permission-denied');
  await expectReject('promo dollarsOff 999999 is refused',
    P({ active: true, buyQty: 3, dollarsOff: 999999 }), 'permission-denied');
  await expectReject('promo dollarsOff as a string is refused',
    P({ active: true, buyQty: 3, dollarsOff: '50' }), 'permission-denied');

  await expectReject('promo with an EXTRA key is refused',
    P({ active: true, buyQty: 3, dollarsOff: 10, freeShipping: true }), 'permission-denied');
  await expectReject('promo with a smuggled vip key is refused',
    P({ active: true, buyQty: 3, dollarsOff: 10, vip: true }), 'permission-denied');
  await expectReject('promo missing `active` is refused',
    P({ buyQty: 3, dollarsOff: 10 }), 'permission-denied');
  await expectReject('promo missing dollarsOff is refused',
    P({ active: true, buyQty: 3 }), 'permission-denied');
  await expectReject('promo active as a string is refused',
    P({ active: 'true', buyQty: 3, dollarsOff: 10 }), 'permission-denied');
  await expectReject('promo as a string is refused', P('buy 3 get $10 off'), 'permission-denied');
  await expectReject('promo as a number is refused', P(10), 'permission-denied');
  await expectReject('promo as an array is refused',
    P([{ active: true, buyQty: 3, dollarsOff: 10 }]), 'permission-denied');

  /* promoOk also guards CREATE, so a fresh account can't be born with a bogus
     banner and simply never update. */
  const pu = await rawUser('promo');
  users.push(pu);
  await expectReject('profile CREATE with an out-of-bounds promo is refused',
    setDoc(doc(pu.db, 'users', pu.uid),
      profile('Promo Pete', { promo: { active: true, buyQty: 3, dollarsOff: 999999 } })),
    'permission-denied');
  await expectAllow('profile CREATE with a valid promo is ALLOWED',
    setDoc(doc(pu.db, 'users', pu.uid),
      profile('Promo Pete', { promo: { active: true, buyQty: 3, dollarsOff: 25 } })));

  /* ================= 8. bumpListingCounter ============================== */

  step('bumpListingCounter (functions/index.js)');

  /* By design a viewer -- not the owner -- may bump viewCount and requestCount.
     That is the callable's whole purpose, so it succeeding is a PASS. */
  const before = (await getDoc(doc(sam.db, 'listings', listingId))).data().viewCount;
  const bumped = await eve.call('bumpListingCounter', { listingId, field: 'viewCount' });
  const after = (await getDoc(doc(sam.db, 'listings', listingId))).data().viewCount;
  check('a viewer CAN bump viewCount by exactly 1 (this is the point of the callable)',
    bumped && bumped.ok === true && after === before + 1,
    `${before} -> ${after} ${JSON.stringify(bumped)}`);

  const skipped = await sam.call('bumpListingCounter', { listingId, field: 'viewCount' });
  const afterSelf = (await getDoc(doc(sam.db, 'listings', listingId))).data().viewCount;
  check('the OWNER bumping their own listing is a no-op, not an increment',
    skipped && skipped.skipped === true && afterSelf === after,
    `${JSON.stringify(skipped)} count=${afterSelf}`);

  for (const field of ['hotScore', 'watchCount', 'openReportCount', 'sellerId',
    'status', 'minPrice', 'title', '', 'viewCount ', 'VIEWCOUNT']) {
    await expectReject(`bumpListingCounter refuses field '${field}'`,
      eve.call('bumpListingCounter', { listingId, field }),
      'invalid-argument');
  }
  await expectReject('bumpListingCounter refuses an injected field path',
    eve.call('bumpListingCounter', { listingId, field: 'promo.dollarsOff' }),
    'invalid-argument');
  await expectReject('bumpListingCounter refuses a field object',
    eve.call('bumpListingCounter', { listingId, field: { viewCount: 1 } }),
    'invalid-argument');
  await expectReject('bumpListingCounter refuses a missing listingId',
    eve.call('bumpListingCounter', { field: 'viewCount' }),
    'invalid-argument');
  await expectReject('bumpListingCounter refuses an unknown listing',
    eve.call('bumpListingCounter', { listingId: 'no_such_listing_' + RUN, field: 'viewCount' }),
    'not-found');

  /* A hidden listing is invisible to strangers through the rules; the callable
     runs on the admin SDK, which bypasses them. Stated as an observation rather
     than an invariant claim -- see the report. */
  let hiddenBump = null;
  try {
    hiddenBump = await eve.call('bumpListingCounter', { listingId: hiddenId, field: 'viewCount' });
  } catch (e) { hiddenBump = { error: `${e.code} ${e.message}` }; }
  console.log(`  \x1b[36mNOTE\x1b[0m  bumping a HIDDEN listing as a stranger -> ${JSON.stringify(hiddenBump)}`);

  const failed = await summarize(users);
  console.log(`\n${results.length} checks run.`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\n\x1b[31mSuite aborted:\x1b[0m', err);
  process.exit(2);
});
