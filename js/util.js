/* Tabled — small shared helpers.
 *
 * Rendering convention for the whole app: views build HTML strings and assign
 * innerHTML, then wire listeners by querying the result. That means every value
 * interpolated from user data MUST pass through U.esc(). There is no framework
 * escaping for us here — a seller's bio is arbitrary text typed by a stranger.
 */
window.U = (function () {

  /* ---- Escaping ----------------------------------------------------------- */

  /* For text inside an element. */
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* For a value going into an attribute — same rules, kept separate so call
   * sites read clearly and so this can tighten later without touching esc(). */
  function attr(s) { return esc(s); }

  /* Storage/BGG URLs get interpolated into src= and background-image. Anything
   * that isn't plainly http(s) or a data: image is dropped rather than trusted,
   * which is what keeps a javascript: URL out of an <img> onerror chain. */
  function safeUrl(s) {
    if (!s) return '';
    var u = String(s).trim();
    if (/^https?:\/\//i.test(u) || /^data:image\//i.test(u) || /^blob:/i.test(u)) return u;
    return '';
  }

  /* ---- DOM ---------------------------------------------------------------- */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  /* Delegated click binding. Views call on(root, '.chip', fn) once instead of
   * looping over freshly-rendered nodes. */
  function on(root, sel, handler, evt) {
    root.addEventListener(evt || 'click', function (e) {
      var t = e.target.closest(sel);
      if (t && root.contains(t)) handler.call(t, e, t);
    });
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var self = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms || 250);
    };
  }

  /* ---- Toast -------------------------------------------------------------- */

  var toastTimer = null;
  function toast(msg, kind) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'show ' + (kind || 'ok');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = ''; }, 3200);
  }

  /* ---- Modal --------------------------------------------------------------
   * One modal at a time, mounted into #modal-root. Returns a close function so
   * callers can dismiss from inside their own handlers. */
  function modal(title, bodyHtml, opts) {
    opts = opts || {};
    var root = $('#modal-root');
    var wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML =
      '<div class="modal-scrim"></div>' +
      '<div class="modal" role="dialog" aria-modal="true" aria-label="' + attr(title) + '">' +
        '<div class="modal-head">' +
          '<h2>' + esc(title) + '</h2>' +
          '<button class="modal-x" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="modal-body">' + bodyHtml + '</div>' +
      '</div>';
    root.appendChild(wrap);
    document.body.classList.add('modal-open');

    function close() {
      if (!wrap.parentNode) return;
      wrap.parentNode.removeChild(wrap);
      if (!root.children.length) document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', onKey);
      if (opts.onClose) opts.onClose();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    $('.modal-x', wrap).addEventListener('click', close);
    $('.modal-scrim', wrap).addEventListener('click', close);
    document.addEventListener('keydown', onKey);

    return { el: $('.modal-body', wrap), close: close };
  }

  function confirmDialog(title, message, confirmLabel) {
    return new Promise(function (resolve) {
      var settled = false;
      var m = modal(title,
        '<p class="modal-msg">' + esc(message) + '</p>' +
        '<div class="modal-actions">' +
          '<button class="btn ghost" data-act="no">Cancel</button>' +
          '<button class="btn danger" data-act="yes">' + esc(confirmLabel || 'Confirm') + '</button>' +
        '</div>',
        { onClose: function () { if (!settled) { settled = true; resolve(false); } } });
      on(m.el, '[data-act]', function (e, t) {
        settled = true;
        m.close();
        resolve(t.dataset.act === 'yes');
      });
    });
  }

  /* ---- Formatting --------------------------------------------------------- */

  function money(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return '$' + Number(n).toFixed(Number(n) % 1 === 0 ? 0 : 2);
  }

  /* Firestore hands back Timestamps; the local backend hands back numbers.
   * Everything downstream wants a Date, so normalize in one place. */
  function toDate(v) {
    if (!v) return null;
    if (v instanceof Date) return v;
    if (typeof v.toDate === 'function') return v.toDate();
    if (typeof v === 'number') return new Date(v);
    if (typeof v === 'string') { var d = new Date(v); return isNaN(d) ? null : d; }
    if (typeof v.seconds === 'number') return new Date(v.seconds * 1000);
    return null;
  }

  function ago(v) {
    var d = toDate(v);
    if (!d) return '';
    var s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 90) return 'just now';
    var m = s / 60;      if (m < 60) return Math.round(m) + 'm ago';
    var h = m / 60;      if (h < 24) return Math.round(h) + 'h ago';
    var dd = h / 24;     if (dd < 30) return Math.round(dd) + 'd ago';
    var mo = dd / 30.44; if (mo < 12) return Math.round(mo) + 'mo ago';
    return Math.round(mo / 12) + 'y ago';
  }

  function monthYear(v) {
    var d = toDate(v);
    if (!d) return '';
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : (many || one + 's'));
  }

  /* ---- Photos -------------------------------------------------------------
   * Downscale + re-encode before upload. Reads through createImageBitmap when
   * available (it honors EXIF orientation, which <img> decoding does not, so
   * portrait phone photos don't arrive sideways) and falls back to an <img>. */
  function resizeImage(file) {
    var maxEdge = CFG.PHOTO.maxEdge;
    return loadBitmap(file).then(function (bmp) {
      var w = bmp.width, h = bmp.height;
      var scale = Math.min(1, maxEdge / Math.max(w, h));
      var cw = Math.round(w * scale), ch = Math.round(h * scale);
      var canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      canvas.getContext('2d').drawImage(bmp, 0, 0, cw, ch);
      if (bmp.close) bmp.close();
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error('Could not encode image'));
        }, 'image/jpeg', CFG.PHOTO.quality);
      });
    });
  }

  function loadBitmap(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return loadViaImg(file); });
    }
    return loadViaImg(file);
  }

  function loadViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Not a readable image')); };
      img.src = url;
    });
  }

  /* ---- Misc ---------------------------------------------------------------- */

  function uid(prefix) {
    return (prefix || '') + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  /* Unique, order-preserving. Used all over the rollup builders. */
  function uniq(arr) {
    var seen = Object.create(null), out = [];
    (arr || []).forEach(function (v) {
      if (v === null || v === undefined || v === '') return;
      var k = String(v);
      if (seen[k]) return;
      seen[k] = 1;
      out.push(v);
    });
    return out;
  }

  /* Punctuation is stripped before picking letters, so "You (demo)" reads as
   * "YD" rather than "Y(" — display names routinely carry brackets, quotes and
   * emoji, and the first character of a word is often not a letter at all. */
  function initials(name) {
    var parts = String(name || '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);
    var out = parts.map(function (p) {
      return Array.from(p)[0].toUpperCase();
    }).join('');
    return out || '?';
  }

  /* Avatar that degrades to initials rather than a broken-image icon — most
   * Google photoURLs work, but they do 404 after a profile-photo change. */
  function avatar(user, size) {
    var cls = 'avatar' + (size ? ' ' + size : '');
    var url = safeUrl(user && user.photoURL);
    if (url) {
      return '<span class="' + cls + '"><img src="' + attr(url) + '" alt="" referrerpolicy="no-referrer"></span>';
    }
    return '<span class="' + cls + ' initials">' + esc(initials(user && user.displayName)) + '</span>';
  }

  function spinner(label) {
    return '<div class="loading"><span class="spin"></span>' +
      (label ? '<span>' + esc(label) + '</span>' : '') + '</div>';
  }

  function empty(title, msg) {
    return '<div class="empty"><h3>' + esc(title) + '</h3>' +
      (msg ? '<p>' + esc(msg) + '</p>' : '') + '</div>';
  }

  /* The "Powered by BGG" mark. BGG's XML API terms of use REQUIRE their logo
   * (not just their name) linked back to the site, sized so the text stays
   * legible, on every public-facing use of their data. This renders a branded
   * badge to satisfy that; to use BGG's exact official artwork instead, drop the
   * file in and swap the inner markup for an <img> — the link + sizing already
   * meet the requirement. One definition, used by the create form and the
   * listing page, so the credit can never go missing from one of them. */
  /* A background-image CSS value with the URL SINGLE-QUOTED, so a URL that
   * contains parentheses -- BGG's images carry "filters:format(jpeg)" -- can't
   * break out of url() and blank the tile. (An <img src> doesn't need this,
   * which is why the detail box art worked but the feed card didn't.) */
  function bgurl(u) {
    var v = safeUrl(u);
    return v ? "background-image:url('" + attr(v.replace(/'/g, '%27')) + "')" : '';
  }

  function bggBadge() {
    return '<a class="bgg-badge" href="https://boardgamegeek.com" target="_blank" ' +
      'rel="noopener noreferrer" aria-label="Powered by BoardGameGeek">' +
      '<span class="bgg-badge-pre">Powered by</span>' +
      '<span class="bgg-badge-mark">BGG</span>' +
    '</a>';
  }

  return {
    esc: esc, attr: attr, safeUrl: safeUrl,
    $: $, $$: $$, on: on, debounce: debounce,
    toast: toast, modal: modal, confirm: confirmDialog,
    money: money, toDate: toDate, ago: ago, monthYear: monthYear, plural: plural,
    resizeImage: resizeImage,
    uid: uid, clamp: clamp, uniq: uniq, initials: initials,
    avatar: avatar, spinner: spinner, empty: empty, bggBadge: bggBadge, bgurl: bgurl
  };
})();
