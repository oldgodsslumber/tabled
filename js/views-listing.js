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
        /* Contents count too. Fetching only the headline ids left a lot's
         * bundled games with no cached record, so the deal badge silently
         * priced the base game alone while the feed card (built from the
         * rollup, which does sum the lot) quoted the full total. */
        var ids = [];
        entries.forEach(function (e) {
          if (e.bggId) ids.push(e.bggId);
          (e.contents || []).forEach(function (c) { if (c.bggId) ids.push(c.bggId); });
        });
        return Store.getGames(ids);
      })
      .then(function (g) {
        games = g;
        /* M5: no per-entry query needed. The waiting count lives on the entry
         * itself (`queueCount`, kept in sync server-side), and whether *I*
         * already have a request is answered from the live myRequests
         * subscription that's already streaming. */
        draw(root, listing, entries, games);
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

  function draw(root, l, entries, games) {
    var mine = Store.isMe(l.sellerId);
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
              U.esc(gameCountLabel(entries)) +
              ' · ' + U.esc(U.ago(l.createdAt)) +
              (l.locationLabel ? ' · ' + U.esc(l.locationLabel) : '') +
            '</p>' +
          '</div>' +
          Safety.menuHtml('listing', l.id, l.title || (l.gameNames && l.gameNames[0]), l.sellerId) +
        '</div>' +

        (ful.length ? '<div class="ful-row">' + ful.map(function (f) {
          return '<span class="badge">' + U.esc(f) + '</span>';
        }).join('') + '</div>' : '') +

        (paymentRow(l)) +

        (l.eventId
          ? '<a class="event-link" href="#/feed?eventId=' + U.attr(l.eventId) + '">' +
              '<span class="grow">Selling at <strong>' +
                U.esc(l.eventName || 'an event') + '</strong></span>' +
              '<span class="chev">\u203a</span>' +
            '</a>'
          : '') +

        '<div class="entries">' +
          entries.map(function (e) {
            return entryHtml(e, games[String(e.bggId)], mine, l, games);
          }).join('') +
        '</div>' +

        dataAttribution(games) +

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
      if (entry) startRequest(t, l, entry);
    });

    U.on(root, '[data-trade]', function (e, t) {
      var entry = entries.filter(function (x) { return x.id === t.dataset.trade; })[0];
      if (entry) tradeDialog(l, entry);
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

  /* "1 game" reads wrong on a listing holding a three-game lot. Count what is
   * actually in the boxes, and say how many boxes when they differ. */
  function gameCountLabel(entries) {
    var total = entries.reduce(function (n, e) {
      return n + 1 + ((e.contents || []).length);
    }, 0);
    if (total === entries.length) return U.plural(total, 'game');
    return U.plural(total, 'game') + ' in ' + U.plural(entries.length, 'lot');
  }

  /* Attribution keyed to where the game data actually came from. Wikidata and
   * BGG each require crediting them, and crediting the wrong one is both a
   * licence problem and simply false. */
  function dataAttribution(games) {
    var keys = Object.keys(games || {});
    if (!keys.length) return '';
    var anyWikidata = keys.some(function (k) { return games[k] && games[k].source === 'wikidata'; });
    if (anyWikidata) {
      return '<p class="bgg-attrib"><a href="https://www.wikidata.org" target="_blank" ' +
        'rel="noopener noreferrer">Game data from Wikidata (CC0)</a></p>';
    }
    return '<p class="bgg-attrib">' + U.bggBadge() + '</p>';
  }

  /* What this seller will take. Purely informational except for Trades, which
   * is what gates the proposal button below. */
  function paymentRow(l) {
    var accepted = CFG.PAYMENT.filter(function (pm) {
      return l.acceptedPayment && l.acceptedPayment[pm.key];
    });
    if (!accepted.length) return '';
    return '<div class="ful-row pay-row">' +
      '<span class="fine">Takes:</span>' +
      accepted.map(function (pm) {
        return '<span class="badge' + (pm.key === 'trades' ? ' deal' : '') + '">' +
          U.esc(pm.label) + '</span>';
      }).join('') +
    '</div>';
  }

  function takesTrades(l) {
    return !!(l.acceptedPayment && l.acceptedPayment.trades);
  }

  /* One request button per game, because a request is against a specific game
   * entry — not the bundle. Someone wanting only the Wingspan out of a
   * three-game listing shouldn't have to ask for all three.
   *
   * M5: a claimed game no longer turns people away. They join the queue, and
   * the wait is stated plainly up front — "you'd be 3rd" is information someone
   * can act on, where a disabled button is just a dead end. */
  function requestBlock(e, mine, tradesOn) {
    if (mine) {
      return e.queueCount
        ? '<p class="fine">' + U.esc(U.plural(e.queueCount, 'person', 'people')) +
          ' waiting on this one.</p>'
        : '';
    }
    if (e.status === 'sold') return '<p class="fine">Already sold.</p>';

    var myReq = Store.myRequestFor(e.id);
    if (myReq) {
      return '<a class="btn ghost small" href="#/thread/' + U.attr(myReq.id) + '">' +
          'Open your thread</a>' +
        '<p class="fine">' + U.esc(positionLabel(myReq)) + '</p>';
    }

    var waiting = e.queueCount || 0;
    var tradeBtn = tradesOn
      ? '<button class="btn ghost small" data-trade="' + U.attr(e.id) + '">Propose a trade</button>'
      : '';

    if (!waiting) {
      return '<button class="btn small" data-request="' + U.attr(e.id) + '">Request this game</button>' +
        tradeBtn;
    }
    return '<button class="btn ghost small" data-request="' + U.attr(e.id) + '">' +
        'Join the queue</button>' + tradeBtn +
      '<p class="fine">' + U.esc(U.plural(waiting, 'person', 'people')) + ' ahead of you. ' +
        'If they don\'t follow through within ' + CFG.QUEUE.holdHours + ' hours, it passes to the next in line.</p>';
  }

  /* Position 0 is "it's your turn" — never "you are number zero". */
  function positionLabel(r) {
    if (r.queuePosition === 0) {
      return r.status === 'scheduled'
        ? "You're scheduled with the seller."
        : "It's your turn — message the seller or propose a time.";
    }
    return 'You\'re #' + (r.queuePosition + 1) + ' in line.';
  }

  function entryHtml(e, game, mine, listingRef, games) {
    var cond = CFG.condition(e.condition);
    var name = e.name || (game && game.name) || 'Untitled game';
    var year = game && game.yearPublished ? ' <span class="year">(' + game.yearPublished + ')</span>' : '';
    var photos = (e.photos || []).map(U.safeUrl).filter(Boolean);
    var box = U.safeUrl(game && game.imageUrl);

    /* For a lot this has to total EVERYTHING in the box, not just the headline
     * game — otherwise this badge and the feed card's badge (which comes from
     * the rollup, and does sum the lot) quote different numbers for the same
     * listing. Two places disagreeing about one figure is worse than neither
     * showing it. */
    var lotTotal = game && typeof game.suggestedPrice === 'number' ? game.suggestedPrice : 0;
    var pricedContents = 0;
    (e.contents || []).forEach(function (c) {
      var cg = c.bggId ? games[String(c.bggId)] : null;
      if (cg && typeof cg.suggestedPrice === 'number') {
        lotTotal += cg.suggestedPrice;
        pricedContents++;
      }
    });

    var deal = '';
    if (lotTotal > 0 && typeof e.askingPrice === 'number' && e.askingPrice < lotTotal) {
      var pct = Math.round((1 - e.askingPrice / lotTotal) * 100);
      if (pct >= 5) {
        var isLot = (e.contents || []).length > 0;
        deal = '<span class="badge deal">' + pct + '% under the ' +
          U.esc(U.money(lotTotal)) + ' BGG marketplace ' +
          (isLot ? 'value of the lot' : 'price') + '</span>';
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

      /* BGG's categories and mechanics shown VERBATIM, exactly as the API
       * returns them. BGG's terms forbid modifying their data, so this displays
       * their vocabulary unchanged and credited (the "Powered by BGG" badge sits
       * below); our own taxonomy is used only to power the feed's filters, never
       * presented here as BGG's classification. */
      (game && ((game.categories && game.categories.length) || (game.mechanics && game.mechanics.length))
        ? '<div class="bgg-info">' +
            (game.categories && game.categories.length
              ? '<p class="fine"><strong>Categories:</strong> ' +
                game.categories.map(function (c) { return U.esc(c); }).join(', ') + '</p>'
              : '') +
            (game.mechanics && game.mechanics.length
              ? '<p class="fine"><strong>Mechanics:</strong> ' +
                game.mechanics.map(function (m) { return U.esc(m); }).join(', ') + '</p>'
              : '') +
          '</div>'
        : '') +

      ((e.contents && e.contents.length)
        ? '<div class="lot-contents">' +
            '<span class="badge deal">Lot of ' + (e.contents.length + 1) + '</span>' +
            '<ul>' +
              '<li><strong>' + U.esc(name) + '</strong> <span class="fine">base</span></li>' +
              e.contents.map(function (c) {
                var role = CFG.LOT_ROLES.filter(function (r) { return r.key === c.role; })[0];
                return '<li>' + U.esc(c.name) +
                  ' <span class="fine">' + U.esc(role ? role.label.toLowerCase() : c.role) +
                  '</span></li>';
              }).join('') +
            '</ul>' +
            '<p class="fine">Sold together as one item.</p>' +
          '</div>'
        : '') +

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

      '<div class="entry-cta">' + requestBlock(e, mine, takesTrades(listingRef)) + '</div>' +
    '</article>';
  }

  /* M5: the client sends only which game it wants. Everything else — queue
   * position, the denormalized display copies, the hold deadline, the
   * requestCount bump — is decided server-side inside a transaction, because
   * position is exactly the field a client would lie about.
   *
   * That also means the local guards below are courtesy, not enforcement. The
   * callable re-checks blocking, restriction and self-requests itself; these
   * exist only to fail fast with a better message. */
  function startRequest(btn, listing, entry) {
    if (!Store.uid()) { U.toast('Sign in to request', 'warn'); return; }
    if (Store.isBlocked(listing.sellerId)) {
      U.toast('You have blocked this seller — unblock them to request', 'warn');
      return;
    }

    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Requesting…';

    Store.createRequest(listing.id, entry.id).then(function (res) {
      if (res.existing) {
        U.toast('You already have a thread for this one');
      } else if (res.queuePosition > 0) {
        U.toast("You're #" + (res.queuePosition + 1) + " in line — we'll tell you when it's your turn");
      } else {
        U.toast('Request sent — say hello');
      }
      App.go('thread', { id: res.requestId });
    }).catch(function (err) {
      console.error('[tabled] request failed', err);
      btn.disabled = false;
      btn.textContent = original;

      /* Callable errors arrive as 'functions/<code>' with a message already
       * written for a person, so surface it rather than replacing it. The
       * fallback only covers the case where there's nothing readable. */
      var msg = (err && err.message) || '';
      var isOurs = /permission-denied|failed-precondition|not-found/.test(err && err.code || '');
      if (/internal|unavailable/i.test(err && err.code || '') && !Store.isDemo()) {
        U.toast('Requests need the Cloud Functions deployed — see the README', 'bad');
      } else {
        U.toast(isOurs && msg ? msg : 'Could not send that request', 'bad');
      }
    });
  }

  /* ---- Trade proposals (M10) ----------------------------------------------
   * A trade proposal is a request with a different payment shape attached. It
   * goes through the identical queue, chat, propose/confirm and mutual
   * completion pipeline — there is no parallel system, which is the entire
   * reason this was cheap to add.
   *
   * Two ways to offer: one of your own active listings, or an item you simply
   * describe. The second exists because most people's shelves aren't listed. */
  function tradeDialog(listing, entry) {
    if (!Store.uid()) { U.toast('Sign in to propose a trade', 'warn'); return; }

    var m = U.modal('Propose a trade', U.spinner('Loading your games'));
    var mode = 'mine';
    var pickedListingId = null, pickedEntryId = null;

    Store.myOfferableEntries().then(function (offerable) {
      m.el.innerHTML =
        '<p class="modal-msg">Offering for <strong>' + U.esc(entry.name || 'this game') +
          '</strong>' + (typeof entry.askingPrice === 'number'
            ? ' (asking ' + U.esc(U.money(entry.askingPrice)) + ')' : '') + '.</p>' +

        '<div class="chip-row">' +
          '<button class="chip on" data-mode="mine">One of my listings</button>' +
          '<button class="chip" data-mode="describe">Something I have</button>' +
        '</div>' +

        '<div id="trade-mine" class="trade-pane">' +
          (offerable.length
            ? '<div class="event-list">' + offerable.map(function (o) {
                return '<button class="event-row" data-offer="' + U.attr(o.entry.id) + '" ' +
                  'data-offer-listing="' + U.attr(o.listingId) + '">' +
                  '<div class="grow">' +
                    '<strong>' + U.esc(o.entry.name || 'Game') + '</strong>' +
                    '<span class="fine">' +
                      U.esc(CFG.condition(o.entry.condition).label) +
                      (typeof o.entry.askingPrice === 'number'
                        ? ' \u00b7 listed at ' + U.esc(U.money(o.entry.askingPrice)) : '') +
                    '</span>' +
                  '</div>' +
                '</button>';
              }).join('') + '</div>'
            : '<p class="fine">You have no listed games free to offer. Either list one, ' +
              'or describe something instead.</p>') +
        '</div>' +

        '<div id="trade-describe" class="trade-pane" hidden>' +
          '<label class="field"><span>What are you offering?</span>' +
            '<input id="tr-name" type="text" maxlength="120" placeholder="Wingspan"></label>' +
          '<label class="field"><span>Condition</span>' +
            '<select id="tr-cond">' +
              CFG.CONDITIONS.map(function (c) {
                return '<option value="' + U.attr(c.key) + '"' + (c.key === 'VG' ? ' selected' : '') +
                  '>' + U.esc(c.key) + ' \u2014 ' + U.esc(c.label) + '</option>';
              }).join('') +
            '</select></label>' +
          '<label class="field"><span>Anything worth adding? <em>optional</em></span>' +
            '<textarea id="tr-notes" rows="2" maxlength="300" ' +
              'placeholder="Sleeved, all expansions, box a bit tatty"></textarea></label>' +
        '</div>' +

        '<label class="field">' +
          '<span>Add cash on top? <em>optional</em></span>' +
          '<input id="tr-cash" type="number" min="0" step="1" inputmode="decimal" placeholder="0">' +
          '<span class="fine">Just a note to the seller \u2014 Tabled never handles it, and the ' +
            'number isn\'t binding. You\'ll settle the details in chat.</span>' +
        '</label>' +

        '<p class="fine">Your offered game is reserved as soon as you send this, so it ' +
          'can\'t end up promised twice. It frees up again if the trade is declined, ' +
          'cancelled or expires.</p>' +

        '<div class="modal-actions">' +
          '<button class="btn ghost" data-act="cancel">Cancel</button>' +
          '<button class="btn" data-act="send">Send proposal</button>' +
        '</div>';

      U.on(m.el, '[data-mode]', function (e, t) {
        mode = t.dataset.mode;
        U.$$('[data-mode]', m.el).forEach(function (b) {
          b.classList.toggle('on', b.dataset.mode === mode);
        });
        U.$('#trade-mine', m.el).hidden = mode !== 'mine';
        U.$('#trade-describe', m.el).hidden = mode !== 'describe';
      });

      U.on(m.el, '[data-offer]', function (e, t) {
        pickedEntryId = t.dataset.offer;
        pickedListingId = t.dataset.offerListing;
        U.$$('[data-offer]', m.el).forEach(function (b) {
          b.classList.toggle('picked', b === t);
        });
      });

      U.on(m.el, '[data-act]', function (e, t) {
        if (t.dataset.act === 'cancel') { m.close(); return; }

        var payload = { proposalType: 'trade' };
        if (mode === 'mine') {
          if (!pickedEntryId) { U.toast('Pick which of your games you\'re offering', 'warn'); return; }
          payload.offeredListingId = pickedListingId;
          payload.offeredGameEntryId = pickedEntryId;
        } else {
          var name = U.$('#tr-name', m.el).value.trim();
          if (!name) { U.toast('Name the game you\'re offering', 'warn'); return; }
          payload.offeredItemDescription = {
            name: name,
            condition: U.$('#tr-cond', m.el).value,
            notes: U.$('#tr-notes', m.el).value.trim(),
            bggId: null,
            tags: [],
            photos: []
          };
        }
        var cash = parseFloat(U.$('#tr-cash', m.el).value);
        if (!isNaN(cash) && cash > 0) payload.additionalCashOffered = cash;

        t.disabled = true;
        t.textContent = 'Sending\u2026';
        Store.createRequest(listing.id, entry.id, payload).then(function (res) {
          m.close();
          U.toast(res.queuePosition > 0
            ? 'Proposal sent \u2014 you\'re #' + (res.queuePosition + 1) + ' in line'
            : 'Trade proposed \u2014 talk it through with them');
          App.go('thread', { id: res.requestId });
        }).catch(function (err) {
          console.error('[tabled] trade proposal failed', err);
          U.toast((err && err.message) || 'Could not send that proposal', 'bad');
          t.disabled = false;
          t.textContent = 'Send proposal';
        });
      });
    }).catch(function (err) {
      console.error('[tabled] offerable load failed', err);
      m.el.innerHTML = U.empty('Could not load your games', '');
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
