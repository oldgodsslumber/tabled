/* Tabled — Listing detail.
 *
 * The one place the `gameEntries` subcollection is actually read. Everywhere
 * else works off the denormalized rollup on the listing doc; here we need the
 * real per-game condition, tags, notes and photos, so this view pays for the
 * extra query and nothing else does.
 */
window.ListingView = (function () {

  function render(root, params) {
    var id = params.id;
    root.innerHTML = U.spinner('Loading listing');

    var listing = null, entries = [], games = {};

    Store.getListing(id)
      .then(function (l) {
        if (!l) throw new Error('notfound');
        listing = l;
        /* An auto-hidden listing is still readable by its owner — they should
         * be able to see and fix what got flagged, not just find it gone. */
        if (listing.status !== 'active' && !Store.isMe(listing.sellerId)) {
          throw new Error('notfound');
        }
        return Store.getEntries(id);
      })
      .then(function (es) {
        entries = es;
        return Store.getGames(entries.map(function (e) { return e.bggId; }).filter(Boolean));
      })
      .then(function (g) {
        games = g;
        /* M4 is first-come-first-served: one open request per game entry. The
         * queue that lets a second person wait in line arrives in M5, so until
         * then a taken game has to say so rather than silently opening a second
         * competing thread. One read per entry, and only on the detail view. */
        return Promise.all(entries.map(function (e) {
          return Store.findActiveRequest(e.id).catch(function () { return null; });
        }));
      })
      .then(function (reqs) {
        var claims = {};
        entries.forEach(function (e, i) { if (reqs[i]) claims[e.id] = reqs[i]; });
        draw(root, listing, entries, games, claims);
        /* Owners viewing their own listing shouldn't inflate its Hot score. */
        if (!Store.isMe(listing.sellerId)) Store.bumpView(id);
      })
      .catch(function (err) {
        if (err && err.message === 'notfound') {
          root.innerHTML = U.empty('Listing not found',
            'It may have been sold and archived, or taken down by its seller.') +
            '<div class="center"><a class="btn" href="#/feed">Back to the feed</a></div>';
          return;
        }
        console.error('[tabled] listing load failed', err);
        root.innerHTML = U.empty('Could not load this listing', 'Check your connection and try again.');
      });
  }

  function draw(root, l, entries, games, claims) {
    var mine = Store.isMe(l.sellerId);
    claims = claims || {};
    var ful = [];
    if (l.fulfillment) {
      CFG.FULFILLMENT.forEach(function (f) { if (l.fulfillment[f.key]) ful.push(f.label); });
    }

    root.innerHTML =
      '<div class="detail">' +
        (l.status !== 'active'
          ? '<div class="banner warn">This listing is hidden from the public feed' +
            (l.status === 'hidden' ? ' because it was reported. It stays visible to you.' : '.') + '</div>'
          : '') +

        '<div class="detail-head">' +
          '<div>' +
            '<h1>' + U.esc(l.title || (l.gameNames && l.gameNames[0]) || 'Listing') + '</h1>' +
            '<p class="detail-sub">' +
              U.esc(U.plural(entries.length, 'game')) +
              ' · ' + U.esc(U.ago(l.createdAt)) +
              (l.locationLabel ? ' · ' + U.esc(l.locationLabel) : '') +
            '</p>' +
          '</div>' +
          Safety.menuHtml('listing', l.id, l.title || (l.gameNames && l.gameNames[0]), l.sellerId) +
        '</div>' +

        (ful.length ? '<div class="ful-row">' + ful.map(function (f) {
          return '<span class="badge">' + U.esc(f) + '</span>';
        }).join('') + '</div>' : '') +

        '<div class="entries">' +
          entries.map(function (e) {
            return entryHtml(e, games[String(e.bggId)], mine, claims[e.id]);
          }).join('') +
        '</div>' +

        sellerCard(l) +

        (mine
          ? '<div class="owner-actions">' +
              '<a class="btn ghost" href="#/edit/' + U.attr(l.id) + '">Edit listing</a>' +
              '<button class="btn danger ghost" id="del">Delete listing</button>' +
            '</div>'
          : '') +
      '</div>';

    Safety.wireMenu(root, {
      listingId: l.id,
      listingLabel: l.title || (l.gameNames && l.gameNames[0]),
      sellerId: l.sellerId,
      sellerName: l.sellerName,
      onBlock: function () { App.go('feed', {}); }
    });

    U.on(root, '.shot', function (e, t) { lightbox(t.dataset.full); });

    U.on(root, '[data-request]', function (e, t) {
      var entry = entries.filter(function (x) { return x.id === t.dataset.request; })[0];
      if (entry) startRequest(t, l, entry, games[String(entry.bggId)]);
    });

    var del = U.$('#del', root);
    if (del) del.addEventListener('click', function () {
      /* Hard delete is correct here — an unsold listing has nothing worth
       * preserving. Completed trades are archived instead, but that path
       * arrives with M7. */
      U.confirm('Delete this listing?',
        'This removes it and all its photos from the feed permanently. This cannot be undone.',
        'Delete').then(function (ok) {
        if (!ok) return;
        Store.deleteListing(l.id).then(function () {
          U.toast('Listing deleted');
          App.go('feed', {});
        }).catch(function (err) {
          console.error('[tabled] delete failed', err);
          U.toast('Could not delete that listing', 'bad');
        });
      });
    });
  }

  /* One request button per game, because a request is against a specific game
   * entry — not the bundle. Someone wanting only the Wingspan out of a
   * three-game listing shouldn't have to ask for all three. */
  function requestBlock(e, mine, claim) {
    if (mine) return '';
    if (e.status === 'sold') return '<p class="fine">Already sold.</p>';

    if (claim) {
      var iAmIn = claim.buyerId === Store.uid();
      if (iAmIn) {
        return '<a class="btn ghost small" href="#/thread/' + U.attr(claim.id) + '">' +
          'Open your thread</a>';
      }
      return '<p class="fine">Someone is already talking to the seller about this one. ' +
        'Queueing behind them arrives in a later milestone.</p>';
    }
    return '<button class="btn small" data-request="' + U.attr(e.id) + '">Request this game</button>';
  }

  function entryHtml(e, game, mine, claim) {
    var cond = CFG.condition(e.condition);
    var name = e.name || (game && game.name) || 'Untitled game';
    var year = game && game.yearPublished ? ' <span class="year">(' + game.yearPublished + ')</span>' : '';
    var photos = (e.photos || []).map(U.safeUrl).filter(Boolean);
    var box = U.safeUrl(game && game.imageUrl);

    var deal = '';
    if (game && game.suggestedPrice > 0 && typeof e.askingPrice === 'number' && e.askingPrice < game.suggestedPrice) {
      var pct = Math.round((1 - e.askingPrice / game.suggestedPrice) * 100);
      if (pct >= 5) {
        deal = '<span class="badge deal">' + pct + '% under the ' +
          U.esc(U.money(game.suggestedPrice)) + ' BGG marketplace price</span>';
      }
    }

    return '<article class="entry">' +
      '<div class="entry-head">' +
        (box ? '<img class="boxart" src="' + U.attr(box) + '" alt="" referrerpolicy="no-referrer">' : '') +
        '<div class="entry-title">' +
          '<h2>' + U.esc(name) + year + '</h2>' +
          '<div class="entry-meta">' +
            '<span class="price big">' + (typeof e.askingPrice === 'number' ? U.esc(U.money(e.askingPrice)) : 'Open to offers') + '</span>' +
            '<span class="badge cond" title="' + U.attr(cond.blurb) + '">' +
              U.esc(cond.key) + ' · ' + U.esc(cond.label) + '</span>' +
            (e.status === 'sold' ? '<span class="badge sold">Sold</span>' : '') +
            (e.status === 'onHold' ? '<span class="badge hold">On hold</span>' : '') +
          '</div>' +
          (deal ? '<div class="entry-deal">' + deal + '</div>' : '') +
        '</div>' +
      '</div>' +

      ((e.tags && e.tags.length)
        ? '<div class="chip-row tight">' + e.tags.map(function (t) {
            return '<span class="chip static">' + U.esc(t) + '</span>';
          }).join('') + '</div>'
        : '') +

      (e.notes ? '<p class="entry-notes">' + U.esc(e.notes) + '</p>' : '') +

      (photos.length
        ? '<div class="shots">' + photos.map(function (p) {
            return '<button class="shot" data-full="' + U.attr(p) + '" ' +
              'style="background-image:url(' + U.attr(p) + ')" aria-label="View photo"></button>';
          }).join('') + '</div>'
        : '') +

      ((game && game.categories && game.categories.length)
        ? '<p class="fine">' + U.esc(game.categories.slice(0, 6).join(' · ')) + '</p>'
        : '') +

      '<div class="entry-cta">' + requestBlock(e, mine, claim) + '</div>' +
    '</article>';
  }

  /* Creating a request writes a denormalized snapshot of both people and the
   * game onto the request document. The dashboard lists threads without opening
   * a single listing, profile or gameEntry — and a listing edited or deleted
   * later doesn't retroactively rewrite what the two of you were discussing. */
  function startRequest(btn, listing, entry, game) {
    if (!Store.uid()) { U.toast('Sign in to request', 'warn'); return; }
    if (Store.isBlocked(listing.sellerId)) {
      U.toast('You have blocked this seller — unblock them to request', 'warn');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Requesting…';
    var me = Store.me();

    /* Re-check right before writing. The page may have been open a while, and
     * losing a race here should read as "someone got there first", not as a
     * silent second thread. */
    Store.findActiveRequest(entry.id).then(function (existing) {
      if (existing) {
        if (existing.buyerId === Store.uid()) { App.go('thread', { id: existing.id }); return null; }
        U.toast('Someone just requested this one', 'warn');
        btn.outerHTML = '<p class="fine">Someone is already talking to the seller about this one.</p>';
        return null;
      }

      return Store.createRequest({
        listingId: listing.id,
        gameEntryId: entry.id,
        buyerId: Store.uid(),
        sellerId: listing.sellerId,
        buyerName: me.displayName,
        buyerPhoto: me.photoURL || null,
        sellerName: listing.sellerName || '',
        sellerPhoto: listing.sellerPhoto || null,
        listingTitle: listing.title || '',
        gameName: entry.name || (game && game.name) || 'Game',
        coverPhoto: (entry.photos && entry.photos[0]) || (game && game.imageUrl) || null,
        askingPrice: typeof entry.askingPrice === 'number' ? entry.askingPrice : null
      }).then(function (id) {
        /* Feeds the Hot score. Fire-and-forget — a lost counter increment must
         * never block the request itself. */
        if (Store.bumpRequestCount) Store.bumpRequestCount(listing.id);
        U.toast('Request sent — say hello');
        App.go('thread', { id: id });
      });
    }).catch(function (err) {
      console.error('[tabled] request failed', err);
      /* The rules block a request against someone who has blocked you, and
       * they can't tell you that directly — the error is a generic permission
       * denial, so translate it into something a person can act on. */
      U.toast(/permission/i.test(err && err.message || '')
        ? "You can't request from this seller"
        : 'Could not send that request', 'bad');
      btn.disabled = false;
      btn.textContent = 'Request this game';
    });
  }

  function sellerCard(l) {
    return '<a class="seller-card" href="#/profile/' + U.attr(l.sellerId) + '">' +
      U.avatar({ displayName: l.sellerName, photoURL: l.sellerPhoto }, 'lg') +
      '<div>' +
        '<strong>' + U.esc(l.sellerName || 'Seller') + '</strong>' +
        '<span class="fine">View profile, reviews and other listings</span>' +
      '</div>' +
      '<span class="chev">›</span>' +
    '</a>';
  }

  function lightbox(url) {
    var safe = U.safeUrl(url);
    if (!safe) return;
    var m = U.modal('Photo', '<img class="lightbox" src="' + U.attr(safe) + '" alt="">');
    U.$('.lightbox', m.el).addEventListener('click', m.close);
  }

  return { render: render };
})();
