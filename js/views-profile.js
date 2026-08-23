/* Tabled — Profiles and settings.
 *
 * One renderer for both "my profile" and "someone else's", because they show
 * the same information and diverging them is how the two versions end up
 * disagreeing about what a trade count means. Ownership only changes which
 * actions appear, never what's displayed.
 *
 * Identity rule enforced here: the only fields ever shown are displayName,
 * photoURL, bio and generalArea. The signed-in user's real Google email is
 * reachable from auth.currentUser but is never rendered, never written to the
 * profile doc, and never leaves the account it belongs to.
 */
window.ProfileView = (function () {

  /* geocodeArea rejects with 'functions/out-of-range' for a non-US area, and
   * its message already reads correctly to a user — surfaced verbatim rather
   * than replaced with our own wording. */
  function isOutOfRegion(err) {
    return !!err && /out-of-range/.test(err.code || '');
  }

  /* Location is a 5-digit US ZIP. It geocodes to a tight centroid (then fuzzed),
   * which is far more precise for distance search than a free-text neighborhood
   * that could map anywhere in a metro. ZIP+4 is trimmed to the 5-digit prefix. */
  function isZip(z) { return /^\d{5}$/.test(String(z || '').trim()); }

  function render(root, params) {
    var uid = params.id || Store.uid();
    var mine = Store.isMe(uid);
    root.innerHTML = U.spinner('Loading profile');

    Store.getUser(uid).then(function (user) {
      if (!user) {
        root.innerHTML = U.empty('Profile not found', '');
        return;
      }
      draw(root, user, mine);
    }).catch(function (err) {
      console.error('[tabled] profile load failed', err);
      root.innerHTML = U.empty('Could not load that profile', '');
    });
  }

  /* Status words for a seller's own in-progress trades. Kept short because
   * they sit as a chip next to the game name. */
  var PROGRESS_LABEL = {
    onHold: 'On hold', queued: 'In queue',
    proposedTime: 'Time proposed', scheduled: 'Scheduled'
  };

  /* A live "buy N, get $X off" deal, or nothing. Only rendered when active, so
   * a seller who toggled it off shows no stale banner. */
  function promoBannerHtml(user) {
    var pr = user.promo;
    if (!pr || !pr.active) return '';
    return '<div class="promo-banner">' +
      '<span class="promo-mark">DEAL</span>' +
      '<span>Buy ' + Number(pr.buyQty) + '+ and take <strong>$' +
        Number(pr.dollarsOff) + ' off</strong> the total. Applied in person - ' +
        'just mention it when you meet up.</span>' +
    '</div>';
  }

  function draw(root, user, mine) {
    var blocked = !mine && Store.isBlocked(user.id);
    var rating = (typeof user.avgRating === 'number' && user.reviewCount)
      ? stars(user.avgRating) + ' <span class="fine">' + user.avgRating.toFixed(1) +
        ' from ' + U.esc(U.plural(user.reviewCount, 'review')) + '</span>'
      : '<span class="fine">No reviews yet</span>';

    /* Section order differs by ownership. On your own profile the "in progress"
     * block sits high because it's the thing you came to check; a visitor never
     * sees it. Sold sits after active in both. */
    var sections =
      '<section class="block" data-sec="active">' +
        '<h2>' + (mine ? 'For sale' : 'Active listings') +
          ' <span class="count" id="c-active"></span></h2>' +
        '<div class="grid" id="p-active">' + U.spinner('') + '</div>' +
        '<div class="section-foot" id="foot-active"></div>' +
      '</section>' +

      (mine
        ? '<section class="block" data-sec="progress">' +
            '<h2>In progress <span class="count" id="c-progress"></span></h2>' +
            '<div id="p-progress"></div>' +
          '</section>'
        : '') +

      '<section class="block" data-sec="sold">' +
        '<h2>Sold <span class="count" id="c-sold"></span></h2>' +
        '<div class="grid sold-grid" id="p-sold">' + U.spinner('') + '</div>' +
        '<div class="section-foot" id="foot-sold"></div>' +
      '</section>' +

      '<section class="block" data-sec="reviews">' +
        '<h2>Reviews</h2>' +
        '<div id="p-reviews">' + U.spinner('') + '</div>' +
      '</section>';

    root.innerHTML =
      '<div class="profile">' +
        '<div class="profile-head">' +
          U.avatar(user, 'xl') +
          '<div class="grow">' +
            '<h1>' + U.esc(user.displayName || 'Board gamer') + '</h1>' +
            '<p class="fine">' +
              (user.generalArea ? U.esc(user.generalArea) + ' · ' : '') +
              'Member since ' + U.esc(U.monthYear(user.createdAt)) +
            '</p>' +
          '</div>' +
          (mine ? '' : Safety.menuHtml('user', user.id, user.displayName, user.id)) +
        '</div>' +

        (user.bio ? '<p class="bio">' + U.esc(user.bio) + '</p>' : '') +

        '<div class="stat-row">' +
          '<div class="stat"><strong>' + (user.tradeCount || 0) + '</strong><span>trades</span></div>' +
          '<div class="stat wide">' + rating + '</div>' +
        '</div>' +

        /* The deal shows to everyone but the seller (they manage it in
         * settings, where they also see a preview). */
        (mine ? '' : promoBannerHtml(user)) +

        (blocked
          ? '<div class="banner warn">You have blocked this person. Their listings are hidden from your feed. ' +
            '<button class="linkish" id="unblock">Unblock</button></div>'
          : '') +

        (mine
          ? '<div class="profile-actions">' +
              '<a class="btn ghost" href="#/settings">Edit profile</a>' +
              '<a class="btn" href="#/create">New listing</a>' +
            '</div>'
          /* No "see what they're selling" button any more - their listings are
           * right here on the page. */
          : '') +

        sections +
      '</div>';

    loadReviews(user.id);
    if (mine) loadProgress(user.id);

    /* Active first (it's what most visits are about); sold loads in parallel
     * but renders into its own section. */
    mountListings({ host: '#p-active', foot: '#foot-active', count: '#c-active',
      sellerId: user.id, statuses: ['active'], mine: mine, sold: false,
      empty: mine ? 'Nothing listed right now.' : 'No active listings.' });

    mountListings({ host: '#p-sold', foot: '#foot-sold', count: '#c-sold',
      sellerId: user.id, statuses: ['archived'], mine: mine, sold: true,
      empty: mine ? 'Nothing sold yet.' : 'No completed sales yet.' });

    if (!mine) {
      Safety.wireMenu(root, {
        sellerId: user.id,
        sellerName: user.displayName,
        onBlock: function () { render(root, { id: user.id }); }
      });
    }
    var ub = U.$('#unblock', root);
    if (ub) ub.addEventListener('click', function () {
      Safety.unblock(user.id).then(function () { render(root, { id: user.id }); });
    });
  }

  /* A paginated listing section. Owns its own cursor and "Load more" so active
   * and sold each page independently. The seller's own sold history and a
   * visitor's both read the same archived docs - the rules now allow it. */
  function mountListings(o) {
    var host = U.$(o.host);
    var foot = U.$(o.foot);
    var countEl = U.$(o.count);
    if (!host) return;
    var items = [];
    var cursor = null;
    var loading = false;

    function paint(exhausted) {
      host.innerHTML = items.length
        ? items.map(function (l) { return Feed.card(l); }).join('')
        : '<p class="fine">' + U.esc(o.empty) + '</p>';
      if (countEl) countEl.textContent = items.length
        ? (items.length + (exhausted ? '' : '+')) : '';
      if (foot) {
        foot.innerHTML = (!exhausted && items.length)
          ? '<button class="btn ghost small" data-more>Load more</button>' : '';
        var b = U.$('[data-more]', foot);
        if (b) b.addEventListener('click', next);
      }
    }

    function next() {
      if (loading) return;
      loading = true;
      var b = foot && U.$('[data-more]', foot);
      if (b) { b.disabled = true; b.textContent = 'Loading…'; }
      Store.queryListings({
        sellerId: o.sellerId, statuses: o.statuses, sort: 'new', limit: 12
      }, cursor).then(function (page) {
        cursor = page.cursor;
        items = items.concat(page.items);
        loading = false;
        paint(page.exhausted);
      }).catch(function (err) {
        console.error('[tabled] profile listings failed', o.statuses, err);
        loading = false;
        host.innerHTML = U.empty('Could not load listings', '');
      });
    }

    next();
  }

  /* The seller's own mid-trade items, read from the live requests list rather
   * than a query - the app already subscribes to it, so this costs nothing.
   * Buyers never see this; it's a private "what's in flight" view. */
  function loadProgress(uid) {
    var host = U.$('#p-progress');
    var countEl = U.$('#c-progress');
    if (!host) return;
    var rows = (Store.myRequests() || []).filter(function (r) {
      return r.sellerId === uid && CFG.isOpenRequest(r.status);
    }).sort(function (a, b) {
      return (U.toDate(b.updatedAt) || 0) - (U.toDate(a.updatedAt) || 0);
    });

    if (countEl) countEl.textContent = rows.length || '';
    if (!rows.length) {
      host.innerHTML = '<p class="fine">No trades in progress. When a buyer requests ' +
        'one of your games, it shows here until the trade is done.</p>';
      return;
    }
    host.innerHTML = '<ul class="progress-list">' + rows.map(function (r) {
      var cover = U.safeUrl(r.coverPhoto);
      return '<li><a class="progress-row" href="#/thread/' + U.attr(r.id) + '">' +
        '<span class="progress-thumb' + (cover ? '' : ' noimg') + '"' +
          (cover ? ' style="background-image:url(' + U.attr(cover) + ')"' : '') + '>' +
          (cover ? '' : U.esc(U.initials(r.gameName || 'Game'))) + '</span>' +
        '<span class="grow">' +
          '<strong>' + U.esc(r.gameName || 'Game') + '</strong>' +
          '<span class="fine">with ' + U.esc(r.buyerName || 'a buyer') + '</span>' +
        '</span>' +
        '<span class="badge">' + U.esc(PROGRESS_LABEL[r.status] || r.status) + '</span>' +
      '</a></li>';
    }).join('') + '</ul>';
  }

  /* Reviews are fetch-once: they never change after posting, so a live
   * subscription would stream data that is by definition immutable. */
  function loadReviews(uid) {
    Store.getReviews(uid).then(function (reviews) {
      var host = U.$('#p-reviews');
      if (!host) return;
      if (!reviews.length) {
        host.innerHTML = '<p class="fine">No reviews yet. They unlock when a trade is ' +
          'confirmed by both sides.</p>';
        return;
      }
      host.innerHTML = reviews.map(function (r) {
        return '<div class="review">' +
          '<div class="review-head">' +
            U.avatar({ displayName: r.reviewerName, photoURL: r.reviewerPhoto }, '') +
            '<div class="grow">' +
              '<strong>' + U.esc(r.reviewerName || 'Someone') + '</strong>' +
              '<span class="fine">' +
                (r.gameName ? U.esc(r.gameName) + ' \u00b7 ' : '') +
                U.esc(U.ago(r.createdAt)) +
              '</span>' +
            '</div>' +
            '<span class="stars">' + stars(r.rating) + '</span>' +
          '</div>' +
          (r.comment ? '<p class="review-body">' + U.esc(r.comment) + '</p>' : '') +
        '</div>';
      }).join('');
    }).catch(function (err) {
      console.error('[tabled] reviews load failed', err);
      var host = U.$('#p-reviews');
      if (host) host.innerHTML = '<p class="fine">Could not load reviews.</p>';
    });
  }

  function stars(n) {
    var full = Math.round(Number(n) || 0);
    var s = '';
    for (var i = 1; i <= 5; i++) s += (i <= full ? '★' : '☆');
    return '<span class="stars" aria-label="' + full + ' out of 5">' + s + '</span>';
  }

  /* ---- Settings ---------------------------------------------------------- */

  function settings(root) {
    var me = Store.me();
    if (!me) { root.innerHTML = U.empty('Sign in first', ''); return; }
    var blockedIds = Store.blockedList();

    root.innerHTML =
      '<div class="form-page">' +
        '<h1>Edit profile</h1>' +

        '<label class="field">' +
          '<span>Display name</span>' +
          '<input id="s-name" type="text" maxlength="60" value="' + U.attr(me.displayName || '') + '">' +
          '<span class="fine">This and your photo are the only things other people see. ' +
            'Your email address is never shown to anyone.</span>' +
        '</label>' +

        '<label class="field">' +
          '<span>Bio <em>optional</em></span>' +
          '<textarea id="s-bio" rows="3" maxlength="300" ' +
            'placeholder="What you play, what you\'re thinning out">' + U.esc(me.bio || '') + '</textarea>' +
        '</label>' +

        '<label class="field">' +
          '<span>ZIP code</span>' +
          '<input id="s-area" type="text" inputmode="numeric" maxlength="5" ' +
            'autocomplete="postal-code" pattern="[0-9]{5}" placeholder="02139" ' +
            'value="' + U.attr(me.generalArea || '') + '">' +
          '<span class="fine">Used for distance search, and shown to others as the ZIP. ' +
            'It\'s converted to a map point jittered by up to a mile or two, so browsing never ' +
            'reveals where anyone actually lives. Tabled serves ' + U.esc(CFG.GEO.label) +
            ' only right now.</span>' +
        '</label>' +

        '<div class="form-actions">' +
          '<a class="btn ghost" href="#/me">Cancel</a>' +
          '<button class="btn" id="s-save">Save</button>' +
        '</div>' +

        availabilitySection(me) +

        promoSection(me) +

        '<section class="block">' +
          '<h2>Blocked people</h2>' +
          '<div id="blocked-list">' +
            (blockedIds.length
              ? U.spinner('')
              : '<p class="fine">Nobody blocked. Blocking someone hides their listings from your ' +
                'feed and stops them contacting you.</p>') +
          '</div>' +
        '</section>' +

        (Store.isStaff()
          ? '<section class="block">' +
              '<h2>Moderation</h2>' +
              '<p class="fine">You have the <strong>' + U.esc(Store.role()) +
                '</strong> role. Reports are readable by staff only.</p>' +
              '<a class="btn ghost" href="#/admin">Open the console</a>' +
            '</section>'
          : '') +

        '<section class="block">' +
          '<h2>Account</h2>' +
          '<button class="btn ghost" id="s-out">Sign out</button>' +
        '</section>' +
      '</div>';

    if (blockedIds.length) drawBlocked(blockedIds);
    wireAvailability(root);
    wirePromo(root);

    U.$('#s-out', root).addEventListener('click', function () { App.signOut(); });

    U.$('#s-save', root).addEventListener('click', function () {
      var btn = this;
      var name = U.$('#s-name').value.trim();
      if (!name) { U.toast('A display name is required', 'warn'); return; }
      var area = U.$('#s-area').value.trim();
      if (area && !isZip(area)) { U.toast('Enter a 5-digit ZIP code', 'warn'); U.$('#s-area').focus(); return; }
      var patch = { displayName: name, bio: U.$('#s-bio').value.trim(), generalArea: area };

      btn.disabled = true;
      btn.textContent = 'Saving…';

      /* Re-geocode only when the text actually changed. The fuzz is applied
       * once, server-side, and stored — re-fuzzing an unchanged area on every
       * save would let anyone watching the point average the jitter out and
       * recover the true location. */
      var geo = (area && area !== (me.generalArea || ''))
        ? Store.geocodeArea(area).then(function (res) {
            if (res && typeof res.lat === 'number') {
              patch.geoPoint = { lat: res.lat, lng: res.lng };
              patch.geohash = res.geohash || Geo.encode(res.lat, res.lng, 9);
              patch.countryCode = res.countryCode || null;
              patch.state = res.state || null;
            }
          }).catch(function (err) {
            /* An out-of-region area is fatal — Tabled is US-only, and saving
             * the label without a point would leave a profile claiming to be
             * somewhere the app doesn't serve. Every other geocoding failure
             * is non-fatal; the profile saves without distance search. */
            if (isOutOfRegion(err)) throw err;
            U.toast('Could not map that area — distance search will be off until it resolves', 'warn');
          })
        : Promise.resolve();

      geo.then(function () { return Store.saveProfile(patch); })
        .then(function () {
          U.toast('Profile saved');
          App.go('me', {});
        })
        .catch(function (err) {
          if (isOutOfRegion(err)) {
            U.toast(err.message, 'warn');
            var input = U.$('#s-area');
            if (input) { input.focus(); input.select(); }
          } else {
            console.error('[tabled] profile save failed', err);
            U.toast('Could not save your profile', 'bad');
          }
          btn.disabled = false;
          btn.textContent = 'Save';
        });
    });
  }

  /* ---- Availability (M6) --------------------------------------------------
   * ONE standing weekly schedule that applies to every listing this person has,
   * not a per-listing setting. That's deliberate: a seller's free Saturday is a
   * fact about the seller, and duplicating it per listing means it's wrong on
   * most of them within a month.
   *
   * The timezone is captured from the browser rather than asked for. Getting it
   * from a dropdown is a worse experience and a worse answer — people move, and
   * the browser already knows. It's shown so it can be sanity-checked. */
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function availabilitySection(me) {
    var windows = me.availabilityWindows || [];
    var tz = me.timeZone || TimeSlots.currentZone();
    var byDay = {};
    windows.forEach(function (w) { byDay[Number(w.dayOfWeek)] = w; });

    return '<section class="block">' +
      '<h2>When can buyers meet you?</h2>' +
      '<p class="fine">Set this once and it applies to every listing you have. ' +
        'Whoever is first in line for a game can book a 30-minute slot in it, ' +
        'and you still confirm before anything is final.</p>' +
      '<div class="avail">' +
        DAYS.map(function (name, i) {
          var w = byDay[i];
          return '<div class="avail-row' + (w ? ' on' : '') + '" data-day="' + i + '">' +
            '<label class="avail-day">' +
              '<input type="checkbox" data-avail-on="' + i + '"' + (w ? ' checked' : '') + '>' +
              '<span>' + U.esc(name.slice(0, 3)) + '</span>' +
            '</label>' +
            '<div class="avail-times"' + (w ? '' : ' hidden') + '>' +
              '<input type="time" step="1800" data-avail-start="' + i + '" ' +
                'value="' + U.attr(w ? w.startTime : '10:00') + '">' +
              '<span class="dash">to</span>' +
              '<input type="time" step="1800" data-avail-end="' + i + '" ' +
                'value="' + U.attr(w ? w.endTime : '14:00') + '">' +
            '</div>' +
          '</div>';
        }).join('') +
      '</div>' +
      '<p class="fine">Times are yours — <strong>' + U.esc(tz) + '</strong>. ' +
        'Buyers see them converted to their own clock, so nobody turns up an hour out.</p>' +
      '<button class="btn ghost small" id="avail-save">Save availability</button>' +
    '</section>';
  }

  function wireAvailability(root) {
    var host = U.$('.avail', root);
    if (!host) return;

    U.on(host, '[data-avail-on]', function (e, t) {
      var row = t.closest('.avail-row');
      row.classList.toggle('on', t.checked);
      U.$('.avail-times', row).hidden = !t.checked;
    }, 'change');

    U.$('#avail-save', root).addEventListener('click', function () {
      var btn = this;
      var windows = [];
      var problem = null;

      U.$$('.avail-row', root).forEach(function (row) {
        var day = Number(row.dataset.day);
        if (!U.$('[data-avail-on]', row).checked) return;
        var start = U.$('[data-avail-start]', row).value;
        var end = U.$('[data-avail-end]', row).value;
        if (!start || !end) { problem = 'Every ticked day needs a start and end time.'; return; }
        if (TimeSlots.toMinutes(end) - TimeSlots.toMinutes(start) < TimeSlots.SLOT_MINUTES) {
          problem = DAYS[day] + ' needs to be at least ' + TimeSlots.SLOT_MINUTES +
            ' minutes long — that\'s one slot.';
          return;
        }
        windows.push({ dayOfWeek: day, startTime: start, endTime: end });
      });

      if (problem) { U.toast(problem, 'warn'); return; }

      btn.disabled = true;
      btn.textContent = 'Saving…';
      Store.saveProfile({
        availabilityWindows: windows,
        /* Re-captured on every save, so someone who moves gets corrected
         * without having to know this field exists. */
        timeZone: TimeSlots.currentZone()
      }).then(function () {
        U.toast(windows.length
          ? 'Availability saved — buyers can book slots now'
          : 'Availability cleared — buyers will negotiate times in chat instead');
        btn.disabled = false;
        btn.textContent = 'Save availability';
      }).catch(function (err) {
        console.error('[tabled] availability save failed', err);
        U.toast('Could not save availability', 'bad');
        btn.disabled = false;
        btn.textContent = 'Save availability';
      });
    });
  }

  /* ---- Seller promotion (buy N, get $X off) -------------------------------
   * Display-only: Tabled processes no money, so this is a signal the two people
   * honor in person, exactly like the asking price. Bounds mirror CFG.PROMO and
   * are re-checked in firestore.rules, so a hand-crafted write can't post an
   * absurd banner. Stored as { active, buyQty, dollarsOff }; toggling off keeps
   * the numbers but sets active:false, so turning it back on doesn't re-ask. */
  function promoSection(me) {
    var pr = me.promo || { active: false, buyQty: CFG.PROMO.minQty, dollarsOff: 5 };
    var on = !!pr.active;
    return '<section class="block">' +
      '<h2>Bundle deal</h2>' +
      '<p class="fine">Offer a "buy several, save a bit" deal across all your ' +
        'listings. It shows on your profile and in your chats. Nothing is charged ' +
        'here — you and the buyer just apply it when you meet up, the same as ' +
        'the price.</p>' +
      '<label class="promo-toggle">' +
        '<input type="checkbox" id="promo-on"' + (on ? ' checked' : '') + '>' +
        '<span>Offer a bundle deal</span>' +
      '</label>' +
      '<div class="promo-fields"' + (on ? '' : ' hidden') + ' id="promo-fields">' +
        '<div class="promo-line">' +
          '<span>Buy at least</span>' +
          '<input type="number" id="promo-qty" min="' + CFG.PROMO.minQty + '" ' +
            'max="' + CFG.PROMO.maxQty + '" step="1" value="' +
            U.attr(String(pr.buyQty || CFG.PROMO.minQty)) + '">' +
          '<span>games, get</span>' +
          '<input type="number" id="promo-off" min="1" max="' + CFG.PROMO.maxDollarsOff +
            '" step="1" value="' + U.attr(String(pr.dollarsOff || 5)) + '">' +
          '<span>dollars off the total.</span>' +
        '</div>' +
        '<p class="fine promo-preview" id="promo-preview"></p>' +
      '</div>' +
      '<button class="btn ghost small" id="promo-save">Save deal</button>' +
    '</section>';
  }

  function promoPreview(root) {
    var el = U.$('#promo-preview', root);
    if (!el) return;
    var qty = Number(U.$('#promo-qty', root).value);
    var off = Number(U.$('#promo-off', root).value);
    el.textContent = (qty >= CFG.PROMO.minQty && off > 0)
      ? 'Buyers will see: "Buy ' + qty + '+ and take $' + off + ' off the total."'
      : '';
  }

  function wirePromo(root) {
    var toggle = U.$('#promo-on', root);
    if (!toggle) return;
    var fields = U.$('#promo-fields', root);
    var qty = U.$('#promo-qty', root);
    var off = U.$('#promo-off', root);

    toggle.addEventListener('change', function () {
      fields.hidden = !toggle.checked;
    });
    [qty, off].forEach(function (i) {
      i.addEventListener('input', function () { promoPreview(root); });
    });
    promoPreview(root);

    U.$('#promo-save', root).addEventListener('click', function () {
      var btn = this;
      var active = toggle.checked;
      var q = Math.round(Number(qty.value));
      var d = Math.round(Number(off.value));

      /* Validate only when the deal is ON. An off deal can save with whatever
       * numbers are in the boxes -- they're just remembered for next time. */
      if (active) {
        if (!(q >= CFG.PROMO.minQty && q <= CFG.PROMO.maxQty)) {
          U.toast('"Buy at least" must be between ' + CFG.PROMO.minQty + ' and ' +
            CFG.PROMO.maxQty + '.', 'warn');
          return;
        }
        if (!(d > 0 && d <= CFG.PROMO.maxDollarsOff)) {
          U.toast('Dollars off must be between $1 and $' + CFG.PROMO.maxDollarsOff + '.', 'warn');
          return;
        }
      }

      /* Clamp the stored values even when inactive, so a later toggle-on can't
       * activate out-of-range numbers the rules would then reject. */
      var promo = {
        active: active,
        buyQty: Math.min(CFG.PROMO.maxQty, Math.max(CFG.PROMO.minQty, q || CFG.PROMO.minQty)),
        dollarsOff: Math.min(CFG.PROMO.maxDollarsOff, Math.max(1, d || 1))
      };

      btn.disabled = true;
      btn.textContent = 'Saving…';
      Store.saveProfile({ promo: promo }).then(function () {
        U.toast(active ? 'Bundle deal is live' : 'Bundle deal turned off');
        btn.disabled = false;
        btn.textContent = 'Save deal';
      }).catch(function (err) {
        console.error('[tabled] promo save failed', err);
        U.toast('Could not save the deal', 'bad');
        btn.disabled = false;
        btn.textContent = 'Save deal';
      });
    });
  }

  function drawBlocked(ids) {
    Promise.all(ids.map(function (id) {
      return Store.getUser(id).catch(function () { return null; });
    })).then(function (users) {
      var host = U.$('#blocked-list');
      if (!host) return;
      host.innerHTML = '<ul class="blocked">' + users.map(function (u, i) {
        var id = ids[i];
        var name = (u && u.displayName) || 'Unknown user';
        return '<li>' + U.avatar(u || {}, '') +
          '<span class="grow">' + U.esc(name) + '</span>' +
          '<button class="btn ghost small" data-unblock="' + U.attr(id) + '">Unblock</button></li>';
      }).join('') + '</ul>';

      U.on(host, '[data-unblock]', function (e, t) {
        Safety.unblock(t.dataset.unblock).then(function () {
          settings(U.$('#view'));
        });
      });
    });
  }

  /* ---- Onboarding (first run) --------------------------------------------
   * A deliberately small first-run screen: a name and a general area, nothing
   * else. The area is required because a listing now inherits its location from
   * the profile -- without one, the create form has nowhere to post. The router
   * holds a new account here until this succeeds. Everything else (bio, photo,
   * availability, promo) is discoverable later in Edit profile. */
  function onboard(root) {
    var me = Store.me();
    if (!me) { root.innerHTML = U.empty('Sign in first', ''); return; }

    root.innerHTML =
      '<div class="form-page onboard">' +
        '<h1>Welcome to Tabled</h1>' +
        '<p class="fine">Two quick things and you\'re in. You can change either ' +
          'later in your profile.</p>' +

        '<label class="field">' +
          '<span>Display name</span>' +
          '<input id="ob-name" type="text" maxlength="60" value="' + U.attr(me.displayName || '') + '">' +
          '<span class="fine">This and your photo are the only things other people see. ' +
            'Your email address is never shown.</span>' +
        '</label>' +

        '<label class="field">' +
          '<span>Your ZIP code</span>' +
          '<input id="ob-area" type="text" inputmode="numeric" maxlength="5" ' +
            'autocomplete="postal-code" pattern="[0-9]{5}" placeholder="02139" ' +
            'value="' + U.attr(me.generalArea || '') + '">' +
          '<span class="fine">Listings search by distance from your ZIP. It becomes a ' +
            'deliberately fuzzed map point — your exact address is never stored or shown, ' +
            'and other people see only the ZIP. Tabled serves ' + U.esc(CFG.GEO.label) +
            ' only right now.</span>' +
        '</label>' +

        '<div class="form-actions">' +
          '<button class="btn" id="ob-go">Start browsing</button>' +
        '</div>' +
      '</div>';

    U.$('#ob-go', root).addEventListener('click', function () {
      var btn = this;
      var name = U.$('#ob-name').value.trim();
      var area = U.$('#ob-area').value.trim();
      if (!name) { U.toast('Pick a display name', 'warn'); return; }
      if (!isZip(area)) { U.toast('Enter a 5-digit ZIP code', 'warn'); U.$('#ob-area').focus(); return; }

      btn.disabled = true;
      btn.textContent = 'Setting up…';

      /* Only an out-of-region area is fatal (Tabled is US-only, and the area is
       * the one required field). Any OTHER geocoding failure -- including the
       * key simply not being configured yet -- must NOT block onboarding, or a
       * new account can't get in at all. In that case the area text saves
       * without a map point and distance search stays off until it resolves,
       * exactly as the Edit-profile flow already behaves. */
      var patch = { displayName: name, generalArea: area };
      Store.geocodeArea(area).then(function (res) {
        if (res && typeof res.lat === 'number') {
          patch.geoPoint = { lat: res.lat, lng: res.lng };
          patch.geohash = res.geohash || Geo.encode(res.lat, res.lng, 9);
          patch.countryCode = res.countryCode || null;
          patch.state = res.state || null;
        }
      }).catch(function (err) {
        if (isOutOfRegion(err)) throw err;
        console.warn('[tabled] onboarding geocode unavailable', err);
        U.toast('Saved — distance search will switch on once mapping is set up', 'warn');
      }).then(function () {
        return Store.saveProfile(patch);
      }).then(function () {
        U.toast('You\'re all set');
        App.go('feed', {});
      }).catch(function (err) {
        if (isOutOfRegion(err)) {
          U.toast(err.message, 'warn');
          var input = U.$('#ob-area');
          if (input) { input.focus(); input.select(); }
        } else {
          console.error('[tabled] onboarding save failed', err);
          U.toast('Could not save that — try again', 'bad');
        }
        btn.disabled = false;
        btn.textContent = 'Start browsing';
      });
    });
  }

  return { render: render, settings: settings, onboard: onboard };
})();
