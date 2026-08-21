/* Tabled — Admin console.
 *
 * Lives in the main app rather than as a separate page: same auth, same store,
 * same styles, and no second build to keep in step. It is reachable only from
 * settings, and only when the role claim is present — but that is presentation
 * only. Every action here is re-authorized server-side by the adminAction
 * callable, because a client-side role check decides what a button looks like,
 * never what it is permitted to do.
 *
 * The reports queue groups by TARGET, not by report. Three people reporting one
 * listing is one decision to make, not three — and seeing "3 reports" with the
 * three reasons side by side is what tells you whether it's a real problem or
 * one person with a grudge and two friends.
 */
window.AdminView = (function () {

  var tab = 'reports';

  function render(root, params) {
    if (!Store.isStaff()) {
      root.innerHTML = U.empty('Not found', '');
      return;
    }
    tab = params.tab || 'reports';

    root.innerHTML =
      '<div class="admin">' +
        '<div class="admin-head">' +
          '<h1>Moderation</h1>' +
          '<span class="badge ' + (Store.isAdmin() ? 'verified' : '') + '">' +
            U.esc(Store.isAdmin() ? 'Admin' : 'Moderator') + '</span>' +
        '</div>' +
        '<div class="sorts admin-tabs">' +
          [['reports', 'Reports'], ['users', 'Flagged users'], ['audit', 'Audit log']]
            .map(function (t) {
              return '<button class="pill' + (tab === t[0] ? ' on' : '') + '" ' +
                'data-tab="' + U.attr(t[0]) + '">' + U.esc(t[1]) + '</button>';
            }).join('') +
        '</div>' +
        '<div id="admin-body">' + U.spinner('Loading') + '</div>' +
      '</div>';

    U.on(root, '[data-tab]', function (e, t) {
      App.go('admin', { tab: t.dataset.tab });
    });

    if (tab === 'reports') loadReports(root);
    else if (tab === 'users') loadUsers(root);
    else loadAudit(root);
  }

  /* ---- Reports ------------------------------------------------------------ */

  function loadReports(root) {
    Store.listOpenReports().then(function (reports) {
      var host = U.$('#admin-body', root);
      if (!host) return;

      if (!reports.length) {
        host.innerHTML = U.empty('Nothing waiting',
          'Open reports show up here. The automatic breaker hides a listing at ' +
          CFG.SAFETY.listingHideAt + ' reports and restricts an account at ' +
          CFG.SAFETY.userRestrictAt + ', but it is a blunt instrument — these are ' +
          'the ones a person should look at.');
        return;
      }

      /* Group by target: three reports on one listing is ONE decision. */
      var groups = {};
      reports.forEach(function (r) {
        var key = r.targetType + '/' + r.targetId;
        if (!groups[key]) {
          groups[key] = { targetType: r.targetType, targetId: r.targetId, reports: [] };
        }
        groups[key].reports.push(r);
      });

      var list = Object.keys(groups).map(function (k) { return groups[k]; })
        .sort(function (a, b) { return b.reports.length - a.reports.length; });

      host.innerHTML = list.map(groupHtml).join('');
      list.forEach(function (g) { loadTargetPreview(g); });
      wireActions(host);
    }).catch(function (err) {
      console.error('[tabled] reports load failed', err);
      var host = U.$('#admin-body', root);
      if (host) {
        host.innerHTML = U.empty('Could not load reports',
          /permission/i.test(err && err.message || '')
            ? 'Your role may not have reached this session yet. Sign out and back in — ' +
              'custom claims only arrive with a fresh ID token.'
            : 'Check the console.');
      }
    });
  }

  function groupHtml(g) {
    var n = g.reports.length;
    var overThreshold = g.targetType === 'listing'
      ? n >= CFG.SAFETY.listingHideAt
      : n >= CFG.SAFETY.userRestrictAt;

    return '<div class="report-group" data-target="' + U.attr(g.targetId) + '" ' +
        'data-type="' + U.attr(g.targetType) + '">' +
      '<div class="rg-head">' +
        '<span class="badge ' + (overThreshold ? 'sold' : 'hold') + '">' +
          U.esc(U.plural(n, 'report')) + '</span>' +
        '<span class="fine">' + U.esc(g.targetType) + '</span>' +
        (overThreshold
          ? '<span class="fine">auto-action already fired</span>'
          : '') +
      '</div>' +

      '<div class="rg-preview">' + U.spinner('') + '</div>' +

      '<ul class="rg-reasons">' +
        g.reports.map(function (r) {
          return '<li><strong>' + U.esc(reasonLabel(g.targetType, r.reason)) + '</strong>' +
            (r.note ? ' — <span class="fine">' + U.esc(r.note) + '</span>' : '') +
            ' <span class="fine">' + U.esc(U.ago(r.createdAt)) + '</span></li>';
        }).join('') +
      '</ul>' +

      '<div class="rg-actions">' +
        '<button class="btn ghost small" data-act="dismissReports">Dismiss</button>' +
        (g.targetType === 'listing'
          ? '<button class="btn small" data-act="hideListing">Hide listing</button>' +
            '<button class="btn ghost small" data-act="unhideListing">Un-hide</button>' +
            (Store.isAdmin()
              ? '<button class="btn danger ghost small" data-act="deleteListing">Delete</button>'
              : '')
          : '') +
        (g.targetType === 'user' && Store.isAdmin()
          ? '<button class="btn danger small" data-act="restrictUser">Restrict</button>' +
            '<button class="btn ghost small" data-act="unrestrictUser">Lift restriction</button>'
          : '') +
      '</div>' +
      (!Store.isAdmin() && g.targetType === 'user'
        ? '<p class="fine">Restricting an account is admin-only.</p>'
        : '') +
    '</div>';
  }

  function reasonLabel(targetType, key) {
    var list = CFG.reasons(targetType) || [];
    var hit = list.filter(function (r) { return r.key === key; })[0];
    return hit ? hit.label : key;
  }

  /* Show what is actually being reported. A queue of bare ids is a queue
   * nobody can act on without opening five tabs. */
  function loadTargetPreview(g) {
    var host = U.$('.report-group[data-target="' + cssEscape(g.targetId) + '"] .rg-preview');
    if (!host) return;

    if (g.targetType === 'listing') {
      Store.getListing(g.targetId).then(function (l) {
        if (!l) { host.innerHTML = '<p class="fine">Listing no longer exists.</p>'; return; }
        host.innerHTML =
          '<a class="rg-target" href="#/listing/' + U.attr(l.id) + '">' +
            '<div class="grow">' +
              '<strong>' + U.esc(l.title || (l.gameNames && l.gameNames[0]) || 'Listing') + '</strong>' +
              '<span class="fine">' + U.esc(l.sellerName || '') +
                ' · ' + U.esc(l.status) +
                ' · ' + U.esc(U.ago(l.createdAt)) + '</span>' +
            '</div><span class="chev">›</span>' +
          '</a>';
      }).catch(function () { host.innerHTML = '<p class="fine">Could not load it.</p>'; });

    } else if (g.targetType === 'user') {
      Store.getUser(g.targetId).then(function (u) {
        if (!u) { host.innerHTML = '<p class="fine">Account no longer exists.</p>'; return; }
        host.innerHTML =
          '<a class="rg-target" href="#/profile/' + U.attr(u.id) + '">' +
            U.avatar(u, '') +
            '<div class="grow">' +
              '<strong>' + U.esc(u.displayName || 'User') + '</strong>' +
              '<span class="fine">' + U.esc(U.plural(u.tradeCount || 0, 'trade')) +
                (u.restricted ? ' · restricted' : '') + '</span>' +
            '</div><span class="chev">›</span>' +
          '</a>';
      }).catch(function () { host.innerHTML = '<p class="fine">Could not load it.</p>'; });

    } else {
      /* Message and event reports carry their evidence in the note, since the
       * message itself may be long gone by the time anyone looks. */
      host.innerHTML = '<p class="fine">Reported ' + U.esc(g.targetType) +
        ' — see the reasons below for the captured text.</p>';
    }
  }

  /* Attribute selectors choke on ids containing quotes or backslashes. */
  function cssEscape(v) {
    return String(v).replace(/["\\]/g, '\\$&');
  }

  function wireActions(host) {
    U.on(host, '[data-act]', function (e, t) {
      var group = t.closest('.report-group');
      var action = t.dataset.act;
      var targetId = group.dataset.target;
      var targetType = group.dataset.type;

      var destructive = action === 'deleteListing' || action === 'restrictUser';
      var confirmFirst = destructive
        ? U.confirm(
            action === 'deleteListing' ? 'Delete this listing?' : 'Restrict this account?',
            action === 'deleteListing'
              ? 'It and its photos go permanently. This cannot be undone.'
              : "They keep browsing and keep their history, but can't create listings, "
                + 'requests or events until it is lifted.',
            action === 'deleteListing' ? 'Delete' : 'Restrict')
        : Promise.resolve(true);

      confirmFirst.then(function (go) {
        if (!go) return;
        askReason(action).then(function (reason) {
          if (reason === null) return;
          t.disabled = true;
          Store.adminAction({
            action: action, targetId: targetId, targetType: targetType, reason: reason
          }).then(function (res) {
            U.toast(actionToast(action, res));
            App.go('admin', { tab: 'reports' });
          }).catch(function (err) {
            console.error('[tabled] admin action failed', err);
            U.toast((err && err.message) || 'That did not work', 'bad');
            t.disabled = false;
          });
        });
      });
    });
  }

  /* Every action records why. An audit log of what happened without why is
   * only half a trail — and the reason is what a future reviewer needs. */
  function askReason(action) {
    return new Promise(function (resolve) {
      var settled = false;
      var m = U.modal('Why?',
        '<p class="modal-msg">Recorded in the audit log against your name.</p>' +
        '<label class="field"><span>Reason <em>optional</em></span>' +
          '<input id="ad-reason" type="text" maxlength="200" ' +
            'placeholder="Photos are of a different game"></label>' +
        '<div class="modal-actions">' +
          '<button class="btn ghost" data-act="cancel">Cancel</button>' +
          '<button class="btn" data-act="go">' + U.esc(actionLabel(action)) + '</button>' +
        '</div>',
        { onClose: function () { if (!settled) { settled = true; resolve(null); } } });

      U.on(m.el, '[data-act]', function (e, t) {
        settled = true;
        var val = t.dataset.act === 'go' ? U.$('#ad-reason', m.el).value.trim() : null;
        m.close();
        resolve(val);
      });
    });
  }

  function actionLabel(a) {
    return ({
      dismissReports: 'Dismiss', hideListing: 'Hide', unhideListing: 'Un-hide',
      deleteListing: 'Delete', restrictUser: 'Restrict', unrestrictUser: 'Lift',
      grantVip: 'Grant VIP', revokeVip: 'Revoke VIP'
    })[a] || 'Confirm';
  }

  function actionToast(a, res) {
    if (a === 'dismissReports') return 'Dismissed ' + U.plural(res.resolved || 0, 'report');
    if (a === 'hideListing') return 'Listing hidden, reports cleared';
    if (a === 'unhideListing') return 'Listing restored, reports cleared';
    if (a === 'deleteListing') return 'Listing deleted';
    if (a === 'restrictUser') return 'Account restricted';
    if (a === 'unrestrictUser') return 'Restriction lifted';
    if (a === 'grantVip') return 'VIP granted';
    if (a === 'revokeVip') return 'VIP revoked';
    return 'Done';
  }

  /* ---- Flagged users ------------------------------------------------------ */

  function loadUsers(root) {
    Store.listFlaggedUsers().then(function (users) {
      var host = U.$('#admin-body', root);
      if (!host) return;
      if (!users.length) {
        host.innerHTML = U.empty('No flagged accounts',
          'Accounts with open reports against them appear here.');
        return;
      }
      host.innerHTML = users.map(function (u) {
        return '<div class="admin-row" data-uid="' + U.attr(u.id) + '">' +
          U.avatar(u, '') +
          '<div class="grow">' +
            '<strong>' + U.esc(u.displayName || 'User') + '</strong>' +
            '<span class="fine">' +
              U.esc(U.plural(u.openReportCount || 0, 'open report')) +
              ' · ' + U.esc(U.plural(u.tradeCount || 0, 'trade')) +
              (u.restricted ? ' · restricted' : '') +
              (u.vip ? ' · VIP' : '') +
              (u.staffRole ? ' · ' + U.esc(u.staffRole) : '') +
            '</span>' +
          '</div>' +
          '<a class="btn ghost small" href="#/profile/' + U.attr(u.id) + '">View</a>' +
          (Store.isAdmin()
            ? '<button class="btn ghost small" data-vip="' + U.attr(u.id) + '">' +
                (u.vip ? 'Revoke VIP' : 'Grant VIP') + '</button>'
            : '') +
        '</div>';
      }).join('');

      U.on(host, '[data-vip]', function (e, t) {
        var uid = t.dataset.vip;
        var u = users.filter(function (x) { return x.id === uid; })[0];
        if (u && u.vip) revokeVip(uid);
        else grantVip(uid);
      });
    });
  }

  /* VIP is deliberately invisible to everyone else — a VIP simply never sees a
   * fee prompt, and nothing on their public profile marks them out. */
  function grantVip(uid) {
    var m = U.modal('Grant VIP',
      '<p class="modal-msg">A supporter/founder flag. It grants nothing automatic ' +
        'right now — a hook for recognition later. Nobody else can see it.</p>' +
      '<label class="field"><span>Until <em>blank means forever</em></span>' +
        '<input id="vip-until" type="date"></label>' +
      '<label class="field"><span>Reason</span>' +
        '<input id="vip-reason" type="text" maxlength="200" ' +
          'placeholder="Founding member"></label>' +

      '<div class="modal-actions">' +
        '<button class="btn ghost" data-act="cancel">Cancel</button>' +
        '<button class="btn" data-act="go">Grant</button>' +
      '</div>');

    U.on(m.el, '[data-act]', function (e, t) {
      if (t.dataset.act === 'cancel') { m.close(); return; }
      var raw = U.$('#vip-until', m.el).value;
      var until = raw ? new Date(raw + 'T23:59:59').getTime() : null;
      t.disabled = true;
      Store.adminAction({
        action: 'grantVip', targetId: uid, targetType: 'user',
        reason: U.$('#vip-reason', m.el).value.trim(), until: until
      }).then(function (res) {
        m.close();
        U.toast(actionToast('grantVip', res));
        App.go('admin', { tab: 'users' });
      }).catch(function (err) {
        U.toast((err && err.message) || 'Could not grant VIP', 'bad');
        t.disabled = false;
      });
    });
  }

  function revokeVip(uid) {
    U.confirm('Revoke VIP?',
      'They start paying verification fees again from their next completed trade. ' +
      'Trades already settled stay settled.', 'Revoke').then(function (ok) {
      if (!ok) return;
      Store.adminAction({ action: 'revokeVip', targetId: uid, targetType: 'user' })
        .then(function () {
          U.toast('VIP revoked');
          App.go('admin', { tab: 'users' });
        }).catch(function (err) {
          U.toast((err && err.message) || 'Could not revoke', 'bad');
        });
    });
  }

  /* ---- Audit log ---------------------------------------------------------- */

  function loadAudit(root) {
    Store.listAdminActions().then(function (actions) {
      var host = U.$('#admin-body', root);
      if (!host) return;
      if (!actions.length) {
        host.innerHTML = U.empty('Nothing yet',
          'Every moderation action is recorded here, with who did it and why.');
        return;
      }
      host.innerHTML = '<div class="audit">' + actions.map(function (a) {
        return '<div class="audit-row">' +
          '<div class="grow">' +
            '<strong>' + U.esc(actionLabel(a.action)) + '</strong> ' +
            '<span class="fine">' + U.esc(a.targetType) + ' ' +
              U.esc(String(a.targetId).slice(0, 12)) + '…</span>' +
            (a.reason ? '<div class="audit-reason">' + U.esc(a.reason) + '</div>' : '') +
          '</div>' +
          '<div class="audit-who">' +
            '<span>' + U.esc(a.actorName || 'staff') + '</span>' +
            '<span class="fine">' + U.esc(U.ago(a.createdAt)) + '</span>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
    });
  }

  return { render: render };
})();
