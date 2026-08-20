/* Tabled — configuration & vocabulary.
 *
 * Everything tunable lives here: condition tiers, the tag list, report reason
 * chips, thresholds, and the Hot formula's weights. Views read from CFG rather
 * than hardcoding strings, so growing the tag list or retuning Hot is a one-file
 * edit and never a hunt through the view layer.
 *
 * Bump CFG.BUILD on every change and mirror it into the ?v= stamps in
 * index.html, or the browser will happily serve you yesterday's app.
 */
window.CFG = (function () {

  var BUILD = '20260820d';

  /* ---- Condition tiers ---------------------------------------------------
   * Ordered best → worst. `key` is what's stored; never store the label. */
  var CONDITIONS = [
    { key: 'NIS', label: 'New in Shrink', blurb: 'Sealed, never opened' },
    { key: 'LN',  label: 'Like New',      blurb: 'Opened, not played' },
    { key: 'VG',  label: 'Very Good',     blurb: 'Played a few times, no wear' },
    { key: 'G',   label: 'Good',          blurb: 'Played often, minor wear' },
    { key: 'F',   label: 'Fair',          blurb: 'Well-loved, complete unless noted' }
  ];

  /* ---- Tags --------------------------------------------------------------
   * A hardcoded, extensible list rather than an admin-managed collection —
   * simpler for v1. Adding a tag here makes it immediately selectable; existing
   * listings that used a removed tag still display it, they just can't re-pick
   * it, so pruning this list is safe. */
  var TAGS = [
    'Sleeved cards',
    'Upgraded components',
    '3D-printed insert',
    'Official insert',
    'Premium playmat',
    'Punched',
    'Unpunched',
    'Painted minis',
    'Unpainted minis',
    'All expansions included',
    'Expansion only',
    'Missing pieces (see notes)',
    'Smoke-free home',
    'Pet-free home',
    'First printing',
    'Kickstarter edition',
    'Foreign language edition'
  ];

  /* ---- Report reasons ----------------------------------------------------
   * Context-specific by target type — never one generic dropdown. Tapping a
   * chip IS the submission; only 'other' opens a text field. */
  var REPORT_REASONS = {
    listing: [
      { key: 'misleading', label: 'Misleading photos or condition' },
      { key: 'scam',       label: 'Suspected scam or counterfeit' },
      { key: 'prohibited', label: 'Prohibited or unsafe item' },
      { key: 'spam',       label: 'Spam or duplicate listing' },
      { key: 'other',      label: 'Something else' }
    ],
    user: [
      { key: 'noshow',     label: "No-show — didn't honor a scheduled meetup" },
      { key: 'harassment', label: 'Harassment or inappropriate messages' },
      { key: 'scam',       label: 'Suspected scam' },
      { key: 'fake',       label: 'Fake or bot profile' },
      { key: 'other',      label: 'Something else' }
    ],
    message: [
      { key: 'harassment', label: 'Harassment or inappropriate' },
      { key: 'scam',       label: 'Suspected scam attempt' },
      { key: 'other',      label: 'Something else' }
    ],
    event: [
      { key: 'duplicate',  label: 'Duplicate of an existing event' },
      { key: 'wrongdates', label: 'Wrong dates or venue' },
      { key: 'spam',       label: 'Spam or not a real event' },
      { key: 'other',      label: 'Something else' }
    ]
  };

  /* ---- BGG categories ----------------------------------------------------
   * BoardGameGeek's category vocabulary is a fixed, slow-moving list, so the
   * filter dropdown ships with it rather than deriving options from whatever
   * happens to be in the current result set — otherwise the available filters
   * would shift every time the feed reloads, which reads as broken.
   *
   * Cached `games` docs store BGG's exact strings; these must match them
   * verbatim or the array-contains filter silently matches nothing. */
  var BGG_CATEGORIES = [
    'Abstract Strategy', 'Adventure', 'Age of Reason', 'American West', 'Ancient',
    'Animals', 'Bluffing', 'Card Game', 'Children\'s Game', 'City Building',
    'Civilization', 'Collectible Components', 'Deduction', 'Dice', 'Economic',
    'Educational', 'Environmental', 'Exploration', 'Fantasy', 'Farming',
    'Fighting', 'Horror', 'Humor', 'Industry / Manufacturing', 'Mafia',
    'Math', 'Maze', 'Medical', 'Medieval', 'Miniatures', 'Modern Warfare',
    'Movies / TV / Radio', 'Murder / Mystery', 'Mythology', 'Napoleonic',
    'Nautical', 'Negotiation', 'Novel-based', 'Party Game', 'Pirates',
    'Political', 'Prehistoric', 'Print & Play', 'Puzzle', 'Racing',
    'Real-time', 'Religious', 'Renaissance', 'Science Fiction', 'Space Exploration',
    'Spies / Secret Agents', 'Sports', 'Territory Building', 'Trains',
    'Transportation', 'Travel', 'Trivia', 'Video Game Theme', 'Wargame',
    'Word Game', 'World War I', 'World War II', 'Zombies'
  ];

  /* ---- Fulfillment -------------------------------------------------------- */
  var FULFILLMENT = [
    { key: 'pickup', label: 'Local pickup' },
    { key: 'shipping', label: 'Will ship' },
    { key: 'inPersonAtEvent', label: 'In person at an event' }
  ];

  /* ---- Geo-lock ----------------------------------------------------------
   * Tabled is US-only. The enforcement that matters is server-side, in
   * geocodeArea — every geoPoint in the system comes from that one function, so
   * gating it gates everything. What's here is for UI copy and a client-side
   * pre-check; neither is a security boundary.
   *
   * `countries` holds ISO-3166-1 alpha-2 codes. Note that Google's geocoder
   * treats US territories as SEPARATE countries — Puerto Rico is 'PR', Guam is
   * 'GU', the USVI is 'VI'. So this list is 50 states + DC only, and widening it
   * is a one-line edit here plus the same edit in functions/index.js.
   *
   * BOX is a deliberately coarse bounding box used as defence-in-depth in
   * firestore.rules, for the case of a modified client writing a geoPoint
   * directly instead of going through the function. It rejects other continents
   * and nothing finer — no rectangle can separate the US from Canada or Mexico,
   * since reaching Alaska at 72°N necessarily covers all of Canada. It is not a
   * US outline and should not become one. The second longitude range is the
   * Aleutians, which cross the antimeridian; a single -180..-66 box drops them.
   *
   * Mirrored in firestore.rules and functions/index.js. Change all three. */
  var GEO = {
    countries: ['US'],
    label: 'the United States',
    shortLabel: 'the US',
    BOX: {
      minLat: 18, maxLat: 72,
      lngRanges: [[-180, -66], [172, 180]]
    }
  };

  /* Client-side pre-check only — the server decides. Used so the UI can react
   * without a round trip when a point is obviously out of bounds. */
  function inUsBox(lat, lng) {
    if (typeof lat !== 'number' || typeof lng !== 'number') return false;
    if (lat < GEO.BOX.minLat || lat > GEO.BOX.maxLat) return false;
    return GEO.BOX.lngRanges.some(function (r) { return lng >= r[0] && lng <= r[1]; });
  }

  /* ---- Safety thresholds -------------------------------------------------
   * The auto-hide circuit breaker. Starting points, expected to be tuned once
   * real usage shows whether they're too twitchy. Enforced server-side in
   * functions/index.js — these copies exist only so the UI can explain itself. */
  var SAFETY = {
    listingHideAt: 3,     /* open reports before a listing drops out of the feed */
    userRestrictAt: 5     /* open reports before a profile can't create anything */
  };

  /* ---- Hot ---------------------------------------------------------------
   * Requests-weighted hard, with Hacker-News-style gravity decay. A listing
   * with 2 real requests should outrank one with 100 idle views, and both
   * should fade as they age.
   *
   *   hotScore = (views + requests * REQUEST_WEIGHT) / (ageHours + 2) ^ GRAVITY
   *
   * Recomputed hourly by a scheduled function, never per-read. Mirrored in
   * functions/index.js — change both or the displayed score drifts from the
   * sorted one. */
  var HOT = {
    requestWeight: 20,
    viewWeight: 1,
    gravity: 1.5
  };

  /* ---- Hold & queue (M5) -------------------------------------------------
   * The first person to request a game entry becomes the holder; everyone
   * after joins the queue in order rather than being turned away.
   *
   * These durations are display copies. The clock that actually decides is in
   * functions/index.js (HOLD_HOURS / GRACE_HOURS) — the client cannot be
   * trusted with expiry, since a browser that never calls home would hold an
   * item forever. Change both together or the countdown lies.
   *
   * Both numbers are starting points, expected to be tuned once real usage
   * shows whether 24h reads as generous or stingy. */
  var QUEUE = {
    holdHours: 24,
    graceHours: 12,
    /* The statuses that occupy a place in the queue. Anything else has left
     * it. Mirrors OPEN_STATUSES in functions/index.js. */
    openStatuses: ['queued', 'onHold', 'proposedTime', 'scheduled']
  };

  function isOpenRequest(status) {
    return QUEUE.openStatuses.indexOf(status) !== -1;
  }

  /* ---- Verification fee (M8) ---------------------------------------------
   * The fee does NOT gate the sale. The app has no visibility into cash
   * changing hands outside it, so gating on the sale would be unenforceable
   * theatre. It gates a status the app fully controls: whether a profile shows
   * "Verified".
   *
   * This is a seller-to-platform charge. The actual game sale is never touched
   * by the app, never routed through Stripe, never processed here.
   *
   * Display copy only. The amount that is actually charged lives in
   * functions/index.js, because a client-supplied price is a client-chosen
   * price. */
  var FEE = {
    label: '$0.25',
    cents: 25,
    /* Mirrors config/global.feeWaiverEndDate, which is the value that actually
     * decides. Used here only to explain the waiver in the UI; a stale copy
     * changes what people are told, never what they are charged. */
    waiverEndsLabel: 'December 31, 2026'
  };

  /* ---- Distance ----------------------------------------------------------
   * Radius options for the "near me" filter, in miles. */
  var RADII = [5, 10, 25, 50, 100];
  var DEFAULT_RADIUS = 25;

  /* ---- Feed --------------------------------------------------------------- */
  var PAGE_SIZE = 24;

  var SORTS = [
    { key: 'new',  label: 'New',       field: 'createdAt',     dir: 'desc' },
    { key: 'hot',  label: 'Hot',       field: 'hotScore',      dir: 'desc' },
    { key: 'deal', label: 'Good Deal', field: 'bestDealScore', dir: 'desc' }
  ];

  /* ---- Photos -------------------------------------------------------------
   * Phone cameras produce 4-6MB images. Everything is downscaled and re-encoded
   * client-side before it ever reaches Storage — a listing with 8 photos would
   * otherwise cost a buyer 40MB of feed scrolling. */
  var PHOTO = {
    maxEdge: 1400,        /* px, longest side after downscale */
    quality: 0.82,        /* JPEG quality */
    maxPerEntry: 6
  };

  /* ---- Search -------------------------------------------------------------
   * Firestore has no full-text search. We fake prefix search by storing every
   * prefix of every token on the listing (see Store.buildSearchTokens), which
   * makes `array-contains` behave like "starts with". These caps keep the
   * index from exploding on a 10-game bundle. */
  var SEARCH = {
    minPrefix: 2,
    maxPrefix: 12,
    maxTokens: 300
  };

  /* Categories/mechanics unioned onto a listing from all its game entries.
   * Capped so a big bundle can't blow past Firestore's index limits. */
  var MAX_ROLLUP_TERMS = 50;

  return {
    BUILD: BUILD,
    CONDITIONS: CONDITIONS,
    TAGS: TAGS,
    BGG_CATEGORIES: BGG_CATEGORIES,
    FULFILLMENT: FULFILLMENT,
    GEO: GEO,
    inUsBox: inUsBox,
    QUEUE: QUEUE,
    FEE: FEE,
    isOpenRequest: isOpenRequest,
    REPORT_REASONS: REPORT_REASONS,
    SAFETY: SAFETY,
    HOT: HOT,
    RADII: RADII,
    DEFAULT_RADIUS: DEFAULT_RADIUS,
    PAGE_SIZE: PAGE_SIZE,
    SORTS: SORTS,
    PHOTO: PHOTO,
    SEARCH: SEARCH,
    MAX_ROLLUP_TERMS: MAX_ROLLUP_TERMS,

    /* Lookup helpers so views never carry their own copy of the tables. */
    condition: function (key) {
      for (var i = 0; i < CONDITIONS.length; i++) {
        if (CONDITIONS[i].key === key) return CONDITIONS[i];
      }
      return { key: key, label: key, blurb: '' };
    },
    reasons: function (targetType) {
      return REPORT_REASONS[targetType] || REPORT_REASONS.listing;
    }
  };
})();
