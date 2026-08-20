/* Tabled — Dashboard: my requests, as buyer and as seller (M4).
 *
 * Reads from Store's single shared requests subscription rather than opening
 * its own. Both this view and the nav's unread badge need the same live list,
 * and two subscriptions would double the read cost of every message anyone
 * sends for byte-identical data.
 *
 * Split by role rather than merged into one list: "someone wants to buy my
 * game" and "I'm trying to buy something" need different things from you, and a
 * single interleaved list makes you re-derive which is which on every row.
 */
window.DashboardView = (function () {

  var stop = null;
  var reviewed = null;   /* requestIds I have already reviewed */

  function teardown() {
    if (stop) { stop(); stop = null; }
  }

  function render(root) {
    teardown();
    root.innerHTML = U.spinner('Loading your requests');

    /* Loaded once per view rather than per row: a completed-trade list is
     * short, and an existence check per row would be N reads for one boolean. */
    Store.getMyReviewedRequestIds().then(function (ids) {
      reviewed = ids;
      if (document.body.contains(root)) draw(root, Store.myRequests());
    }).catch(function () { reviewed = []; });

    stop = Store.onMyRequests(function (all) {
      /* app.js swaps out #view on navigation; a store subscription outlives
       * that, so bail (and release) once the node is detached. */
      if (!document.body.contains(root)) { teardown(); return; }
      draw(root, all);
    });
  }

  var OPEN = ['queued', 'onHold', 'proposedTime', 'scheduled'];

  function draw(root, all) {
    var me = Store.uid();
    var selling = all.filter(function (r) { return r.sellerId === me && OPEN.indexOf(r.status) !== -1; });
    var buying = all.filter(function (r) { return r.buyerId === me && OPEN.indexOf(r.status) !== -1; });
    var closed = all.filter(function (r) { return OPEN.indexOf(r.status) === -1; });

    /* Completed trades still owed a review. Surfaced as its own section because
     * a review prompt buried in a closed-threads list is a review nobody
     * writes — and reviews are the entire trust surface. */
    var toReview = reviewed === null ? [] : all.filter(function (r) {
      return r.status === 'completed' && reviewed.indexOf(r.id) === -1;
    });

    root.innerHTML =
      '<div class="dash">' +
        '<h1>Requests</h1>' +

        (toReview.length
          ? '<section class="block review-prompt">' +
              '<h2>Leave a review</h2>' +
              '<p class="fine">These trades are done. A review is the only thing that ' +
                'tells the next person what you found.</p>' +
              toReview.map(function (r) {
                var them = r.sellerId === me ? r.buyerName : r.sellerName;
                return '<div class="dash-row">' +
                  U.avatar({ displayName: them }, '') +
                  '<div class="grow">' +
                    '<strong>' + U.esc(r.gameName || 'Game') + '</strong>' +
                    '<div class="dash-preview">with ' + U.esc(them || 'them') + '</div>' +
                  '</div>' +
                  '<button class="btn small" data-review="' + U.attr(r.id) + '">Review</button>' +
                '</div>';
              }).join('') +
            '</section>'
          : '') +

        section('Selling', selling,
          'Nothing yet. When someone requests one of your games, the conversation lands here.') +

        section('Buying', buying,
          'You haven\'t requested anything yet. Find something in the feed and hit “Request this”.') +

        (closed.length
          ? '<section class="block"><h2>Closed</h2>' +
            closed.slice(0, 20).map(function (r) { return row(r, me); }).join('') +
            '</section>'
          : '') +
      '</div>';

    U.on(root, '[data-review]', function (e, t) {
      var r = all.filter(function (x) { return x.id === t.dataset.review; })[0];
      if (r) ThreadView.reviewDialog(r);
    });
  }

  function section(title, rows, emptyMsg) {
    var me = Store.uid();
    return '<section class="block">' +
      '<h2>' + U.esc(title) +
        (rows.length ? ' <span class="count-pill">' + rows.length + '</span>' : '') +
      '</h2>' +
      (rows.length
        ? rows.map(function (r) { return row(r, me); }).join('')
        : '<p class="fine">' + U.esc(emptyMsg) + '</p>') +
    '</section>';
  }

  function row(r, me) {
    var amSeller = r.sellerId === me;
    var other = amSeller
      ? { displayName: r.buyerName, photoURL: r.buyerPhoto }
      : { displayName: r.sellerName, photoURL: r.sellerPhoto };
    var unread = Store.isUnread(r);

    /* The preview is whatever's most actionable: an un-actioned proposal beats
     * the last chat line, because "confirm this time" is the thing that's
     * actually waiting on you. */
    var preview;
    if (r.status === 'queued') {
      /* Position beats the last chat line here: when you're waiting, where you
       * are in the queue is the only thing you actually want to know. */
      preview = amSeller
        ? (r.buyerName || 'Someone') + ' is #' + (r.queuePosition + 1) + ' in line'
        : "You're #" + (r.queuePosition + 1) + ' in line';
    } else if (r.status === 'proposedTime') {
      preview = (r.proposedBy === me ? 'Waiting on ' : 'Needs your answer: ') + when(r.proposedTime);
    } else if (r.status === 'scheduled') {
      preview = '✓ ' + when(r.scheduledTime);
    } else if (r.lastMessageText) {
      preview = (r.lastMessageSenderId === me ? 'You: ' : '') + r.lastMessageText;
    } else {
      preview = 'No messages yet';
    }

    return '<a class="dash-row' + (unread ? ' unread' : '') + '" ' +
        'href="#/thread/' + U.attr(r.id) + '">' +
      U.avatar(other, '') +
      '<div class="grow">' +
        '<div class="dash-top">' +
          '<strong>' + U.esc(r.gameName || 'Game') + '</strong>' +
          '<span class="fine">' + U.esc(U.ago(r.updatedAt || r.createdAt)) + '</span>' +
        '</div>' +
        '<div class="dash-sub">' +
          '<span class="who">' + U.esc(other.displayName || 'User') + '</span>' +
          statusBadge(r, amSeller) +
        '</div>' +
        '<div class="dash-preview">' + U.esc(preview) + '</div>' +
      '</div>' +
      (unread ? '<span class="dot-unread" aria-label="Unread"></span>' : '') +
    '</a>';
  }

  function statusBadge(r, amSeller) {
    var map = {
      queued: ['#' + (r.queuePosition + 1) + ' in line', ''],
      onHold: ['Your turn', 'hold'],
      proposedTime: [amSeller ? 'Needs your OK' : 'Proposed', 'hold'],
      scheduled: ['Scheduled', 'verified'],
      completed: ['Completed', 'verified'],
      cancelled: ['Cancelled', 'sold'],
      expired: ['Expired', 'sold']
    };
    var e = map[r.status] || [r.status, ''];
    return '<span class="badge ' + U.attr(e[1]) + '">' + U.esc(e[0]) + '</span>';
  }

  function when(v) {
    var d = U.toDate(v);
    if (!d) return 'a time';
    return d.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  }

  return { render: render, teardown: teardown };
})();
