/* Tabled — BoardGameGeek client (M2).
 *
 * Every call goes through a Cloud Function proxy. This is not a preference:
 * BGG's XML API sends no CORS headers, so a direct fetch() from the browser is
 * blocked before it ever reaches them. The proxy also parses the XML, caches the
 * result into our own `games/{bggId}` collection, and applies the rate-limit
 * courtesy that a browser tab full of keystrokes would not.
 *
 * Two rules the proxy depends on us honoring:
 *   - Search is debounced by the caller (see views-create.js), never per-keystroke.
 *   - Details are fetched once, on selection, and then read from the cache.
 *
 * BGG's published rate limits are vague and their enforcement is not. Treat a
 * 429 as "back off and tell the user", never as "retry immediately".
 */
window.BGG = (function () {

  var call = null;                      /* set by firebase-config.js */

  /* Proof-of-concept data source switch. `?source=wikidata` (or CFG.GAME_SOURCE)
   * routes every game lookup through the fully-open Wikidata module instead of
   * the BGG proxy — no token, no approval, and it works client-side, so the
   * whole flow runs from the demo link with nothing deployed. When BGG's own
   * approval lands, drop the flag and this module goes back to the BGG proxy
   * unchanged. */
  function usingWikidata() {
    if (/[?&]source=wikidata/.test(location.search)) return true;
    return (typeof CFG !== 'undefined' && CFG.GAME_SOURCE === 'wikidata');
  }

  /* The default source: a bundled snapshot of BoardGameGeek's public dataset
   * (~33k games with categories + mechanics, already folded onto our taxonomy).
   * BGG's own API needs an approved token and its site blocks datacenter IPs, so
   * a static catalogue is how real BGG data reaches the app without either. It
   * loads lazily on first search and is a same-origin fetch, so it works in demo
   * mode too. `?source=wikidata` still overrides for comparison. */
  function usingCatalog() {
    if (/[?&]source=(wikidata|bggapi)/.test(location.search)) return false;
    return (typeof CFG !== 'undefined' && CFG.GAME_SOURCE === 'bgg');
  }

  var CATALOG_URL = 'bgg-catalog.json' +
    (typeof CFG !== 'undefined' && CFG.BUILD ? '?v=' + CFG.BUILD : '');
  var catalogPromise = null;   /* the fetch, once */
  var catalogList = null;      /* [{ bggId, name, yearPublished, categories }] */
  var catalogById = null;

  function loadCatalog() {
    if (catalogPromise) return catalogPromise;
    catalogPromise = fetch(CATALOG_URL).then(function (r) {
      if (!r.ok) throw new Error('catalog ' + r.status);
      return r.json();
    }).then(function (rows) {
      catalogById = Object.create(null);
      catalogList = rows.map(function (r) {
        /* Compact row shape: [id, name, year, [categories]]. */
        var g = { bggId: String(r[0]), name: r[1], yearPublished: r[2] || null, categories: r[3] || [] };
        catalogById[g.bggId] = g;
        return g;
      });
      return catalogList;
    }).catch(function (err) {
      console.warn('[tabled] BGG catalog load failed', err);
      U.toast('Could not load the game catalogue — you can still enter games by hand', 'warn');
      catalogPromise = null;   /* let a later keystroke retry */
      return [];
    });
    return catalogPromise;
  }

  function catalogSearch(q) {
    var needle = String(q || '').trim().toLowerCase();
    if (needle.length < 2) return Promise.resolve([]);
    return loadCatalog().then(function (list) {
      var hits = [];
      for (var i = 0; i < list.length && hits.length < 60; i++) {
        if (list[i].name.toLowerCase().indexOf(needle) !== -1) hits.push(list[i]);
      }
      /* Exact, then prefix, then contains — and the list is already sorted by
       * popularity, so ties resolve toward the games people actually mean. */
      hits.sort(function (a, b) {
        var an = a.name.toLowerCase(), bn = b.name.toLowerCase();
        var ap = an === needle ? 0 : (an.indexOf(needle) === 0 ? 1 : 2);
        var bp = bn === needle ? 0 : (bn.indexOf(needle) === 0 ? 1 : 2);
        return ap - bp;
      });
      return hits.slice(0, 12).map(function (g) {
        return { bggId: g.bggId, name: g.name, yearPublished: g.yearPublished };
      });
    });
  }

  function catalogDetails(id) {
    var key = String(id);
    return loadCatalog().then(function () {
      var g = catalogById && catalogById[key];
      if (!g) return null;
      return {
        id: g.bggId, name: g.name, yearPublished: g.yearPublished,
        imageUrl: null,               /* the dataset carries no box art */
        categories: g.categories || [],
        mechanics: [],                /* folded into categories already */
        suggestedPrice: null,         /* no marketplace pricing in the snapshot */
        source: 'bgg',
        lastSyncedAt: Date.now()
      };
    });
  }

  var detailCache = Object.create(null);
  var searchCache = Object.create(null);

  /* Set once the server tells us BGG is not usable — no approved token, or a
   * revoked one. That is a configuration state, not a blip, so retrying every
   * keystroke would just be noise. Latching it lets the create form commit to
   * the manual path and say so plainly instead of flickering between the two. */
  var unusable = false;
  var unusableReason = '';

  function markUnusable(reason) {
    unusable = true;
    unusableReason = reason ||
      'BoardGameGeek search is unavailable, so games are entered by hand.';
  }

  /* A small offline catalog so the listing form's autocomplete is usable in
   * demo mode. Deliberately tiny — it is a demo affordance, not a fallback data
   * source, and it never runs once a real project is configured. */
  var DEMO_CATALOG = [
    { bggId: '174430', name: 'Gloomhaven', yearPublished: 2017, categories: ['Adventure', 'Exploration', 'Fantasy', 'Fighting'], mechanics: ['Cooperative Game', 'Hand Management', 'Modular Board'], suggestedPrice: 120 },
    { bggId: '167791', name: 'Terraforming Mars', yearPublished: 2016, categories: ['Economic', 'Environmental', 'Science Fiction'], mechanics: ['Card Drafting', 'Hand Management', 'Tile Placement'], suggestedPrice: 62 },
    { bggId: '224517', name: 'Brass: Birmingham', yearPublished: 2018, categories: ['Economic', 'Industry / Manufacturing'], mechanics: ['Hand Management', 'Network Building'], suggestedPrice: 68 },
    { bggId: '266192', name: 'Wingspan', yearPublished: 2019, categories: ['Animals', 'Card Game', 'Educational'], mechanics: ['Dice Rolling', 'Engine Building', 'Set Collection'], suggestedPrice: 45 },
    { bggId: '295947', name: 'Cascadia', yearPublished: 2021, categories: ['Animals', 'Environmental', 'Puzzle'], mechanics: ['Pattern Building', 'Tile Placement'], suggestedPrice: 30 },
    { bggId: '13',     name: 'CATAN', yearPublished: 1995, categories: ['Economic', 'Negotiation'], mechanics: ['Dice Rolling', 'Trading'], suggestedPrice: 35 },
    { bggId: '30549',  name: 'Pandemic', yearPublished: 2008, categories: ['Medical'], mechanics: ['Cooperative Game', 'Hand Management', 'Set Collection'], suggestedPrice: 28 },
    { bggId: '822',    name: 'Carcassonne', yearPublished: 2000, categories: ['City Building', 'Medieval'], mechanics: ['Area Majority', 'Tile Placement'], suggestedPrice: 25 },
    { bggId: '68448',  name: '7 Wonders', yearPublished: 2010, categories: ['Ancient', 'Card Game', 'City Building'], mechanics: ['Card Drafting', 'Set Collection'], suggestedPrice: 34 },
    { bggId: '161936', name: 'Pandemic Legacy: Season 1', yearPublished: 2015, categories: ['Environmental', 'Medical'], mechanics: ['Cooperative Game', 'Legacy Game'], suggestedPrice: 55 },
    { bggId: '182028', name: 'Through the Ages: A New Story of Civilization', yearPublished: 2015, categories: ['Card Game', 'Civilization', 'Economic'], mechanics: ['Card Drafting', 'Worker Placement'], suggestedPrice: 50 },
    { bggId: '31260',  name: 'Agricola', yearPublished: 2007, categories: ['Animals', 'Economic', 'Farming'], mechanics: ['Hand Management', 'Worker Placement'], suggestedPrice: 40 },
    { bggId: '120677', name: 'Terra Mystica', yearPublished: 2012, categories: ['Civilization', 'Economic', 'Fantasy'], mechanics: ['Area Majority', 'Network Building'], suggestedPrice: 55 },
    { bggId: '233078', name: 'Twilight Imperium: Fourth Edition', yearPublished: 2017, categories: ['Civilization', 'Negotiation', 'Science Fiction'], mechanics: ['Area Majority', 'Variable Player Powers'], suggestedPrice: 110 },
    { bggId: '291457', name: 'Gloomhaven: Jaws of the Lion', yearPublished: 2020, categories: ['Adventure', 'Fantasy', 'Fighting'], mechanics: ['Cooperative Game', 'Hand Management'], suggestedPrice: 40 },
    { bggId: '316554', name: 'Dune: Imperium', yearPublished: 2020, categories: ['Movies / TV / Radio', 'Science Fiction'], mechanics: ['Deck Building', 'Worker Placement'], suggestedPrice: 48 },
    { bggId: '246900', name: 'Eclipse: Second Dawn for the Galaxy', yearPublished: 2020, categories: ['Civilization', 'Science Fiction'], mechanics: ['Area Majority', 'Tech Trees'], suggestedPrice: 90 },
    { bggId: '284083', name: 'The Crew: The Quest for Planet Nine', yearPublished: 2019, categories: ['Card Game', 'Science Fiction'], mechanics: ['Cooperative Game', 'Trick-taking'], suggestedPrice: 12 },
    { bggId: '244521', name: 'The Quacks of Quedlinburg', yearPublished: 2018, categories: ['Fantasy', 'Medieval'], mechanics: ['Push Your Luck', 'Set Collection'], suggestedPrice: 30 },
    { bggId: '199792', name: 'Everdell', yearPublished: 2018, categories: ['Animals', 'Card Game', 'City Building'], mechanics: ['Hand Management', 'Worker Placement'], suggestedPrice: 52 }
  ];

  function demoSearch(q) {
    var needle = String(q || '').toLowerCase();
    return DEMO_CATALOG.filter(function (g) {
      return g.name.toLowerCase().indexOf(needle) !== -1;
    }).slice(0, 10);
  }

  /* ---- Public ------------------------------------------------------------ */

  function attach(callableRunner) { call = callableRunner; }

  /* Whether a game SEARCH can be offered at all — not whether the real BGG is
   * reachable. Demo mode has no callable but does have the offline catalog
   * below, so search still works there; only a latched unusable state (no
   * approved token, or a revoked one) takes the search box away. */
  function available() { return (usingWikidata() || usingCatalog()) ? true : !unusable; }
  function reason() { return unusableReason; }

  /* Candidate matches for the create-listing autocomplete. Results are cached
   * by query string for the life of the page — users backspace constantly, and
   * re-asking BGG for a query we already answered is exactly what gets an app
   * rate-limited. */
  function search(q) {
    if (usingWikidata()) return Wikidata.search(q);
    if (usingCatalog()) return catalogSearch(q);
    var key = String(q || '').trim().toLowerCase();
    if (key.length < 2) return Promise.resolve([]);
    if (searchCache[key]) return Promise.resolve(searchCache[key]);

    if (!call) {
      var demo = demoSearch(key);
      searchCache[key] = demo;
      return Promise.resolve(demo);
    }

    return call('searchGames', { query: key })
      .then(function (res) {
        var rows = (res && res.results) || [];
        searchCache[key] = rows;
        return rows;
      })
      .catch(function (err) {
        console.warn('[tabled] BGG search failed', err);
        var code = (err && err.code) || '';
        var msg = (err && err.message) || '';

        if (/failed-precondition/.test(code)) {
          /* Not a transient failure. Latch it and let the form switch to
           * manual entry for good rather than offering a retry that cannot
           * succeed. */
          markUnusable(msg);
          U.toast('BoardGameGeek search is unavailable — enter games by hand', 'warn');
        } else if (/resource-exhausted|429/i.test(code + ' ' + msg)) {
          U.toast('BoardGameGeek is rate-limiting us — try again in a moment', 'warn');
        } else {
          U.toast('Could not reach BoardGameGeek — you can still enter the game manually', 'warn');
        }
        return [];
      });
  }

  /* Full details for one game. The function writes `games/{bggId}` as a side
   * effect, which is what makes categories and mechanics available to the feed
   * filters without any further BGG traffic. */
  function details(bggId) {
    if (usingWikidata()) return Wikidata.details(bggId);
    if (usingCatalog()) return catalogDetails(bggId);
    var id = String(bggId);
    if (detailCache[id]) return Promise.resolve(detailCache[id]);

    if (!call) {
      var hit = DEMO_CATALOG.filter(function (g) { return g.bggId === id; })[0];
      var demo = hit ? Object.assign({ id: id, imageUrl: null }, hit) : null;
      if (demo) detailCache[id] = demo;
      return Promise.resolve(demo);
    }

    /* Read the cache first — most games are listed by more than one person, and
     * a cache hit costs one document read instead of a round trip to BGG. */
    return Store.getGame(id)
      .then(function (cached) {
        if (cached && fresh(cached)) return cached;
        return call('getGameDetails', { bggId: id }).then(function (res) {
          return (res && res.game) || cached || null;
        });
      })
      .then(function (game) {
        if (game) detailCache[id] = game;
        return game;
      })
      .catch(function (err) {
        console.warn('[tabled] BGG details failed', err);
        if (/failed-precondition/.test((err && err.code) || '')) {
          markUnusable((err && err.message) || '');
        } else {
          U.toast('Could not load that game from BoardGameGeek', 'warn');
        }
        return null;
      });
  }

  /* 30 days. Categories and mechanics essentially never change; the suggested
   * price does drift, which is the only reason this refreshes at all. */
  function fresh(game) {
    var t = U.toDate(game.lastSyncedAt);
    if (!t) return false;
    return (Date.now() - t.getTime()) < 30 * 86400000;
  }

  return {
    attach: attach,
    available: available,
    usingWikidata: usingWikidata,
    usingCatalog: usingCatalog,
    reason: reason,
    markUnusable: markUnusable,
    search: search,
    details: details,
    DEMO_CATALOG: DEMO_CATALOG
  };
})();
