/* Tabled — reporting and blocking (M1).
 *
 * Two different tools that people constantly conflate, kept deliberately
 * distinct in the UI:
 *
 *   Report  flags something for review later. Nothing visibly changes for the
 *           reporter. Feeds the auto-hide circuit breaker.
 *   Block   stops a specific person reaching you, right now, no review.
 *
 * The report UX rule that shapes this whole file: tapping a reason chip IS the
 * submission. No second screen, no confirm button, no "tell us more" the user
 * has to dismiss. Only "Something else" opens a text field, because that's the
 * only case where the chip itself carries no information.
 */
window.Safety = (function () {

  /* Open the report sheet for one target. `label` is what the user sees named
   * in the header so they can tell they're reporting the right thing. */
  function report(targetType, targetId, label, opts) {
    opts = opts || {};
    if (!Store.uid()) { U.toast('Sign in to report', 'warn'); return; }
    if (targetType === 'user' && Store.isMe(targetId)) {
      U.toast("You can't report yourself", 'warn');
      return;
    }

    var reasons = CFG.reasons(targetType);
    var html =
      (label ? '<p class="modal-msg">Reporting <strong>' + U.esc(label) + '</strong></p>' : '') +
      '<div class="reason-chips">' +
        reasons.map(function (r) {
          return '<button class="chip reason" data-reason="' + U.attr(r.key) + '">' +
            U.esc(r.label) + '</button>';
        }).join('') +
      '</div>' +
      '<div class="reason-other" hidden>' +
        '<label for="report-note">What happened?</label>' +
        '<input id="report-note" type="text" maxlength="280" placeholder="One line is plenty">' +
        '<div class="modal-actions">' +
          '<button class="btn ghost" data-act="back">Back</button>' +
          '<button class="btn" data-act="send">Send report</button>' +
        '</div>' +
      '</div>' +
      '<p class="fine">Reports are reviewed later — they don\'t notify the other person. ' +
        'To stop someone contacting you right now, block them instead.</p>';

    var m = U.modal('Report', html);
    var chips = U.$('.reason-chips', m.el);
    var other = U.$('.reason-other', m.el);
    var note = U.$('#report-note', m.el);

    U.on(chips, '.reason', function (e, t) {
      var key = t.dataset.reason;
      if (key === 'other') {
        chips.hidden = true;
        other.hidden = false;
        note.focus();
        return;
      }
      submit(key, '');
    });

    U.on(other, '[data-act]', function (e, t) {
      if (t.dataset.act === 'back') {
        other.hidden = true;
        chips.hidden = false;
        return;
      }
      var text = note.value.trim();
      if (!text) { U.toast('Add a line so this can be reviewed', 'warn'); note.focus(); return; }
      submit('other', text);
    });

    note.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') U.$('[data-act="send"]', other).click();
    });

    function submit(reason, text) {
      m.close();
      Store.submitReport({
        targetType: targetType,
        targetId: targetId,
        contextRequestId: opts.contextRequestId || null,
        reason: reason,
        /* Message reports carry the reported text as evidence — by the time
         * anyone reviews this, the message may well have been edited away in
         * a future version, and a report with no artifact is unreviewable. */
        note: text || opts.prefillNote || '',
        reporterId: Store.uid()
      }).then(function () {
        U.toast('Reported. Thanks — we look at these.');
      }).catch(function (err) {
        console.error('[tabled] report failed', err);
        U.toast('Could not send that report', 'bad');
      });
    }
  }

  /* Blocking is instant and self-protective, so it asks once and then just
   * does it. The confirm exists only because unblocking is a trip to settings,
   * not because the action needs weighing. */
  function block(targetUid, displayName) {
    if (!Store.uid()) { U.toast('Sign in to block', 'warn'); return Promise.resolve(false); }
    if (Store.isMe(targetUid)) { U.toast("You can't block yourself", 'warn'); return Promise.resolve(false); }

    return U.confirm(
      'Block ' + (displayName || 'this person') + '?',
      "They won't be able to request your listings or message you, and their listings drop out of your feed. They aren't told.",
      'Block'
    ).then(function (ok) {
      if (!ok) return false;
      return Store.block(targetUid).then(function () {
        U.toast('Blocked. Their listings are hidden from your feed.');
        return true;
      }).catch(function (err) {
        console.error('[tabled] block failed', err);
        U.toast('Could not block that person', 'bad');
        return false;
      });
    });
  }

  function unblock(targetUid) {
    return Store.unblock(targetUid).then(function () {
      U.toast('Unblocked.');
      return true;
    }).catch(function () {
      U.toast('Could not unblock', 'bad');
      return false;
    });
  }

  /* The overflow menu attached to listings and profiles. Kept here rather than
   * in each view so the report/block pair always appears together and always
   * reads the same way. */
  function menuHtml(kind, id, label, sellerId) {
    var items = [];
    if (kind === 'listing') {
      items.push({ act: 'report-listing', label: 'Report this listing' });
      if (sellerId && !Store.isMe(sellerId)) {
        items.push({ act: 'report-user', label: 'Report the seller' });
        items.push({
          act: Store.isBlocked(sellerId) ? 'unblock' : 'block',
          label: Store.isBlocked(sellerId) ? 'Unblock the seller' : 'Block the seller'
        });
      }
    } else {
      items.push({ act: 'report-user', label: 'Report this person' });
      items.push({
        act: Store.isBlocked(id) ? 'unblock' : 'block',
        label: Store.isBlocked(id) ? 'Unblock' : 'Block'
      });
    }
    return '<div class="overflow">' +
      '<button class="icon-btn of-toggle" aria-label="More options" aria-expanded="false">&#8942;</button>' +
      '<div class="of-menu" hidden>' +
        items.map(function (i) {
          return '<button data-of="' + U.attr(i.act) + '">' + U.esc(i.label) + '</button>';
        }).join('') +
      '</div>' +
    '</div>';
  }

  function closeAllMenus() {
    U.$$('.of-menu').forEach(function (m) { m.hidden = true; });
    U.$$('.of-toggle').forEach(function (t) { t.setAttribute('aria-expanded', 'false'); });
  }

  /* Click-outside-to-close is bound to `document` once, at load, rather than
   * per menu. Binding it inside wireMenu would add a listener every time any
   * view redraws, and document listeners outlive the elements that created
   * them — they'd accumulate for the life of the page. */
  document.addEventListener('click', closeAllMenus);

  /* Wire one rendered overflow menu. `ctx` supplies whatever the actions need:
   * { listingId, listingLabel, sellerId, sellerName }. */
  function wireMenu(root, ctx) {
    var wrap = U.$('.overflow', root);
    if (!wrap) return;
    var toggle = U.$('.of-toggle', wrap);
    var menu = U.$('.of-menu', wrap);
    var closeAll = closeAllMenus;

    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = menu.hidden;
      closeAll();
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    });

    U.on(menu, '[data-of]', function (e, t) {
      e.stopPropagation();
      closeAll();
      var act = t.dataset.of;
      if (act === 'report-listing') report('listing', ctx.listingId, ctx.listingLabel);
      else if (act === 'report-user') report('user', ctx.sellerId, ctx.sellerName);
      else if (act === 'block') block(ctx.sellerId, ctx.sellerName).then(function (did) { if (did && ctx.onBlock) ctx.onBlock(); });
      else if (act === 'unblock') unblock(ctx.sellerId).then(function () { if (ctx.onBlock) ctx.onBlock(); });
    });
  }

  return {
    report: report,
    block: block,
    unblock: unblock,
    menuHtml: menuHtml,
    wireMenu: wireMenu
  };
})();
