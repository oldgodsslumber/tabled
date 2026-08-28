/* Tabled — shared emulator harness for multi-user tests.
 *
 * SAFETY: the project id is `demo-tabled`. The Firebase CLI treats any id
 * starting with `demo-` as offline-only, and this process holds no credentials,
 * so nothing here can reach tabled-2ad11 — it fails to connect instead.
 *
 * Start the emulators first:
 *   firebase emulators:start --only auth,firestore,functions --project demo-tabled
 */
import { createRequire } from 'node:module';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } from 'firebase/auth';
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, collection,
  GeoPoint, serverTimestamp, updateDoc
} from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';

const require = createRequire(import.meta.url);
/* The real slot maths bookSlot validates against, not a reimplementation. */
export const TimeSlots = require('../js/timeslots.js');

export const PROJECT = 'demo-tabled';
export const REGION = 'us-central1';
export const TZ = 'America/New_York';

/* Emulator state survives between runs, so fixed identities make the second run
 * die on email-already-in-use. A per-run suffix keeps every script repeatable
 * without restarting the emulators, and keeps concurrent scripts from
 * colliding with each other. */
export const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/* A standing weekly availability wide enough that a slot always exists. */
export const WINDOWS = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
  dayOfWeek: d, startTime: '09:00', endTime: '21:00'
}));

/* ---- assertions ----------------------------------------------------------
 * Record and continue rather than throw: a suite that stops at the first
 * failure hides how much else is broken. */
export const results = [];
export function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}
export function step(title) { console.log(`\n\x1b[1m${title}\x1b[0m`); }

/* Rejection IS the assertion for anything whose job is to say no. "It didn't
 * blow up" tests nothing about a rule that exists to refuse. */
export async function expectReject(name, promise, codeLike) {
  try {
    await promise;
    check(name, false, 'expected a rejection, but the call SUCCEEDED');
  } catch (err) {
    const msg = `${err.code || ''} ${err.message || ''}`.trim();
    check(name, !codeLike || new RegExp(codeLike, 'i').test(msg), msg);
  }
}

/* Triggers are eventually consistent — poll instead of sleeping a fixed amount,
 * so a slow emulator isn't flaky and a fast one isn't slow. */
export async function until(label, fn, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export function summarize(users) {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n\x1b[1m${results.length - failed.length}/${results.length} checks passed\x1b[0m`);
  if (failed.length) {
    console.log('\x1b[31mFailures:\x1b[0m');
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `  [${f.detail}]` : ''}`));
  }
  return Promise.all((users || []).map((u) => deleteApp(u.app).catch(() => {})))
    .then(() => failed.length);
}

/* ---- users --------------------------------------------------------------- */

export async function makeUser(label, displayName) {
  const app = initializeApp({ apiKey: 'fake-api-key', projectId: PROJECT },
    `app-${label}-${RUN}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  const fns = getFunctions(app, REGION);
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);

  const cred = await createUserWithEmailAndPassword(
    auth, `${label}-${RUN}@example.test`, 'password123');

  const u = {
    label, displayName, app, db, fns, uid: cred.user.uid,
    call: (name, payload) => httpsCallable(fns, name)(payload || {}).then((r) => r.data)
  };

  /* Mirrors CloudBackend.ensureProfile in js/store.js. Every field the users
   * create rule pins is written here, so drift between the two shows up as a
   * permission-denied rather than a silent shape mismatch.
   *
   * The GeoPoint is deliberate: this exact write was rejected for the app's
   * whole life because usPoint() read latitude/longitude as properties when a
   * latlng exposes them as methods. */
  await setDoc(doc(db, 'users', u.uid), {
    displayName, photoURL: null, bio: '', generalArea: 'Riverside, Jacksonville, FL',
    geoPoint: new GeoPoint(30.3322, -81.6557), geohash: 'djmpuytg1',
    countryCode: 'US', state: 'FL',
    createdAt: serverTimestamp(),
    tradeCount: 0, avgRating: null, reviewCount: 0,
    availabilityWindows: [], openReportCount: 0, restricted: false
  });
  return u;
}

/* A seller who can actually be booked: without windows + timeZone, bookSlot
 * refuses with "this seller hasn't set any availability". */
export async function makeSeller(label, displayName) {
  const u = await makeUser(label, displayName);
  await updateDoc(doc(u.db, 'users', u.uid),
    { availabilityWindows: WINDOWS, timeZone: TZ });
  return u;
}

/* ---- listings ------------------------------------------------------------ */

export async function createListing(seller, title, games) {
  const listingRef = doc(collection(seller.db, 'listings'));
  await setDoc(listingRef, {
    sellerId: seller.uid, sellerName: seller.displayName, sellerPhoto: null,
    title, fulfillment: { pickup: true, inPersonAtEvent: false },
    locationLabel: 'Riverside, Jacksonville, FL',
    geoPoint: new GeoPoint(30.3322, -81.6557), geohash: 'djmpuytg1',
    countryCode: 'US', state: 'FL',
    acceptedPayment: { cash: true, paypal: false, venmo: false, trades: true },
    eventId: null, eventName: null, eventStartDate: null, eventEndDate: null,
    gameNames: games.map((g) => g.name),
    minPrice: Math.min(...games.map((g) => g.askingPrice)),
    maxPrice: Math.max(...games.map((g) => g.askingPrice)),
    categories: [], mechanics: [],
    status: 'active', createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    /* The create rule pins every one of these to zero. */
    viewCount: 0, requestCount: 0, watchCount: 0, hotScore: 0, openReportCount: 0
  });

  const entryIds = [];
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    const entryRef = doc(collection(seller.db, 'listings', listingRef.id, 'gameEntries'));
    await setDoc(entryRef, {
      sellerId: seller.uid, bggId: g.bggId || null, name: g.name,
      condition: g.condition || 'VG', categories: [], contents: [], tags: [],
      photos: [], askingPrice: g.askingPrice, notes: '', order: i,
      /* Hold/queue state is function-owned from M5 on. */
      status: 'active', currentHoldRequestId: null, holdExpiresAt: null, queueCount: 0
    });
    entryIds.push(entryRef.id);
  }
  return { listingId: listingRef.id, entryIds };
}

/* ---- scheduling ---------------------------------------------------------- */

/* The next slot genuinely inside the seller's windows and in the future,
 * computed with the module the callable validates against. */
export function nextSlot(windows = WINDOWS, minAheadMs = 3600000) {
  const slots = TimeSlots.generateSlots(windows, TZ, { fromMs: Date.now(), days: 7 });
  const s = slots.find((x) => x.startsAtMs > Date.now() + minAheadMs);
  if (!s) throw new Error('no bookable slot generated');
  return s;
}

/* The seller agreeing to a proposed time. bookSlot only PROPOSES; whoever
 * proposes, the seller gets the final say (js/views-thread.js respond()).
 * Scheduling is a direct client write the rules permit, not a callable. */
export async function acceptProposal(seller, requestId) {
  const snap = await getDoc(doc(seller.db, 'requests', requestId));
  const proposed = snap.data().proposedTime;
  await updateDoc(doc(seller.db, 'requests', requestId), {
    status: 'scheduled',
    scheduledTime: proposed && proposed.toDate ? proposed.toDate() : proposed,
    updatedAt: serverTimestamp()
  });
}

/* Full happy path, for tests that need a COMPLETED trade to attack. */
export async function completeTrade(seller, buyer, listingId, entryId) {
  const res = await buyer.call('createRequest', { listingId, gameEntryId: entryId });
  const requestId = res.requestId;
  const slot = nextSlot();
  await buyer.call('bookSlot', { requestId, date: slot.date, startTime: slot.startTime });
  await acceptProposal(seller, requestId);
  await buyer.call('confirmSold', { requestId });
  await seller.call('confirmSold', { requestId });
  await until('trade to complete', async () => {
    const s = await getDoc(doc(seller.db, 'requests', requestId));
    return s.data().status === 'completed' ? s : null;
  });
  return requestId;
}

export { doc, getDoc, setDoc, updateDoc, collection, GeoPoint, serverTimestamp };
