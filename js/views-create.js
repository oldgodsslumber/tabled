/* Tabled — Create / Edit listing (M1 + M2).
 *
 * A listing is one seller, one location, one fulfillment setting — and one or
 * more games, each with its own condition, tags, photos, price and notes. That
 * bundle shape is the reason gameEntries is a subcollection rather than an
 * array field, and it's the reason this form is built around a repeating entry
 * block instead of a flat set of inputs.
 *
 * Editing discipline: text inputs write straight into the draft on `input` and
 * never trigger a re-render, because re-rendering mid-keystroke steals focus and
 * eats the caret position. Only structural changes — adding or removing a game,
 * adding or removing a photo — redraw.
 */
window.CreateView = (function () {

  var draft = null;
  var editingId = null;
  var gamesById = {};      /* BGG cache for the games in this draft */
  var busy = false;

  function blankEntry(seed) {
    return Object.assign({
      id: null, bggId: null, name: '', condition: 'VG',
      categories: [], contents: [], tags: [], photos: [], askingPrice: null, notes: ''
    }, seed || {});
  }

  function render(root, params) {
    editingId = params.id || null;
    busy = false;
    gamesById = {};
    root.innerHTML = U.spinner(editingId ? 'Loading listing' : 'Preparing');

    var me = Store.me();
    if (!me) { root.innerHTML = U.empty('Sign in first', ''); return; }

    if (!editingId) {
      draft = {
        title: '',
        fulfillment: { pickup: true, inPersonAtEvent: false },
        /* Location defaults to the seller's profile area — copied onto the
         * listing at creation time rather than referenced, so later changing
         * where you live never silently moves every listing you ever made. */
        locationLabel: me.generalArea || '',
        geoPoint: me.geoPoint || null,
        geohash: me.geohash || null,
        eventId: null, eventName: null, eventStartDate: null, eventEndDate: null,
        acceptedPayment: { cash: true, paypal: false, venmo: false, trades: false },
        entries: []
      };
      draw(root);
      return;
    }

    Store.getListing(editingId).then(function (l) {
      if (!l) throw new Error('notfound');
      if (!Store.isMe(l.sellerId)) throw new Error('forbidden');
      return Store.getEntries(editingId).then(function (es) {
        draft = {
          title: l.title || '',
          fulfillment: Object.assign({ pickup: true, inPersonAtEvent: false }, l.fulfillment || {}),
          locationLabel: l.locationLabel || '',
          geoPoint: l.geoPoint || null,
          geohash: l.geohash || null,
          eventId: l.eventId || null,
          eventName: l.eventName || null,
          eventStartDate: l.eventStartDate || null,
          eventEndDate: l.eventEndDate || null,
          acceptedPayment: Object.assign(
            { cash: true, paypal: false, venmo: false, trades: false },
            l.acceptedPayment || {}),
          entries: es.length ? es.map(function (e) { return blankEntry(e); }) : [blankEntry()]
        };
        return Store.getGames(es.map(function (e) { return e.bggId; }).filter(Boolean));
      }).then(function (g) {
        gamesById = g;
        draw(root);
      });
    }).catch(function (err) {
      root.innerHTML = U.empty(
        err && err.message === 'forbidden' ? 'That isn\'t your listing' : 'Listing not found', '');
    });
  }

  /* ---- Render ------------------------------------------------------------ */

  function draw(root) {
    root.innerHTML =
      '<div class="form-page">' +
        '<h1>' + (editingId ? 'Edit listing' : 'New listing') + '</h1>' +

        '<section class="block">' +
          '<h2>Games in this listing</h2>' +
          '<div id="entries"></div>' +
          '<div class="add-game">' +
            (BGG.available()
              ? '<label class="field">' +
                  '<span>Add a game</span>' +
                  '<input id="bgg-q" type="search" autocomplete="off" ' +
                    'placeholder="Search for a board game — start typing a title">' +
                '</label>' +
                '<div id="bgg-results" class="bgg-results" hidden></div>' +
                '<button class="btn ghost small" id="add-manual">Add a game manually instead</button>' +
                bggAttribution()
              : '<p class="fine">' + U.esc(BGG.reason() ||
                  'BoardGameGeek search is unavailable here, so games are entered by hand.') +
                '</p>' +
                '<button class="btn ghost small" id="add-manual">Add a game</button>') +
          '</div>' +
        '</section>' +

        '<section class="block">' +
          '<h2>How can buyers get it?</h2>' +
          '<div class="chip-row">' +
            CFG.FULFILLMENT.map(function (f) {
              return '<button class="chip' + (draft.fulfillment[f.key] ? ' on' : '') +
                '" data-ful="' + U.attr(f.key) + '">' + U.esc(f.label) + '</button>';
            }).join('') +
          '</div>' +
          '<div id="event-picker">' + eventPickerHtml() + '</div>' +
        '</section>' +

        '<section class="block">' +
          '<h2>What will you take?</h2>' +
          '<div class="chip-row">' +
            CFG.PAYMENT.map(function (pm) {
              return '<button class="chip' + (draft.acceptedPayment[pm.key] ? ' on' : '') +
                '" data-pay="' + U.attr(pm.key) + '">' + U.esc(pm.label) + '</button>';
            }).join('') +
          '</div>' +
          '<p class="fine">Descriptive only — Tabled never handles any of it. ' +
            'Ticking <strong>Trades</strong> is the one that does something: it puts a ' +
            '“Propose a trade” button on this listing.</p>' +
        '</section>' +

        '<section class="block">' +
          '<h2>Where</h2>' +
          '<p class="fine">Posts from ZIP <strong>' + U.esc(Store.me().generalArea || 'your ZIP') +
            '</strong> — pulled from your profile, so you never retype it. Others see the ZIP; ' +
            'the map point behind it is deliberately fuzzed. ' +
            '<a href="#/settings">Change your ZIP</a>.</p>' +
        '</section>' +

        '<div class="form-actions">' +
          '<a class="btn ghost" href="' + (editingId ? '#/listing/' + U.attr(editingId) : '#/feed') + '">Cancel</a>' +
          '<button class="btn" id="save">' + (editingId ? 'Save changes' : 'Post listing') + '</button>' +
        '</div>' +
      '</div>';

    drawEntries();
    wire(root);
  }

  /* Summed marketplace value of a lot: the headline game plus everything
   * bundled with it. This is what the Good Deal sort compares against. */
  function lotValue(e) {
    var g = e.bggId ? gamesById[String(e.bggId)] : null;
    var total = g && typeof g.suggestedPrice === 'number' ? g.suggestedPrice : 0;
    (e.contents || []).forEach(function (c) {
      var cg = c.bggId ? gamesById[String(c.bggId)] : null;
      if (cg && typeof cg.suggestedPrice === 'number') total += cg.suggestedPrice;
    });
    return total;
  }

  function drawEntries() {
    var host = U.$('#entries');
    if (!host) return;
    host.innerHTML = draft.entries.map(entryHtml).join('');
  }

  /* BGG's XML API terms require the "Powered by BGG" logo, linked back, wherever
   * their data appears. Wikidata (CC0) needs a different credit; the catalogue
   * fallback and the live API are both BGG. U.bggBadge() is the shared mark. */
  function bggAttribution() {
    if (BGG.usingWikidata()) {
      return '<p class="bgg-attrib">' +
        '<a href="https://www.wikidata.org" target="_blank" rel="noopener noreferrer">' +
          'Game data from Wikidata (CC0)' +
        '</a></p>';
    }
    return '<p class="bgg-attrib">' + U.bggBadge() + '</p>';
  }

  /* Categories for ANY game in the listing -- searched or hand-entered. A
   * searched game is pre-seeded from its own data (Wikidata's genres, folded
   * onto our taxonomy), and the seller can fix or add to them here; that's the
   * cure for "the categories are all wrong". Without categories a listing never
   * matches a category filter, so this is worth surfacing on every entry. */
  function categoryHtml(e, i) {
    var chosen = e.categories || [];
    return '<div class="field">' +
      '<span>Categories <em>optional</em></span>' +
      '<select class="e-cat-add">' +
        '<option value="">Add a category…</option>' +
        CFG.CATEGORIES.filter(function (c) { return chosen.indexOf(c) === -1; })
          .map(function (c) {
            return '<option value="' + U.attr(c) + '">' + U.esc(c) + '</option>';
          }).join('') +
      '</select>' +
      (chosen.length
        ? '<div class="chip-row tight" style="margin-top:.4rem">' +
            chosen.map(function (c) {
              return '<button class="chip on" data-rmcat="' + U.attr(c) + '">' +
                U.esc(c) + ' <span class="x">&times;</span></button>';
            }).join('') +
          '</div>'
        : '') +
      '<span class="fine">Without these, this listing won\'t show up when someone ' +
        'filters by category.</span>' +
    '</div>';
  }

  /* ---- Lots (Phase 3) -----------------------------------------------------
   * "It's a collector's edition with two expansions in the box" is one item
   * with one price, so it is one entry with contents — not three entries. */
  function lotHtml(e, i) {
    var contents = e.contents || [];
    return '<div class="field lot-field">' +
      '<span>Also in this lot <em>optional</em></span>' +
      (contents.length
        ? '<div class="lot-list">' + contents.map(function (c, ci) {
            var role = CFG.LOT_ROLES.filter(function (r) { return r.key === c.role; })[0];
            return '<div class="lot-item">' +
              '<div class="grow">' +
                '<strong>' + U.esc(c.name) + '</strong>' +
                '<span class="fine">' + U.esc(role ? role.label : c.role) +
                  (c.bggId ? ' \u00b7 BGG #' + U.esc(c.bggId) : ' \u00b7 entered by hand') +
                '</span>' +
              '</div>' +
              '<button class="icon-btn danger" data-rmcontent="' + ci + '" ' +
                'aria-label="Remove from lot">&times;</button>' +
            '</div>';
          }).join('') + '</div>'
        : '') +
      (contents.length < CFG.MAX_LOT_CONTENTS
        ? '<button class="btn ghost small" data-addlot="' + i + '">' +
            (contents.length ? 'Add another' : 'Add an expansion or extra') +
          '</button>'
        : '<p class="fine">That\'s the most a single lot can hold.</p>') +
      (contents.length
        ? '<span class="fine">These sell together as one item at the price above \u2014 ' +
          'nobody can request just part of the lot.</span>'
        : '<span class="fine">For a collector\'s edition or a base game bundled with ' +
          'its expansions.</span>') +
    '</div>';
  }

  /* Adding to a lot reuses the same BGG-or-manual split as the main game
   * picker, so it degrades identically when BGG is unavailable. */
  function openLotAdd(entryIndex) {
    var entry = draft.entries[entryIndex];
    var m = U.modal('Add to this lot',
      (BGG.available()
        ? '<label class="field"><span>Search for a game</span>' +
            '<input id="lot-q" type="search" autocomplete="off" ' +
              'placeholder="Start typing an expansion name"></label>' +
          '<div id="lot-results" class="bgg-results" hidden></div>' +
          '<p class="fine">Or add it by hand below.</p>'
        : '') +
      '<label class="field"><span>Name</span>' +
        '<input id="lot-name" type="text" maxlength="120" placeholder="Wolfenstein: The Board Game – Ghost Files"></label>' +
      '<label class="field"><span>What is it?</span>' +
        '<select id="lot-role">' +
          CFG.LOT_ROLES.map(function (r) {
            return '<option value="' + U.attr(r.key) + '">' + U.esc(r.label) + '</option>';
          }).join('') +
        '</select></label>' +
      '<div class="modal-actions">' +
        '<button class="btn ghost" data-act="cancel">Cancel</button>' +
        '<button class="btn" data-act="add">Add to lot</button>' +
      '</div>');

    var picked = null;

    if (BGG.available()) {
      var q = U.$('#lot-q', m.el);
      var results = U.$('#lot-results', m.el);
      q.addEventListener('input', U.debounce(function () {
        var text = q.value.trim();
        if (text.length < 2) { results.hidden = true; results.innerHTML = ''; return; }
        results.hidden = false;
        results.innerHTML = U.spinner('Searching');
        BGG.search(text).then(function (rows) {
          if (q.value.trim() !== text) return;
          if (!rows.length) { results.innerHTML = '<p class="fine pad">No matches.</p>'; return; }
          results.innerHTML = rows.map(function (r) {
            return '<button class="bgg-row" data-lotpick="' + U.attr(r.bggId) + '" ' +
              'data-name="' + U.attr(r.name) + '"><strong>' + U.esc(r.name) + '</strong>' +
              (r.yearPublished ? '<span class="year">' + U.esc(r.yearPublished) + '</span>' : '') +
              '</button>';
          }).join('');
        });
      }, 450));

      U.on(results, '[data-lotpick]', function (e, t) {
        picked = { bggId: t.dataset.lotpick, name: t.dataset.name };
        U.$('#lot-name', m.el).value = t.dataset.name;
        results.hidden = true;
        /* Pull categories in the background so the lot's contents contribute
         * to filtering just as the headline game does. */
        BGG.details(picked.bggId).then(function (game) {
          if (game) gamesById[String(picked.bggId)] = game;
        });
      });
    }

    U.on(m.el, '[data-act]', function (e, t) {
      if (t.dataset.act === 'cancel') { m.close(); return; }
      var name = U.$('#lot-name', m.el).value.trim();
      if (!name) { U.toast('Give it a name', 'warn'); return; }

      var bggId = picked && picked.name === name ? picked.bggId : null;
      if (entry.contents.some(function (c) {
        return (bggId && String(c.bggId) === String(bggId)) ||
          (!bggId && c.name.toLowerCase() === name.toLowerCase());
      })) {
        U.toast('That is already in this lot', 'warn');
        return;
      }

      entry.contents.push({
        bggId: bggId,
        name: name,
        role: U.$('#lot-role', m.el).value,
        categories: []
      });
      m.close();
      drawEntries();
    });
  }

  function entryHtml(e, i) {
    var game = e.bggId ? gamesById[String(e.bggId)] : null;
    var suggested = game && typeof game.suggestedPrice === 'number' ? game.suggestedPrice : null;
    var box = U.safeUrl(game && game.imageUrl);

    return '<div class="entry-edit" data-i="' + i + '">' +
      '<div class="entry-edit-head">' +
        (box ? '<img class="boxart sm" src="' + U.attr(box) + '" alt="" referrerpolicy="no-referrer">' : '') +
        '<div class="grow">' +
          (e.bggId
            ? '<strong>' + U.esc(e.name) + '</strong>' +
              (game && game.yearPublished ? ' <span class="year">(' + game.yearPublished + ')</span>' : '') +
              '<div class="fine">BGG #' + U.esc(e.bggId) + '</div>'
            : '<input class="e-name" type="text" maxlength="120" placeholder="Game title" ' +
              'value="' + U.attr(e.name) + '">' +
              '<div class="fine">Entered manually.</div>') +
        '</div>' +
        (draft.entries.length > 1
          ? '<button class="icon-btn danger" data-remove="' + i + '" aria-label="Remove this game">&times;</button>'
          : '') +
      '</div>' +

      '<div class="row2">' +
        '<label class="field">' +
          '<span>Asking price</span>' +
          '<input class="e-price" type="number" min="0" step="1" inputmode="decimal" ' +
            'placeholder="Open to offers" value="' +
            (typeof e.askingPrice === 'number' ? U.attr(e.askingPrice) : '') + '">' +
          (suggested
            ? '<span class="fine">' +
                ((e.contents || []).length
                  ? 'Everything in this lot is worth about ' + U.esc(U.money(lotValue(e))) +
                    ' on the BGG marketplace.'
                  : 'BGG marketplace sits around ' + U.esc(U.money(suggested)) + '.') +
                ' Price under it and this shows up in the Good Deal sort.</span>'
            : '') +
        '</label>' +
        '<label class="field">' +
          '<span>Condition</span>' +
          '<select class="e-cond">' +
            CFG.CONDITIONS.map(function (c) {
              return '<option value="' + U.attr(c.key) + '"' + (e.condition === c.key ? ' selected' : '') + '>' +
                U.esc(c.key) + ' — ' + U.esc(c.label) + '</option>';
            }).join('') +
          '</select>' +
          '<span class="fine">' + U.esc(CFG.condition(e.condition).blurb) + '</span>' +
        '</label>' +
      '</div>' +

      lotHtml(e, i) +

      categoryHtml(e, i) +

      '<div class="field">' +
        '<span>Tags</span>' +
        '<div class="chip-row tight">' +
          CFG.TAGS.map(function (t) {
            return '<button class="chip' + (e.tags.indexOf(t) !== -1 ? ' on' : '') +
              '" data-etag="' + U.attr(t) + '">' + U.esc(t) + '</button>';
          }).join('') +
        '</div>' +
      '</div>' +

      '<label class="field">' +
        '<span>Notes <em>optional</em></span>' +
        '<textarea class="e-notes" maxlength="500" rows="2" ' +
          'placeholder="Anything a buyer should know — missing bits, box wear, what\'s included">' +
          U.esc(e.notes) + '</textarea>' +
      '</label>' +

      '<div class="field">' +
        '<span>Photos <em>' + e.photos.length + '/' + CFG.PHOTO.maxPerEntry + '</em></span>' +
        '<div class="shots edit">' +
          e.photos.map(function (p, pi) {
            var safe = U.safeUrl(p);
            return '<div class="shot' + (safe ? '' : ' noimg') + '"' +
              (safe ? ' style="background-image:url(' + U.attr(safe) + ')"' : '') + '>' +
              '<button class="shot-x" data-rmphoto="' + pi + '" aria-label="Remove photo">&times;</button>' +
            '</div>';
          }).join('') +
          (e.photos.length < CFG.PHOTO.maxPerEntry
            ? '<label class="shot add"><input type="file" accept="image/*" class="e-photo" multiple hidden>' +
              '<span>+</span></label>'
            : '') +
        '</div>' +
        '<span class="fine">Photos of the actual copy sell it. Box art is filled in automatically.</span>' +
      '</div>' +
    '</div>';
  }

  /* ---- Wiring ------------------------------------------------------------ */

  /* ---- Events (M9) --------------------------------------------------------
   * Selecting "in person at an event" is a third fulfillment option, not a
   * location hack. It copies the event's dates onto the listing so hold timing
   * can react to them without a second lookup. */
  function eventPickerHtml() {
    if (!draft.fulfillment.inPersonAtEvent) return '';
    return '<div class="event-pick">' +
      (draft.eventId
        ? '<div class="event-chosen">' +
            '<div class="grow">' +
              '<strong>' + U.esc(draft.eventName || 'Event') + '</strong>' +
              '<span class="fine">' + U.esc(eventDatesLabel(draft)) + '</span>' +
            '</div>' +
            '<button class="btn ghost small" data-ev="change">Change</button>' +
          '</div>' +
          '<p class="fine">Holds on this listing don\'t start ticking until the event ' +
            'begins, then compress to ' + CFG.EVENT.holdHours + ' hours so the queue ' +
            'keeps moving while you\'re there.</p>'
        : '<button class="btn ghost small" data-ev="pick">Choose an event</button>' +
          '<p class="fine">Required for in-person selling.</p>') +
    '</div>';
  }

  function eventDatesLabel(d) {
    var a = U.toDate(d.eventStartDate), b = U.toDate(d.eventEndDate);
    if (!a || !b) return '';
    var opts = { month: 'short', day: 'numeric' };
    var same = a.toDateString() === b.toDateString();
    return same
      ? a.toLocaleDateString(undefined, opts)
      : a.toLocaleDateString(undefined, opts) + ' \u2013 ' +
        b.toLocaleDateString(undefined, Object.assign({ year: 'numeric' }, opts));
  }

  function refreshEventPicker() {
    var host = U.$('#event-picker');
    if (host) host.innerHTML = eventPickerHtml();
  }

  function openEventPicker() {
    var m = U.modal('Which event?', U.spinner('Loading events'));
    Store.listEvents().then(function (events) {
      m.el.innerHTML =
        (events.length
          ? '<div class="event-list">' + events.map(function (e) {
              return '<button class="event-row" data-pick="' + U.attr(e.id) + '">' +
                '<div class="grow">' +
                  '<strong>' + U.esc(e.name) + '</strong>' +
                  '<span class="fine">' + U.esc(e.venue || '') +
                    (e.venue ? ' \u00b7 ' : '') +
                    U.esc(eventDatesLabel({ eventStartDate: e.startDate, eventEndDate: e.endDate })) +
                  '</span>' +
                '</div>' +
              '</button>';
            }).join('') + '</div>'
          : '<p class="fine">No upcoming events yet. Create the one you\'re going to.</p>') +
        '<div class="modal-actions">' +
          '<button class="btn ghost" data-act="new">Create an event</button>' +
        '</div>' +
        '<p class="fine">Anyone can add an event \u2014 there\'s no approval queue. ' +
          'Duplicates and spam get reported the same way listings do.</p>';

      U.on(m.el, '[data-pick]', function (e, t) {
        var ev = events.filter(function (x) { return x.id === t.dataset.pick; })[0];
        if (!ev) return;
        chooseEvent(ev);
        m.close();
      });
      U.on(m.el, '[data-act="new"]', function () { m.close(); openEventCreate(); });
    });
  }

  function chooseEvent(ev) {
    draft.eventId = ev.id;
    draft.eventName = ev.name;
    draft.eventStartDate = ev.startDate;
    draft.eventEndDate = ev.endDate;
    refreshEventPicker();
  }

  function openEventCreate() {
    var today = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var iso = function (d) {
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    };
    var m = U.modal('New event',
      '<label class="field"><span>Name</span>' +
        '<input id="ev-name" type="text" maxlength="80" placeholder="PAX Unplugged 2026"></label>' +
      '<label class="field"><span>Venue <em>optional</em></span>' +
        '<input id="ev-venue" type="text" maxlength="120" placeholder="Pennsylvania Convention Center"></label>' +
      '<div class="row2">' +
        '<label class="field"><span>First day</span>' +
          '<input id="ev-start" type="date" value="' + U.attr(iso(today)) + '"></label>' +
        '<label class="field"><span>Last day</span>' +
          '<input id="ev-end" type="date" value="' + U.attr(iso(today)) + '"></label>' +
      '</div>' +
      '<p class="fine">Dates are read in your own timezone. For a multi-day con that ' +
        'is close enough \u2014 they decide when holds start and stop ticking, not when ' +
        'anyone has to be somewhere.</p>' +
      '<div class="modal-actions">' +
        '<button class="btn ghost" data-act="cancel">Cancel</button>' +
        '<button class="btn" data-act="create">Create</button>' +
      '</div>');

    U.on(m.el, '[data-act]', function (e, t) {
      if (t.dataset.act === 'cancel') { m.close(); return; }
      var name = U.$('#ev-name', m.el).value.trim();
      var startStr = U.$('#ev-start', m.el).value;
      var endStr = U.$('#ev-end', m.el).value;
      if (!name) { U.toast('The event needs a name', 'warn'); return; }
      if (!startStr || !endStr) { U.toast('Both dates are required', 'warn'); return; }

      /* Local midnight to local end-of-day, so a whole final day counts as
       * "during the event" rather than ending at 00:00 on it. */
      var start = new Date(startStr + 'T00:00:00');
      var end = new Date(endStr + 'T23:59:59');
      if (end < start) { U.toast('The last day is before the first', 'warn'); return; }

      var days = (end - start) / 86400000;
      if (days > CFG.EVENT.maxDays) {
        U.toast('That is longer than ' + CFG.EVENT.maxDays + ' days \u2014 is it really one event?', 'warn');
        return;
      }
      var monthsAhead = (start - Date.now()) / (30.44 * 86400000);
      if (monthsAhead > CFG.EVENT.maxMonthsAhead) {
        U.toast('That is more than ' + CFG.EVENT.maxMonthsAhead + ' months away \u2014 check the year', 'warn');
        return;
      }
      if (end < new Date()) { U.toast('That event has already finished', 'warn'); return; }

      t.disabled = true;
      t.textContent = 'Creating\u2026';
      Store.createEvent({
        name: name,
        venue: U.$('#ev-venue', m.el).value.trim(),
        startDate: start,
        endDate: end,
        timeZone: TimeSlots.currentZone()
      }).then(function (id) {
        m.close();
        chooseEvent({ id: id, name: name, startDate: start, endDate: end });
        U.toast('Event created');
      }).catch(function (err) {
        console.error('[tabled] event create failed', err);
        U.toast('Could not create that event', 'bad');
        t.disabled = false;
        t.textContent = 'Create';
      });
    });
  }

  function wire(root) {
    U.on(root, '[data-ful]', function (e, t) {
      if (t.disabled) return;
      var k = t.dataset.ful;
      draft.fulfillment[k] = !draft.fulfillment[k];
      t.classList.toggle('on', draft.fulfillment[k]);
      if (k === 'inPersonAtEvent') {
        /* Turning it off clears the event rather than leaving a stale one
         * attached to a listing that no longer claims to be at a con. */
        if (!draft.fulfillment[k]) {
          draft.eventId = draft.eventName = null;
          draft.eventStartDate = draft.eventEndDate = null;
        }
        refreshEventPicker();
      }
    });

    U.on(root, '[data-pay]', function (e, t) {
      var k = t.dataset.pay;
      draft.acceptedPayment[k] = !draft.acceptedPayment[k];
      t.classList.toggle('on', draft.acceptedPayment[k]);
    });

    U.on(root, '[data-ev]', function (e, t) {
      if (t.dataset.ev === 'pick' || t.dataset.ev === 'change') openEventPicker();
    });

    /* ---- Entry fields (delegated; no re-render on typing) ---- */
    var host = U.$('#entries', root);

    host.addEventListener('input', function (e) {
      var block = e.target.closest('.entry-edit');
      if (!block) return;
      var entry = draft.entries[Number(block.dataset.i)];
      if (!entry) return;
      if (e.target.classList.contains('e-name')) entry.name = e.target.value;
      else if (e.target.classList.contains('e-notes')) entry.notes = e.target.value;
      else if (e.target.classList.contains('e-price')) {
        var v = e.target.value.trim();
        entry.askingPrice = v === '' ? null : Number(v);
      }
    });

    host.addEventListener('change', function (e) {
      var block = e.target.closest('.entry-edit');
      if (!block) return;
      var idx = Number(block.dataset.i);
      var entry = draft.entries[idx];
      if (!entry) return;

      if (e.target.classList.contains('e-cond')) {
        entry.condition = e.target.value;
        var hint = e.target.parentNode.querySelector('.fine');
        if (hint) hint.textContent = CFG.condition(entry.condition).blurb;
      } else if (e.target.classList.contains('e-cat-add')) {
        var cat = e.target.value;
        if (cat && entry.categories.indexOf(cat) === -1) {
          entry.categories.push(cat);
          drawEntries();
        }
      } else if (e.target.classList.contains('e-photo')) {
        addPhotos(idx, e.target.files);
        e.target.value = '';
      }
    });

    U.on(host, '[data-etag]', function (e, t) {
      var block = t.closest('.entry-edit');
      var entry = draft.entries[Number(block.dataset.i)];
      var tag = t.dataset.etag;
      var i = entry.tags.indexOf(tag);
      if (i === -1) entry.tags.push(tag); else entry.tags.splice(i, 1);
      t.classList.toggle('on', i === -1);
    });

    U.on(host, '[data-addlot]', function (e, t) {
      openLotAdd(Number(t.dataset.addlot));
    });

    U.on(host, '[data-rmcontent]', function (e, t) {
      var block = t.closest('.entry-edit');
      var entry = draft.entries[Number(block.dataset.i)];
      entry.contents.splice(Number(t.dataset.rmcontent), 1);
      drawEntries();
    });

    U.on(host, '[data-rmcat]', function (e, t) {
      var block = t.closest('.entry-edit');
      var entry = draft.entries[Number(block.dataset.i)];
      var i = entry.categories.indexOf(t.dataset.rmcat);
      if (i !== -1) { entry.categories.splice(i, 1); drawEntries(); }
    });

    U.on(host, '[data-remove]', function (e, t) {
      draft.entries.splice(Number(t.dataset.remove), 1);
      drawEntries();
    });

    U.on(host, '[data-rmphoto]', function (e, t) {
      var block = t.closest('.entry-edit');
      var entry = draft.entries[Number(block.dataset.i)];
      entry.photos.splice(Number(t.dataset.rmphoto), 1);
      drawEntries();
    });

    /* ---- BGG autocomplete ---- */
    var q = U.$('#bgg-q', root);
    var results = U.$('#bgg-results', root);
    if (!q || !results) {
      /* BGG unavailable: only the manual button exists. */
      var addBtn = U.$('#add-manual', root);
      if (addBtn) addBtn.addEventListener('click', function () { pushEntry(blankEntry()); });
      U.$('#save', root).addEventListener('click', save);
      return;
    }

    /* Debounced hard. BGG's rate limits are real and undocumented; a search per
     * keystroke is the fastest way to get an app blocked by them. */
    q.addEventListener('input', U.debounce(function () {
      var text = q.value.trim();
      if (text.length < 2) { results.hidden = true; results.innerHTML = ''; return; }
      results.hidden = false;
      results.innerHTML = U.spinner('Searching games');
      BGG.search(text).then(function (rows) {
        if (q.value.trim() !== text) return;   /* a newer query already won */
        if (!rows.length) {
          results.innerHTML = '<p class="fine pad">No matches. You can still add it manually.</p>';
          return;
        }
        results.innerHTML = rows.map(function (r) {
          return '<button class="bgg-row" data-bgg="' + U.attr(r.bggId) + '" ' +
            'data-name="' + U.attr(r.name) + '">' +
            '<strong>' + U.esc(r.name) + '</strong>' +
            (r.yearPublished ? '<span class="year">' + U.esc(r.yearPublished) + '</span>' : '') +
          '</button>';
        }).join('');
      });
    }, 450));

    U.on(results, '[data-bgg]', function (e, t) {
      addFromBgg(t.dataset.bgg, t.dataset.name);
      q.value = '';
      results.hidden = true;
      results.innerHTML = '';
    });

    U.$('#add-manual', root).addEventListener('click', function () {
      pushEntry(blankEntry());
    });

    U.$('#save', root).addEventListener('click', save);
  }

  /* An empty first row is a placeholder, not data — fill it rather than
   * stacking a second blank block underneath it. */
  function pushEntry(entry) {
    var first = draft.entries[0];
    if (draft.entries.length === 1 && !first.bggId && !first.name && !first.photos.length) {
      draft.entries[0] = entry;
    } else {
      draft.entries.push(entry);
    }
    drawEntries();
  }

  function addFromBgg(bggId, name) {
    if (draft.entries.some(function (e) { return String(e.bggId) === String(bggId); })) {
      U.toast('That game is already in this listing', 'warn');
      return;
    }
    pushEntry(blankEntry({ bggId: String(bggId), name: name }));
    /* Details fill in asynchronously — box art, categories, suggested price.
     * The entry is usable immediately; the redraw just enriches it. */
    BGG.details(bggId).then(function (game) {
      if (!game) return;
      gamesById[String(bggId)] = game;
      draft.entries.forEach(function (e) {
        if (String(e.bggId) !== String(bggId)) return;
        if (!e.name) e.name = game.name;
        /* Seed the category chips from the game's data (already normalized to
         * our taxonomy) so the seller starts from something real and edits from
         * there. Only seed an empty set -- never clobber a seller's own edits
         * on a later redraw. */
        if (!(e.categories && e.categories.length) && game.categories && game.categories.length) {
          e.categories = CFG.normalizeCategories(game.categories);
        }
      });
      drawEntries();
    });
  }

  function addPhotos(idx, fileList) {
    var entry = draft.entries[idx];
    var files = Array.prototype.slice.call(fileList || []);
    var room = CFG.PHOTO.maxPerEntry - entry.photos.length;
    if (room <= 0) return;
    if (files.length > room) {
      U.toast('Only ' + U.plural(room, 'photo') + ' left for this game', 'warn');
      files = files.slice(0, room);
    }

    U.toast('Processing ' + U.plural(files.length, 'photo') + '…');
    /* Sequential, not parallel: resizing decodes a full-resolution bitmap, and
     * six of those at once will kill a phone browser tab. */
    files.reduce(function (chain, file) {
      return chain.then(function () {
        return U.resizeImage(file)
          .then(function (blob) { return Store.uploadPhoto(blob); })
          .then(function (url) { entry.photos.push(url); })
          .catch(function (err) {
            console.error('[tabled] photo failed', err);
            U.toast('One photo could not be added', 'bad');
          });
      });
    }, Promise.resolve()).then(function () {
      drawEntries();
    });
  }

  /* ---- Save -------------------------------------------------------------- */

  function validate() {
    var real = draft.entries.filter(function (e) { return e.bggId || (e.name || '').trim(); });
    if (!real.length) return 'Add at least one game.';
    if (!draft.fulfillment.pickup && !draft.fulfillment.inPersonAtEvent) {
      return 'Pick at least one way buyers can get it.';
    }
    if (draft.fulfillment.pickup && !(Store.me().generalArea || '').trim()) {
      return 'Set your general area in your profile before posting a pickup listing.';
    }
    if (draft.fulfillment.inPersonAtEvent && !draft.eventId) {
      return 'Pick an event, or create one, for in-person selling.';
    }
    var bad = real.filter(function (e) {
      return e.askingPrice !== null && (isNaN(e.askingPrice) || e.askingPrice < 0);
    });
    if (bad.length) return 'Prices have to be a number, or blank for "open to offers".';
    return null;
  }

  function save() {
    if (busy) return;
    var problem = validate();
    if (problem) { U.toast(problem, 'warn'); return; }

    busy = true;
    var btn = U.$('#save');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    var me = Store.me();
    var entries = draft.entries.filter(function (e) { return e.bggId || (e.name || '').trim(); });

    resolveLocation()
      .then(function () {
        return Store.saveListing(editingId, {
          sellerId: Store.uid(),
          sellerName: me.displayName,
          sellerPhoto: me.photoURL || null,
          title: draft.title.trim(),
          fulfillment: draft.fulfillment,
          locationLabel: draft.locationLabel.trim(),
          geoPoint: draft.geoPoint,
          geohash: draft.geohash,
          eventId: draft.eventId,
          eventName: draft.eventName,
          eventStartDate: draft.eventStartDate,
          eventEndDate: draft.eventEndDate,
          acceptedPayment: draft.acceptedPayment,
          countryCode: draft.countryCode || null,
          state: draft.state || null,
          status: 'active'
        }, entries, gamesById);
      })
      .then(function (id) {
        U.toast(editingId ? 'Listing updated' : 'Listing posted');
        App.go('listing', { id: id });
      })
      .catch(function (err) {
        console.error('[tabled] save failed', err);
        U.toast('Could not save that listing', 'bad');
        busy = false;
        btn.disabled = false;
        btn.textContent = editingId ? 'Save changes' : 'Post listing';
      });
  }

  /* Location comes from the seller's profile, never this form. The profile area
   * was geocoded and fuzzed once, when they set it, so every one of a seller's
   * listings shares that single point. That's deliberate: re-geocoding each
   * listing would jitter it independently, and averaging a seller's listings
   * could then recover their true location. Onboarding guarantees a new account
   * has set an area before it can ever reach this form, and the area was
   * already validated US-only at that point, so there's no geocoding — and no
   * out-of-region case — here. */
  function resolveLocation() {
    var me = Store.me();
    draft.locationLabel = me.generalArea || '';
    draft.geoPoint = me.geoPoint || null;
    draft.geohash = me.geohash || null;
    draft.countryCode = me.countryCode || null;
    draft.state = me.state || null;
    return Promise.resolve();
  }

  return { render: render };
})();
