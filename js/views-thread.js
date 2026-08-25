/* Tabled — Request thread: real-time chat + negotiated scheduling (M4).
 *
 * This is the one view where real-time genuinely matters, so it holds two live
 * subscriptions: one on the request document (the counterparty can confirm or
 * decline a time while you're looking at it) and one on the messages
 * subcollection.
 *
 * Both must be torn down on navigation. app.js replaces #view on every route
 * change, which drops DOM listeners automatically — but a Firestore listener is
 * not a DOM listener. It survives its element, keeps billing reads, and keeps
 * calling back into a detached node. Hence the explicit teardown below.
 *
 * The scheduling model, straight from the spec: a proposed time NEVER becomes
 * `scheduled` on its own. Whoever proposes, the seller always gets the final
 * Confirm/Decline. Chat negotiation and (later) auto-book are just two ways of
 * arriving at the same `proposedTime` state.
 */
window.ThreadView = (function () {

  var stopRequest = null;
  var stopMessages = null;
  var lastRenderedStatus = null;
  var pinnedToBottom = true;

  function teardown() {
    if (stopRequest) { stopRequest(); stopRequest = null; }
    if (stopMessages) { stopMessages(); stopMessages = null; }
    window.removeEventListener('resize', onResize);
  }

  /* Fill exactly the space between the top of the thread and the nav bar.
   * Measured rather than calculated: the env banner above is conditional and
   * wraps unpredictably, so any hardcoded offset is wrong on some screen.
   * Uses innerHeight, not 100vh, so the mobile URL bar collapsing doesn't
   * leave the composer stranded under the fold. */
  function sizeThread(root) {
    var el = U.$('.thread', root || document);
    if (!el) return;
    var top = el.getBoundingClientRect().top + window.scrollY;
    var nav = U.$('#nav');
    var navH = (nav && !nav.hidden) ? nav.offsetHeight : 0;
    var h = Math.max(320, window.innerHeight - top - navH);
    el.style.setProperty('--thread-h', h + 'px');
  }

  function onResize() { sizeThread(); }

  function render(root, params) {
    teardown();
    lastRenderedStatus = null;
    pinnedToBottom = true;

    var id = params.id;
    root.innerHTML = U.spinner('Opening thread');

    /* app.js discards the container on every navigation. When that happens this
     * node is no longer in the document, which is the signal to release the
     * subscriptions — checked on each callback rather than tracked separately,
     * so there's no route-change hook to forget to wire up. */
    function alive() { return document.body.contains(root); }

    Store.getRequest(id).then(function (req) {
      if (!req) {
        root.innerHTML = U.empty('Thread not found', 'It may have been cancelled.');
        return;
      }
      if (req.buyerId !== Store.uid() && req.sellerId !== Store.uid()) {
        root.innerHTML = U.empty('Not your thread', '');
        return;
      }

      shell(root, req);

      stopRequest = Store.watchRequest(id, function (fresh) {
        if (!alive()) { teardown(); return; }
        if (!fresh) return;
        current = fresh;
        drawHeader(root, fresh);
        drawScheduling(root, fresh);
      });

      stopMessages = Store.watchMessages(id, function (msgs) {
        if (!alive()) { teardown(); return; }
        drawMessages(root, msgs, current);
      });

      Store.markRead(id, req.buyerId === Store.uid());
    }).catch(function (err) {
      console.error('[tabled] thread load failed', err);
      root.innerHTML = U.empty('Could not open that thread', '');
    });
  }

  var current = null;

  /* ---- Shell ------------------------------------------------------------- */

  function shell(root, req) {
    current = req;
    root.innerHTML =
      '<div class="thread">' +
        '<div id="t-header"></div>' +
        '<div id="t-sched"></div>' +
        '<div class="messages" id="t-messages">' + U.spinner('') + '</div>' +
        '<form class="composer" id="t-composer">' +
          '<textarea id="t-input" rows="1" maxlength="1000" ' +
            'placeholder="Message…" autocomplete="off"></textarea>' +
          '<button class="btn send" type="submit" aria-label="Send">↑</button>' +
        '</form>' +
      '</div>';

    drawHeader(root, req);
    drawScheduling(root, req);

    var form = U.$('#t-composer', root);
    var input = U.$('#t-input', root);

    /* Grow with the text up to a cap, so a long message is readable while
     * composing without the composer eating the whole thread. */
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    });

    /* Enter sends on desktop; Shift+Enter makes a newline. On touch keyboards
     * Enter must insert a newline instead — there's no Shift, and hijacking it
     * makes multi-line messages impossible to type. */
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey) return;
      if (window.matchMedia('(hover: none)').matches) return;
      e.preventDefault();
      form.requestSubmit();
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      if (current && ['cancelled', 'expired'].indexOf(current.status) !== -1) {
        U.toast('This thread is closed', 'warn');
        return;
      }
      input.value = '';
      input.style.height = 'auto';
      pinnedToBottom = true;
      Store.sendMessage(current.id, text).catch(function (err) {
        console.error('[tabled] send failed', err);
        U.toast('Message not sent', 'bad');
        input.value = text;
      });
    });

    sizeThread(root);
    window.addEventListener('resize', onResize);

    var list = U.$('#t-messages', root);
    /* Only auto-scroll when the reader is already at the bottom. Yanking
     * someone back down while they're reading history is the single most
     * irritating thing a chat view can do. */
    list.addEventListener('scroll', function () {
      pinnedToBottom = (list.scrollHeight - list.scrollTop - list.clientHeight) < 60;
    });
  }

  /* ---- Header ------------------------------------------------------------ */

  function drawHeader(root, req) {
    var host = U.$('#t-header', root);
    if (!host) return;
    var mine = req.sellerId === Store.uid();
    var other = mine
      ? { id: req.buyerId, displayName: req.buyerName, photoURL: req.buyerPhoto }
      : { id: req.sellerId, displayName: req.sellerName, photoURL: req.sellerPhoto };

    host.innerHTML =
      '<div class="thread-head">' +
        '<a class="thread-who" href="#/profile/' + U.attr(other.id) + '">' +
          U.avatar(other, '') +
          '<div>' +
            '<strong>' + U.esc(other.displayName || 'User') + '</strong>' +
            '<span class="fine">' + (mine ? 'wants to buy' : 'selling') + ' ' +
              U.esc(req.gameName || 'this game') + '</span>' +
          '</div>' +
        '</a>' +
        Safety.menuHtml('user', other.id, other.displayName, other.id) +
      '</div>' +
      tradeOfferHtml(req) +
      '<a class="thread-item" href="#/listing/' + U.attr(req.listingId) + '">' +
        (U.safeUrl(req.coverPhoto)
          ? '<span class="ti-photo" style="' + U.bgurl(req.coverPhoto) + '"></span>'
          : '<span class="ti-photo noimg"></span>') +
        '<span class="grow">' + U.esc(req.gameName || 'Game') + '</span>' +
        '<span class="price">' +
          (typeof req.askingPrice === 'number' ? U.esc(U.money(req.askingPrice)) : 'Ask') +
        '</span>' +
      '</a>';

    Safety.wireMenu(host, {
      sellerId: other.id,
      sellerName: other.displayName,
      onBlock: function () { App.go('dashboard', {}); }
    });
  }

  /* What's on the table, when this is a trade rather than a purchase. Shown in
   * the header rather than buried in chat, because it is the whole substance of
   * the conversation. */
  function tradeOfferHtml(req) {
    if (req.proposalType !== 'trade') return '';
    var what = req.offeredGameName ||
      (req.offeredItemDescription && req.offeredItemDescription.name) || 'a game';
    var desc = req.offeredItemDescription;
    var cash = typeof req.additionalCashOffered === 'number' && req.additionalCashOffered > 0
      ? ' + ' + U.money(req.additionalCashOffered) : '';

    return '<div class="trade-offer">' +
      '<span class="badge deal">Trade</span>' +
      '<div class="grow">' +
        '<strong>' + U.esc(what) + U.esc(cash) + '</strong>' +
        '<span class="fine">' +
          (desc
            ? U.esc(CFG.condition(desc.condition).label) +
              (desc.notes ? ' \u00b7 ' + U.esc(desc.notes) : '') +
              ' \u00b7 not a listing, described by them'
            : 'from their listings') +
        '</span>' +
      '</div>' +
    '</div>';
  }

  /* ---- Scheduling -------------------------------------------------------- */

  function drawScheduling(root, req) {
    var host = U.$('#t-sched', root);
    if (!host) return;
    var key = [req.status, req.proposedTime, req.buyerConfirmedAt,
      req.sellerConfirmedAt, req.closedReason,
      req.meetingAddressPending, req.meetingAddressFor].join('|');
    if (lastRenderedStatus === key) return;
    lastRenderedStatus = key;

    var amSeller = req.sellerId === Store.uid();
    var html = '';

    /* Someone waiting in line can read and chat, but cannot put a time on the
     * table — that's the holder's turn to take. Enforced in firestore.rules;
     * the UI just avoids offering a button that would be rejected. */
    if (req.status === 'queued') {
      html =
        '<div class="sched queued">' +
          '<p class="sched-state">' +
            (amSeller
              ? U.esc((req.buyerName || 'They') + ' is #' + (req.queuePosition + 1) +
                ' in line for this one.')
              : U.esc("You're #" + (req.queuePosition + 1) + ' in line.')) +
          '</p>' +
          '<p class="fine">' + (amSeller
            ? 'You\'re currently arranging this with someone ahead of them.'
            : 'You can still ask questions here. If the person ahead doesn\'t follow ' +
              'through within ' + CFG.QUEUE.holdHours + ' hours, it passes to you automatically.') +
          '</p>' +
        '</div>';

    } else if (req.status === 'onHold') {
      html =
        '<div class="sched">' +
          '<p class="sched-state">No time agreed yet.' +
            holdCountdown(req, amSeller) + '</p>' +
          (amSeller ? '' : '<button class="btn small" data-act="slots">Pick a slot</button>') +
          '<button class="btn ghost small" data-act="propose">' +
            (amSeller ? 'Propose a time' : 'Suggest another time') + '</button>' +
        '</div>';

    } else if (req.status === 'proposedTime') {
      var byMe = req.proposedBy === Store.uid();
      var when = U.esc(whenLabel(req.proposedTime));
      var how = 'meet up';

      html =
        '<div class="sched proposed">' +
          '<p class="sched-state"><strong>' + when + '</strong> — ' + U.esc(how) + '</p>' +
          (amSeller
            /* The seller is always the one who confirms, whoever proposed. */
            ? '<div class="sched-actions">' +
                '<button class="btn small" data-act="confirm">Confirm</button>' +
                '<button class="btn ghost small" data-act="decline">Decline</button>' +
              '</div>'
            : '<p class="fine">' + (byMe
                ? 'Waiting for the seller to confirm.'
                : 'The seller proposed this — they still need to confirm it once you agree in chat.') +
              '</p>' +
              '<button class="btn ghost small" data-act="propose">Propose a different time</button>') +
        '</div>';

    } else if (req.status === 'scheduled') {
      /* Mutual confirmation. The app can never see money change hands outside
       * it, but it can see two people independently agreeing that it did — and
       * that agreement is the one thing neither side can fake alone. */
      var mineDone = !!Store.myConfirmation(req);
      var theirsDone = !!Store.theirConfirmation(req);
      var otherName = amSeller ? (req.buyerName || 'the buyer') : (req.sellerName || 'the seller');

      html =
        '<div class="sched confirmed">' +
          '<p class="sched-state">✓ Confirmed for <strong>' +
            U.esc(whenLabel(req.scheduledTime)) + '</strong>' +
            ' — meeting up</p>' +
          (mineDone
            ? '<p class="fine">You\'ve marked this done. Waiting on ' +
              U.esc(otherName) + ' to confirm before it counts.</p>'
            : (theirsDone
                ? '<p class="fine">' + U.esc(otherName) + ' has marked this done. ' +
                  'Confirm to complete the trade.</p>'
                : '<p class="fine">Once you\'ve actually swapped the game, both of you ' +
                  'confirm here. That\'s what records the trade and opens reviews.</p>')) +
          (mineDone
            ? '<span class="badge verified">You confirmed</span>'
            : '<button class="btn small" data-act="sold">' +
              (theirsDone ? 'Confirm — completes the trade' : 'Mark as done') + '</button>') +
          (mineDone ? '' :
            '<button class="btn ghost small" data-act="propose">Change the time</button>') +
        '</div>' +
        meetingToolkit(req);

    } else if (req.status === 'cancelled' || req.status === 'expired') {
      html = '<div class="sched closed"><p class="sched-state">' +
        (req.closedReason === 'itemSold'
          ? 'This game sold to someone else.'
          : 'This request was ' + U.esc(req.status) + '.') +
        '</p></div>';

    } else if (req.status === 'completed') {
      html =
        '<div class="sched confirmed">' +
          '<p class="sched-state">✓ Trade completed.</p>' +
          '<button class="btn small" data-act="review">Leave a review</button>' +
        '</div>';
    }

    if (['cancelled', 'expired', 'completed'].indexOf(req.status) === -1) {
      html += '<button class="linkish cancel-req" data-act="cancel">' +
        (amSeller ? 'Decline this request' : 'Cancel my request') + '</button>';
    }

    host.innerHTML = html;

    U.on(host, '[data-act]', function (e, t) {
      var act = t.dataset.act;
      if (act === 'propose') proposeDialog(req);
      else if (act === 'slots') slotDialog(req);
      else if (act === 'sold') confirmSold(req, t);
      else if (act === 'review') reviewDialog(req);
      else if (act === 'share-address') shareAddressDialog(req);
      else if (act === 'view-address') viewAddressDialog(req);
      else if (act === 'safe-spot') safeSpotDialog(req);
      else if (act === 'confirm-pickup') confirmPickup(req);
      else if (act === 'confirm') respond(req, true);
      else if (act === 'decline') respond(req, false);
      else if (act === 'cancel') cancel(req, amSeller);
    });
  }

  /* The hold clock, stated as remaining time rather than a deadline timestamp —
   * "about 6 hours left" is actionable where "expires 2026-08-21T09:14Z" needs
   * mental arithmetic. Only shown when it's actually close enough to matter. */
  function holdCountdown(req, amSeller) {
    var d = U.toDate(req.holdExpiresAt);
    if (!d) return '';
    var hoursLeft = (d.getTime() - Date.now()) / 3600000;
    if (hoursLeft <= 0) {
      return ' <span class="hold-warn">Hold has lapsed — it may pass to the next in line.</span>';
    }
    if (hoursLeft > CFG.QUEUE.holdHours) return '';

    var left = hoursLeft < 1
      ? Math.max(1, Math.round(hoursLeft * 60)) + ' min'
      : Math.round(hoursLeft) + 'h';

    if (amSeller) {
      return ' <span class="fine">(their hold has ' + U.esc(left) + ' left)</span>';
    }
    return ' <span class="' + (hoursLeft < 4 ? 'hold-warn' : 'fine') + '">' +
      U.esc(left) + ' left to lock in a time.</span>';
  }

  function whenLabel(v) {
    var d = U.toDate(v);
    if (!d) return 'a time';
    return d.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  }

  /* ---- Auto-book slot picker (M6) ----------------------------------------
   * One tap claims a 30-minute increment out of the seller's standing weekly
   * availability. Exclusivity is the deterministic document ID, so a race here
   * fails cleanly with "someone just took that" rather than double-booking.
   *
   * Everything is rendered in the VIEWER's local time — the buyer needs to know
   * when to leave their own house. When the two zones differ, each slot also
   * carries the seller's own clock, because "2pm your time" and "2pm their
   * time" being different is exactly the thing that wastes an afternoon. */
  function slotDialog(req) {
    var m = U.modal('Pick a slot', U.spinner('Loading availability'));

    Promise.all([
      Store.getUser(req.sellerId),
      Store.getBookedSlots(req.sellerId)
    ]).then(function (res) {
      var seller = res[0] || {};
      var taken = res[1] || [];
      var windows = seller.availabilityWindows || [];
      var tz = seller.timeZone;

      if (!windows.length || !tz) {
        m.el.innerHTML = U.empty("No set availability",
          (seller.displayName || 'This seller') + " hasn't published meeting times. " +
          'Agree one in chat instead.') +
          '<div class="modal-actions"><button class="btn" data-act="chat">Suggest a time</button></div>';
        U.on(m.el, '[data-act="chat"]', function () { m.close(); proposeDialog(req); });
        return;
      }

      var slots = TimeSlots.generateSlots(windows, tz, {
        sellerId: req.sellerId,
        taken: taken,
        fromMs: Date.now()
      });

      if (!slots.length) {
        m.el.innerHTML = U.empty('No open slots',
          'Everything in the next two weeks is taken or already past. ' +
          'Suggest a time in chat instead.') +
          '<div class="modal-actions"><button class="btn" data-act="chat">Suggest a time</button></div>';
        U.on(m.el, '[data-act="chat"]', function () { m.close(); proposeDialog(req); });
        return;
      }

      var crossZone = !TimeSlots.sameOffset(tz, TimeSlots.currentZone());
      var days = TimeSlots.groupByDay(slots, tz);

      m.el.innerHTML =
        (crossZone
          ? '<p class="banner warn">' + U.esc(seller.displayName || 'The seller') +
            ' is in ' + U.esc(tz) + '. Times below are in <strong>your</strong> local ' +
            'time, with theirs in brackets.</p>'
          : '') +
        days.map(function (day) {
          return '<div class="slot-day">' +
            '<h4>' + U.esc(day.label) + '</h4>' +
            '<div class="chip-row">' +
              day.slots.map(function (s) {
                var theirs = crossZone
                  ? ' <span class="slot-alt">(' + U.esc(s.startTime) + ' their time)</span>'
                  : '';
                return '<button class="chip slot" data-date="' + U.attr(s.date) + '" ' +
                  'data-start="' + U.attr(s.startTime) + '">' +
                  U.esc(TimeSlots.localTimeLabel(s.startsAtMs)) + theirs + '</button>';
              }).join('') +
            '</div>' +
          '</div>';
        }).join('') +
        '<p class="fine">Booking a slot reserves it and asks the seller to confirm. ' +
          'Nothing is final until they do.</p>';

      U.on(m.el, '.slot', function (e, t) {
        var btn = t;
        U.$$('.slot', m.el).forEach(function (b) { b.disabled = true; });
        btn.textContent = 'Booking…';

        Store.bookSlot(req.id, btn.dataset.date, btn.dataset.start).then(function () {
          m.close();
          U.toast('Slot booked — waiting on the seller to confirm');
          return Store.sendMessage(req.id,
            'Booked your ' + whenLabel(new Date(TimeSlots.zonedToUtc(
              btn.dataset.date, btn.dataset.start, tz))) + ' slot.');
        }).catch(function (err) {
          console.error('[tabled] bookSlot failed', err);
          var msg = (err && err.message) || '';
          if (/already-exists|just took/i.test((err && err.code) + ' ' + msg)) {
            /* The exclusivity mechanism firing, not a fault. Reopen with a
             * fresh list rather than leaving a dead button on screen. */
            U.toast('Someone just took that one — here are the rest', 'warn');
            m.close();
            slotDialog(req);
            return;
          }
          U.toast(msg || 'Could not book that slot', 'bad');
          U.$$('.slot', m.el).forEach(function (b) { b.disabled = false; });
          btn.textContent = TimeSlots.localTimeLabel(
            TimeSlots.zonedToUtc(btn.dataset.date, btn.dataset.start, tz));
        });
      });
    }).catch(function (err) {
      console.error('[tabled] slot load failed', err);
      m.el.innerHTML = U.empty('Could not load availability', '');
    });
  }

  function proposeDialog(req) {
    var now = new Date();
    /* Default to tomorrow at a plausible hour rather than "right now", which is
     * never the answer and forces every user to change both fields. */
    var d = new Date(now.getTime() + 86400000);
    d.setHours(18, 0, 0, 0);
    var localValue = toLocalInput(d);

    var m = U.modal('Propose a time',
      '<label class="field">' +
        '<span>When</span>' +
        '<input id="p-when" type="datetime-local" value="' + U.attr(localValue) + '" ' +
          'min="' + U.attr(toLocalInput(now)) + '">' +
      '</label>' +
      '<p class="fine">You\'ll meet up in person to hand it over. Sort out where in ' +
        'chat once the time is set.</p>' +
      '<div class="modal-actions">' +
        '<button class="btn ghost" data-act="no">Cancel</button>' +
        '<button class="btn" data-act="go">Propose</button>' +
      '</div>');

    /* Pickup is the only method Tabled supports; it's still written onto the
     * request so the data model and the scheduling functions are unchanged. */
    var method = 'pickup';

    U.on(m.el, '[data-act]', function (e, t) {
      if (t.dataset.act === 'no') { m.close(); return; }
      var raw = U.$('#p-when', m.el).value;
      if (!raw) { U.toast('Pick a date and time', 'warn'); return; }
      var when = new Date(raw);
      if (isNaN(when)) { U.toast('That date didn\'t parse', 'warn'); return; }
      if (when.getTime() < Date.now() - 60000) {
        U.toast('That time is in the past', 'warn');
        return;
      }
      m.close();

      /* A Date, not epoch milliseconds. Firestore stores a Date as a Timestamp,
       * and advanceExpiredHolds runs range queries against this field —
       * Firestore sorts numbers and Timestamps as separate type groups, so a
       * mix produces silently wrong sweep results rather than an error. */
      Store.updateRequest(req.id, {
        status: 'proposedTime',
        proposedTime: when,
        proposedBy: Store.uid(),
        method: method
      }).then(function () {
        /* Post it into the thread too. A scheduling change that only shows in
         * a header the other person has to notice is a scheduling change that
         * gets missed. */
        return Store.sendMessage(req.id,
          'Proposed ' + whenLabel(when) + ' — meet up.');
      }).catch(function (err) {
        console.error('[tabled] propose failed', err);
        U.toast('Could not propose that time', 'bad');
      });
    });
  }

  /* <input type="datetime-local"> wants local wall-clock time with no zone,
   * which is exactly what toISOString() does NOT give you. */
  function toLocalInput(d) {
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function respond(req, confirmed) {
    /* Normalized through toDate so the value written is always a Date — the
     * proposal may have come back from Firestore as a Timestamp or from the
     * demo store as an ISO string, and scheduledTime has to stay one type for
     * the no-show sweep's range query to work. */
    var patch = confirmed
      ? { status: 'scheduled', scheduledTime: U.toDate(req.proposedTime) }
      /* Declining returns the buyer to holder state rather than ending the
       * request — they proposed in good faith and shouldn't lose their place
       * over a time that didn't suit. */
      : { status: 'onHold', proposedTime: null, proposedBy: null };

    Store.updateRequest(req.id, patch).then(function () {
      return Store.sendMessage(req.id, confirmed
        ? 'Confirmed ' + whenLabel(req.proposedTime) + '.'
        : 'Declined that time — propose another?');
    }).catch(function (err) {
      console.error('[tabled] respond failed', err);
      U.toast('Could not update that', 'bad');
    });
  }

  function cancel(req, amSeller) {
    U.confirm(amSeller ? 'Decline this request?' : 'Cancel your request?',
      amSeller
        ? 'The buyer is told the request was declined. The game becomes available again.'
        : 'The seller is told you cancelled. You can request it again later if it\'s still up.',
      amSeller ? 'Decline' : 'Cancel request'
    ).then(function (ok) {
      if (!ok) return;
      Store.updateRequest(req.id, { status: 'cancelled' }).then(function () {
        U.toast('Request cancelled');
        App.go('dashboard', {});
      }).catch(function (err) {
        console.error('[tabled] cancel failed', err);
        U.toast('Could not cancel', 'bad');
      });
    });
  }

  /* ---- Meeting toolkit (privacy & safety) ---------------------------------
   * Sits under a confirmed meetup. The address is never typed into the chat —
   * it is released through a one-time card, read once, and cleared on pickup.
   * A safe public place can be picked instead, which sidesteps sharing a home
   * address at all. */
  function meetingToolkit(req) {
    return '<div class="sched meet-toolkit">' +
      '<p class="fine"><strong>Meeting up.</strong> Pick somewhere public, or ' +
      'share an address only when you\'re actually on your way.</p>' +
      '<div class="chip-row">' +
        '<button class="btn ghost small" data-act="safe-spot">Suggest a safe spot</button>' +
        '<button class="btn ghost small" data-act="share-address">Share an address</button>' +
      '</div>' +
      addressPendingFor(req) +
    '</div>';
  }

  /* When an address is waiting FOR me, show the read-once button. */
  function addressPendingFor(req) {
    if (req.meetingAddressPending && req.meetingAddressFor === Store.uid()) {
      return '<div class="addr-waiting">' +
        '<p class="fine">An address is waiting for you. Open it when you\'re ready ' +
        'to head over \u2014 it disappears once you confirm pickup.</p>' +
        '<button class="btn small" data-act="view-address">Show the address</button>' +
      '</div>';
    }
    if (req.meetingAddressPending && req.meetingAddressFor !== Store.uid()) {
      return '<p class="fine">You\'ve shared an address. It clears automatically ' +
        'once they confirm pickup, or after the window you set.</p>';
    }
    return '';
  }

  function shareAddressDialog(req) {
    var m = U.modal('Share an address',
      '<p class="modal-msg">This goes straight to ' +
        U.esc(req.sellerId === Store.uid() ? (req.buyerName || 'the buyer') : (req.sellerName || 'the seller')) +
        ' and nowhere else. It is never posted in the chat, and Tabled stores it ' +
        'encrypted only until pickup is confirmed.</p>' +
      '<label class="field"><span>Address</span>' +
        '<textarea id="addr-text" rows="3" maxlength="400" ' +
          'placeholder="42 Elm Street, Apt 3B\nWorcester, MA 01609"></textarea></label>' +
      '<label class="field"><span>Keep it available for</span>' +
        '<select id="addr-ttl">' +
          '<option value="today">Just today</option>' +
          '<option value="24" selected>24 hours</option>' +
          (U.toDate(req.scheduledTime) ? '<option value="sched">Until our time, plus a few hours</option>' : '') +
          '<option value="48">48 hours</option>' +
        '</select>' +
        '<span class="fine">It clears the moment they confirm pickup, whichever comes first. ' +
          'Maximum 48 hours either way.</span>' +
      '</label>' +
      '<div class="modal-actions">' +
        '<button class="btn ghost" data-act="cancel">Cancel</button>' +
        '<button class="btn" data-act="send">Share it</button>' +
      '</div>');

    U.on(m.el, '[data-act]', function (e, t) {
      if (t.dataset.act === 'cancel') { m.close(); return; }
      var addr = U.$('#addr-text', m.el).value.trim();
      if (addr.length < 5) { U.toast('That address looks too short', 'warn'); return; }

      var choice = U.$('#addr-ttl', m.el).value;
      var ttlMs = 24 * 3600000;
      if (choice === 'today') {
        var end = new Date(); end.setHours(23, 59, 59, 0);
        ttlMs = Math.max(3600000, end.getTime() - Date.now());
      } else if (choice === '48') ttlMs = 48 * 3600000;
      else if (choice === 'sched') {
        var st = U.toDate(req.scheduledTime);
        if (st) ttlMs = Math.max(3600000, st.getTime() + 3 * 3600000 - Date.now());
      }

      t.disabled = true;
      t.textContent = 'Sharing\u2026';
      Store.releaseMeetingAddress(req.id, addr, ttlMs).then(function () {
        m.close();
        U.toast('Address shared \u2014 it clears on pickup');
      }).catch(function (err) {
        console.error('[tabled] address release failed', err);
        U.toast((err && err.message) || 'Could not share that', 'bad');
        t.disabled = false;
        t.textContent = 'Share it';
      });
    });
  }

  function viewAddressDialog(req) {
    var m = U.modal('Meeting address', U.spinner('Opening'));
    Store.readMeetingAddress(req.id).then(function (res) {
      m.el.innerHTML =
        '<div class="addr-reveal">' +
          '<p class="addr-line">' + U.esc(res.address) + '</p>' +
        '</div>' +
        '<p class="fine">Available until ' + U.esc(whenLabel(new Date(res.expireAtMs))) +
          '. Confirm pickup once you have the game and it clears immediately.</p>' +
        '<div class="modal-actions">' +
          '<button class="btn ghost" data-act="close">Close</button>' +
          '<button class="btn" data-act="picked">I\'ve picked it up</button>' +
        '</div>';
      U.on(m.el, '[data-act]', function (e, t) {
        if (t.dataset.act === 'close') { m.close(); return; }
        m.close();
        confirmPickup(req);
      });
    }).catch(function (err) {
      m.el.innerHTML = U.empty('No address',
        (err && err.message) || 'Nothing is waiting for you.');
    });
  }

  function confirmPickup(req) {
    Store.confirmPickup(req.id).then(function () {
      U.toast('Pickup confirmed \u2014 address cleared');
    }).catch(function (err) {
      console.error('[tabled] confirm pickup failed', err);
      U.toast((err && err.message) || 'Could not confirm', 'bad');
    });
  }

  /* The point we search around. Prefer the profile's stored geoPoint; but a
   * profile can have an area with no point yet -- e.g. it was saved during the
   * window when geocoding wasn't reachable. In that case geocode the saved area
   * on demand, use it now, and quietly backfill the profile so it's fixed for
   * good (and so distance search starts working too). */
  function resolveMyPoint() {
    var me = Store.me();
    if (me && me.geoPoint) return Promise.resolve(me.geoPoint);
    if (!me || !me.generalArea) return Promise.resolve(null);
    return Store.geocodeArea(me.generalArea).then(function (res) {
      if (!res || typeof res.lat !== 'number') return null;
      var pt = { lat: res.lat, lng: res.lng };
      var patch = {
        geoPoint: pt, geohash: res.geohash || null,
        countryCode: res.countryCode || null, state: res.state || null
      };
      /* Same label upgrade as Store.backfillGeoPoint -- whichever of the two
       * fires first, the profile ends up consistent. */
      if (res.areaLabel) patch.generalArea = res.areaLabel;
      Store.saveProfile(patch).catch(function () {});   /* backfill is best-effort */
      return pt;
    }).catch(function () { return null; });
  }

  /* An address the seller chose to remember for safe-spot searches. Kept in
   * THIS browser only -- never sent to the server, never on their profile. */
  var SPOT_ADDR_KEY = 'tabled.safeSpotAddr';
  function savedSpotAddr() {
    try { return localStorage.getItem(SPOT_ADDR_KEY) || ''; } catch (e) { return ''; }
  }
  function setSavedSpotAddr(v) {
    try { if (v) localStorage.setItem(SPOT_ADDR_KEY, v); else localStorage.removeItem(SPOT_ADDR_KEY); } catch (e) {}
  }

  /* The safe-spot picker. Defaults to searching around the seller's fuzzed
   * profile point, but lets them give a precise location -- a typed address or
   * the device's current position -- for THAT lookup only. The precise location is
   * used to find nearby public places and then discarded: never stored on the
   * profile or a listing, never shown to the other person. A typed address can
   * optionally be remembered in this browser (only) for convenience. */
  function safeSpotDialog(req) {
    var m = U.modal('Somewhere safe to meet',
      '<div id="ss-loc"></div><div id="ss-results">' + U.spinner('Finding public places') + '</div>');
    var locBar = U.$('#ss-loc', m.el);
    var results = U.$('#ss-results', m.el);

    function searchAt(pt) {
      results.innerHTML = U.spinner('Finding public places');
      return Store.findSafeSpots(pt.lat, pt.lng).then(renderSpots).catch(function (err) {
        results.innerHTML = U.empty('Could not look that up',
          (err && err.message) || 'Try again in a moment.');
      });
    }

    function renderSpots(spots) {
      if (!spots.length) {
        results.innerHTML = U.empty('Nothing found nearby',
          'Try a specific address above, or pick a public place you both know — a busy ' +
          'cafe or a police station exchange zone is the usual advice.');
        return;
      }
      var KIND = { police: 'Police exchange zone', cafe: 'Cafe', library: 'Library' };
      results.innerHTML =
        '<p class="modal-msg">Meeting in public is the single best safety step. ' +
        'Police-station exchange zones are safest; a busy cafe is fine too.</p>' +
        '<div class="event-list">' +
          spots.map(function (sp) {
            return '<button class="event-row" data-spot="' + U.attr(sp.name) + '">' +
              '<div class="grow">' +
                '<strong>' + U.esc(sp.name) + '</strong>' +
                '<span class="fine">' + U.esc(KIND[sp.kind] || sp.kind) +
                  ' · ' + U.esc(sp.distanceMi + ' mi') + '</span>' +
              '</div></button>';
          }).join('') +
        '</div>' +
        '<p class="bgg-attrib"><a href="https://www.openstreetmap.org/copyright" ' +
          'target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a></p>';
    }

    function drawLoc(label, expanded) {
      var addr = savedSpotAddr();
      locBar.innerHTML =
        '<div class="ss-locbar">' +
          '<span class="fine">Searching near <strong>' + U.esc(label) + '</strong>.</span> ' +
          '<button class="linkish" id="ss-toggle">' +
            (expanded ? 'Hide' : 'Use a specific address') + '</button>' +
        '</div>' +
        (expanded
          ? '<div class="ss-addr">' +
              '<input id="ss-input" type="text" autocomplete="off" ' +
                'placeholder="123 Main St, your town" value="' + U.attr(addr) + '">' +
              '<div class="ss-addr-actions">' +
                '<button class="btn small" id="ss-search">Search here</button>' +
                (navigator.geolocation
                  ? '<button class="btn ghost small" id="ss-gps">Use my location</button>' : '') +
              '</div>' +
              '<label class="ss-save"><input type="checkbox" id="ss-remember"' +
                (addr ? ' checked' : '') + '> Remember this address on this device</label>' +
              '<p class="fine">Only used to find nearby places right now — never saved to ' +
                'your profile, shown to anyone, or attached to a listing.</p>' +
            '</div>'
          : '');
      wireLoc(label, expanded);
    }

    function wireLoc(label, expanded) {
      var tog = U.$('#ss-toggle', m.el);
      if (tog) tog.addEventListener('click', function () { drawLoc(label, !expanded); });

      var srch = U.$('#ss-search', m.el);
      if (srch) srch.addEventListener('click', function () {
        var v = U.$('#ss-input', m.el).value.trim();
        if (!v) { U.toast('Enter an address', 'warn'); return; }
        setSavedSpotAddr(U.$('#ss-remember', m.el).checked ? v : '');
        results.innerHTML = U.spinner('Finding the address');
        Store.geocodeArea(v).then(function (res) {
          if (!res || typeof res.lat !== 'number') throw new Error('notfound');
          drawLoc('that address', true);
          return searchAt({ lat: res.lat, lng: res.lng });
        }).catch(function (err) {
          if (err && /out-of-range/.test(err.code || '')) {
            results.innerHTML = U.empty('That address isn\'t in the US', err.message || '');
          } else {
            results.innerHTML = U.empty('Could not find that address',
              'Check it and try again — a street and town is enough.');
          }
        });
      });

      var gps = U.$('#ss-gps', m.el);
      if (gps) gps.addEventListener('click', function () {
        results.innerHTML = U.spinner('Getting your location');
        navigator.geolocation.getCurrentPosition(function (pos) {
          drawLoc('your current location', true);
          searchAt({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        }, function () {
          results.innerHTML = U.empty('Location unavailable',
            'Allow location access, or type an address instead.');
        }, { enableHighAccuracy: true, timeout: 10000 });
      });
    }

    /* Suggesting a spot posts it into the chat. Delegated on the modal so it
     * keeps working after the results re-render. */
    U.on(m.el, '[data-spot]', function (e, t) {
      var name = t.dataset.spot;
      m.close();
      Store.sendMessage(req.id, 'Let\'s meet at ' + name + '?');
      U.toast('Suggested ' + name + ' in the chat');
    });

    /* Open on the profile's fuzzed area point; if there isn't one, start on the
     * address form instead of a dead end. */
    resolveMyPoint().then(function (pt) {
      var me = Store.me();
      if (!pt) {
        drawLoc('nowhere yet', true);
        results.innerHTML = U.empty('Pick a place to search around',
          'Enter an address above, or use your current location.');
        return;
      }
      drawLoc(me && me.generalArea ? me.generalArea : 'your area', false);
      return searchAt(pt);
    }).catch(function () {
      drawLoc('your area', true);
      results.innerHTML = U.empty('Pick a place to search around',
        'Enter an address above, or use your current location.');
    });
  }

  function findAndRenderSpots(m, req, pt) {
    return Store.findSafeSpots(pt.lat, pt.lng).then(function (spots) {
      if (!spots.length) {
        m.el.innerHTML = U.empty('Nothing found nearby',
          'Pick a public place you both know \u2014 a busy cafe or a police station ' +
          'exchange zone is the usual advice.');
        return;
      }
      var KIND = { police: 'Police exchange zone', cafe: 'Cafe', library: 'Library' };
      m.el.innerHTML =
        '<p class="modal-msg">Meeting in public is the single best safety step. ' +
        'Police-station exchange zones are safest; a busy cafe is fine too.</p>' +
        '<div class="event-list">' +
          spots.map(function (sp) {
            return '<button class="event-row" data-spot="' + U.attr(sp.name) + '">' +
              '<div class="grow">' +
                '<strong>' + U.esc(sp.name) + '</strong>' +
                '<span class="fine">' + U.esc(KIND[sp.kind] || sp.kind) +
                  ' \u00b7 ' + U.esc(sp.distanceMi + ' mi') + '</span>' +
              '</div></button>';
          }).join('') +
        '</div>' +
        '<p class="bgg-attrib"><a href="https://www.openstreetmap.org/copyright" ' +
          'target="_blank" rel="noopener noreferrer">\u00a9 OpenStreetMap contributors</a></p>';

      U.on(m.el, '[data-spot]', function (e, t) {
        var name = t.dataset.spot;
        m.close();
        /* Posting it into chat is fine — a public venue name is not private,
         * and it gives both people a shared, non-address meeting point. */
        Store.sendMessage(req.id, 'Let\'s meet at ' + name + '?');
        U.toast('Suggested ' + name + ' in the chat');
      });
    }).catch(function (err) {
      m.el.innerHTML = U.empty('Could not look that up',
        (err && err.message) || 'Try again in a moment.');
    });
  }

  /* ---- Completion (M7) ---------------------------------------------------- */

  function confirmSold(req, btn) {
    var theirsDone = !!Store.theirConfirmation(req);
    U.confirm(
      theirsDone ? 'Complete this trade?' : 'Mark this as done?',
      theirsDone
        ? 'This completes the trade for both of you. It counts toward both trade '
          + 'histories and opens reviews. This cannot be undone.'
        : 'Only do this once you actually have the game (or have handed it over). '
          + 'The trade completes when the other person confirms too.',
      theirsDone ? 'Complete trade' : 'Mark as done'
    ).then(function (ok) {
      if (!ok) return;
      btn.disabled = true;
      btn.textContent = 'Confirming\u2026';
      Store.confirmSold(req.id).then(function (res) {
        if (res.completed) {
          U.toast('Trade completed \u2014 leave each other a review');
          reviewDialog(req);
        } else {
          U.toast('Marked done \u2014 waiting on the other side');
        }
      }).catch(function (err) {
        console.error('[tabled] confirmSold failed', err);
        U.toast((err && err.message) || 'Could not confirm', 'bad');
        btn.disabled = false;
        btn.textContent = theirsDone ? 'Confirm \u2014 completes the trade' : 'Mark as done';
      });
    });
  }

  /* ---- Reviews (M7) ------------------------------------------------------- */

  function reviewDialog(req) {
    var amSeller = req.sellerId === Store.uid();
    var revieweeId = amSeller ? req.buyerId : req.sellerId;
    var revieweeName = amSeller ? req.buyerName : req.sellerName;
    var me = Store.me() || {};
    var chosen = 0;

    var m = U.modal('Review ' + (revieweeName || 'them'),
      '<div class="rate" role="radiogroup" aria-label="Rating">' +
        [1, 2, 3, 4, 5].map(function (n) {
          return '<button class="star" data-rate="' + n + '" ' +
            'aria-label="' + n + ' star' + (n > 1 ? 's' : '') + '">\u2606</button>';
        }).join('') +
      '</div>' +
      '<p class="fine rate-hint">Tap to rate</p>' +
      '<label class="field">' +
        '<span>Anything worth saying? <em>optional</em></span>' +
        '<textarea id="rv-text" rows="3" maxlength="400" ' +
          'placeholder="Turned up on time, game was exactly as described"></textarea>' +
      '</label>' +
      '<p class="fine">Reviews are public and permanent \u2014 they can\'t be edited or ' +
        'deleted once posted. That is what makes them worth anything.</p>' +
      '<div class="modal-actions">' +
        '<button class="btn ghost" data-act="later">Not now</button>' +
        '<button class="btn" data-act="post">Post review</button>' +
      '</div>');

    var hint = U.$('.rate-hint', m.el);
    var LABELS = ['', 'Poor', 'Not great', 'Fine', 'Good', 'Excellent'];

    U.on(m.el, '[data-rate]', function (e, t) {
      chosen = Number(t.dataset.rate);
      U.$$('.star', m.el).forEach(function (b) {
        var on = Number(b.dataset.rate) <= chosen;
        b.textContent = on ? '\u2605' : '\u2606';
        b.classList.toggle('on', on);
      });
      hint.textContent = LABELS[chosen];
    });

    U.on(m.el, '[data-act]', function (e, t) {
      if (t.dataset.act === 'later') { m.close(); return; }
      if (!chosen) { U.toast('Pick a rating first', 'warn'); return; }
      t.disabled = true;
      t.textContent = 'Posting\u2026';
      Store.createReview({
        requestId: req.id,
        reviewerId: Store.uid(),
        revieweeId: revieweeId,
        reviewerName: me.displayName || '',
        reviewerPhoto: me.photoURL || null,
        gameName: req.gameName || '',
        rating: chosen,
        comment: U.$('#rv-text', m.el).value.trim()
      }).then(function () {
        m.close();
        U.toast('Review posted');
      }).catch(function (err) {
        console.error('[tabled] review failed', err);
        U.toast((err && err.message) || 'Could not post that review', 'bad');
        t.disabled = false;
        t.textContent = 'Post review';
      });
    });
  }

  /* ---- Messages ---------------------------------------------------------- */

  function drawMessages(root, msgs, req) {
    var host = U.$('#t-messages', root);
    if (!host) return;

    if (!msgs.length) {
      host.innerHTML = U.empty('Say hello',
        'Ask about condition, agree a price, or propose a time to meet.');
      return;
    }

    var me = Store.uid();
    var lastDay = '';
    host.innerHTML = msgs.map(function (m) {
      var d = U.toDate(m.createdAt);
      var day = d ? d.toDateString() : '';
      var sep = '';
      if (day && day !== lastDay) {
        lastDay = day;
        sep = '<div class="day-sep"><span>' + U.esc(dayLabel(d)) + '</span></div>';
      }
      var mine = m.senderId === me;
      return sep +
        '<div class="msg' + (mine ? ' mine' : '') + (m.pending ? ' pending' : '') + '" ' +
          'data-mid="' + U.attr(m.id) + '">' +
          '<div class="bubble">' + U.esc(m.text) + '</div>' +
          '<div class="msg-meta">' +
            '<span>' + U.esc(d ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '') + '</span>' +
            (mine ? '' : '<button class="msg-report" data-report-msg="' + U.attr(m.id) + '" ' +
              'title="Report this message">⚑</button>') +
          '</div>' +
        '</div>';
    }).join('');

    U.on(host, '[data-report-msg]', function (e, t) {
      var msg = msgs.filter(function (x) { return x.id === t.dataset.reportMsg; })[0];
      if (!msg) return;
      Safety.report('message', msg.id, 'this message', {
        contextRequestId: req && req.id,
        /* The reported text travels with the report. By the time anyone reads
         * it the message may be long gone, and a report with no artifact is
         * unreviewable. */
        prefillNote: msg.text.slice(0, 280)
      });
    });

    if (pinnedToBottom) host.scrollTop = host.scrollHeight;
  }

  function dayLabel(d) {
    var today = new Date().toDateString();
    var yday = new Date(Date.now() - 86400000).toDateString();
    if (d.toDateString() === today) return 'Today';
    if (d.toDateString() === yday) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  return { render: render, teardown: teardown, reviewDialog: reviewDialog };
})();
