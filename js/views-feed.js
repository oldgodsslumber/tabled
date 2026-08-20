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
    var deal = l.bestDealScore > 0.12
      ? '<span class="badge deal">' + Math.round(l.bestDealScore * 100) + '% under BGG</span>'
      : '';
    var dist = (typeof l._distanceMi === 'number')
      ? Geo.describeDistance(l._distanceMi)
      : (l.locationLabel || '');

    return '<a class="card" href="#/listing/' + U.attr(l.id) + '">' +
      '<div class="card-photo' + (cover ? '' : ' noimg') + '"' +
        (cover ? ' style="background-image:url(' + U.attr(cover) + ')"' : '') + '>' +
        (cover ? '' : '<span class="noimg-mark">' + U.esc(U.initials(titleLine)) + '</span>') +
        (deal ? '<div class="card-badges">' + deal + '</div>' : '') +
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
          (dist ? '<span class="dot">·</span><span>' + U.esc(dist) + '</span>' : '') +
          '<span class="dot">·</span><span>' + U.esc(U.ago(l.createdAt)) + '</span>' +
        '</div>' +
      '</div>' +
    '</a>';
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
      category: p.category || '',
      condition: p.condition || '',
      fulfillment: p.fulfillment || '',
      tags: p.tags ? String(p.tags).split(',').filter(Boolean) : [],
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
    ['category', 'condition', 'fulfillment', 'radius'].forEach(function (k) { if (p[k]) n++; });
    if (p.tags) n += String(p.tags).split(',').filter(Boolean).length;
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
          '<button class="pill filter-btn' + (n ? ' on' : '') + '" data-open-filters>' +
            'Filters' + (n ? ' <span class="count">' + n + '</span>' : '') +
          '</button>' +
        '</div>' +
        activeChips(state) +
      '</div>' +
      '<div class="grid" id="feed-grid">' + U.spinner('Loading listings') + '</div>' +
      '<div class="feed-foot" id="feed-foot"></div>';

    wire(root);
    load(true);
  }

  /* A row of removable chips for whatever is currently narrowing the feed. Cheap
   * to build and it prevents the classic "why is my feed empty" confusion when a
   * filter is set two screens away in a sheet. */
  function activeChips(p) {
    var chips = [];
    if (p.radius) chips.push({ k: 'radius', t: 'Within ' + p.radius + ' mi' });
    if (p.category) chips.push({ k: 'category', t: p.category });
    if (p.condition) chips.push({ k: 'condition', t: CFG.condition(p.condition).label });
    if (p.fulfillment) {
      var ful = CFG.FULFILLMENT.filter(function (f) { return f.key === p.fulfillment; })[0];
      chips.push({ k: 'fulfillment', t: ful ? ful.label : p.fulfillment });
    }
    (p.tags ? String(p.tags).split(',').filter(Boolean) : []).forEach(function (t) {
      chips.push({ k: 'tag:' + t, t: t });
    });
    if (!chips.length) return '';
    return '<div class="active-chips">' +
      chips.map(function (c) {
        return '<button class="chip on" data-drop="' + U.attr(c.k) + '">' +
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

    U.on(root, '[data-drop]', function (e, t) {
      var k = t.dataset.drop;
      var next = Object.assign({}, state);
      if (k === '*') {
        ['radius', 'category', 'condition', 'fulfillment', 'tags'].forEach(function (f) { delete next[f]; });
      } else if (k.indexOf('tag:') === 0) {
        var drop = k.slice(4);
        var left = String(next.tags || '').split(',').filter(function (x) { return x && x !== drop; });
        next.tags = left.length ? left.join(',') : undefined;
      } else {
        next[k] = undefined;
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

  function openFilters() {
    var p = state;
    var chosenTags = p.tags ? String(p.tags).split(',').filter(Boolean) : [];
    var hasArea = !!(Store.me() && Store.me().geoPoint);

    var html =
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

      '<div class="filter-group">' +
        '<h4>Category</h4>' +
        '<select data-f="category">' +
          '<option value="">Any category</option>' +
          CFG.BGG_CATEGORIES.map(function (c) {
            return '<option value="' + U.attr(c) + '"' + (p.category === c ? ' selected' : '') + '>' +
              U.esc(c) + '</option>';
          }).join('') +
        '</select>' +
        '<p class="fine">Categories come from BoardGameGeek, so manually-entered games won\'t match one.</p>' +
      '</div>' +

      '<div class="filter-group">' +
        '<h4>Condition</h4>' +
        '<div class="chip-row">' +
          '<button class="chip' + (!p.condition ? ' on' : '') + '" data-f="condition" data-v="">Any</button>' +
          CFG.CONDITIONS.map(function (c) {
            return '<button class="chip' + (p.condition === c.key ? ' on' : '') +
              '" data-f="condition" data-v="' + U.attr(c.key) + '" title="' + U.attr(c.blurb) + '">' +
              U.esc(c.key) + ' · ' + U.esc(c.label) + '</button>';
          }).join('') +
        '</div>' +
      '</div>' +

      '<div class="filter-group">' +
        '<h4>Fulfillment</h4>' +
        '<div class="chip-row">' +
          '<button class="chip' + (!p.fulfillment ? ' on' : '') + '" data-f="fulfillment" data-v="">Any</button>' +
          CFG.FULFILLMENT.map(function (f) {
            return '<button class="chip' + (p.fulfillment === f.key ? ' on' : '') +
              '" data-f="fulfillment" data-v="' + U.attr(f.key) + '">' + U.esc(f.label) + '</button>';
          }).join('') +
        '</div>' +
      '</div>' +

      '<div class="filter-group">' +
        '<h4>Tags <span class="fine">(all selected must match)</span></h4>' +
        '<div class="chip-row">' +
          CFG.TAGS.map(function (t) {
            return '<button class="chip' + (chosenTags.indexOf(t) !== -1 ? ' on' : '') +
              '" data-tag="' + U.attr(t) + '">' + U.esc(t) + '</button>';
          }).join('') +
        '</div>' +
      '</div>' +

      '<div class="modal-actions sticky">' +
        '<button class="btn ghost" data-act="reset">Clear all</button>' +
        '<button class="btn" data-act="apply">Show results</button>' +
      '</div>';

    var m = U.modal('Filters', html);
    var draft = Object.assign({}, p);
    var draftTags = chosenTags.slice();

    U.on(m.el, '[data-f]', function (e, t) {
      if (t.tagName === 'SELECT') return;
      var f = t.dataset.f;
      draft[f] = t.dataset.v || undefined;
      U.$$('[data-f="' + f + '"]', m.el).forEach(function (b) {
        if (b.tagName === 'BUTTON') b.classList.toggle('on', (b.dataset.v || '') === (draft[f] || ''));
      });
    });

    var sel = U.$('select[data-f="category"]', m.el);
    sel.addEventListener('change', function () { draft.category = sel.value || undefined; });

    U.on(m.el, '[data-tag]', function (e, t) {
      var tag = t.dataset.tag;
      var i = draftTags.indexOf(tag);
      if (i === -1) draftTags.push(tag); else draftTags.splice(i, 1);
      t.classList.toggle('on', i === -1);
    });

    U.on(m.el, '[data-act]', function (e, t) {
      if (t.dataset.act === 'reset') {
        m.close();
        var cleared = Object.assign({}, state);
        ['radius', 'category', 'condition', 'fulfillment', 'tags'].forEach(function (k) { delete cleared[k]; });
        App.go('feed', cleared);
        return;
      }
      draft.tags = draftTags.length ? draftTags.join(',') : undefined;
      m.close();
      App.go('feed', draft);
    });
  }

  return { render: render, card: card };
})();
