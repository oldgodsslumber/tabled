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
              (user.verifiedSeller
                ? ' <span class="badge verified" title="Verification fees are current">Verified</span>'
                : '') +
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
          '<p class="fine">Reviews unlock when a trade is confirmed by both sides — that flow ' +
            'arrives with M7, so nothing here yet.</p>' +
        '</section>' +
      '</div>';

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

  function stars(n) {
    var full = Math.round(n);
    var s = '';
    for (var i = 1; i <= 5; i++) s += (i <= full ? '★' : '☆');
    return '<span class="stars" aria-label="' + n.toFixed(1) + ' out of 5">' + s + '</span>';
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

        '<section class="block">' +
          '<h2>Blocked people</h2>' +
          '<div id="blocked-list">' +
            (blockedIds.length
              ? U.spinner('')
              : '<p class="fine">Nobody blocked. Blocking someone hides their listings from your ' +
                'feed and stops them contacting you.</p>') +
          '</div>' +
        '</section>' +

        '<section class="block">' +
          '<h2>Account</h2>' +
          '<button class="btn ghost" id="s-out">Sign out</button>' +
        '</section>' +
      '</div>';

    if (blockedIds.length) drawBlocked(blockedIds);

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
