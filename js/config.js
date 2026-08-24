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

  var BUILD = '20260824a';

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
  /* How tabletop players actually describe games: the popular MECHANICS
   * (Worker Placement, Tile Placement, Deck Building...) alongside the themes.
   * BGG's own list is themes only, which is why a hand-entered game used to
   * offer no "Worker Placement" or "Tile Placement" at all. This one list drives
   * both the create-form picker and the feed's category filter, so the two can
   * never drift. Kept alphabetical for a scannable dropdown. */
  var CATEGORIES = [
    'Abstract', 'Adventure', 'Ancient', 'Animals', 'Area Control',
    'Auction / Bidding', 'Bluffing', 'Campaign / Legacy', 'Card Drafting',
    'Card Game', 'Children\'s', 'City Building', 'Civilization', 'Cooperative',
    'Deck Building', 'Deduction', 'Dexterity', 'Dice Rolling', 'Economic',
    'Educational', 'Engine Building', 'Exploration', 'Family', 'Fantasy',
    'Fighting', 'Hand Management', 'Historical', 'Horror', 'Humor', 'Medieval',
    'Modular Board', 'Mystery', 'Mythology', 'Nautical', 'Negotiation', 'Party',
    'Pattern Building', 'Pirates', 'Political', 'Push Your Luck', 'Puzzle',
    'Racing', 'Roll & Write', 'Route Building', 'Science Fiction',
    'Set Collection', 'Social Deduction', 'Solo', 'Space', 'Sports', 'Strategy',
    'Tableau Building', 'Tile Placement', 'Trains', 'Trick-Taking', 'Two-Player',
    'Variable Player Powers', 'Wargame', 'Word Game', 'Worker Placement', 'Zombies'
  ];

  /* Maps the messy vocabularies of BGG and Wikidata onto CATEGORIES above.
   * Ordered: the FIRST substring a raw label contains wins, so more-specific
   * terms are listed before the general ones they contain -- 'abstract strategy'
   * must resolve to Abstract before 'strategy' could claim it, and 'card
   * drafting' to Card Drafting before plain 'card'. Anything that matches
   * nothing is dropped rather than shown as a bogus category. */
  var CATEGORY_SYNONYMS = [
    ['worker placement', 'Worker Placement'],
    ['abstract', 'Abstract'],
    ['social deduction', 'Social Deduction'],
    ['hidden role', 'Social Deduction'],
    ['hidden traitor', 'Social Deduction'],
    ['deck-build', 'Deck Building'], ['deck build', 'Deck Building'],
    ['deckbuild', 'Deck Building'], ['deck construction', 'Deck Building'],
    ['engine build', 'Engine Building'],
    ['tableau', 'Tableau Building'],
    ['card draft', 'Card Drafting'], ['drafting', 'Card Drafting'],
    ['tile', 'Tile Placement'],
    ['set collection', 'Set Collection'],
    ['area control', 'Area Control'], ['area majority', 'Area Control'],
    ['area influence', 'Area Control'], ['area enclosure', 'Area Control'],
    ['hand management', 'Hand Management'],
    ['push your luck', 'Push Your Luck'], ['push-your-luck', 'Push Your Luck'],
    ['roll-and-write', 'Roll & Write'], ['roll and write', 'Roll & Write'],
    ['roll & write', 'Roll & Write'], ['flip and write', 'Roll & Write'],
    ['trick-taking', 'Trick-Taking'], ['trick taking', 'Trick-Taking'],
    ['pattern building', 'Pattern Building'], ['pattern recognition', 'Pattern Building'],
    ['variable player power', 'Variable Player Powers'],
    ['modular board', 'Modular Board'],
    ['auction', 'Auction / Bidding'], ['bidding', 'Auction / Bidding'],
    ['dexterity', 'Dexterity'], ['flick', 'Dexterity'],
    ['deduction', 'Deduction'],
    ['negotiation', 'Negotiation'], ['trading', 'Economic'],
    ['route', 'Route Building'], ['network build', 'Route Building'],
    ['pick-up and deliver', 'Route Building'], ['pickup and deliver', 'Route Building'],
    ['co-op', 'Cooperative'], ['cooperative', 'Cooperative'], ['co-operative', 'Cooperative'],
    ['legacy', 'Campaign / Legacy'], ['campaign', 'Campaign / Legacy'],
    ['dice', 'Dice Rolling'],
    ['bluff', 'Bluffing'],
    ['adventure', 'Adventure'],
    ['ancient', 'Ancient'],
    ['animal', 'Animals'], ['nature', 'Animals'], ['wildlife', 'Animals'],
    ['children', "Children's"], ['kids', "Children's"], ['family', 'Family'],
    ['city building', 'City Building'], ['city-building', 'City Building'],
    ['civilization', 'Civilization'], ['civilisation', 'Civilization'],
    ['economic', 'Economic'], ['economy', 'Economic'], ['industry', 'Economic'],
    ['manufacturing', 'Economic'], ['farming', 'Economic'], ['financial', 'Economic'],
    ['educational', 'Educational'],
    ['exploration', 'Exploration'],
    ['fantasy', 'Fantasy'],
    ['fighting', 'Fighting'], ['combat', 'Fighting'], ['wrestling', 'Fighting'],
    ['horror', 'Horror'],
    ['humor', 'Humor'], ['humour', 'Humor'], ['comedy', 'Humor'],
    ['medieval', 'Medieval'],
    ['murder', 'Mystery'], ['mystery', 'Mystery'], ['detective', 'Mystery'],
    ['mytholog', 'Mythology'],
    ['nautical', 'Nautical'], ['naval', 'Nautical'], ['sailing', 'Nautical'],
    ['pirate', 'Pirates'],
    ['party', 'Party'],
    ['political', 'Political'], ['politics', 'Political'],
    ['puzzle', 'Puzzle'],
    ['racing', 'Racing'],
    ['science fiction', 'Science Fiction'], ['sci-fi', 'Science Fiction'],
    ['scifi', 'Science Fiction'], ['science-fiction', 'Science Fiction'],
    ['space', 'Space'],
    ['sports', 'Sports'],
    ['trains', 'Trains'], ['railway', 'Trains'], ['railroad', 'Trains'],
    ['wargame', 'Wargame'], ['war game', 'Wargame'], ['miniatures wargame', 'Wargame'],
    ['word', 'Word Game'],
    ['zombie', 'Zombies'],
    ['two-player', 'Two-Player'], ['2-player', 'Two-Player'], ['two player', 'Two-Player'],
    ['solitaire', 'Solo'], ['solo', 'Solo'],
    ['card game', 'Card Game'],
    ['eurogame', 'Strategy'], ['strateg', 'Strategy']
  ];

  /* Fold a list of raw genre/category/mechanic labels (from BGG or Wikidata)
   * down to the CATEGORIES vocabulary. Unknown labels are dropped, not kept:
   * a bogus 'Tile-Based Video Game' category is worse than none, because it
   * never matches a filter and just looks wrong. Order is preserved, dupes
   * removed. A label already in the taxonomy passes straight through. */
  var CATEGORY_SET = {};
  CATEGORIES.forEach(function (c) { CATEGORY_SET[c.toLowerCase()] = c; });

  function normalizeCategories(list) {
    var out = [], seen = {};
    (list || []).forEach(function (raw) {
      var low = String(raw || '').toLowerCase().trim();
      if (!low) return;
      var hit = CATEGORY_SET[low] || null;
      if (!hit) {
        for (var i = 0; i < CATEGORY_SYNONYMS.length; i++) {
          if (low.indexOf(CATEGORY_SYNONYMS[i][0]) !== -1) { hit = CATEGORY_SYNONYMS[i][1]; break; }
        }
      }
      if (hit && !seen[hit]) { seen[hit] = 1; out.push(hit); }
    });
    return out;
  }

  /* ---- Fulfillment -------------------------------------------------------- */
  /* Pickup-only. Tabled is local, in-person trading — there is no shipping
   * path anywhere in the app, so a listing is met in person or handed over at
   * an event, full stop. */
  var FULFILLMENT = [
    { key: 'pickup', label: 'Local pickup' },
    { key: 'inPersonAtEvent', label: 'In person at an event' }
  ];

  /* ---- Seller promotion --------------------------------------------------
   * A seller-declared "buy N, get $X off" deal. It is DISPLAYED, never applied:
   * Tabled processes no payment, so the price and this discount alike are just
   * signals the two people honor when they settle up in person. These bounds
   * are echoed in firestore.rules (promoOk) so a modified client can't post an
   * absurd banner. */
  var PROMO = { minQty: 2, maxQty: 20, maxDollarsOff: 500 };

  /* ---- Game data source --------------------------------------------------
   * 'bggapi' = the live BoardGameGeek XML API (approved token, via the
   * searchGames/getGameDetails functions) -- the definitive source, with box
   * art and marketplace pricing. `?source=bgg` falls back to the bundled static
   * catalogue and `?source=wikidata` to Wikidata; both are handy in demo mode,
   * which has no Cloud Functions to reach the live API. */
  var GAME_SOURCE = 'bggapi';

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

  /* ---- Events (M9) -------------------------------------------------------
   * Convention selling. The direct replacement for hunting through a BGG forum
   * thread the week before a con.
   *
   * Hold timing compresses hard once an event is live: a flat 24h window is
   * wrong in both directions for a convention. Too short before it starts (a
   * listing made in October for a November con would expire its holder for not
   * proposing a time at an event that doesn't exist yet); far too long once it
   * is running (a con lasts three days, so a 24h hold takes the item off the
   * market for a third of it).
   *
   * Display copies. functions/index.js holds the values that actually decide. */
  var EVENT = {
    holdHours: 3,
    graceHours: 1,
    /* How far ahead an event may be created. Long enough for next year's con,
     * short enough that a typo of 2262 is caught. */
    maxMonthsAhead: 24,
    maxDays: 14
  };

  /* ---- Accepted payment (M10) --------------------------------------------
   * Purely descriptive metadata. None of these are ever processed by the app —
   * the same boundary as the game sale itself: Tabled displays what a seller is
   * open to, and everything after that happens outside it.
   *
   * Only `trades` has any functional effect, and exactly one: it decides
   * whether the "Propose a trade" button appears on that listing. */
  var PAYMENT = [
    { key: 'cash', label: 'Cash' },
    { key: 'paypal', label: 'PayPal' },
    { key: 'venmo', label: 'Venmo' },
    { key: 'trades', label: 'Trades' }
  ];

  /* ---- Lots (Phase 3) ----------------------------------------------------
   * A lot is several games sold as ONE unit at ONE price — a collector's
   * edition with its expansions, a base game plus everything for it.
   *
   * Modelled as ONE gameEntry with a `contents` array, NOT as several entries.
   * That is the load-bearing decision: every mechanism from M5 onward — hold,
   * queue position, reserved, sold, auto-book, trade offers — operates on a
   * single gameEntry. A lot modelled as one entry inherits all of it correctly,
   * because a lot genuinely IS one item. Modelled as several entries, every one
   * of those mechanisms would need a new "these move together" concept. */
  var LOT_ROLES = [
    { key: 'expansion', label: 'Expansion' },
    { key: 'promo', label: 'Promo / mini-expansion' },
    { key: 'accessory', label: 'Accessory / insert' },
    { key: 'other', label: 'Something else' }
  ];
  var MAX_LOT_CONTENTS = 12;

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
    PROMO: PROMO,
    GAME_SOURCE: GAME_SOURCE,
    CONDITIONS: CONDITIONS,
    TAGS: TAGS,
    CATEGORIES: CATEGORIES,
    normalizeCategories: normalizeCategories,
    FULFILLMENT: FULFILLMENT,
    GEO: GEO,
    inUsBox: inUsBox,
    QUEUE: QUEUE,
    EVENT: EVENT,
    PAYMENT: PAYMENT,
    LOT_ROLES: LOT_ROLES,
    MAX_LOT_CONTENTS: MAX_LOT_CONTENTS,
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
