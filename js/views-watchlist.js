/* Tabled — Watchlist. The listings you're watching, loaded fresh so price and
 * status (a "Sold" badge, or gone entirely) are always current rather than a
 * stale snapshot. Your watch ids live in Store.watchSet; the listings are read
 * one by one and anything unreadable (deleted, or pulled from the feed) is
 * simply dropped. */
window.WatchlistView = (function () {

  function render(root) {
    var ids = Store.watchlistIds();
    root.innerHTML =
      '<div class="feed-head"><h1>Watchlist</h1></div>' +
      '<div class="grid" id="wl-grid">' +
        (ids.length ? U.spinner('') : emptyHtml()) +
      '</div>';

    if (!ids.length) return;

    /* Load each watched listing fresh. Order preserved as returned; missing
     * ones fall out. */
    Promise.all(ids.map(function (id) {
      return Store.getListing(id).catch(function () { return null; });
    })).then(function (listings) {
      var host = U.$('#wl-grid', root);
      if (!host) return;
      var live = listings.filter(Boolean);
      host.innerHTML = live.length
        ? live.map(function (l) { return Feed.card(l); }).join('')
        : emptyHtml();
    }).catch(function (err) {
      console.error('[tabled] watchlist load failed', err);
      var host = U.$('#wl-grid', root);
      if (host) host.innerHTML = U.empty('Could not load your watchlist', '');
    });
  }

  function emptyHtml() {
    return U.empty('Nothing watched yet',
      'Tap ☆ Watch on any listing to save it here and keep an eye on it.');
  }

  return { render: render };
})();
