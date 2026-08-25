/* Tabled — Browse / Feed and Search results (M1 + M3).
 *
 * One view serves both. A search is just the feed with `q` set, and an event
 * feed is just the feed with `eventId` set, so there is a single card grid, a
 * single filter model, and a single pagination path rather than three that
 * drift apart.
 *
 * Filter state lives in the URL hash, not in a module variable. That's what
 * makes the browser Back button return you to the filtered feed you came from
 * instead of an unfiltered one — the single most common complaint about
 * marketplace apps that keep filters in memory.
 */
window.Feed = (function () {

  var state = null;      /* the params this render is showing */
  var cursor = null;
  var exhausted = false;
  var loading = false;
  var items = [];

  /* ---- Facet model (include / exclude) ------------------------------------
   * Every filter is a facet whose URL value is a comma-joined list of tokens; a
   * leading '!' means exclude. "Fantasy,!Wargame" = include Fantasy, exclude
   * Wargame. parseFacet turns that into { inc, exc }; facetToStr goes back. */
  function parseFacet(str) {
    var inc = [], exc = [];
    String(str || '').split(',').filter(Boolean).forEach(function (t) {
      if (t.charAt(0) === '!') exc.push(t.slice(1)); else inc.push(t);
    });
    return { inc: inc, exc: exc };
  }
  function facetToStr(f) {
    return f.inc.concat(f.exc.map(function (x) { return '!' + x; })).join(',');
  }
  function mapVal(v) { return { v: v, label: v }; }

  /* The six include/exclude facets. Category and Mechanic are long, so they get
   * a search box; the rest are short chip rows. */
  var FACETS = [
    { key: 'category', label: 'Category', search: true,
      hint: 'Themes from BoardGameGeek — what the game is about.',
      opts: function () { return CFG.CATEGORIES.map(mapVal); } },
    { key: 'mechanic', label: 'Mechanic', search: true,
      hint: 'How it plays — worker placement, tile laying, deck building…',
      opts: function () { return CFG.MECHANICS.map(mapVal); } },
    { key: 'condition', label: 'Condition',
      opts: function () { return CFG.CONDITIONS.map(function (c) {
        return { v: c.key, label: c.key + ' · ' + c.label, title: c.blurb }; }); } },
    { key: 'fulfillment', label: 'Fulfillment',
      opts: function () { return CFG.FULFILLMENT.map(function (f) {
        return { v: f.key, label: f.label }; }); } },
    { key: 'payment', label: 'Payment accepted',
      opts: function () { return CFG.PAYMENT.map(function (pm) {
        return { v: pm.key, label: pm.label }; }); } },
    { key: 'tags', label: 'Tags',
      opts: function () { return CFG.TAGS.map(mapVal); } }
  ];
  function facetLabel(k, v) {
    if (k === 'condition') { var c = CFG.condition(v); return c ? c.label : v; }
    if (k === 'fulfillment') { var f = CFG.FULFILLMENT.filter(function (x) { return x.key === v; })[0]; return f ? f.label : v; }
    if (k === 'payment') { var pm = CFG.PAYMENT.filter(function (x) { return x.key === v; })[0]; return pm ? pm.label : v; }
    return v;
  }

  /* ---- Card -------------------------------------------------------------- */

  /* Rendered from the listing's denormalized rollup only — never from the
   * gameEntries subcollection. A feed of 24 cards must cost 24 document reads,
   * not 24 + one subcollection query each. */
  function card(l) {
    var cover = U.safeUrl(l.coverPhoto);
    var names = l.gameNames || [];
    var titleLine = l.title || names[0] || 'Untitled listing';
    var extra = names.length > 1 ? ' <span class="plus">+' + (names.length - 1) + ' more</span>' : '';
    var price = priceLabel(l);
    /* A sold (archived) card is a record, not an offer: dim it, badge it
     * "Sold", and drop the deal badge -- how far under BGG it once was is noise
     * once it's gone. It still links through to the (now read-only) listing. */
    var sold = l.status === 'archived';
    var deal = (!sold && l.bestDealScore > 0.12)
      ? '<span class="badge deal">' + Math.round(l.bestDealScore * 100) + '% under BGG</span>'
      : '';
    var soldBadge = sold ? '<span class="badge sold">Sold</span>' : '';
    var dist = (typeof l._distanceMi === 'number')
      ? Geo.describeDistance(l._distanceMi)
      : (l.locationLabel || '');

    return '<a class="card' + (sold ? ' is-sold' : '') + '" href="#/listing/' + U.attr(l.id) + '">' +
      '<div class="card-photo' + (cover ? '' : ' noimg') + '"' +
        (cover ? ' style="' + U.bgurl(cover) + '"' : '') + '>' +
        (cover ? '' : '<span class="noimg-mark">' + U.esc(U.initials(titleLine)) + '</span>') +
        (deal || soldBadge ? '<div class="card-badges">' + soldBadge + deal + '</div>' : '') +
      '</div>' +
      '<div class="card-body">' +
        '<h3 class="card-title">' + U.esc(titleLine) + extra + '</h3>' +
        '<div class="card-meta">' +
          '<span class="price">' + price + '</span>' +
          (l.conditions && l.conditions.length
            ? '<span class="cond">' + U.esc(CFG.condition(l.conditions[0]).key) +
              (l.conditions.length > 1 ? '+' : '') + '</span>' : '') +
        '</div>' +
        '<div class="card-sub">' +
          '<span>' + U.esc(l.sellerName || 'Seller') + '</span>' +
          /* Sold cards drop distance (you can't go get it) and show when it
           * sold rather than when it was posted. */
          (sold
            ? '<span class="dot">·</span><span>Sold ' + U.esc(U.ago(l.updatedAt || l.createdAt)) + '</span>'
            : (dist ? '<span class="dot">·</span><span>' + U.esc(dist) + '</span>' : '') +
              '<span class="dot">·</span><span>' + U.esc(U.ago(l.createdAt)) + '</span>') +
        '</div>' +
      '</div>' +
    '</a>';
  }

  /* Browse events. Deliberately a sheet rather than a route: it's a jump-off
   * point, not somewhere anyone wants to land via Back. */
  function openEvents() {
    var m = U.modal('Events', U.spinner('Loading events'));
    Store.listEvents().then(function (events) {
      if (!events.length) {
        m.el.innerHTML = U.empty('No events yet',
          'Events appear here once someone lists a game to sell at one.');
        return;
      }
      var now = Date.now();
      m.el.innerHTML = '<div class="event-list">' + events.map(function (e) {
        var start = U.toDate(e.startDate), end = U.toDate(e.endDate);
        var live = start && end && now >= start.getTime() && now <= end.getTime();
        return '<button class="event-row" data-open="' + U.attr(e.id) + '">' +
          '<div class="grow">' +
            '<strong>' + U.esc(e.name) + '</strong>' +
            '<span class="fine">' + (e.venue ? U.esc(e.venue) + ' \u00b7 ' : '') +
              U.esc(rangeLabel(start, end)) + '</span>' +
          '</div>' +
          (live ? '<span class="badge deal">On now</span>' : '') +
        '</button>';
      }).join('') + '</div>';

      U.on(m.el, '[data-open]', function (e, t) {
        m.close();
        App.go('feed', { eventId: t.dataset.open, sort: 'new' });
      });
    });
  }

  function priceLabel(l) {
    if (typeof l.minPrice !== 'number') return '<span class="ask">Ask</span>';
    if (typeof l.maxPrice === 'number' && l.maxPrice !== l.minPrice) {
      return U.esc(U.money(l.minPrice)) + '–' + U.esc(U.money(l.maxPrice));
    }
    return U.esc(U.money(l.minPrice));
  }

  /* ---- Params <-> filters ------------------------------------------------ */

  /* The URL carries tags as a comma-joined list; everything else is scalar. */
  function toFilters(p) {
    var f = {
      q: p.q || '',
      sort: p.sort || 'new',
      category: parseFacet(p.category),
      mechanic: parseFacet(p.mechanic),
      condition: parseFacet(p.condition),
      fulfillment: parseFacet(p.fulfillment),
      payment: parseFacet(p.payment),
      tags: parseFacet(p.tags),
      sellerId: p.sellerId || '',
      eventId: p.eventId || '',
      near: null,
      limit: CFG.PAGE_SIZE
    };
    if (p.radius) {
      var me = Store.me();
      if (me && me.geoPoint) {
        f.near = { lat: me.geoPoint.lat, lng: me.geoPoint.lng, radiusMi: Number(p.radius) };
      }
    }
    return f;
  }

  function activeCount(p) {
    var n = 0;
    ['category', 'mechanic', 'condition', 'fulfillment', 'payment', 'tags'].forEach(function (k) {
      var f = parseFacet(p[k]); n += f.inc.length + f.exc.length;
    });
    if (p.radius) n++;
    return n;
  }

  /* ---- Render ------------------------------------------------------------ */

  function render(root, params) {
    state = params || {};
    cursor = null;
    exhausted = false;
    items = [];

    var n = activeCount(state);
    root.innerHTML =
      '<div id="event-header"></div>' +
      '<div class="feed-head">' +
        '<form class="searchbar" role="search">' +
          '<input type="search" name="q" placeholder="Search games — try &quot;wingspan&quot;" ' +
            'value="' + U.attr(state.q || '') + '" autocomplete="off">' +
          (state.q ? '<button type="button" class="clear-q" aria-label="Clear search">&times;</button>' : '') +
        '</form>' +
        '<div class="feed-tools">' +
          '<div class="sorts">' +
            CFG.SORTS.map(function (s) {
              var on = (state.sort || 'new') === s.key;
              return '<button class="pill' + (on ? ' on' : '') + '" data-sort="' + U.attr(s.key) + '">' +
                U.esc(s.label) + '</button>';
            }).join('') +
          '</div>' +
          '<button class="pill" data-events>Events</button>' +
          '<button class="pill filter-btn' + (n ? ' on' : '') + '" data-open-filters>' +
            'Filters' + (n ? ' <span class="count">' + n + '</span>' : '') +
          '</button>' +
        '</div>' +
        activeChips(state) +
      '</div>' +
      '<div class="grid" id="feed-grid">' + U.spinner('Loading listings') + '</div>' +
      '<div class="feed-foot" id="feed-foot"></div>';

    wire(root);
    if (state.eventId) drawEventHeader(root, state.eventId);
    load(true);
  }

  /* An event feed gets its venue and dates up top — this is the direct
   * replacement for a BGG forum thread, and the first thing anyone wants to
   * confirm is that they're looking at the right con. */
  function drawEventHeader(root, eventId) {
    var host = U.$('#event-header', root);
    if (!host) return;
    host.innerHTML = U.spinner('');

    Store.getEvent(eventId).then(function (ev) {
      if (!ev) { host.innerHTML = ''; return; }
      var start = U.toDate(ev.startDate), end = U.toDate(ev.endDate);
      var now = Date.now();
      var phase = !start || !end ? ''
        : (now < start.getTime() ? 'upcoming'
          : (now > end.getTime() ? 'over' : 'live'));

      host.innerHTML =
        '<div class="event-banner ' + U.attr(phase) + '">' +
          '<div class="grow">' +
            '<h1>' + U.esc(ev.name) + '</h1>' +
            '<p class="fine">' +
              (ev.venue ? U.esc(ev.venue) + ' \u00b7 ' : '') +
              U.esc(rangeLabel(start, end)) +
            '</p>' +
          '</div>' +
          (phase === 'live' ? '<span class="badge deal">On now</span>' : '') +
          (phase === 'over' ? '<span class="badge sold">Finished</span>' : '') +
          Safety.menuHtml('event', ev.id, ev.name, null) +
        '</div>' +
        (phase === 'over'
          ? '<div class="banner warn">This event has finished. In-person holds on ' +
            'these listings were released \u2014 sellers may still ship.</div>'
          : '');

      Safety.wireMenu(host, { sellerId: ev.id, sellerName: ev.name });
    }).catch(function () { host.innerHTML = ''; });
  }

  function rangeLabel(a, b) {
    if (!a || !b) return '';
    var o = { month: 'short', day: 'numeric' };
    if (a.toDateString() === b.toDateString()) {
      return a.toLocaleDateString(undefined, Object.assign({ year: 'numeric' }, o));
    }
    return a.toLocaleDateString(undefined, o) + ' \u2013 ' +
      b.toLocaleDateString(undefined, Object.assign({ year: 'numeric' }, o));
  }

  /* A row of removable chips for whatever is currently narrowing the feed. Cheap
   * to build and it prevents the classic "why is my feed empty" confusion when a
   * filter is set two screens away in a sheet. */
  function activeChips(p) {
    var chips = [];
    if (p.eventId) chips.push({ drop: 'eventId', t: 'At this event', exc: false });
    if (p.radius) chips.push({ drop: 'radius', t: 'Within ' + p.radius + ' mi', exc: false });
    ['category', 'mechanic', 'condition', 'fulfillment', 'payment', 'tags'].forEach(function (k) {
      var f = parseFacet(p[k]);
      f.inc.forEach(function (v) { chips.push({ drop: k + ':' + v, t: facetLabel(k, v), exc: false }); });
      f.exc.forEach(function (v) { chips.push({ drop: k + ':!' + v, t: 'not ' + facetLabel(k, v), exc: true }); });
    });
    if (!chips.length) return '';
    return '<div class="active-chips">' +
      chips.map(function (c) {
        return '<button class="chip on' + (c.exc ? ' exc' : '') + '" data-drop="' + U.attr(c.drop) + '">' +
          U.esc(c.t) + ' <span class="x">&times;</span></button>';
      }).join('') +
      '<button class="chip clear-all" data-drop="*">Clear all</button>' +
    '</div>';
  }

  function wire(root) {
    var form = U.$('.searchbar', root);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      App.go('feed', Object.assign({}, state, { q: form.q.value.trim() || undefined }));
    });
    var clear = U.$('.clear-q', root);
    if (clear) clear.addEventListener('click', function () {
      App.go('feed', Object.assign({}, state, { q: undefined }));
    });

    U.on(root, '[data-sort]', function (e, t) {
      App.go('feed', Object.assign({}, state, { sort: t.dataset.sort }));
    });

    U.on(root, '[data-open-filters]', function () { openFilters(); });
    U.on(root, '[data-events]', function () { openEvents(); });

    U.on(root, '[data-drop]', function (e, t) {
      var k = t.dataset.drop;
      var next = Object.assign({}, state);
      if (k === '*') {
        ['radius', 'category', 'mechanic', 'condition', 'fulfillment', 'tags', 'eventId', 'payment']
          .forEach(function (f) { delete next[f]; });
      } else if (k === 'eventId' || k === 'radius') {
        next[k] = undefined;
      } else {
        /* "facet:value" (include) or "facet:!value" (exclude) — drop that one. */
        var ci = k.indexOf(':');
        var facet = k.slice(0, ci), token = k.slice(ci + 1);
        var f = parseFacet(next[facet]);
        if (token.charAt(0) === '!') {
          var tv = token.slice(1); f.exc = f.exc.filter(function (x) { return x !== tv; });
        } else {
          f.inc = f.inc.filter(function (x) { return x !== token; });
        }
        var str = facetToStr(f);
        next[facet] = str || undefined;
      }
      App.go('feed', next);
    });
  }

  /* ---- Loading ----------------------------------------------------------- */

  function load(first) {
    if (loading || (!first && exhausted)) return;
    loading = true;
    var grid = U.$('#feed-grid');
    var foot = U.$('#feed-foot');
    if (!first) foot.innerHTML = U.spinner('');

    var f = toFilters(state);

    /* "Near me" needs a point to measure from. Rather than silently returning
     * nothing, say what's missing and link to the fix. */
    if (state.radius && !f.near) {
      loading = false;
      grid.innerHTML = U.empty('Set your general area first',
        'Distance search measures from the area on your profile.') +
        '<div class="center"><a class="btn" href="#/settings">Set my area</a></div>';
      foot.innerHTML = '';
      return;
    }

    Store.queryListings(f, cursor).then(function (page) {
      items = first ? page.items : items.concat(page.items);
      cursor = page.cursor;
      exhausted = page.exhausted;

      if (!items.length) {
        grid.innerHTML = U.empty(
          state.q ? 'No listings match “' + state.q + '”' : 'Nothing here yet',
          activeCount(state) ? 'Try widening or clearing your filters.'
                             : 'Be the first to list something.');
        foot.innerHTML = '';
      } else {
        grid.innerHTML = items.map(card).join('');
        /* Near-mode results are a bounded sample across 9 geohash cells rather
         * than a true cursor page, so there is deliberately no "load more"
         * there — offering one would show the same cards again. */
        foot.innerHTML = (!exhausted && !f.near)
          ? '<button class="btn ghost wide" id="more">Load more</button>'
          : (items.length >= CFG.PAGE_SIZE
              ? '<p class="fine center">That\'s everything matching these filters.</p>' : '');
        var more = U.$('#more');
        if (more) more.addEventListener('click', function () { load(false); });
      }
      loading = false;
    }).catch(function (err) {
      loading = false;
      console.error('[tabled] feed query failed', err);
      /* A missing composite index is the single most likely first-run failure
       * and Firestore puts the one-click fix in the error message, so surface
       * it rather than swallowing it into a generic error state. */
      var needsIndex = /index/i.test(err && err.message || '');
      grid.innerHTML = U.empty('Could not load listings',
        needsIndex
          ? 'Firestore needs a composite index for this filter combination. Open the browser console — the error contains a one-click link to create it.'
          : 'Check your connection and try again.');
      foot.innerHTML = '';
    });
  }

  /* ---- Filter sheet ------------------------------------------------------ */

  function facetGroupHtml(spec, p) {
    var f = parseFacet(p[spec.key]);
    return '<div class="filter-group">' +
      '<h4>' + U.esc(spec.label) + '</h4>' +
      (spec.hint ? '<p class="fine">' + U.esc(spec.hint) + '</p>' : '') +
      (spec.search
        ? '<input class="facet-search" data-fsearch="' + U.attr(spec.key) + '" type="search" ' +
          'placeholder="Filter ' + U.esc(spec.label.toLowerCase()) + '…" autocomplete="off">'
        : '') +
      '<div class="chip-row facet-chips" data-facet="' + U.attr(spec.key) + '">' +
        spec.opts().map(function (o) {
          var st = f.exc.indexOf(o.v) !== -1 ? ' exc' : (f.inc.indexOf(o.v) !== -1 ? ' inc' : '');
          return '<button class="chip fchip' + st + '" data-fv="' + U.attr(o.v) + '"' +
            (o.title ? ' title="' + U.attr(o.title) + '"' : '') + '>' + U.esc(o.label) + '</button>';
        }).join('') +
      '</div>' +
    '</div>';
  }

  function openFilters() {
    var p = state;
    var hasArea = !!(Store.me() && Store.me().geoPoint);

    var html =
      '<p class="filter-howto fine">Tap to <strong>include</strong>, double-tap to <strong>exclude</strong>.</p>' +
      '<div class="filter-group">' +
        '<h4>Distance</h4>' +
        (hasArea
          ? '<div class="chip-row">' +
              '<button class="chip' + (!p.radius ? ' on' : '') + '" data-f="radius" data-v="">Anywhere</button>' +
              CFG.RADII.map(function (r) {
                return '<button class="chip' + (String(p.radius) === String(r) ? ' on' : '') +
                  '" data-f="radius" data-v="' + r + '">' + r + ' mi</button>';
              }).join('') +
            '</div>' +
            '<p class="fine">Measured from ' + U.esc(Store.me().generalArea || 'your area') +
              '. Exact locations are never shown — everyone\'s point is deliberately fuzzed.</p>'
          : '<p class="fine">Add a general area to your profile to filter by distance. ' +
            '<a href="#/settings">Set it now</a></p>') +
      '</div>' +

      FACETS.map(function (spec) { return facetGroupHtml(spec, p); }).join('') +

      '<div class="modal-actions sticky">' +
        '<button class="btn ghost" data-act="reset">Clear all</button>' +
        '<button class="btn" data-act="apply">Show results</button>' +
      '</div>';

    var m = U.modal('Filters', html);
    var draft = Object.assign({}, p);      /* radius + passthrough */
    var draftFacets = {};
    FACETS.forEach(function (spec) { draftFacets[spec.key] = parseFacet(p[spec.key]); });

    /* Radius stays single-select (it's a range, not include/exclude). */
    U.on(m.el, '[data-f]', function (e, t) {
      var f = t.dataset.f;
      draft[f] = t.dataset.v || undefined;
      U.$$('[data-f="' + f + '"]', m.el).forEach(function (b) {
        b.classList.toggle('on', (b.dataset.v || '') === (draft[f] || ''));
      });
    });

    /* Single-tap = include, double-tap = exclude, tap-again = clear. The click
     * timer lets a second tap arrive and cancel the pending include. */
    function setChip(el, mode) {
      var key = el.parentNode.dataset.facet;
      var v = el.dataset.fv;
      var f = draftFacets[key];
      var wasInc = f.inc.indexOf(v) !== -1, wasExc = f.exc.indexOf(v) !== -1;
      f.inc = f.inc.filter(function (x) { return x !== v; });
      f.exc = f.exc.filter(function (x) { return x !== v; });
      if (mode === 'inc' && !wasInc) f.inc.push(v);
      if (mode === 'exc' && !wasExc) f.exc.push(v);
      el.classList.remove('inc', 'exc');
      if (f.inc.indexOf(v) !== -1) el.classList.add('inc');
      else if (f.exc.indexOf(v) !== -1) el.classList.add('exc');
    }
    var dblTimer = null;
    U.on(m.el, '.fchip', function (e, t) {
      var el = t; clearTimeout(dblTimer);
      dblTimer = setTimeout(function () { setChip(el, 'inc'); }, 250);
    }, 'click');
    U.on(m.el, '.fchip', function (e, t) {
      clearTimeout(dblTimer); setChip(t, 'exc');
    }, 'dblclick');

    /* Type to narrow a long chip list (category / mechanic). */
    U.on(m.el, '[data-fsearch]', function (e, t) {
      var key = t.dataset.fsearch, q = (t.value || '').toLowerCase();
      U.$$('.facet-chips[data-facet="' + key + '"] .fchip', m.el).forEach(function (c) {
        c.style.display = c.textContent.toLowerCase().indexOf(q) !== -1 ? '' : 'none';
      });
    }, 'input');

    /* A link inside the sheet (e.g. "Set it now" -> settings) closes it. */
    U.on(m.el, 'a[href^="#/"]', function () { m.close(); });

    U.on(m.el, '[data-act]', function (e, t) {
      if (t.dataset.act === 'reset') {
        m.close();
        var cleared = Object.assign({}, state);
        ['radius', 'category', 'mechanic', 'condition', 'fulfillment', 'tags', 'payment']
          .forEach(function (k) { delete cleared[k]; });
        App.go('feed', cleared);
        return;
      }
      FACETS.forEach(function (spec) {
        var str = facetToStr(draftFacets[spec.key]);
        draft[spec.key] = str || undefined;
      });
      m.close();
      App.go('feed', draft);
    });
  }

  return { render: render, card: card };
})();
