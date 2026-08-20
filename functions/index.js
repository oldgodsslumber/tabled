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
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
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

/* ---- shared -------------------------------------------------------------- */

function requireAuth(req) {
  if (!req.auth || !req.auth.uid) {
    throw new HttpsError('unauthenticated', 'Sign in first');
  }
}
