/* Tabled — Cloud Functions (M1–M3).
 *
 * Everything here exists because it CANNOT be done from the browser:
 *
 *   searchGames / getGameDetails  BGG's XML API sends no CORS headers, so a
 *                                 direct browser fetch is blocked outright.
 *   geocodeArea                   The geocoding key must not ship to clients,
 *                                 and the privacy fuzz has to be applied
 *                                 somewhere the client can't see the true point.
 *   bumpListingCounter            Incrementing a counter on someone else's
 *                                 listing would otherwise require giving every
 *                                 signed-in user write access to every listing.
 *   recomputeHotScores            Decay has to be recomputed on a clock; doing
 *                                 it per-read would be a full scan per query.
 *   onReportCreate                The auto-hide circuit breaker has to be
 *                                 unfakeable, and clients can't read `reports`.
 *
 * Region is pinned to us-central1 and must match FUNCTIONS_REGION in
 * js/firebase-config.js. A region mismatch surfaces as an opaque CORS failure
 * in the browser rather than anything that names the actual problem.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const { XMLParser } = require('fast-xml-parser');
const Geo = require('./geo');

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const GEOCODING_KEY = defineSecret('GEOCODING_API_KEY');

/* How far a stored point is displaced from the geocoder's answer, in miles.
 * Big enough that the point can't be read as an address; small enough that a
 * 25-mile radius search is still meaningful. */
const FUZZ_RADIUS_MI = 1.5;

/* ---- Geo-lock -----------------------------------------------------------
 * Tabled is US-only, and this is where that is actually enforced. Every
 * geoPoint that exists anywhere in the system — on a user, on a listing —
 * comes out of geocodeArea below. Gate this one function and the whole app is
 * gated; there is no second path in.
 *
 * ISO-3166-1 alpha-2. Google's geocoder treats US territories as separate
 * countries, so 'US' here means the 50 states plus DC. Puerto Rico ('PR'),
 * Guam ('GU') and the USVI ('VI') would each need adding explicitly.
 *
 * Mirrored in js/config.js (UI copy) and firestore.rules (bounding box). */
const ALLOWED_COUNTRIES = ['US'];

/* Thresholds for the auto-hide circuit breaker. Mirrors CFG.SAFETY on the
 * client, which only uses its copy to explain itself — this one is the one
 * that actually decides. */
const LISTING_HIDE_AT = 3;
const USER_RESTRICT_AT = 5;

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  /* BGG returns a bare <item> when there's one result and an array when there
   * are several. Forcing these paths to always be arrays removes a whole class
   * of "works until someone searches for something unique" bug. */
  isArray: (name) => ['item', 'link', 'name', 'listing'].includes(name)
});

/* ---- BGG plumbing -------------------------------------------------------- */

const BGG_BASE = 'https://boardgamegeek.com/xmlapi2';

/* BGG answers a cold `thing` request with HTTP 202 and an empty body, meaning
 * "queued, ask again". Treating that as success yields an empty game record
 * that then gets cached — so it has to be retried, not accepted. */
async function bggFetch(path, attempt = 0) {
  const res = await fetch(BGG_BASE + path, {
    headers: { 'User-Agent': 'Tabled/1.0 (local board game marketplace)' }
  });

  if (res.status === 202 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    return bggFetch(path, attempt + 1);
  }
  if (res.status === 429) {
    throw new HttpsError('resource-exhausted',
      'BoardGameGeek is rate-limiting requests. Try again in a moment.');
  }
  if (!res.ok) {
    throw new HttpsError('unavailable', `BoardGameGeek returned ${res.status}`);
  }

  const body = await res.text();
  if (!body || !body.trim()) {
    throw new HttpsError('unavailable', 'BoardGameGeek returned an empty response');
  }
  return xml.parse(body);
}

function primaryName(item) {
  const names = item.name || [];
  const primary = names.find((n) => n['@_type'] === 'primary') || names[0];
  return primary ? String(primary['@_value']) : '';
}

function linksOfType(item, type) {
  return (item.link || [])
    .filter((l) => l['@_type'] === type)
    .map((l) => String(l['@_value']));
}

/* BGG's marketplace block is a list of live for-sale listings in mixed
 * currencies and mixed conditions. The median USD price is a far better
 * "what's this worth" signal than the mean, which a single mispriced
 * collector's edition would drag upward by 300%. Returns null when there
 * isn't enough data to say anything honest. */
function medianUsdPrice(item) {
  const listings = (item.marketplacelistings && item.marketplacelistings.listing) || [];
  const usd = listings
    .map((l) => l.price && l.price['@_currency'] === 'USD' ? Number(l.price['@_value']) : NaN)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  if (usd.length < 3) return null;
  const mid = Math.floor(usd.length / 2);
  const median = usd.length % 2 ? usd[mid] : (usd[mid - 1] + usd[mid]) / 2;
  return Math.round(median * 100) / 100;
}

/* ---- searchGames --------------------------------------------------------- */

exports.searchGames = onCall(async (req) => {
  requireAuth(req);
  const query = String(req.data?.query || '').trim();
  if (query.length < 2) return { results: [] };

  const parsed = await bggFetch(
    `/search?query=${encodeURIComponent(query)}&type=boardgame,boardgameexpansion`);

  const items = (parsed.items && parsed.items.item) || [];
  const results = items.slice(0, 15).map((it) => ({
    bggId: String(it['@_id']),
    name: primaryName(it),
    yearPublished: it.yearpublished ? Number(it.yearpublished['@_value']) : null
  })).filter((r) => r.name);

  /* BGG's search is exact-ish and unranked, so a title the user is part-way
   * through typing tends to arrive buried. Surface prefix matches first. */
  const needle = query.toLowerCase();
  results.sort((a, b) => {
    const ap = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
    const bp = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return (b.yearPublished || 0) - (a.yearPublished || 0);
  });

  return { results };
});

/* ---- getGameDetails ------------------------------------------------------ */

exports.getGameDetails = onCall(async (req) => {
  requireAuth(req);
  const bggId = String(req.data?.bggId || '').trim();
  if (!/^\d+$/.test(bggId)) {
    throw new HttpsError('invalid-argument', 'bggId must be numeric');
  }

  const parsed = await bggFetch(`/thing?id=${bggId}&stats=1&marketplace=1`);
  const item = ((parsed.items && parsed.items.item) || [])[0];
  if (!item) throw new HttpsError('not-found', 'No such game on BoardGameGeek');

  const game = {
    name: primaryName(item),
    yearPublished: item.yearpublished ? Number(item.yearpublished['@_value']) : null,
    imageUrl: item.image ? String(item.image) : (item.thumbnail ? String(item.thumbnail) : null),
    categories: linksOfType(item, 'boardgamecategory'),
    mechanics: linksOfType(item, 'boardgamemechanic'),
    suggestedPrice: medianUsdPrice(item),
    lastSyncedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  /* merge:true so a refresh that comes back without marketplace data (BGG
   * omits the block entirely when nothing is for sale) doesn't wipe a price we
   * successfully captured on an earlier sync. */
  await db.collection('games').doc(bggId).set(game, { merge: true });

  return { game: { ...game, id: bggId, lastSyncedAt: Date.now() } };
});

/* ---- geocodeArea --------------------------------------------------------- */

exports.geocodeArea = onCall({ secrets: [GEOCODING_KEY] }, async (req) => {
  requireAuth(req);
  const text = String(req.data?.text || '').trim();
  if (text.length < 2) throw new HttpsError('invalid-argument', 'Area text is too short');

  const key = GEOCODING_KEY.value();
  if (!key) {
    throw new HttpsError('failed-precondition',
      'GEOCODING_API_KEY is not set. Run: firebase functions:secrets:set GEOCODING_API_KEY');
  }

  /* `components=country:US` is a HARD FILTER, not a bias — Google returns
   * ZERO_RESULTS for a foreign address rather than matching it. `region` would
   * only tilt ambiguous results, which is not the same thing at all. */
  const components = ALLOWED_COUNTRIES.map((c) => `country:${c}`).join('|');
  const url = 'https://maps.googleapis.com/maps/api/geocode/json' +
    `?address=${encodeURIComponent(text)}` +
    `&components=${encodeURIComponent(components)}` +
    `&key=${encodeURIComponent(key)}`;

  const res = await fetch(url);
  const body = await res.json();

  if (body.status === 'ZERO_RESULTS') {
    /* Ambiguous by design: with the country filter applied, "no such place"
     * and "that place isn't in the US" are indistinguishable in the response.
     * Say both, rather than guessing wrong about which one it was. */
    throw new HttpsError('not-found',
      "Couldn't find that area in the United States");
  }
  if (body.status !== 'OK') {
    console.error('geocode failed', body.status, body.error_message);
    throw new HttpsError('unavailable', 'Geocoding is unavailable right now');
  }

  const result = body.results[0];

  /* Verify independently rather than trusting the filter. The two fail in
   * different ways — a malformed components parameter is silently ignored by
   * the API, which would turn the hard filter back into no filter at all with
   * nothing in the response to say so. */
  const parts = result.address_components || [];
  const country = parts.find((c) => (c.types || []).includes('country'));
  const countryCode = country ? country.short_name : null;

  if (!countryCode || !ALLOWED_COUNTRIES.includes(countryCode)) {
    throw new HttpsError('out-of-range',
      'Tabled is only available in the United States right now.');
  }

  /* Two-letter state, e.g. "FL". Useful to admins immediately and to
   * state-level browse later; capturing it now avoids a backfill. */
  const admin1 = parts.find((c) => (c.types || []).includes('administrative_area_level_1'));
  const state = admin1 ? admin1.short_name : null;

  const loc = result.geometry.location;

  /* Fuzz here, return only the fuzzed point, and never log the real one. The
   * client stores what it's given, so the true coordinate exists nowhere in
   * our system — which is the only version of this promise that's actually
   * true rather than merely intended. */
  const fuzzed = Geo.jitter(loc.lat, loc.lng, FUZZ_RADIUS_MI);

  return {
    label: text,
    lat: fuzzed.lat,
    lng: fuzzed.lng,
    geohash: Geo.encode(fuzzed.lat, fuzzed.lng, 9),
    countryCode,
    state
  };
});

/* ---- bumpListingCounter -------------------------------------------------- */

exports.bumpListingCounter = onCall(async (req) => {
  requireAuth(req);
  const listingId = String(req.data?.listingId || '');
  const field = String(req.data?.field || '');

  if (!listingId) throw new HttpsError('invalid-argument', 'listingId is required');
  /* Allowlisted, not passed through. Without this, "field" is an arbitrary
   * write into someone else's document — which is the exact hole this callable
   * exists to close. */
  if (!['viewCount', 'requestCount'].includes(field)) {
    throw new HttpsError('invalid-argument', 'Unsupported counter');
  }

  const ref = db.collection('listings').doc(listingId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such listing');
  /* Owners don't inflate their own numbers. The client already avoids calling
   * this for its own listings; this is the half that can't be bypassed. */
  if (snap.data().sellerId === req.auth.uid) return { skipped: true };

  await ref.update({ [field]: admin.firestore.FieldValue.increment(1) });
  return { ok: true };
});

/* ---- recomputeHotScores -------------------------------------------------- */

/* hotScore = (views + requests * 20) / (ageHours + 2) ^ 1.5
 *
 * Requests-weighted hard: two real requests should outrank a hundred idle
 * views, because a view is a thumb passing by and a request is intent. Gravity
 * is Hacker-News-shaped so today's listings surface without last month's
 * bestsellers permanently occupying the top.
 *
 * MIRROR of CFG.HOT in js/config.js — the client computes this live for display
 * on brand-new listings. Change both together or the number shown drifts from
 * the number sorted on. */
const HOT = { requestWeight: 20, viewWeight: 1, gravity: 1.5 };

exports.recomputeHotScores = onSchedule('every 60 minutes', async () => {
  const now = Date.now();
  let processed = 0;
  let cursor = null;

  /* Paged rather than one big read: a full scan of every active listing in one
   * query works fine at launch and falls over silently at scale. */
  for (;;) {
    let q = db.collection('listings')
      .where('status', '==', 'active')
      .orderBy('createdAt', 'desc')
      .limit(400);
    if (cursor) q = q.startAfter(cursor);

    const snap = await q.get();
    if (snap.empty) break;

    const batch = db.batch();
    snap.docs.forEach((doc) => {
      const d = doc.data();
      const created = d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : now;
      const ageH = Math.max(0, (now - created) / 3600000);
      const raw = (d.viewCount || 0) * HOT.viewWeight + (d.requestCount || 0) * HOT.requestWeight;
      const score = raw / Math.pow(ageH + 2, HOT.gravity);
      batch.update(doc.ref, { hotScore: Math.round(score * 10000) / 10000 });
    });
    await batch.commit();

    processed += snap.size;
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.size < 400) break;
  }

  console.log(`recomputeHotScores: updated ${processed} listings`);
});

/* ---- onReportCreate: the auto-hide circuit breaker ------------------------ */

/* Deliberately a blunt instrument. It is NOT moderation — it exists so the
 * report button does something real before an admin console exists. Both
 * thresholds are starting points; expect to tune them once you can see whether
 * they're firing on genuine problems or on one person's grudge.
 *
 * Reports use a deterministic ID ({reporter}_{type}_{target}), so one person
 * reporting the same thing twice overwrites rather than counting twice — and
 * this trigger only fires on create, so a re-report can't drive the count up
 * either. That's what makes a count of 3 mean three distinct people. */
exports.onReportCreate = onDocumentCreated('reports/{reportId}', async (event) => {
  const report = event.data && event.data.data();
  if (!report) return;

  const { targetType, targetId } = report;
  if (!targetId) return;

  const openCount = (await db.collection('reports')
    .where('targetType', '==', targetType)
    .where('targetId', '==', targetId)
    .where('status', '==', 'open')
    .count()
    .get()).data().count;

  if (targetType === 'listing') {
    const ref = db.collection('listings').doc(targetId);
    const update = { openReportCount: openCount };
    if (openCount >= LISTING_HIDE_AT) {
      /* Hidden, never deleted. The seller can still open it, see the banner,
       * and fix whatever drew the reports — and a false positive is one field
       * edit away from being undone. */
      update.status = 'hidden';
    }
    await ref.set(update, { merge: true });
    console.log(`report on listing ${targetId}: ${openCount} open` +
      (update.status ? ' → hidden' : ''));

  } else if (targetType === 'user') {
    const update = { openReportCount: openCount };
    if (openCount >= USER_RESTRICT_AT) update.restricted = true;
    await db.collection('users').doc(targetId).set(update, { merge: true });
    console.log(`report on user ${targetId}: ${openCount} open` +
      (update.restricted ? ' → restricted' : ''));
  }
  /* message and event reports are recorded but have no automatic consequence —
   * hiding a chat message on a report count would be trivially weaponizable
   * between two people who are already arguing. */
});

/* =========================================================================
 * M5 — Hold, queue and expiry
 *
 * The whole point of this milestone is that a queue nobody can cheat. That
 * forces one structural decision: requests are created ONLY by the callable
 * below, never by a client write, and `firestore.rules` denies client creates
 * outright.
 *
 * The reason is simple. Queue position cannot be computed by the client,
 * because a client that writes its own `queuePosition` can write `0`. It also
 * cannot be assigned by an onCreate trigger, because between the write and the
 * trigger the document exists with a position nobody validated, and two
 * simultaneous requests would both read "the queue is empty". Only a
 * transaction that reads the current queue and writes the new request together
 * gets this right.
 * ========================================================================= */

const HOLD_HOURS = 24;    /* holder's window to land on a time */
const GRACE_HOURS = 12;   /* after a scheduled time passes with no completion */

/* The statuses that occupy a place in the queue. Anything else (completed,
 * cancelled, expired) has left it. */
const OPEN_STATUSES = ['queued', 'onHold', 'proposedTime', 'scheduled'];

function holdDeadline(fromMs) {
  return admin.firestore.Timestamp.fromMillis(fromMs + HOLD_HOURS * 3600000);
}

/* Recompute a game entry's queue from the requests that actually exist.
 *
 * Derived, never incremented. An incremented counter drifts the first time any
 * write is retried or lost, and a queue that says "3 waiting" with two people
 * in it is worse than no queue at all. Everything here — positions, entry
 * status, hold deadline — is recalculated from the open request set each time,
 * so the state is self-healing.
 *
 * Must be called inside a transaction that has already read what it needs.
 */
async function resyncQueue(tx, listingId, gameEntryId, nowMs) {
  const entryRef = db.collection('listings').doc(listingId)
    .collection('gameEntries').doc(gameEntryId);

  const openSnap = await tx.get(
    db.collection('requests')
      .where('gameEntryId', '==', gameEntryId)
      .where('status', 'in', OPEN_STATUSES)
  );

  /* Sorted here rather than with orderBy so the query needs only the
   * (gameEntryId, status) index. These sets are single digits. */
  const open = openSnap.docs.slice().sort((a, b) => {
    const at = a.data().createdAt, bt = b.data().createdAt;
    return (at ? at.toMillis() : 0) - (bt ? bt.toMillis() : 0);
  });

  const entrySnap = await tx.get(entryRef);
  const sold = entrySnap.exists && entrySnap.data().status === 'sold';

  if (!open.length) {
    if (!sold) {
      tx.update(entryRef, {
        status: 'active',
        currentHoldRequestId: null,
        holdExpiresAt: null,
        queueCount: 0
      });
    } else {
      tx.update(entryRef, { queueCount: 0 });
    }
    return;
  }

  open.forEach((doc, i) => {
    const d = doc.data();
    const patch = {};
    if (d.queuePosition !== i) patch.queuePosition = i;

    if (i === 0 && d.status === 'queued') {
      /* Promoted to holder: a fresh full window, not the remainder of
       * someone else's. They've only just been told it's their turn. */
      patch.status = 'onHold';
      patch.holdExpiresAt = holdDeadline(nowMs);
      patch.promotedAt = admin.firestore.Timestamp.fromMillis(nowMs);
    }
    if (Object.keys(patch).length) {
      patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
      tx.update(doc.ref, patch);
    }
  });

  const holder = open[0];
  if (!sold) {
    tx.update(entryRef, {
      status: 'onHold',
      currentHoldRequestId: holder.id,
      holdExpiresAt: holder.data().holdExpiresAt || holdDeadline(nowMs),
      queueCount: open.length
    });
  } else {
    tx.update(entryRef, { queueCount: open.length });
  }
}

/* ---- createRequest ------------------------------------------------------- */

exports.createRequest = onCall(async (req) => {
  requireAuth(req);
  const uid = req.auth.uid;
  const d = req.data || {};
  const listingId = String(d.listingId || '');
  const gameEntryId = String(d.gameEntryId || '');

  if (!listingId || !gameEntryId) {
    throw new HttpsError('invalid-argument', 'listingId and gameEntryId are required');
  }

  const listingRef = db.collection('listings').doc(listingId);
  const entryRef = listingRef.collection('gameEntries').doc(gameEntryId);
  const nowMs = Date.now();

  const result = await db.runTransaction(async (tx) => {
    const listingSnap = await tx.get(listingRef);
    if (!listingSnap.exists) throw new HttpsError('not-found', 'No such listing');
    const listing = listingSnap.data();

    if (listing.status !== 'active') {
      throw new HttpsError('failed-precondition', 'That listing is no longer available');
    }
    if (listing.sellerId === uid) {
      throw new HttpsError('failed-precondition', "You can't request your own listing");
    }

    const entrySnap = await tx.get(entryRef);
    if (!entrySnap.exists) throw new HttpsError('not-found', 'No such game');
    if (entrySnap.data().status === 'sold') {
      throw new HttpsError('failed-precondition', 'That game is already sold');
    }

    /* Blocking is checked here as well as in the rules, because the rules
     * never see this write — the admin SDK bypasses them entirely. Every
     * guard the client-create path used to get from rules has to be
     * re-established in this function or it silently disappears. */
    const blocked = await tx.get(
      db.collection('users').doc(listing.sellerId).collection('blocked').doc(uid));
    if (blocked.exists) {
      throw new HttpsError('permission-denied', "You can't request from this seller");
    }

    const meSnap = await tx.get(db.collection('users').doc(uid));
    if (meSnap.exists && meSnap.data().restricted === true) {
      throw new HttpsError('permission-denied',
        'Your account is restricted while reports against it are reviewed');
    }

    const openSnap = await tx.get(
      db.collection('requests')
        .where('gameEntryId', '==', gameEntryId)
        .where('status', 'in', OPEN_STATUSES)
    );

    const mine = openSnap.docs.find((doc) => doc.data().buyerId === uid);
    if (mine) {
      /* Not an error — they almost certainly want the thread they already
       * have. Returning it is friendlier than refusing. */
      return { requestId: mine.id, queuePosition: mine.data().queuePosition, existing: true };
    }

    const position = openSnap.size;
    const newRef = db.collection('requests').doc();
    const meProfile = meSnap.exists ? meSnap.data() : {};
    const entry = entrySnap.data();

    tx.set(newRef, {
      listingId,
      gameEntryId,
      buyerId: uid,
      sellerId: listing.sellerId,
      /* Denormalized display copies so the dashboard lists threads without
       * opening a listing, profile or entry per row. */
      buyerName: meProfile.displayName || 'Buyer',
      buyerPhoto: meProfile.photoURL || null,
      sellerName: listing.sellerName || '',
      sellerPhoto: listing.sellerPhoto || null,
      listingTitle: listing.title || '',
      gameName: entry.name || 'Game',
      coverPhoto: (entry.photos && entry.photos[0]) || listing.coverPhoto || null,
      askingPrice: typeof entry.askingPrice === 'number' ? entry.askingPrice : null,

      status: position === 0 ? 'onHold' : 'queued',
      queuePosition: position,
      /* Only the holder is on the clock. Everyone else is waiting on them. */
      holdExpiresAt: position === 0 ? holdDeadline(nowMs) : null,
      promotedAt: position === 0 ? admin.firestore.Timestamp.fromMillis(nowMs) : null,

      proposedTime: null,
      proposedBy: null,
      scheduledTime: null,
      method: null,
      bookedSlotId: null,
      feePaid: false,
      lastMessageAt: null,
      lastMessageText: '',
      lastMessageSenderId: null,
      lastReadBuyerAt: null,
      lastReadSellerAt: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    tx.update(entryRef, {
      status: 'onHold',
      currentHoldRequestId: position === 0 ? newRef.id : (entry.currentHoldRequestId || newRef.id),
      holdExpiresAt: position === 0 ? holdDeadline(nowMs) : (entry.holdExpiresAt || null),
      queueCount: position + 1
    });

    tx.update(listingRef, {
      requestCount: admin.firestore.FieldValue.increment(1)
    });

    return { requestId: newRef.id, queuePosition: position, existing: false };
  });

  return result;
});

/* ---- queue advancement on status change ---------------------------------- */

/* When a request leaves the open set — cancelled, expired, completed — the
 * person behind it moves up. Doing this in a trigger rather than in each place
 * that closes a request means there is exactly one implementation of "what
 * happens next", and it runs no matter how the request got closed. */
exports.onRequestStatusChange = onDocumentUpdated('requests/{requestId}', async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!before || !after) return;

  const wasOpen = OPEN_STATUSES.includes(before.status);
  const isOpen = OPEN_STATUSES.includes(after.status);
  if (wasOpen === isOpen) return;   /* still in the queue, or still out of it */

  const nowMs = Date.now();
  await db.runTransaction(async (tx) => {
    await resyncQueue(tx, after.listingId, after.gameEntryId, nowMs);
  });

  if (wasOpen && !isOpen) {
    console.log(`request ${event.params.requestId} left the queue (${after.status}) ` +
      `- resynced entry ${after.gameEntryId}`);
  }
});

/* ---- advanceExpiredHolds ------------------------------------------------- */

/* Two kinds of expiry, deliberately treated differently:
 *
 *   1. A holder who never landed on a time within HOLD_HOURS. Their hold
 *      expires and the queue moves up.
 *
 *   2. A `proposedTime` the seller never answered. This reverts to `onHold`
 *      with a fresh window rather than expiring the buyer — they already acted
 *      by proposing, and a slow seller shouldn't cost them their place.
 *
 * Plus the no-show case: a `scheduled` time that came and went with no mutual
 * completion, after a GRACE_HOURS cushion.
 */
exports.advanceExpiredHolds = onSchedule('every 30 minutes', async () => {
  const now = admin.firestore.Timestamp.now();
  const nowMs = now.toMillis();
  const touched = new Map();   /* key -> {listingId, gameEntryId} */
  let expired = 0, reverted = 0, noShows = 0;

  const remember = (d) => {
    touched.set(`${d.listingId}/${d.gameEntryId}`,
      { listingId: d.listingId, gameEntryId: d.gameEntryId });
  };

  /* 1. Holders who ran out of time. */
  const lapsed = await db.collection('requests')
    .where('status', '==', 'onHold')
    .where('holdExpiresAt', '<=', now)
    .limit(300).get();

  for (const doc of lapsed.docs) {
    await doc.ref.update({
      status: 'expired',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    remember(doc.data());
    expired++;
  }

  /* 2. Proposals the seller never answered. The buyer keeps position 0. */
  const stale = await db.collection('requests')
    .where('status', '==', 'proposedTime')
    .where('holdExpiresAt', '<=', now)
    .limit(300).get();

  for (const doc of stale.docs) {
    await doc.ref.update({
      status: 'onHold',
      proposedTime: null,
      proposedBy: null,
      holdExpiresAt: holdDeadline(nowMs),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    reverted++;
  }

  /* 3. No-shows: a scheduled time plus the grace cushion, with no completion. */
  const graceCutoff = admin.firestore.Timestamp.fromMillis(nowMs - GRACE_HOURS * 3600000);
  const missed = await db.collection('requests')
    .where('status', '==', 'scheduled')
    .where('scheduledTime', '<=', graceCutoff)
    .limit(300).get();

  for (const doc of missed.docs) {
    await doc.ref.update({
      status: 'expired',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    remember(doc.data());
    noShows++;
  }

  /* The onRequestStatusChange trigger will also fire for each of these, but
   * resyncing here too makes the sweep self-contained and idempotent —
   * resyncQueue derives everything from scratch, so running it twice is
   * harmless and running it zero times is not. */
  for (const t of touched.values()) {
    await db.runTransaction(async (tx) => {
      await resyncQueue(tx, t.listingId, t.gameEntryId, nowMs);
    });
  }

  console.log(`advanceExpiredHolds: ${expired} holds expired, ${reverted} proposals ` +
    `reverted, ${noShows} no-shows, ${touched.size} entries resynced`);
});

/* =========================================================================
 * M6 — Preset availability & auto-book
 *
 * A seller sets one standing weekly availability that applies across all their
 * listings. It's sliced into 30-minute increments, and whoever currently holds
 * a game entry can claim one in a single tap.
 *
 * Exclusivity comes from the deterministic document ID
 * ({sellerId}_{date}_{startTime}) plus `.create()`, which fails if the document
 * already exists. No transaction, no locking — the uniqueness of a primary key
 * IS the lock. Keyed on the seller rather than the listing, so the same person
 * can't be booked twice at once across two different listings.
 *
 * The callable re-derives the instant from (date, startTime, seller's zone)
 * rather than trusting the client's arithmetic, and re-checks the slot against
 * the seller's stored windows. A client that computes a slot outside the
 * seller's availability, or in the past, gets rejected.
 * ========================================================================= */

const TimeSlots = require('./timeslots');

/* The statuses during which a booked slot is genuinely held. Leaving this set
 * for any reason releases the slot. */
const SLOT_HOLDING_STATUSES = ['proposedTime', 'scheduled'];

exports.bookSlot = onCall(async (req) => {
  requireAuth(req);
  const uid = req.auth.uid;
  const d = req.data || {};
  const requestId = String(d.requestId || '');
  const date = String(d.date || '');
  const startTime = String(d.startTime || '');

  if (!requestId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime)) {
    throw new HttpsError('invalid-argument', 'requestId, date and startTime are required');
  }

  const requestRef = db.collection('requests').doc(requestId);
  const requestSnap = await requestRef.get();
  if (!requestSnap.exists) throw new HttpsError('not-found', 'No such request');
  const request = requestSnap.data();

  if (request.buyerId !== uid) {
    throw new HttpsError('permission-denied', 'Only the buyer can claim a slot');
  }
  /* The deterministic ID stops two people taking the same slot, but it does
   * nothing about someone claiming slots on a request that isn't their turn —
   * that check has to be here. */
  if (request.queuePosition !== 0) {
    throw new HttpsError('failed-precondition', "It isn't your turn yet");
  }
  if (!['onHold', 'proposedTime'].includes(request.status)) {
    throw new HttpsError('failed-precondition', 'This request is not open for scheduling');
  }

  const sellerSnap = await db.collection('users').doc(request.sellerId).get();
  const seller = sellerSnap.exists ? sellerSnap.data() : {};
  const windows = seller.availabilityWindows || [];
  const tz = seller.timeZone;

  if (!windows.length || !tz) {
    throw new HttpsError('failed-precondition', "This seller hasn't set any availability");
  }

  const slotMinutes = TimeSlots.SLOT_MINUTES;
  if (!TimeSlots.withinWindows(windows, date, startTime, slotMinutes)) {
    throw new HttpsError('failed-precondition', "That time isn't in the seller's availability");
  }

  /* Recomputed here, never taken from the client. */
  const startsAtMs = TimeSlots.zonedToUtc(date, startTime, tz);
  if (startsAtMs <= Date.now()) {
    throw new HttpsError('failed-precondition', 'That time has already passed');
  }

  /* Event-tagged listings only offer slots inside the convention window — the
   * point of an event listing is meeting at the con, not at the seller's house
   * next Tuesday. (M9 sets these fields; they're null until then.) */
  const listingSnap = await db.collection('listings').doc(request.listingId).get();
  const listing = listingSnap.exists ? listingSnap.data() : {};
  if (listing.eventStartDate && startsAtMs < listing.eventStartDate.toMillis()) {
    throw new HttpsError('failed-precondition', 'That time is before the event starts');
  }
  if (listing.eventEndDate && startsAtMs > listing.eventEndDate.toMillis()) {
    throw new HttpsError('failed-precondition', 'That time is after the event ends');
  }

  const slotDocId = TimeSlots.slotId(request.sellerId, date, startTime);
  const slotRef = db.collection('users').doc(request.sellerId)
    .collection('bookedSlots').doc(slotDocId);

  /* A buyer changing their mind should release the slot they had rather than
   * silently hoarding two. Done before the create so a failed create doesn't
   * leave them holding nothing. */
  const previousSlotId = request.bookedSlotId;

  try {
    await slotRef.create({
      date,
      startTime,
      endTime: TimeSlots.toHHMM(TimeSlots.toMinutes(startTime) + slotMinutes),
      startsAt: admin.firestore.Timestamp.fromMillis(startsAtMs),
      requestId,
      gameEntryId: request.gameEntryId,
      listingId: request.listingId,
      buyerId: uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    /* ALREADY_EXISTS is the whole exclusivity mechanism firing, not a bug. It
     * means somebody claimed this increment between the page rendering and the
     * tap — which is exactly what it's for. */
    if (err && (err.code === 6 || /already exists/i.test(err.message || ''))) {
      throw new HttpsError('already-exists', 'Someone just took that slot — pick another');
    }
    throw err;
  }

  if (previousSlotId && previousSlotId !== slotDocId) {
    await db.collection('users').doc(request.sellerId)
      .collection('bookedSlots').doc(previousSlotId).delete().catch(() => {});
  }

  /* Deliberately `proposedTime`, never `scheduled`. Auto-book and chat
   * negotiation are two ways of ARRIVING at a proposal; what happens after is
   * identical, and the seller still gets the final Confirm/Decline. */
  await requestRef.update({
    status: 'proposedTime',
    proposedTime: admin.firestore.Timestamp.fromMillis(startsAtMs),
    proposedBy: uid,
    method: 'pickup',
    bookedSlotId: slotDocId,
    /* The seller's response window. If they never answer, advanceExpiredHolds
     * reverts this to onHold and releases the slot. */
    holdExpiresAt: holdDeadline(Date.now()),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return { slotId: slotDocId, startsAtMs, requestId };
});

/* ---- slot release --------------------------------------------------------
 * A booked slot has to be freed whenever the request stops holding it —
 * declined, cancelled, expired, or completed. Doing this in a trigger rather
 * than in each of those call sites means there is one implementation, and it
 * runs however the request got there, including from the expiry sweep.
 *
 * It also has to be a trigger for a plainer reason: storage.rules and
 * firestore.rules both deny all client writes to bookedSlots, so no client
 * could release its own slot even if we asked it to. */
exports.onSlotHoldChange = onDocumentUpdated('requests/{requestId}', async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!before || !after) return;

  const heldBefore = SLOT_HOLDING_STATUSES.includes(before.status) && before.bookedSlotId;
  const heldAfter = SLOT_HOLDING_STATUSES.includes(after.status) && after.bookedSlotId;
  if (!heldBefore || heldAfter) return;

  await db.collection('users').doc(before.sellerId)
    .collection('bookedSlots').doc(before.bookedSlotId).delete().catch(() => {});

  /* Clearing the pointer matters: leaving a stale bookedSlotId on the request
   * would make a later re-book think it had a previous slot to release, and
   * delete whatever now occupies that ID. */
  if (after.bookedSlotId) {
    await event.data.after.ref.update({ bookedSlotId: null }).catch(() => {});
  }

  console.log(`released slot ${before.bookedSlotId} (request went to ${after.status})`);
});

/* =========================================================================
 * M7 — Completion & trust
 *
 * A trade completes only when BOTH sides say it did. That is the whole point:
 * the app can never observe money changing hands outside it, but it can
 * observe two people independently agreeing, and that agreement cannot be
 * faked by either one alone.
 *
 * Completion is what unlocks reviews and increments tradeCount — which is
 * exactly why it can't be a client write. A seller able to mark their own
 * trades complete could manufacture a trade history, and every trust signal
 * on the profile becomes decorative.
 * ========================================================================= */

exports.confirmSold = onCall(async (req) => {
  requireAuth(req);
  const uid = req.auth.uid;
  const requestId = String((req.data || {}).requestId || '');
  if (!requestId) throw new HttpsError('invalid-argument', 'requestId is required');

  const requestRef = db.collection('requests').doc(requestId);
  const nowMs = Date.now();

  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(requestRef);
    if (!snap.exists) throw new HttpsError('not-found', 'No such request');
    const r = snap.data();

    const isBuyer = r.buyerId === uid;
    const isSeller = r.sellerId === uid;
    if (!isBuyer && !isSeller) throw new HttpsError('permission-denied', 'Not your trade');
    if (r.status === 'completed') return { already: true, completed: true };
    if (r.status !== 'scheduled') {
      throw new HttpsError('failed-precondition',
        'Agree a time first — confirming comes after that');
    }

    const field = isBuyer ? 'buyerConfirmedAt' : 'sellerConfirmedAt';
    if (r[field]) return { already: true, completed: false };

    const otherField = isBuyer ? 'sellerConfirmedAt' : 'buyerConfirmedAt';
    const bothNow = !!r[otherField];

    const patch = {};
    patch[field] = admin.firestore.Timestamp.fromMillis(nowMs);
    patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    if (!bothNow) {
      tx.update(requestRef, patch);
      return { already: false, completed: false, waitingOn: isBuyer ? 'seller' : 'buyer' };
    }

    /* ---- Both sides are in. Everything below happens atomically. ---- */

    patch.status = 'completed';
    patch.completedAt = admin.firestore.Timestamp.fromMillis(nowMs);

    /* The launch waiver (M8). During it, completion satisfies the verification
     * fee outright — no Stripe call, no prompt shown at all. Deciding it HERE
     * rather than at fee time is what makes the spec's promise true: a trade
     * completed during the waiver stays free forever, even after the cutoff.
     *
     * A missing config doc is treated as waived. The fee system does not exist
     * yet, and defaulting to unpaid would strip the Verified badge off every
     * seller the moment M8 ships. */
    const cfg = await tx.get(db.collection('config').doc('global'));
    const waiverEnd = cfg.exists && cfg.data().feeWaiverEndDate
      ? cfg.data().feeWaiverEndDate.toMillis()
      : Infinity;
    patch.feePaid = nowMs < waiverEnd;
    patch.feeWaived = patch.feePaid;

    tx.update(requestRef, patch);

    const entryRef = db.collection('listings').doc(r.listingId)
      .collection('gameEntries').doc(r.gameEntryId);
    tx.update(entryRef, {
      status: 'sold',
      currentHoldRequestId: null,
      holdExpiresAt: null,
      queueCount: 0
    });

    /* Anyone still queued behind this trade is waiting for something that no
     * longer exists. Closing them explicitly is kinder than leaving them to
     * find out when their hold silently lapses. */
    const queued = await tx.get(
      db.collection('requests')
        .where('gameEntryId', '==', r.gameEntryId)
        .where('status', 'in', OPEN_STATUSES)
    );
    let closed = 0;
    queued.docs.forEach((doc) => {
      if (doc.id === requestId) return;
      tx.update(doc.ref, {
        status: 'expired',
        closedReason: 'itemSold',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      closed++;
    });

    /* tradeCount counts for BOTH people. A trade is symmetric — both sides
     * turned up and did the thing. Written here because these fields are
     * function-only in the rules for exactly this reason. */
    tx.update(db.collection('users').doc(r.buyerId),
      { tradeCount: admin.firestore.FieldValue.increment(1) });
    tx.update(db.collection('users').doc(r.sellerId),
      { tradeCount: admin.firestore.FieldValue.increment(1) });

    return {
      already: false, completed: true, closedOthers: closed,
      listingId: r.listingId, sellerId: r.sellerId
    };
  });

  /* Archival runs after the transaction, not inside it: deciding it needs a
   * read of every sibling entry, and a transaction that reads a whole
   * subcollection to settle one boolean is a contention magnet on a busy
   * listing. Worst case here is a listing that stays 'active' with everything
   * sold for a moment. */
  if (outcome.completed && outcome.listingId) {
    await archiveIfAllSold(outcome.listingId);
    await recomputeVerified(outcome.sellerId);
  }

  return outcome;
});

/* A listing whose every game has sold has nothing left to show. Archived, not
 * deleted — trade history and reviews point at it. */
async function archiveIfAllSold(listingId) {
  const entries = await db.collection('listings').doc(listingId)
    .collection('gameEntries').get();
  if (entries.empty) return;
  if (!entries.docs.every((d) => d.data().status === 'sold')) return;
  await db.collection('listings').doc(listingId).update({
    status: 'archived',
    archivedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log('listing ' + listingId + ' archived - every game sold');
}

/* verifiedSeller is a CURRENT-STANDING flag, not a threshold crossed once:
 * true only while zero completed trades carry an unpaid fee. One unpaid trade
 * turns it off; paying turns it back on. tradeCount is deliberately unaffected,
 * so a profile never looks artificially thin because of a fee. */
async function recomputeVerified(sellerId) {
  const unpaid = await db.collection('requests')
    .where('sellerId', '==', sellerId)
    .where('status', '==', 'completed')
    .where('feePaid', '==', false)
    .limit(1).get();
  await db.collection('users').doc(sellerId)
    .update({ verifiedSeller: unpaid.empty })
    .catch((e) => console.warn('verified recompute failed', e));
}

/* ---- Reviews -------------------------------------------------------------
 * The reviews themselves are a client write: the rules can fully express who
 * may write one — a participant in a completed trade, once, immutably — so a
 * callable would add a hop without adding a guarantee.
 *
 * The AGGREGATE cannot be, for the same reason as tradeCount. Anyone able to
 * set their own avgRating would. So it is derived here. */
exports.onReviewCreate = onDocumentCreated('reviews/{reviewId}', async (event) => {
  const review = event.data && event.data.data();
  if (!review || !review.revieweeId) return;

  /* Recomputed from the collection rather than folded into a running average.
   * A running average drifts on any retry and can't be repaired without the
   * full set anyway — and the full set is tiny. */
  const all = await db.collection('reviews')
    .where('revieweeId', '==', review.revieweeId)
    .limit(500).get();

  const ratings = all.docs
    .map((d) => Number(d.data().rating))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
  if (!ratings.length) return;

  const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
  await db.collection('users').doc(review.revieweeId).update({
    avgRating: Math.round(avg * 100) / 100,
    reviewCount: ratings.length
  });
});

/* ---- shared -------------------------------------------------------------- */

function requireAuth(req) {
  if (!req.auth || !req.auth.uid) {
    throw new HttpsError('unauthenticated', 'Sign in first');
  }
}
