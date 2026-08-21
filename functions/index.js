/* Tabled — Cloud Functions (M1–M10).
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

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
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

/* NOT www.boardgamegeek.com. BGG state outright that the www subdomain
 * "may interfere with request authorization" — the token silently stops
 * working, which is a miserable thing to debug from the symptom. */
const BGG_BASE = 'https://boardgamegeek.com/xmlapi2';

/* ---- Authorization (required since 2025-07-02) ---------------------------
 * BGG's XML API is no longer open. Every request needs a Bearer token from a
 * registered application, and unregistered requests get a flat 401.
 *
 * Registration is at boardgamegeek.com/applications and BGG warn it can take
 * "a week or more". Tabled counts as COMMERCIAL under their policy, because
 * the verification fee is a user payment — their stated terms give a free
 * commercial licence until 100 paying users.
 *
 * Worth recording honestly: approval is not guaranteed. BGG reserve the right
 * to decline anything that "competes with any part of BGG's business", and
 * they run their own marketplace. Everything downstream of this token is
 * therefore contingent, which is why the manual-entry path below is built as
 * a real alternative rather than an error state. */
const BGG_TOKEN = defineSecret('BGG_API_TOKEN');

/* BGG throttle hard: too-frequent requests earn 500/503, and their own docs
 * suggest ~5 seconds between calls. maxInstances is pinned to 1 on the two
 * BGG-facing functions so this in-process gate actually serializes everything
 * rather than being sidestepped by a second container.
 *
 * That is only affordable because `games/{bggId}` caches results — the vast
 * majority of lookups never reach BGG at all. */
const BGG_MIN_GAP_MS = 5000;
let bggLastCallAt = 0;

async function bggThrottle() {
  const wait = bggLastCallAt + BGG_MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  bggLastCallAt = Date.now();
}

/* BGG answers a cold `thing` request with HTTP 202 and an empty body, meaning
 * "queued, ask again". Treating that as success yields an empty game record
 * that then gets cached — so it has to be retried, not accepted. */
async function bggFetch(path, attempt = 0) {
  const token = BGG_TOKEN.value();
  if (!token || token === 'PLACEHOLDER_SET_A_REAL_KEY') {
    /* failed-precondition, not unavailable: this is a configuration state that
     * will not fix itself, and the client uses the distinction to fall back to
     * manual entry permanently rather than offering a pointless retry. */
    throw new HttpsError('failed-precondition',
      'BoardGameGeek search needs an approved API token. Register the app at ' +
      'boardgamegeek.com/applications, then set BGG_API_TOKEN.');
  }

  await bggThrottle();

  const res = await fetch(BGG_BASE + path, {
    headers: {
      /* "Bearer" then a space, no colon. */
      'Authorization': 'Bearer ' + token,
      'User-Agent': 'Tabled/1.0 (local board game marketplace)'
    }
  });

  if (res.status === 202 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    return bggFetch(path, attempt + 1);
  }
  if (res.status === 401 || res.status === 403) {
    /* The token is missing, wrong, revoked, or the request went to the www
     * subdomain. All four look identical from here. */
    console.error('BGG rejected our token (' + res.status + ') for ' + path);
    throw new HttpsError('failed-precondition',
      'BoardGameGeek rejected our API token. It may not be approved yet, or it ' +
      'may have been revoked.');
  }
  if (res.status === 429 || res.status === 503 || res.status === 500) {
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

exports.searchGames = onCall({ secrets: [BGG_TOKEN], maxInstances: 1 }, async (req) => {
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

exports.getGameDetails = onCall({ secrets: [BGG_TOKEN], maxInstances: 1 }, async (req) => {
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
  /* Secret Manager has no concept of an empty secret, and defineSecret refuses
   * to DEPLOY at all if the secret is absent — which would block every other
   * function in this file over one unconfigured key. So the secret may hold the
   * sentinel below as a placeholder, and that is treated as "not configured"
   * rather than sent to Google as a real key (which would fail with an opaque
   * REQUEST_DENIED and look like an outage). */
  if (!key || key === 'PLACEHOLDER_SET_A_REAL_KEY') {
    throw new HttpsError('failed-precondition',
      'Geocoding is not configured yet. Set a real key with: ' +
      'firebase functions:secrets:set GEOCODING_API_KEY');
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

/* ---- Event-aware hold timing (M9) ---------------------------------------
 * A flat 24h window is wrong in BOTH directions for a convention.
 *
 * Too short before it starts: a listing made in October for a late-November
 * con would expire its holder for not proposing a pickup time at an event that
 * does not exist yet.
 *
 * Too long once it is running: a con lasts three days. Somebody sitting on a
 * 24-hour hold has effectively taken the item off the market for a third of
 * the event.
 *
 * So event listings get three phases: no expiry before, compressed during,
 * force-expired after. */
const EVENT_HOLD_HOURS = 3;
const EVENT_GRACE_HOURS = 1;

function toMs(ts) {
  return ts && typeof ts.toMillis === 'function' ? ts.toMillis() : null;
}

/* The hold deadline for a request, given the listing it is against.
 *
 * Returns null for "does not expire yet" — a pre-event hold. The sweep skips
 * null deadlines entirely, which is what implements "paused before the event"
 * without a special case anywhere else. */
function holdDeadlineFor(listing, nowMs) {
  const startMs = toMs(listing && listing.eventStartDate);
  const endMs = toMs(listing && listing.eventEndDate);

  if (!startMs || !endMs) return holdDeadline(nowMs);          /* ordinary listing */
  if (nowMs < startMs) return null;                            /* con hasn't started */
  if (nowMs > endMs) return admin.firestore.Timestamp.fromMillis(nowMs);  /* over */

  /* Live: compressed, but never past the end of the event itself. */
  const compressed = nowMs + EVENT_HOLD_HOURS * 3600000;
  return admin.firestore.Timestamp.fromMillis(Math.min(compressed, endMs));
}

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
  const listingRef = db.collection('listings').doc(listingId);
  const entryRef = listingRef.collection('gameEntries').doc(gameEntryId);

  /* Read the listing so a promoted holder gets the right KIND of window — a
   * compressed one at a live con, none at all before it starts. */
  const listingSnap = await tx.get(listingRef);
  const listing = listingSnap.exists ? listingSnap.data() : {};

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
      patch.holdExpiresAt = holdDeadlineFor(listing, nowMs);
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
      holdExpiresAt: holder.data().holdExpiresAt || holdDeadlineFor(listing, nowMs),
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

  /* ---- M10: trade proposals ---------------------------------------------
   * A trade proposal is structurally a request with a different payment shape
   * attached — same queue, same chat, same proposedTime gate, same mutual
   * completion. That reuse is the whole design; there is no parallel system.
   *
   * The addendum assumed a client write plus a follow-up trigger to reserve
   * the offered item. M5 moved request creation into this callable, so the
   * reservation happens inside the SAME transaction instead — atomic rather
   * than eventually consistent, which matters because the thing being
   * reserved is a single physical object. */
  const proposalType = d.proposalType === 'trade' ? 'trade' : 'purchase';
  const offeredListingId = d.offeredListingId ? String(d.offeredListingId) : null;
  const offeredGameEntryId = d.offeredGameEntryId ? String(d.offeredGameEntryId) : null;
  const offeredItem = d.offeredItemDescription || null;

  /* Informational only, never validated or processed. "My Catan + $10" is a
   * thing people say to each other; the number is displayed to the seller and
   * settled in chat like everything else. */
  const cashOffered = Number.isFinite(Number(d.additionalCashOffered))
    ? Math.max(0, Math.round(Number(d.additionalCashOffered) * 100) / 100)
    : null;

  if (proposalType === 'trade' && !offeredGameEntryId && !offeredItem) {
    throw new HttpsError('invalid-argument',
      'A trade proposal has to offer something — a listing of yours, or a described item');
  }
  if (offeredGameEntryId && !offeredListingId) {
    throw new HttpsError('invalid-argument', 'offeredListingId is required with offeredGameEntryId');
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

    /* Trades only where the seller said they're open to them. `acceptedPayment`
     * is otherwise purely descriptive — this is the single place any of it has
     * a functional effect. */
    if (proposalType === 'trade' &&
        !(listing.acceptedPayment && listing.acceptedPayment.trades === true)) {
      throw new HttpsError('failed-precondition', "This seller isn't taking trades");
    }

    /* Read and validate the offered item BEFORE any write, both because
     * transactions require it and because a proposal that fails validation
     * must not leave someone's game reserved. */
    let offeredRef = null;
    let offeredEntry = null;
    if (offeredGameEntryId) {
      const offeredListingRef = db.collection('listings').doc(offeredListingId);
      const offeredListingSnap = await tx.get(offeredListingRef);
      if (!offeredListingSnap.exists) {
        throw new HttpsError('not-found', "Can't find the listing you're offering from");
      }
      if (offeredListingSnap.data().sellerId !== uid) {
        throw new HttpsError('permission-denied', "You can only offer your own listings");
      }
      offeredRef = offeredListingRef.collection('gameEntries').doc(offeredGameEntryId);
      const offeredSnap = await tx.get(offeredRef);
      if (!offeredSnap.exists) throw new HttpsError('not-found', "Can't find the game you're offering");
      offeredEntry = offeredSnap.data();

      if (offeredEntry.status === 'sold') {
        throw new HttpsError('failed-precondition', "You've already sold that one");
      }
      if (offeredEntry.status === 'reserved') {
        throw new HttpsError('failed-precondition',
          "That game is already on the table in another trade");
      }
      if (offeredEntry.status === 'onHold') {
        throw new HttpsError('failed-precondition',
          "Someone is already in a queue for that game — you can't offer it in a trade too");
      }
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
      /* Only the holder is on the clock. Everyone else is waiting on them.
       * For an event listing this may legitimately be null — a hold placed
       * before the con starts does not tick. */
      holdExpiresAt: position === 0 ? holdDeadlineFor(listing, nowMs) : null,
      promotedAt: position === 0 ? admin.firestore.Timestamp.fromMillis(nowMs) : null,
      /* Denormalized so the expiry sweep can find requests whose event has
       * ended. Firestore cannot join, and a sweep that had to read the parent
       * listing for every open request would be one read per request per run. */
      eventId: listing.eventId || null,
      eventEndDate: listing.eventEndDate || null,

      proposalType,
      offeredListingId,
      offeredGameEntryId,
      /* Denormalized so the thread can show the offer without reading a
       * listing that may later be edited or deleted out from under it. */
      offeredGameName: offeredEntry ? (offeredEntry.name || 'Game') : null,
      offeredItemDescription: offeredItem,
      additionalCashOffered: cashOffered,

      proposedTime: null,
      proposedBy: null,
      scheduledTime: null,
      method: null,
      bookedSlotId: null,
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
      holdExpiresAt: position === 0 ? holdDeadlineFor(listing, nowMs) : (entry.holdExpiresAt || null),
      queueCount: position + 1
    });

    /* Reserved the moment the proposal is submitted, not once it reaches the
     * front of the queue. It is a single physical object: letting it sit fully
     * `active` while it is also on the table in an unrelated trade is how the
     * same game gets committed twice.
     *
     * The cost is real and worth stating in the UI — your game is off the
     * market while a speculative offer sits in someone else's queue. It
     * releases automatically if the proposal is declined, cancelled or
     * expires. */
    if (offeredRef) {
      tx.update(offeredRef, {
        status: 'reserved',
        reservedByRequestId: newRef.id
      });
    }

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

  /* A trade proposal that closed without completing must hand the offered game
   * back. Completion is excluded because confirmSold marks it `sold` instead —
   * releasing it to `active` there would put a traded-away game back on the
   * market. */
  if (wasOpen && !isOpen && after.offeredGameEntryId && after.status !== 'completed') {
    const offeredRef = db.collection('listings').doc(after.offeredListingId)
      .collection('gameEntries').doc(after.offeredGameEntryId);
    await offeredRef.update({
      status: 'active',
      reservedByRequestId: null
    }).catch((e) => console.warn('could not release reserved entry', e));
    console.log(`released reserved entry ${after.offeredGameEntryId} (${after.status})`);
  }

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

  /* 3. Event listings whose convention has ended. The in-person opportunity is
   * gone, so an open hold or proposal on one is holding an item hostage to a
   * meeting that can no longer happen. The listing itself is untouched — a
   * seller can still switch it to shipping-only for whoever missed them. */
  const endedEvents = await db.collection('requests')
    .where('status', 'in', OPEN_STATUSES)
    .where('eventEndDate', '<=', now)
    .limit(300).get();

  let eventClosed = 0;
  for (const doc of endedEvents.docs) {
    await doc.ref.update({
      status: 'expired',
      closedReason: 'eventEnded',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    remember(doc.data());
    eventClosed++;
  }

  /* 4. No-shows: a scheduled time plus the grace cushion, with no completion.
   * Event listings use a much shorter cushion — an hour, not twelve — because
   * a con is only a few days long and the next person in line needs their
   * turn while the event is still running. */
  const graceCutoff = admin.firestore.Timestamp.fromMillis(nowMs - GRACE_HOURS * 3600000);
  const eventGraceCutoff = admin.firestore.Timestamp.fromMillis(nowMs - EVENT_GRACE_HOURS * 3600000);
  const missed = await db.collection('requests')
    .where('status', '==', 'scheduled')
    .where('scheduledTime', '<=', eventGraceCutoff)
    .limit(300).get();

  for (const doc of missed.docs) {
    const d = doc.data();
    /* An event request that is inside the shorter cushion is not a no-show
     * yet. The broad query above uses the generous cutoff, so this filters
     * back down for the ones that need it. */
    const scheduledMs = toMs(d.scheduledTime);
    const cushion = d.eventEndDate ? EVENT_GRACE_HOURS : GRACE_HOURS;
    if (scheduledMs && scheduledMs + cushion * 3600000 > nowMs) continue;

    await doc.ref.update({
      status: 'expired',
      closedReason: 'noShow',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    remember(d);
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
    `reverted, ${eventClosed} ended-event closures, ${noShows} no-shows, ` +
    `${touched.size} entries resynced`);
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

    /* Tabled is free — there is no verification fee. Completion is the whole
     * event: it counts the trade for both people and unlocks reviews, and
     * nothing about it is gated on payment. */
    tx.update(requestRef, patch);

    const entryRef = db.collection('listings').doc(r.listingId)
      .collection('gameEntries').doc(r.gameEntryId);
    tx.update(entryRef, {
      status: 'sold',
      currentHoldRequestId: null,
      holdExpiresAt: null,
      queueCount: 0
    });

    /* M10: a completed trade moves TWO games. The offered side is sold too —
     * it changed hands just as much as the requested one did. */
    if (r.offeredGameEntryId && r.offeredListingId) {
      tx.update(
        db.collection('listings').doc(r.offeredListingId)
          .collection('gameEntries').doc(r.offeredGameEntryId),
        {
          status: 'sold',
          reservedByRequestId: null,
          currentHoldRequestId: null,
          holdExpiresAt: null,
          queueCount: 0
        });
    }

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
      listingId: r.listingId, sellerId: r.sellerId,
      offeredListingId: r.offeredListingId || null
    };
  });

  /* Archival runs after the transaction, not inside it: deciding it needs a
   * read of every sibling entry, and a transaction that reads a whole
   * subcollection to settle one boolean is a contention magnet on a busy
   * listing. Worst case here is a listing that stays 'active' with everything
   * sold for a moment. */
  if (outcome.completed && outcome.listingId) {
    await archiveIfAllSold(outcome.listingId);
    /* Both listings can be emptied by one trade. */
    if (outcome.offeredListingId) await archiveIfAllSold(outcome.offeredListingId);
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

/* =========================================================================
 * Admin console — roles, moderation actions, audit trail
 *
 * ONE callable performs every mutation. That is deliberate and structural.
 *
 * The invariant this codebase has held since M1 is that denormalized and
 * consequential fields are function-only — not writable even by the owner of
 * the document they sit on. Granting staff direct write access through rules
 * would open a second path to exactly the fields that invariant protects
 * (`restricted`, `status`, `vip`), and a second path is one nobody remembers
 * to keep in step.
 *
 * So rules grant staff only READ access, every change comes through here, and
 * every change writes an audit row in the same operation. Moderation without a
 * trail is how a mistake becomes unexplainable six weeks later.
 *
 * Roles live in a custom claim, not a Firestore field, so `firestore.rules`
 * can check them from the token without a document read on every evaluation.
 * The cost of that choice: a freshly-granted role does not take effect until
 * the client's ID token refreshes. See setUserRole below.
 * ========================================================================= */

function callerRole(req) {
  return (req.auth && req.auth.token && req.auth.token.role) || null;
}
function requireStaff(req) {
  requireAuth(req);
  const role = callerRole(req);
  if (role !== 'admin' && role !== 'moderator') {
    throw new HttpsError('permission-denied', 'Staff only');
  }
  return role;
}
function requireAdmin(req) {
  requireAuth(req);
  if (callerRole(req) !== 'admin') {
    throw new HttpsError('permission-denied', 'This action is admin-only');
  }
  return 'admin';
}

/* Actions a moderator may take. Anything absent here is admin-only.
 *
 * The split is deliberate: moderators triage content, admins make decisions
 * that touch a person's account or cost money. */
const MODERATOR_ACTIONS = ['dismissReports', 'hideListing', 'unhideListing'];

const ALL_ACTIONS = MODERATOR_ACTIONS.concat([
  'deleteListing', 'restrictUser', 'unrestrictUser', 'grantVip', 'revokeVip'
]);

/* Resolving reports is what makes un-hiding actually work.
 *
 * The auto-hide breaker counts reports with status 'open'. If a moderator
 * clears a listing without resolving them, the count stays at three and the
 * very next report re-hides it — the human decision silently undone. So every
 * action that settles a target closes its open reports too. */
async function resolveOpenReports(targetType, targetId, actorUid) {
  const open = await db.collection('reports')
    .where('targetType', '==', targetType)
    .where('targetId', '==', targetId)
    .where('status', '==', 'open')
    .limit(200).get();

  if (open.empty) return 0;

  const batch = db.batch();
  open.docs.forEach((doc) => {
    batch.update(doc.ref, {
      status: 'reviewed',
      reviewedBy: actorUid,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
  await batch.commit();
  return open.size;
}

async function writeAudit(entry) {
  await db.collection('adminActions').add(Object.assign({
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, entry));
}

exports.adminAction = onCall(async (req) => {
  const role = requireStaff(req);
  const uid = req.auth.uid;
  const d = req.data || {};
  const action = String(d.action || '');
  const targetId = String(d.targetId || '');
  const reason = String(d.reason || '').slice(0, 500);

  if (ALL_ACTIONS.indexOf(action) === -1) {
    throw new HttpsError('invalid-argument', 'Unknown action');
  }
  if (role !== 'admin' && MODERATOR_ACTIONS.indexOf(action) === -1) {
    throw new HttpsError('permission-denied', 'That action is admin-only');
  }
  if (!targetId) throw new HttpsError('invalid-argument', 'targetId is required');

  const actorName = (req.auth.token && req.auth.token.name) || 'staff';
  let targetType = 'listing';
  let result = {};

  switch (action) {
    /* ---- Content ---- */

    case 'dismissReports': {
      targetType = String(d.targetType || 'listing');
      const n = await resolveOpenReports(targetType, targetId, uid);
      await recountReports(targetType, targetId);
      result = { resolved: n };
      break;
    }

    case 'hideListing':
    case 'unhideListing': {
      const ref = db.collection('listings').doc(targetId);
      const snap = await ref.get();
      if (!snap.exists) throw new HttpsError('not-found', 'No such listing');
      await ref.update({ status: action === 'hideListing' ? 'hidden' : 'active' });
      const n = await resolveOpenReports('listing', targetId, uid);
      await recountReports('listing', targetId);
      result = { resolved: n, status: action === 'hideListing' ? 'hidden' : 'active' };
      break;
    }

    case 'deleteListing': {
      /* Entries first: deleting the parent orphans the subcollection, which
       * stays billable and unreachable. Firestore has no cascade. */
      const entries = await db.collection('listings').doc(targetId)
        .collection('gameEntries').get();
      const batch = db.batch();
      entries.docs.forEach((doc) => batch.delete(doc.ref));
      batch.delete(db.collection('listings').doc(targetId));
      await batch.commit();
      await resolveOpenReports('listing', targetId, uid);
      result = { deletedEntries: entries.size };
      break;
    }

    /* ---- Accounts ---- */

    case 'restrictUser':
    case 'unrestrictUser': {
      targetType = 'user';
      if (targetId === uid) {
        throw new HttpsError('failed-precondition', "You can't restrict yourself");
      }
      await db.collection('users').doc(targetId)
        .update({ restricted: action === 'restrictUser' });
      const n = await resolveOpenReports('user', targetId, uid);
      await recountReports('user', targetId);
      result = { resolved: n, restricted: action === 'restrictUser' };
      break;
    }

    /* ---- VIP ----
     * A billing decision rather than a moderation one, hence admin-only.
     * Invisible by design: a VIP simply never sees a fee prompt, and nothing
     * on their public profile marks them out. */
    case 'grantVip': {
      targetType = 'user';
      /* null means forever. A date means comped-until. */
      const untilMs = Number(d.until);
      const vipUntil = Number.isFinite(untilMs) && untilMs > Date.now()
        ? admin.firestore.Timestamp.fromMillis(untilMs)
        : null;

      await db.collection('users').doc(targetId).update({
        vip: true,
        vipUntil,
        vipGrantedAt: admin.firestore.FieldValue.serverTimestamp(),
        vipGrantedBy: uid,
        vipReason: reason
      });

      result = { vipUntil: vipUntil ? vipUntil.toMillis() : null };
      break;
    }

    case 'revokeVip': {
      targetType = 'user';
      await db.collection('users').doc(targetId).update({
        vip: false,
        vipUntil: null
      });
      /* NOT retroactive, same principle as the launch waiver. Already-settled
       * trades stay settled — clawing back would darken a badge over history
       * the person can no longer act on. */
      result = { retroactive: false };
      break;
    }
  }

  await writeAudit({
    action, targetType, targetId, reason,
    actorUid: uid, actorName, actorRole: role,
    result
  });

  return Object.assign({ ok: true, action }, result);
});

/* openReportCount is denormalized onto the target so the console can sort by
 * it without an aggregation per row. Recomputed from the collection rather
 * than decremented — a decrement drifts the first time anything is retried. */
async function recountReports(targetType, targetId) {
  const n = (await db.collection('reports')
    .where('targetType', '==', targetType)
    .where('targetId', '==', targetId)
    .where('status', '==', 'open')
    .count().get()).data().count;

  const ref = targetType === 'user'
    ? db.collection('users').doc(targetId)
    : db.collection('listings').doc(targetId);
  await ref.set({ openReportCount: n }, { merge: true }).catch(() => {});
  return n;
}


/* ---- setUserRole ---------------------------------------------------------
 * Admin-only. Writes a custom claim, which is what firestore.rules reads.
 *
 * THE GOTCHA: custom claims live in the ID token, and an existing token does
 * not carry a claim granted after it was issued. Firebase refreshes tokens
 * roughly hourly, so without a forced refresh a newly-promoted admin gets
 * permission-denied from rules for up to an hour — which looks exactly like a
 * broken build. The client must call getIdToken(true) after this returns, and
 * the console tells the granting admin to have them reload. */
exports.setUserRole = onCall(async (req) => {
  requireAdmin(req);
  const uid = String((req.data || {}).uid || '');
  const role = (req.data || {}).role;

  if (!uid) throw new HttpsError('invalid-argument', 'uid is required');
  if (role !== null && role !== 'admin' && role !== 'moderator') {
    throw new HttpsError('invalid-argument', "role must be 'admin', 'moderator' or null");
  }
  if (uid === req.auth.uid && role !== 'admin') {
    /* Locking yourself out is recoverable only by running the bootstrap script
     * again with a service-account key. Refuse rather than allow it by
     * accident. */
    throw new HttpsError('failed-precondition',
      "You can't remove your own admin role from here");
  }

  await admin.auth().setCustomUserClaims(uid, role ? { role } : {});
  /* Mirrored onto the user doc purely so the console can list staff. The claim
   * is what rules trust; this copy is display only and must never be read as
   * an authorization decision. */
  await db.collection('users').doc(uid)
    .set({ staffRole: role || null }, { merge: true });

  await writeAudit({
    action: 'setUserRole', targetType: 'user', targetId: uid,
    reason: String((req.data || {}).reason || '').slice(0, 500),
    actorUid: req.auth.uid,
    actorName: (req.auth.token && req.auth.token.name) || 'admin',
    actorRole: 'admin',
    result: { role: role || null }
  });

  return { ok: true, role: role || null, tokenRefreshRequired: true };
});

/* =========================================================================
 * Privacy & safety — message retention, gated address exchange, safe spots
 *
 * Three connected pieces, all serving one goal: hold as little personal data
 * as possible, for as short a time as possible, in the fewest hands.
 *
 *   1. Messages live only through the deal, then move to an admin-only archive
 *      for a few days, then are deleted outright. A closed trade should not
 *      leave a permanent, subpoenable, breachable log of who met whom where.
 *
 *   2. A pickup address is never stored in a message. It is released once, by
 *      the person who owns it, on a deliberate act, encrypted at rest, and
 *      deleted the moment pickup is confirmed — or on a short backstop timer
 *      the sender chooses within a hard cap.
 *
 *   3. The safest meeting option — a public place, a police exchange zone —
 *      is a first-class button that needs no address at all.
 * ========================================================================= */

const crypto = require('crypto');

/* Days a closed deal's messages stay in the admin-only archive before hard
 * deletion. Deliberately short: a local trade either happens within days or
 * falls apart, and a moderation record only needs to outlive the trade. */
const ARCHIVE_DAYS = 5;

/* The terminal statuses. A deal in one of these is over, and its message log
 * starts its countdown to archival. */
const CLOSED_STATUSES = ['completed', 'cancelled', 'expired'];

/* Encrypts released addresses at rest. A leaked or subpoenaed meetingDetails
 * doc is ciphertext without this key, which lives only in Secret Manager. */
const ADDRESS_KEY = defineSecret('ADDRESS_ENC_KEY');

/* Hard ceiling on how long a released address may sit before self-deleting,
 * regardless of what the sender picks. The safety model depends on addresses
 * being short-lived; the sender chooses within this bound, never past it. */
const ADDRESS_MAX_TTL_MS = 48 * 3600000;

/* ---- Address encryption -------------------------------------------------- */

function encKey() {
  const raw = ADDRESS_KEY.value();
  if (!raw || raw === 'PLACEHOLDER_SET_A_REAL_KEY') {
    throw new HttpsError('failed-precondition',
      'Address exchange is not configured. Set ADDRESS_ENC_KEY to a 32-byte ' +
      'base64 key (openssl rand -base64 32).');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new HttpsError('failed-precondition', 'ADDRESS_ENC_KEY must decode to 32 bytes');
  }
  return key;
}

function encryptAddress(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  /* iv.tag.ciphertext, all base64 — everything decrypt needs, nothing it doesn't. */
  return iv.toString('base64') + '.' + tag.toString('base64') + '.' + ct.toString('base64');
}

function decryptAddress(blob) {
  const [ivB, tagB, ctB] = String(blob).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8');
}

/* ---- releaseMeetingAddress ----------------------------------------------
 * The sender deliberately releases their address to the other party. This is
 * an ACT, not a stored field — Jerry decides you're really coming and sends
 * it. It never touches the messages subcollection, so it never lands in the
 * archive or a breach of it.
 */
exports.releaseMeetingAddress = onCall({ secrets: [ADDRESS_KEY] }, async (req) => {
  requireAuth(req);
  const uid = req.auth.uid;
  const d = req.data || {};
  const requestId = String(d.requestId || '');
  const address = String(d.address || '').trim();
  const ttlChoiceMs = Number(d.ttlMs);

  if (!requestId) throw new HttpsError('invalid-argument', 'requestId is required');
  if (address.length < 5 || address.length > 400) {
    throw new HttpsError('invalid-argument', 'That address looks wrong');
  }

  const reqSnap = await db.collection('requests').doc(requestId).get();
  if (!reqSnap.exists) throw new HttpsError('not-found', 'No such request');
  const r = reqSnap.data();

  if (r.buyerId !== uid && r.sellerId !== uid) {
    throw new HttpsError('permission-denied', 'Not your trade');
  }
  if (!['proposedTime', 'scheduled'].includes(r.status)) {
    throw new HttpsError('failed-precondition',
      'Agree a time before sharing an address');
  }

  /* Capped. The sender chooses the window; the ceiling is not theirs to lift,
   * because the whole point is that addresses do not linger. */
  const ttl = Number.isFinite(ttlChoiceMs)
    ? Math.min(Math.max(ttlChoiceMs, 3600000), ADDRESS_MAX_TTL_MS)
    : 24 * 3600000;
  const expireAtMs = Date.now() + ttl;

  /* recipientId is the OTHER party — the one allowed to read it back. */
  const recipientId = r.buyerId === uid ? r.sellerId : r.buyerId;

  await db.collection('meetingDetails').doc(requestId).set({
    requestId,
    senderId: uid,
    recipientId,
    ciphertext: encryptAddress(address),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    /* Firestore TTL policy deletes on this field — the backstop that fires
     * even if pickup is never confirmed and no function ever runs. */
    expireAt: admin.firestore.Timestamp.fromMillis(expireAtMs)
  });

  /* A pointer on the request so both clients can see an address is waiting,
   * without the address itself being anywhere near the request doc. */
  await reqSnap.ref.update({
    meetingAddressPending: true,
    meetingAddressFor: recipientId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return { ok: true, expireAtMs };
});

/* ---- readMeetingAddress --------------------------------------------------
 * The recipient reads it back. Deliberately a callable rather than a readable
 * doc: the address must never be client-readable at rest, or "disappears from
 * the UI" would not mean "gone from your servers". Only this function, holding
 * the key, can turn the stored ciphertext into an address.
 */
exports.readMeetingAddress = onCall({ secrets: [ADDRESS_KEY] }, async (req) => {
  requireAuth(req);
  const uid = req.auth.uid;
  const requestId = String((req.data || {}).requestId || '');
  if (!requestId) throw new HttpsError('invalid-argument', 'requestId is required');

  const snap = await db.collection('meetingDetails').doc(requestId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No address is waiting');
  const m = snap.data();

  /* Only the intended recipient, and only before it expires. */
  if (m.recipientId !== uid) throw new HttpsError('permission-denied', 'Not shared with you');
  if (m.expireAt && m.expireAt.toMillis() < Date.now()) {
    await snap.ref.delete().catch(() => {});
    throw new HttpsError('not-found', 'That address has expired');
  }

  return { address: decryptAddress(m.ciphertext), expireAtMs: m.expireAt.toMillis() };
});

/* ---- confirmPickup -------------------------------------------------------
 * The receiver confirms they have the item. This deletes the address
 * IMMEDIATELY — not on a timer. The timer is only the backstop for the case
 * where nobody ever confirms.
 */
exports.confirmPickup = onCall(async (req) => {
  requireAuth(req);
  const uid = req.auth.uid;
  const requestId = String((req.data || {}).requestId || '');
  if (!requestId) throw new HttpsError('invalid-argument', 'requestId is required');

  const reqSnap = await db.collection('requests').doc(requestId).get();
  if (!reqSnap.exists) throw new HttpsError('not-found', 'No such request');
  const r = reqSnap.data();
  if (r.buyerId !== uid && r.sellerId !== uid) {
    throw new HttpsError('permission-denied', 'Not your trade');
  }

  await db.collection('meetingDetails').doc(requestId).delete().catch(() => {});
  await reqSnap.ref.update({
    meetingAddressPending: false,
    meetingAddressFor: null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return { ok: true };
});

/* ---- archiveClosedThreads ------------------------------------------------
 * Scheduled sweep. A deal closed more than ARCHIVE_DAYS ago has its messages
 * MOVED to an admin-only archive and deleted from where the participants can
 * read them. "Secretly archived" means staff-only, which means the messages
 * must move, not linger — leaving them in place for five days is not archival,
 * the participants still see them.
 *
 * The archive is itself given a TTL, so "kept for five days" does not become
 * "kept forever in a different drawer".
 */
exports.archiveClosedThreads = onSchedule('every 6 hours', async () => {
  const cutoff = admin.firestore.Timestamp.fromMillis(
    Date.now() - ARCHIVE_DAYS * 86400000);

  /* Closed, past the cutoff, not already archived. */
  const closed = await db.collection('requests')
    .where('status', 'in', CLOSED_STATUSES)
    .where('updatedAt', '<=', cutoff)
    .limit(100).get();

  let archived = 0, skipped = 0;
  for (const doc of closed.docs) {
    if (doc.data().messagesArchived) { skipped++; continue; }

    const msgsRef = doc.ref.collection('messages');
    const msgs = await msgsRef.orderBy('createdAt', 'asc').limit(1000).get();

    if (!msgs.empty) {
      /* Copy into the admin-only archive as one document — a closed thread is
       * small, and one doc is cheaper to read, delete and TTL than a mirrored
       * subcollection. */
      await db.collection('messageArchive').doc(doc.id).set({
        requestId: doc.id,
        buyerId: doc.data().buyerId,
        sellerId: doc.data().sellerId,
        gameName: doc.data().gameName || '',
        closedStatus: doc.data().status,
        messages: msgs.docs.map((m) => {
          const x = m.data();
          return {
            senderId: x.senderId,
            text: x.text,
            createdAt: x.createdAt || null
          };
        }),
        archivedAt: admin.firestore.FieldValue.serverTimestamp(),
        /* The archive expires too. Firestore TTL deletes on this field. */
        expireAt: admin.firestore.Timestamp.fromMillis(Date.now() + ARCHIVE_DAYS * 86400000)
      });

      /* Delete the live messages in batches. */
      const batch = db.batch();
      msgs.docs.forEach((m) => batch.delete(m.ref));
      await batch.commit();
    }

    /* Any released address that somehow outlived the deal goes now too. */
    await db.collection('meetingDetails').doc(doc.id).delete().catch(() => {});

    await doc.ref.update({
      messagesArchived: true,
      lastMessageText: '',
      updatedAt: doc.data().updatedAt   /* preserve — do NOT reset the sort */
    });
    archived++;
  }

  console.log(`archiveClosedThreads: ${archived} archived, ${skipped} already done`);
});

/* ---- findSafeSpots -------------------------------------------------------
 * Nearby public places to meet, from OpenStreetMap via Overpass. Police
 * "exchange zones" first, then cafes and libraries.
 *
 * Server-side and cached for three reasons that all point the same way: the
 * Overpass usage policy discourages heavy client-side use; a neighbourhood's
 * coffee shops do not move, so one cached call serves everyone nearby; and it
 * keeps the precise pickup address off the request entirely — this takes a
 * ROUGH point and returns public venues.
 */
exports.findSafeSpots = onCall(async (req) => {
  requireAuth(req);
  const d = req.data || {};
  const lat = Number(d.lat), lng = Number(d.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new HttpsError('invalid-argument', 'lat and lng are required');
  }

  /* Cache by coarse geohash (precision 6 ≈ 1.2km cell) so a whole area is one
   * Overpass call, refreshed monthly. */
  const cellHash = Geo.encode(lat, lng, 6);
  const cacheRef = db.collection('safeSpots').doc(cellHash);
  const cached = await cacheRef.get();
  if (cached.exists) {
    const c = cached.data();
    const ageMs = Date.now() - (c.fetchedAt ? c.fetchedAt.toMillis() : 0);
    if (ageMs < 30 * 86400000) return { spots: c.spots, cached: true };
  }

  /* police exchange zones, cafes, libraries within ~2km. */
  const query = '[out:json][timeout:20];(' +
    'node["amenity"="police"](around:2500,' + lat + ',' + lng + ');' +
    'node["amenity"="cafe"](around:2000,' + lat + ',' + lng + ');' +
    'node["amenity"="library"](around:2500,' + lat + ',' + lng + ');' +
    ');out body 30;';

  let elements = [];
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query)
    });
    if (!res.ok) throw new Error('Overpass ' + res.status);
    const body = await res.json();
    elements = body.elements || [];
  } catch (err) {
    console.warn('findSafeSpots: Overpass failed', err.message);
    if (cached.exists) return { spots: cached.data().spots, cached: true, stale: true };
    throw new HttpsError('unavailable', 'Could not look up nearby places right now');
  }

  /* Rank police first — an exchange zone is the safest option and worth
   * surfacing above a coffee shop. Then by distance. */
  const rank = { police: 0, library: 1, cafe: 2 };
  const spots = elements
    .filter((e) => e.tags && e.tags.name && Number.isFinite(e.lat) && Number.isFinite(e.lon))
    .map((e) => ({
      name: e.tags.name,
      kind: e.tags.amenity,
      lat: e.lat,
      lng: e.lon,
      distanceMi: Math.round(Geo.distanceMi(lat, lng, e.lat, e.lon) * 10) / 10
    }))
    .sort((a, b) => (rank[a.kind] - rank[b.kind]) || (a.distanceMi - b.distanceMi))
    .slice(0, 12);

  await cacheRef.set({
    spots,
    fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
    /* OSM data is refreshable; let the cache self-expire so stale venues age out. */
    expireAt: admin.firestore.Timestamp.fromMillis(Date.now() + 60 * 86400000)
  });

  return { spots, cached: false };
});

/* ---- shared -------------------------------------------------------------- */

function requireAuth(req) {
  if (!req.auth || !req.auth.uid) {
    throw new HttpsError('unauthenticated', 'Sign in first');
  }
}
