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
      '<a class="thread-item" href="#/listing/' + U.attr(req.listingId) + '">' +
        (U.safeUrl(req.coverPhoto)
          ? '<span class="ti-photo" style="background-image:url(' +
            U.attr(U.safeUrl(req.coverPhoto)) + ')"></span>'
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

  /* ---- Scheduling -------------------------------------------------------- */

  function drawScheduling(root, req) {
    var host = U.$('#t-sched', root);
    if (!host) return;
    if (lastRenderedStatus === req.status + '|' + String(req.proposedTime)) return;
    lastRenderedStatus = req.status + '|' + String(req.proposedTime);

    var amSeller = req.sellerId === Store.uid();
    var html = '';

    if (req.status === 'onHold' || req.status === 'queued') {
      html =
        '<div class="sched">' +
          '<p class="sched-state">No time agreed yet.</p>' +
          '<button class="btn small" data-act="propose">Propose a time</button>' +
        '</div>';

    } else if (req.status === 'proposedTime') {
      var byMe = req.proposedBy === Store.uid();
      var when = U.esc(whenLabel(req.proposedTime));
      var how = req.method === 'shipping' ? 'ship' : 'meet up';

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
      html =
        '<div class="sched confirmed">' +
          '<p class="sched-state">✓ Confirmed for <strong>' +
            U.esc(whenLabel(req.scheduledTime)) + '</strong>' +
            (req.method === 'shipping' ? ' — shipping' : ' — meeting up') + '</p>' +
          '<p class="fine">Marking the trade complete (and leaving reviews) arrives with a ' +
            'later milestone. For now, this is the handshake.</p>' +
          '<button class="btn ghost small" data-act="propose">Change the time</button>' +
        '</div>';

    } else if (req.status === 'cancelled' || req.status === 'expired') {
      html = '<div class="sched closed"><p class="sched-state">This request was ' +
        U.esc(req.status) + '.</p></div>';

    } else if (req.status === 'completed') {
      html = '<div class="sched confirmed"><p class="sched-state">✓ Trade completed.</p></div>';
    }

    if (['cancelled', 'expired', 'completed'].indexOf(req.status) === -1) {
      html += '<button class="linkish cancel-req" data-act="cancel">' +
        (amSeller ? 'Decline this request' : 'Cancel my request') + '</button>';
    }

    host.innerHTML = html;

    U.on(host, '[data-act]', function (e, t) {
      var act = t.dataset.act;
      if (act === 'propose') proposeDialog(req);
      else if (act === 'confirm') respond(req, true);
      else if (act === 'decline') respond(req, false);
      else if (act === 'cancel') cancel(req, amSeller);
    });
  }

  function whenLabel(v) {
    var d = U.toDate(v);
    if (!d) return 'a time';
    return d.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  }

  function proposeDialog(req) {
    var now = new Date();
    /* Default to tomorrow at a plausible hour rather than "right now", which is
     * never the answer and forces every user to change both fields. */
    var d = new Date(now.getTime() + 86400000);
    d.setHours(18, 0, 0, 0);
    var localValue = toLocalInput(d);
    var canShip = true;

    var m = U.modal('Propose a time',
      '<label class="field">' +
        '<span>When</span>' +
        '<input id="p-when" type="datetime-local" value="' + U.attr(localValue) + '" ' +
          'min="' + U.attr(toLocalInput(now)) + '">' +
      '</label>' +
      '<div class="field">' +
        '<span>How</span>' +
        '<div class="chip-row">' +
          '<button class="chip on" data-method="pickup">Meet up</button>' +
          (canShip ? '<button class="chip" data-method="shipping">Ship it</button>' : '') +
        '</div>' +
        '<span class="fine">Shipping addresses are exchanged here in chat — Tabled never ' +
          'stores one.</span>' +
      '</div>' +
      '<div class="modal-actions">' +
        '<button class="btn ghost" data-act="no">Cancel</button>' +
        '<button class="btn" data-act="go">Propose</button>' +
      '</div>');

    var method = 'pickup';
    U.on(m.el, '[data-method]', function (e, t) {
      method = t.dataset.method;
      U.$$('[data-method]', m.el).forEach(function (b) {
        b.classList.toggle('on', b.dataset.method === method);
      });
    });

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

      Store.updateRequest(req.id, {
        status: 'proposedTime',
        proposedTime: when.getTime(),
        proposedBy: Store.uid(),
        method: method
      }).then(function () {
        /* Post it into the thread too. A scheduling change that only shows in
         * a header the other person has to notice is a scheduling change that
         * gets missed. */
        return Store.sendMessage(req.id,
          'Proposed ' + whenLabel(when) + ' — ' +
          (method === 'shipping' ? 'shipping' : 'meet up') + '.');
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
    var patch = confirmed
      ? { status: 'scheduled', scheduledTime: req.proposedTime }
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

  return { render: render, teardown: teardown };
})();
