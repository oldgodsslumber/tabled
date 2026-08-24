/* Tabled — shell, router, auth gate.
 *
 * Routing is hash-based and stateless: everything a view needs to redraw itself
 * is in the URL. That's what makes the Back button work through a filtered feed,
 * and it's why Feed keeps its filters in params rather than in a closure.
 *
 * Boot order matters and is deliberate:
 *   1. This file runs (classic script) and shows the boot spinner.
 *   2. firebase-config.js (module, loaded last) resolves the config and calls
 *      App.useCloud(...) or App.useDemo().
 *   3. Auth state resolves, and only then does the shell appear.
 *
 * Step 3 is the "never flash the app before auth resolves" rule. Rendering the
 * feed and then yanking it back to a sign-in screen half a second later is the
 * single most common Firebase-app tell.
 */
window.App = (function () {

  var authApi = null;          /* { signIn, signOut } — supplied by the backend */
  var booted = false;
  var currentUser = null;
  var bootTimer = null;

  /* ---- Routing ----------------------------------------------------------- */

  var ROUTES = {
    feed:     { render: function (root, p) { Feed.render(root, p); }, nav: 'browse' },
    listing:  { render: function (root, p) { ListingView.render(root, p); } },
    create:   { render: function (root, p) { CreateView.render(root, p); }, nav: 'sell', auth: true },
    edit:     { render: function (root, p) { CreateView.render(root, p); }, auth: true },
    dashboard:{ render: function (root, p) { DashboardView.render(root, p); }, nav: 'inbox', auth: true },
    thread:   { render: function (root, p) { ThreadView.render(root, p); }, nav: 'inbox', auth: true },
    profile:  { render: function (root, p) { ProfileView.render(root, p); } },
    me:       { render: function (root, p) { ProfileView.render(root, {}); }, nav: 'me', auth: true },
    settings: { render: function (root, p) { ProfileView.settings(root); }, auth: true },
    /* First-run profile setup. Not in the nav; the router forces a new account
     * here until it has set a general area (see route_render). */
    onboard:  { render: function (root, p) { ProfileView.onboard(root); }, auth: true },
    /* Not in the nav — reachable from settings, and only rendered when the
     * role claim is present. That is presentation; the rules and the callable
     * are what actually gate it. */
    admin:    { render: function (root, p) { AdminView.render(root, p); }, auth: true }
  };

  /* '#/listing/abc123?sort=hot' -> { route:'listing', id:'abc123', sort:'hot' } */
  function parseHash() {
    var raw = String(location.hash || '').replace(/^#\/?/, '');
    var qIdx = raw.indexOf('?');
    var path = qIdx === -1 ? raw : raw.slice(0, qIdx);
    var query = qIdx === -1 ? '' : raw.slice(qIdx + 1);
    var parts = path.split('/').filter(Boolean);

    var params = {};
    query.split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('=');
      var k = decodeURIComponent(i === -1 ? pair : pair.slice(0, i));
      var v = i === -1 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
      if (k) params[k] = v;
    });

    var route = parts[0] || 'feed';
    if (!ROUTES[route]) route = 'feed';
    if (parts[1]) params.id = parts[1];
    params.route = route;
    return params;
  }

  function buildHash(route, params) {
    params = params || {};
    var path = '/' + route;
    if (params.id && (route === 'listing' || route === 'edit' || route === 'profile' || route === 'thread')) {
      path += '/' + encodeURIComponent(params.id);
    }
    var qs = Object.keys(params)
      .filter(function (k) {
        if (k === 'route') return false;
        if (k === 'id' && path.indexOf(encodeURIComponent(params.id)) !== -1) return false;
        var v = params[k];
        return v !== undefined && v !== null && v !== '';
      })
      .sort()
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
      .join('&');
    return '#' + path + (qs ? '?' + qs : '');
  }

  function go(route, params) {
    var next = buildHash(route, params);
    if (location.hash === next) route_render();     /* same URL, force a redraw */
    else location.hash = next;
  }

  /* Every view wires its listeners onto the container it's handed, and none of
   * them tear those listeners down. Reusing one #view node across navigations
   * therefore stacks a fresh set on every render — by the third visit to the
   * feed, one tap on "Filters" opened three modals. Swapping in an empty node
   * makes teardown automatic: the old element goes away with its listeners
   * attached to it, and no view has to remember to clean up after itself. */
  function freshView() {
    var old = U.$('#view');
    var next = document.createElement('main');
    next.id = 'view';
    old.parentNode.replaceChild(next, old);
    return next;
  }

  function route_render() {
    var p = parseHash();

    /* Require a general area once. A new account inherits nothing to locate its
     * listings, so it's held on the onboarding screen until it sets one; after
     * that needsOnboarding() is false and this never fires again. */
    if (currentUser && p.route !== 'onboard' && Store.needsOnboarding()) {
      location.hash = '#/onboard';
      return;
    }
    /* And the reverse: don't strand a finished account on the setup screen. */
    if (currentUser && p.route === 'onboard' && !Store.needsOnboarding()) {
      location.hash = '#/feed';
      return;
    }

    var def = ROUTES[p.route];

    /* Firestore listeners are not DOM listeners — swapping out #view drops the
     * elements but leaves the subscriptions running, billing reads and calling
     * back into a detached tree. The views that hold them expose a teardown. */
    if (window.ThreadView) ThreadView.teardown();
    if (window.DashboardView) DashboardView.teardown();

    var root = freshView();

    if (def.auth && !currentUser) {
      root.innerHTML = U.empty('Sign in to do that', '') +
        '<div class="center"><button class="btn" id="gate-in">Sign in with Google</button></div>';
      U.$('#gate-in').addEventListener('click', signIn);
      return;
    }

    setNav(def.nav);
    /* Onboarding is a gate, not a destination — hide the nav so there's nothing
     * to tap away to. (The router would bounce them back anyway.) */
    var navBar = U.$('#nav');
    if (navBar) navBar.hidden = (p.route === 'onboard');
    root.scrollTop = 0;
    window.scrollTo(0, 0);
    def.render(root, p);
  }

  function setNav(key) {
    U.$$('#nav [data-nav]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.nav === key);
    });
  }

  /* ---- Auth -------------------------------------------------------------- */

  function signIn() {
    if (!authApi) { U.toast('Still starting up…', 'warn'); return; }
    authApi.signIn().catch(function (err) {
      console.error('[tabled] sign-in failed', err);
      /* A closed popup is a user action, not an error worth shouting about. */
      if (err && /popup-closed|cancelled/i.test(err.code || '')) return;
      U.toast('Sign-in failed — check that this domain is authorized in Firebase Auth', 'bad');
    });
  }

  function signOut() {
    if (!authApi) return;
    authApi.signOut().then(function () {
      U.toast('Signed out');
    });
  }

  /* Called by the backend whenever auth state settles — including the initial
   * resolve, which is what releases the boot gate. */
  function setUser(user) {
    clearTimeout(bootTimer);
    if (!user) {
      currentUser = null;
      Store.endSession();
      showGate();
      return;
    }
    Store.startSession(user).then(function () {
      currentUser = user;
      showApp();
    }).catch(function (err) {
      console.error('[tabled] session start failed', err);
      U.$('#boot').innerHTML =
        '<div class="boot-error">' +
          '<h2>Couldn\'t load your profile</h2>' +
          '<p>Firestore rejected the read. The usual cause is that firestore.rules ' +
             'hasn\'t been published yet, or the database hasn\'t been created.</p>' +
          '<button class="btn" onclick="location.reload()">Retry</button>' +
        '</div>';
    });
  }

  function showGate() {
    U.$('#boot').hidden = true;
    U.$('#gate').hidden = false;
    U.$('#nav').hidden = true;
    U.$('#view').hidden = true;
  }

  function showApp() {
    U.$('#boot').hidden = true;
    U.$('#gate').hidden = true;
    U.$('#nav').hidden = false;
    U.$('#view').hidden = false;
    if (!booted) {
      booted = true;
      window.addEventListener('hashchange', route_render);
    }
    route_render();
  }

  /* ---- Backend attachment ------------------------------------------------ */

  function useCloud(deps) {
    clearTimeout(bootTimer);
    Store.useCloud(deps.fb, deps.db, deps.storage, deps.functions);
    if (deps.callable) BGG.attach(deps.callable);
    authApi = { signIn: deps.signIn, signOut: deps.signOut };
    setBanner('');
  }

  function useDemo(reason) {
    clearTimeout(bootTimer);
    Store.useDemo();
    BGG.attach(null);
    authApi = {
      signIn: function () {
        /* A stable fake uid so demo listings survive a reload.
         * `?role=admin` grants a demo staff role, so the moderation console is
         * exercisable offline. Demo mode touches nothing but localStorage, so
         * this grants no real permission whatsoever — the live app reads the
         * role from a signed ID token claim and nowhere else. */
        var m = /[?&]role=(admin|moderator)/.exec(location.search);
        setUser({
          uid: 'demo_me', displayName: 'You (demo)', photoURL: null,
          role: m ? m[1] : null
        });
        return Promise.resolve();
      },
      signOut: function () { setUser(null); return Promise.resolve(); }
    };
    setBanner(/demo=1/.test(location.search)
      ? 'Demo mode (?demo=1) — sample data in this browser only. Nothing here touches the live project.'
      : 'Demo mode — sample data in this browser only. ' +
        'Add your Firebase config in js/firebase-config.js to go live.');
    if (reason) console.info('[tabled] demo mode:', reason);
    /* The landing's "Take a look around" links to ?demo=1&enter=1 so a visitor
     * lands straight in sample browsing in one click. Plain ?demo=1 (what the
     * tests use) still shows the gate first. */
    if (/[?&]enter=1/.test(location.search)) authApi.signIn();
    else setUser(null);
  }

  function setBanner(text) {
    var el = U.$('#env-banner');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }

  /* ---- Boot -------------------------------------------------------------- */

  function boot() {
    U.$('#build-tag').textContent = CFG.BUILD;

    U.on(U.$('#nav'), '[data-nav]', function (e, t) {
      var k = t.dataset.nav;
      if (k === 'browse') go('feed', {});
      else if (k === 'sell') go('create', {});
      else if (k === 'inbox') go('dashboard', {});
      else if (k === 'me') go('me', {});
    });

    /* The nav badge rides the same requests subscription the dashboard uses, so
     * an unread count costs nothing beyond what's already streaming. */
    Store.onMyRequests(function () {
      var badge = U.$('#nav-unread');
      if (!badge) return;
      var n = Store.unreadCount();
      badge.textContent = n > 9 ? '9+' : String(n);
      badge.hidden = n === 0;
    });

    /* Every sign-in CTA on the landing page (hero + closing) triggers the same
     * flow; the id stays on the first for continuity. */
    U.$$('[data-signin]').forEach(function (b) { b.addEventListener('click', signIn); });

    /* If firebase-config.js never reports in — a 404, a syntax error, a blocked
     * CDN — fall through to demo mode rather than leaving a spinner forever.
     * A visibly wrong app beats an invisibly broken one. */
    bootTimer = setTimeout(function () {
      useDemo('firebase-config.js did not report in within 4s');
    }, 4000);
  }

  return {
    boot: boot,
    go: go,
    signIn: signIn,
    signOut: signOut,
    setUser: setUser,
    useCloud: useCloud,
    useDemo: useDemo,
    parseHash: parseHash
  };
})();

document.addEventListener('DOMContentLoaded', function () { App.boot(); });
