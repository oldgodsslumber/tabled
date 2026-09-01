/* Tabled — plain-text export.
 *
 * Turns a seller's inventory into a block of text they can paste somewhere
 * Tabled isn't: a Facebook group, a Reddit thread, a Discord channel.
 *
 * Two rules hold this file together:
 *
 *  1. ONE ROW MODEL, MANY FORMATTERS. Everything Store.exportInventory hands
 *     back is flattened once into `rows()`, and each venue's formatter is a
 *     pure rows[] -> string. Pure means the live preview, the clipboard copy,
 *     the .txt download and any future test all run the same code, so they
 *     cannot drift apart.
 *
 *  2. NO DOM, NO FIRESTORE, NO CFG LOOKUPS BY LABEL. This module is callable
 *     with a hand-built array of rows and nothing else mounted. That is what
 *     makes it testable before the modal exists.
 *
 * Privacy is enforced HERE rather than in the modal, because the text leaves
 * the app's control the moment it is pasted. What goes out: display name,
 * generalArea (already server-side jittered), the games, payment and
 * fulfillment, a link back. What never goes out at any toggle setting:
 * geoPoint, geohash, email, phone, availability windows, buyer names, or
 * anything from the request/thread layer. Availability is a deliberate
 * omission — "Saturdays 10am-2pm, Jacksonville" posted publicly next to a name
 * is a meet-up schedule handed to strangers.
 */
window.ExportList = (function () {

  /* ---- Links -------------------------------------------------------------
   * There is no canonical-origin constant in the app; the hash router means
   * origin + pathname is always the right base, whichever host is serving. */
  function origin() {
    if (CFG.EXPORT.ORIGIN) return String(CFG.EXPORT.ORIGIN).replace(/\/+$/, '') + '/';
    return location.origin + location.pathname;
  }
  function profileUrl(uid) { return origin() + '#/profile/' + uid; }
  function listingUrl(id) { return origin() + '#/listing/' + id; }

  /* ---- Row model ---------------------------------------------------------
   * One row per gameEntry. A LOT IS ONE ROW, not one per item in `contents` —
   * exploding it would imply the pieces are separately purchasable, which is
   * the opposite of what a lot means (see CFG.LOT_ROLES). */
  function rows(items, opts) {
    opts = opts || {};
    var out = [];
    (items || []).forEach(function (pair) {
      var listing = (pair && pair.listing) || {};
      var entries = (pair && pair.entries) || [];
      if (!Array.isArray(entries)) entries = [];
      entries.forEach(function (e) {
        e = e || {};
        /* On-hold and reserved entries are still technically listed, but
         * advertising them off-app invites a message about a game somebody
         * else is already mid-trade for. */
        if (!opts.onHold && e.status && e.status !== 'active') return;
        out.push({
          /* Every free-text field is flattened to a single line HERE, at the
           * edge, rather than in each formatter. A newline inside a game name
           * would break the one-game-per-line contract that the whole plain
           * text format rests on — the second line arrives with no bullet and
           * reads as a separate item. */
          title: oneLine(e.name) || 'Untitled game',
          bggId: e.bggId ? String(e.bggId) : null,
          condition: e.condition || null,
          price: toPrice(e.askingPrice),
          tags: arr(e.tags).map(oneLine).filter(Boolean),
          notes: oneLine(e.notes),
          contents: arr(e.contents).map(function (c) {
            return oneLine(c && c.name);
          }).filter(Boolean),
          status: e.status || 'active',
          listingId: listing.id || null,
          url: listing.id ? listingUrl(listing.id) : null
        });
      });
    });
    return out;
  }

  /* ---- Shared pieces -----------------------------------------------------
   * Header and footer are format-agnostic text; only the decoration around
   * them differs, so each formatter styles what it gets rather than rebuilding
   * the facts. */
  function arr(v) { return Array.isArray(v) ? v : []; }

  /* Collapse anything that would smuggle a line break, a tab or a run of
   * spaces into a line-oriented format. Applied to every field that comes from
   * user input, including the seller's own display name and area. */
  function oneLine(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* Firestore stores numbers, but a hand-edited or migrated doc can carry a
   * numeric string, and nothing downstream should print "$NaN" or "$Infinity".
   * A negative price is corrupt rather than meaningful, so it reads as "no
   * price" instead of "$-5". */
  function toPrice(v) {
    var n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return null;
    return n;
  }

  function headline(user) {
    var name = oneLine(user && user.displayName) || 'Board gamer';
    return name + "'s board game list";
  }

  function area(user) {
    return oneLine(user && user.generalArea);
  }

  /* Fulfillment and payment are per-listing, so the export states the union.
   * "Local pickup. Cash, Venmo." is the sentence a buyer scans for. */
  function terms(items) {
    var ful = {}, pay = {};
    /* BOTH of these are boolean maps — {pickup:true, inPersonAtEvent:false} —
     * not string keys. A listing can offer pickup AND event handover at once,
     * which is exactly why it is shaped like acceptedPayment (see
     * views-create.js and the onKeys() facet filter in store.js). Treating
     * fulfillment as a string keyed the map with "[object Object]" and dropped
     * the "Local pickup." sentence from every real export. */
    function union(src, into) {
      Object.keys(src || {}).forEach(function (k) { if (src[k]) into[k] = 1; });
    }
    (items || []).forEach(function (pair) {
      var l = (pair && pair.listing) || {};
      union(l.fulfillment, ful);
      union(l.acceptedPayment, pay);
    });
    function labels(table, on) {
      return table.filter(function (x) { return on[x.key]; })
        .map(function (x) { return x.label; });
    }
    var parts = [];
    var f = labels(CFG.FULFILLMENT, ful);
    var p = labels(CFG.PAYMENT, pay);
    if (f.length) parts.push(f.join(' or ') + '.');
    if (p.length) parts.push(p.join(', ') + '.');
    return parts.join(' ');
  }

  function conditionLabel(key) {
    return key ? CFG.condition(key).label : '';
  }

  /* Matches U.money, for the column formats where an em dash means "empty
   * cell" and reads correctly. */
  function price(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return '$' + Number(n).toFixed(Number(n) % 1 === 0 ? 0 : 2);
  }

  /* The line formats separate facts with em dashes, so U.money's em dash for a
   * missing price collides with them: "Wingspan — Good — —". A priceless entry
   * says so in words instead. */
  function priceInline(n) {
    if (n === null || n === undefined || isNaN(n)) return 'Ask';
    return price(n);
  }

  function clip(s, max) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1).trim() + '…' : s;
  }

  /* A lot renders its contents inline: "Brass (+ Cornish Mine, promo tiles)" */
  function titleOf(row) {
    if (!row.contents.length) return row.title;
    return row.title + ' (+ ' + row.contents.join(', ') + ')';
  }

  function columns(opts) {
    var c = {};
    Object.keys(CFG.EXPORT.DEFAULT_COLUMNS).forEach(function (k) {
      c[k] = (opts && opts[k] !== undefined) ? !!opts[k] : CFG.EXPORT.DEFAULT_COLUMNS[k];
    });
    return c;
  }

  /* Non-active entries, when the seller opts to include them. 'sold' and
   * 'reserved' are the two the app actually writes, and they mean opposite
   * things to a buyer — labelling a sold copy "ON HOLD" invites exactly the
   * message the label exists to prevent. */
  var STATUS_LABEL = { sold: 'SOLD', reserved: 'ON HOLD' };

  /* ---- Facebook / plain --------------------------------------------------
   * The hard case, and the reason this file has formatters at all. Facebook
   * strips nothing but aligns nothing: no markdown, no monospace, no reliable
   * leading whitespace. So: one game per line, a separator between facts, and
   * a blank line between blocks — Facebook collapses single newlines in some
   * surfaces but always keeps a paragraph break.
   *
   * SEP is a middle dot rather than the em dash the first draft used. Em
   * dashes are common INSIDE game titles ("Twilight Imperium: Prophecy of
   * Kings — Shattered Ascension"), so an em dash separator left a reader no
   * way to tell where the title stopped and the condition began. A middle dot
   * is effectively absent from board game names, and unlike an ASCII hyphen it
   * does not read as a stray mid-sentence hyphen in a proportional font. */
  var SEP = ' · ';

  function facebook(rows, ctx) {
    var c = columns(ctx.columns);
    var head = headline(ctx.user);
    if (area(ctx.user)) head += SEP + area(ctx.user);

    var body = rows.map(function (r) {
      var bits = [titleOf(r)];
      if (c.condition && r.condition) bits.push(conditionLabel(r.condition));
      if (c.price) bits.push(priceInline(r.price));
      if (c.tags && r.tags.length) bits.push(r.tags.join(', '));
      if (c.notes && r.notes) bits.push(clip(r.notes, CFG.EXPORT.MAX_NOTE));
      if (r.status !== 'active') bits.push(STATUS_LABEL[r.status] || 'UNAVAILABLE');
      if (c.links && r.url) bits.push(r.url);
      return '• ' + bits.join(SEP);
    }).join('\n');

    var blocks = [head];

    if (!rows.length) {
      /* Nothing to advertise. Say so plainly and stop — printing payment terms
       * and a truncation notice under an empty list is a post that promises an
       * inventory the seller does not have. */
      blocks.push('Nothing listed right now.');
      blocks.push(profileLine(ctx.user));
      return blocks.filter(Boolean).join('\n\n');
    }

    blocks.push(body);

    if (ctx.truncated) {
      /* Counted in listings, not games — the cap is on listings read, and
       * saying "the first 3" of a 400-game inventory would be a lie. */
      blocks.push('(Showing the first ' + ctx.items.length +
        ' listings — the rest are at the link below.)');
    }
    /* A read failure means the seller is holding a list that is short by an
     * unknown number of games. Better a visible caveat in the post than a
     * quietly incomplete advertisement. */
    if (ctx.failed) {
      blocks.push('(' + ctx.failed + (ctx.failed === 1 ? ' listing' : ' listings') +
        " couldn't be read — check the app for the full list.)");
    }

    var foot = [terms(ctx.items), profileLine(ctx.user)].filter(Boolean);
    if (foot.length) blocks.push(foot.join('\n'));

    return blocks.filter(Boolean).join('\n\n');
  }

  /* Always present, never toggleable — the whole point of letting someone take
   * their list off-app is that the list still points back. Omitted entirely
   * when there is no id to build it from, rather than published as a broken
   * "#/profile/undefined" link. */
  function profileLine(user) {
    var id = user && user.id;
    return id ? 'Full list & photos: ' + profileUrl(id) : '';
  }

  var FORMATTERS = {
    facebook: facebook
  };

  /* ---- Entry point -------------------------------------------------------
   * data is what Store.exportInventory resolves to:
   *   { user, items: [{listing, entries}], truncated }  */
  function build(data, opts) {
    data = data || {};
    opts = opts || {};
    var format = opts.format || CFG.EXPORT.FORMATS[0].key;
    var fn = FORMATTERS[format];
    if (!fn) throw new Error('Unknown export format: ' + format);
    var list = rows(data.items, columns(opts.columns));
    return {
      text: fn(list, {
        user: data.user || {},
        items: data.items || [],
        truncated: !!data.truncated,
        failed: data.failed || 0,
        columns: opts.columns
      }),
      gameCount: list.length
    };
  }

  return {
    build: build,
    rows: rows,
    profileUrl: profileUrl,
    listingUrl: listingUrl,
    /* Exposed for tests and for the formatters step 4 will add. */
    _internal: {
      terms: terms, titleOf: titleOf, price: price, priceInline: priceInline,
      clip: clip, oneLine: oneLine, toPrice: toPrice, SEP: SEP
    }
  };
})();
