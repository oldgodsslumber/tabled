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
  var detailCache = Object.create(null);
  var searchCache = Object.create(null);

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

  function available() { return !!call; }

  /* Candidate matches for the create-listing autocomplete. Results are cached
   * by query string for the life of the page — users backspace constantly, and
   * re-asking BGG for a query we already answered is exactly what gets an app
   * rate-limited. */
  function search(q) {
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
        if (err && /resource-exhausted|429/i.test(err.code || err.message || '')) {
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
        U.toast('Could not load that game from BoardGameGeek', 'warn');
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
    search: search,
    details: details,
    DEMO_CATALOG: DEMO_CATALOG
  };
})();
