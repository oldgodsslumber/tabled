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
      return loadListings(uid);
    }).catch(function (err) {
      console.error('[tabled] profile load failed', err);
      root.innerHTML = U.empty('Could not load that profile', '');
    });
  }

  function draw(root, user, mine) {
    var blocked = !mine && Store.isBlocked(user.id);
    var rating = (typeof user.avgRating === 'number' && user.reviewCount)
      ? stars(user.avgRating) + ' <span class="fine">' + user.avgRating.toFixed(1) +
        ' from ' + U.esc(U.plural(user.reviewCount, 'review')) + '</span>'
      : '<span class="fine">No reviews yet</span>';

    root.innerHTML =
      '<div class="profile">' +
        '<div class="profile-head">' +
          U.avatar(user, 'xl') +
          '<div class="grow">' +
            '<h1>' + U.esc(user.displayName || 'Board gamer') +

            '</h1>' +
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

        (blocked
          ? '<div class="banner warn">You have blocked this person. Their listings are hidden from your feed. ' +
            '<button class="linkish" id="unblock">Unblock</button></div>'
          : '') +

        (mine
          ? '<div class="profile-actions">' +
              '<a class="btn ghost" href="#/settings">Edit profile</a>' +
              '<a class="btn" href="#/create">New listing</a>' +
            '</div>'
          /* "Request a game" isn't a profile-level action — a request is
           * always against one specific game entry. So this points at what
           * they're selling rather than pretending to be a button that could
           * work on its own. */
          : '<div class="profile-actions">' +
              '<a class="btn" href="#/feed?sellerId=' + U.attr(user.id) + '">See what they\'re selling</a>' +
            '</div>') +

        '<section class="block">' +
          '<h2>' + (mine ? 'My active listings' : 'Active listings') + '</h2>' +
          '<div class="grid" id="p-listings">' + U.spinner('') + '</div>' +
        '</section>' +

        '<section class="block">' +
          '<h2>Reviews</h2>' +
          '<div id="p-reviews">' + U.spinner('') + '</div>' +
        '</section>' +
      '</div>';

    loadReviews(user.id);

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

  function loadListings(uid) {
    return Store.queryListings({ sellerId: uid, sort: 'new', limit: 24 }).then(function (page) {
      var host = U.$('#p-listings');
      if (!host) return;
      host.innerHTML = page.items.length
        ? page.items.map(Feed.card).join('')
        : U.empty('No active listings', '');
    }).catch(function (err) {
      console.error('[tabled] profile listings failed', err);
      var host = U.$('#p-listings');
      if (host) host.innerHTML = U.empty('Could not load listings', '');
    });
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
          '<span>General area</span>' +
          '<input id="s-area" type="text" maxlength="80" placeholder="North Jacksonville" ' +
            'value="' + U.attr(me.generalArea || '') + '">' +
          '<span class="fine">Used for distance search, and shown as this exact text. ' +
            'It\'s converted to a map point that is deliberately jittered by up to a mile or two, ' +
            'so browsing never reveals where anyone actually lives. Keep it broad — a neighborhood, ' +
            'not a street. Tabled serves ' + U.esc(CFG.GEO.label) + ' only right now.</span>' +
        '</label>' +

        '<div class="form-actions">' +
          '<a class="btn ghost" href="#/me">Cancel</a>' +
          '<button class="btn" id="s-save">Save</button>' +
        '</div>' +

        availabilitySection(me) +

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

    U.$('#s-out', root).addEventListener('click', function () { App.signOut(); });

    U.$('#s-save', root).addEventListener('click', function () {
      var btn = this;
      var name = U.$('#s-name').value.trim();
      if (!name) { U.toast('A display name is required', 'warn'); return; }
      var area = U.$('#s-area').value.trim();
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

  return { render: render, settings: settings };
})();
