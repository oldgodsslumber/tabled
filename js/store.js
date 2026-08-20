/* Tabled — data layer.
 *
 * Two interchangeable backends behind one interface:
 *
 *   CloudBackend  Firestore + Storage + callable Functions. The real one.
 *                 Attached by firebase-config.js once Google auth resolves.
 *   DemoBackend   In-memory, seeded with sample listings, persisted to
 *                 localStorage. Used when firebase-config.js still holds
 *                 placeholders, so the app is fully browsable before you touch
 *                 the Firebase console.
 *
 * Two structural decisions drive most of this file, both forced by Firestore
 * rather than chosen:
 *
 * 1. ROLLUPS. The feed queries `listings`, but every filterable attribute
 *    (category, condition, tags, price) lives on the `gameEntries`
 *    subcollection, and Firestore cannot filter a parent by its children. So
 *    every write recomputes a denormalized rollup onto the listing doc. The
 *    subcollection stays authoritative; the rollup is a query index that
 *    happens to be made of fields. If they ever disagree, the subcollection
 *    wins and the rollup gets rebuilt.
 *
 * 2. ONE RANGE FILTER. Firestore permits a single range/inequality field per
 *    query. In "near me" mode the geohash range IS that field, which means
 *    nothing else can narrow server-side — category, condition, tags, and text
 *    all fall to the client for that path. buildPipeline() below is written so
 *    the same filter logic runs either place.
 */
window.Store = (function () {

  var backend = null;
  var myUid = null;
  var myProfile = null;
  var blockedSet = Object.create(null);   /* uids I have blocked */
  var listeners = [];                     /* fns to call when session changes */

  /* ================= Shared shaping ======================================= */

  /* Tokenize a string into every searchable prefix. Firestore has no prefix
   * operator on array-contains, so we precompute the prefixes and store them —
   * "glo" then matches Gloomhaven because "glo" is literally in the array.
   * Cost is paid once at write time instead of on every search. */
  function tokenize(text) {
    var out = [];
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .forEach(function (word) {
        if (word.length < CFG.SEARCH.minPrefix) return;
        var stop = Math.min(word.length, CFG.SEARCH.maxPrefix);
        for (var i = CFG.SEARCH.minPrefix; i <= stop; i++) out.push(word.slice(0, i));
        /* Keep the whole word too when it's longer than the prefix cap, so an
         * exact search for a long title still hits. */
        if (word.length > CFG.SEARCH.maxPrefix) out.push(word);
      });
    return U.uniq(out).slice(0, CFG.SEARCH.maxTokens);
  }

  /* The search term a query turns into: the longest token the user typed,
   * truncated to the prefix cap so it can actually match a stored prefix. */
  function searchTerm(q) {
    var words = String(q || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .filter(function (w) { return w.length >= CFG.SEARCH.minPrefix; })
      .sort(function (a, b) { return b.length - a.length; });
    if (!words.length) return null;
    return words[0].slice(0, CFG.SEARCH.maxPrefix);
  }

  /* Recompute every denormalized field on a listing from its entries.
   * `gamesById` supplies the cached BGG data (categories, mechanics, suggested
   * price); it's empty for manually-entered games, which is fine — those
   * listings simply carry no categories and drop out of the Good Deal sort. */
  function buildRollup(listing, entries, gamesById) {
    gamesById = gamesById || {};
    var names = [], bggIds = [], cats = [], mechs = [], conds = [], tags = [];
    var prices = [], cover = null, bestDeal = null;

    entries.forEach(function (e) {
      var g = e.bggId ? gamesById[String(e.bggId)] : null;
      var name = e.name || (g && g.name) || 'Untitled game';
      names.push(name);
      if (e.bggId) bggIds.push(String(e.bggId));
      if (g) {
        cats = cats.concat(g.categories || []);
        mechs = mechs.concat(g.mechanics || []);
      }
      if (e.condition) conds.push(e.condition);
      tags = tags.concat(e.tags || []);

      if (typeof e.askingPrice === 'number' && !isNaN(e.askingPrice)) {
        prices.push(e.askingPrice);
        var sug = g && typeof g.suggestedPrice === 'number' ? g.suggestedPrice : null;
        if (sug && sug > 0 && e.askingPrice < sug) {
          var d = (sug - e.askingPrice) / sug;
          if (bestDeal === null || d > bestDeal) bestDeal = d;
        }
      }
      if (!cover) {
        cover = (e.photos && e.photos[0]) || (g && g.imageUrl) || null;
      }
    });

    return {
      entryCount: entries.length,
      coverPhoto: cover,
      gameNames: names.slice(0, CFG.MAX_ROLLUP_TERMS),
      bggIds: U.uniq(bggIds).slice(0, CFG.MAX_ROLLUP_TERMS),
      categories: U.uniq(cats).slice(0, CFG.MAX_ROLLUP_TERMS),
      mechanics: U.uniq(mechs).slice(0, CFG.MAX_ROLLUP_TERMS),
      conditions: U.uniq(conds),
      tags: U.uniq(tags).slice(0, CFG.MAX_ROLLUP_TERMS),
      minPrice: prices.length ? Math.min.apply(null, prices) : null,
      maxPrice: prices.length ? Math.max.apply(null, prices) : null,
      /* Rounded to 4 places purely so the sort is stable across recomputes. */
      bestDealScore: bestDeal === null ? null : Math.round(bestDeal * 10000) / 10000,
      searchTokens: tokenize([listing.title || ''].concat(names).join(' '))
    };
  }

  /* ---- The filter pipeline ------------------------------------------------
   * Shared by both backends. The cloud backend pre-narrows what it can in the
   * query and then runs this over the results; the demo backend runs it over
   * everything. Either way one implementation decides what a filter means. */
  function buildPipeline(filters) {
    var f = filters || {};
    var term = f.q ? searchTerm(f.q) : null;
    var wantTags = f.tags && f.tags.length ? f.tags : null;

    return function (items) {
      var out = items.filter(function (l) {
        if (l.status !== 'active') return false;
        if (blockedSet[l.sellerId]) return false;

        if (f.sellerId && l.sellerId !== f.sellerId) return false;
        if (f.eventId && l.eventId !== f.eventId) return false;

        if (term && (l.searchTokens || []).indexOf(term) === -1) return false;
        if (f.category && (l.categories || []).indexOf(f.category) === -1) return false;
        if (f.condition && (l.conditions || []).indexOf(f.condition) === -1) return false;

        /* Tags are AND, not OR — someone filtering for "sleeved + insert" wants
         * both, not either. Categories stay single-select for the same reason
         * inverted: two categories is almost always meant as "either". */
        if (wantTags && !wantTags.every(function (t) { return (l.tags || []).indexOf(t) !== -1; })) {
          return false;
        }

        if (f.fulfillment && !(l.fulfillment && l.fulfillment[f.fulfillment])) return false;
        if (f.payment && !(l.acceptedPayment && l.acceptedPayment[f.payment])) return false;

        if (f.near) {
          if (!l.geoPoint) return false;
          l._distanceMi = Geo.distanceMi(f.near.lat, f.near.lng, l.geoPoint.lat, l.geoPoint.lng);
          /* The geohash cells are square and the search area is a circle, so
           * this is where the corners get trimmed. */
          if (l._distanceMi > f.near.radiusMi) return false;
        }
        if (f.sort === 'deal' && !(l.bestDealScore > 0)) return false;

        return true;
      });

      return sortItems(out, f.sort);
    };
  }

  function sortItems(items, sort) {
    var key = sort === 'hot' ? 'hotScore' : (sort === 'deal' ? 'bestDealScore' : 'createdAt');
    return items.sort(function (a, b) {
      var av = key === 'createdAt' ? (U.toDate(a.createdAt) || 0) : (a[key] || 0);
      var bv = key === 'createdAt' ? (U.toDate(b.createdAt) || 0) : (b[key] || 0);
      return bv - av;
    });
  }

  /* Hot, computed live for display. The authoritative value is written by the
   * scheduled function; this exists so a brand-new listing doesn't show a stale
   * 0 for the first hour. Formula mirrors CFG.HOT and functions/index.js. */
  function hotScore(listing) {
    var created = U.toDate(listing.createdAt);
    var ageH = created ? Math.max(0, (Date.now() - created.getTime()) / 3600000) : 0;
    var raw = (listing.viewCount || 0) * CFG.HOT.viewWeight +
              (listing.requestCount || 0) * CFG.HOT.requestWeight;
    return raw / Math.pow(ageH + 2, CFG.HOT.gravity);
  }

  /* ================= Cloud backend ======================================== */

  function CloudBackend(fb, db, storage, fns) {

    function col() {
      return fb.collection.apply(null, [db].concat(Array.prototype.slice.call(arguments)));
    }
    function docRef() {
      return fb.doc.apply(null, [db].concat(Array.prototype.slice.call(arguments)));
    }
    function snapData(s) {
      if (!s.exists()) return null;
      var d = s.data();
      d.id = s.id;
      return normalizeGeo(d);
    }
    /* Firestore GeoPoints come back as objects with latitude/longitude; the
     * rest of the app (and the demo backend) speaks {lat,lng}. Normalize on
     * the way out so nothing downstream has to know which backend it got. */
    function normalizeGeo(d) {
      if (d.geoPoint && typeof d.geoPoint.latitude === 'number') {
        d.geoPoint = { lat: d.geoPoint.latitude, lng: d.geoPoint.longitude };
      }
      return d;
    }
    function toGeoPoint(p) {
      return p ? new fb.GeoPoint(p.lat, p.lng) : null;
    }

    function callable(name, payload) {
      return fb.httpsCallable(fns, name)(payload || {}).then(function (r) { return r.data; });
    }

    return {
      kind: 'cloud',

      /* ---- Profiles ---- */

      getUser: function (uid) {
        return fb.getDoc(docRef('users', uid)).then(snapData);
      },

      /* First sign-in writes the public identity fields only. Google's real
       * email is deliberately never copied into this doc — it stays available
       * to the account owner via auth.currentUser.email and nowhere else. */
      ensureProfile: function (authUser) {
        var ref = docRef('users', authUser.uid);
        return fb.getDoc(ref).then(function (s) {
          if (s.exists()) return snapData(s);
          var fresh = {
            displayName: authUser.displayName || 'Board gamer',
            photoURL: authUser.photoURL || null,
            bio: '',
            generalArea: '',
            geoPoint: null,
            geohash: null,
            /* Null until the user sets an area. The rules permit null and
             * permit 'US'; they permit nothing else. */
            countryCode: null,
            state: null,
            createdAt: fb.serverTimestamp(),
            tradeCount: 0,
            avgRating: null,
            reviewCount: 0,
            verifiedSeller: false,
            availabilityWindows: [],
            openReportCount: 0,
            restricted: false
          };
          return fb.setDoc(ref, fresh).then(function () {
            return fb.getDoc(ref).then(snapData);
          });
        });
      },

      /* Only the fields a user is allowed to own. tradeCount / avgRating /
       * reviewCount / verifiedSeller are absent by design — Firestore rules
       * reject them even from the profile's own owner, so sending them would
       * fail the whole write. */
      saveProfile: function (uid, patch) {
        var writable = {
          displayName: patch.displayName,
          bio: patch.bio,
          photoURL: patch.photoURL || null
        };
        if (patch.generalArea !== undefined) writable.generalArea = patch.generalArea;
        if (patch.geoPoint !== undefined) writable.geoPoint = toGeoPoint(patch.geoPoint);
        if (patch.geohash !== undefined) writable.geohash = patch.geohash;
        if (patch.countryCode !== undefined) writable.countryCode = patch.countryCode;
        if (patch.state !== undefined) writable.state = patch.state;
        /* M6. The zone is stored alongside the windows because "Saturday 10:00"
         * is a wall-clock time and means nothing without one. */
        if (patch.availabilityWindows !== undefined) writable.availabilityWindows = patch.availabilityWindows;
        if (patch.timeZone !== undefined) writable.timeZone = patch.timeZone;
        return fb.updateDoc(docRef('users', uid), writable);
      },

      /* Geocoding runs server-side: the API key can't live in client code, and
       * the privacy fuzz has to be applied somewhere the client can't observe
       * the pre-fuzz value. Returns the already-jittered point. */
      geocodeArea: function (text) {
        return callable('geocodeArea', { text: text });
      },

      /* ---- Games (BGG cache) ---- */

      getGame: function (bggId) {
        return fb.getDoc(docRef('games', String(bggId))).then(snapData);
      },
      getGames: function (bggIds) {
        var ids = U.uniq(bggIds || []).map(String);
        if (!ids.length) return Promise.resolve({});
        return Promise.all(ids.map(function (id) {
          return fb.getDoc(docRef('games', id)).then(snapData).catch(function () { return null; });
        })).then(function (rows) {
          var map = {};
          rows.forEach(function (g) { if (g) map[g.id] = g; });
          return map;
        });
      },

      /* ---- Listings ---- */

      getListing: function (id) {
        return fb.getDoc(docRef('listings', id)).then(snapData);
      },

      getEntries: function (listingId) {
        return fb.getDocs(col('listings', listingId, 'gameEntries')).then(function (qs) {
          var out = [];
          qs.forEach(function (s) { var d = s.data(); d.id = s.id; out.push(d); });
          return out.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
        });
      },

      /* Listing doc + every entry in one atomic batch. A half-written listing
       * (rollup says 3 games, subcollection has 1) would show wrong counts in
       * the feed with no obvious way to notice, so this is all-or-nothing. */
      saveListing: function (listingId, listing, entries, gamesById) {
        var isNew = !listingId;
        var ref = isNew ? fb.doc(col('listings')) : docRef('listings', listingId);
        var batch = fb.writeBatch(db);
        var rollup = buildRollup(listing, entries, gamesById);

        var body = {
          sellerId: listing.sellerId,
          sellerName: listing.sellerName || '',
          sellerPhoto: listing.sellerPhoto || null,
          title: listing.title || '',
          fulfillment: listing.fulfillment,
          locationLabel: listing.locationLabel || '',
          geoPoint: toGeoPoint(listing.geoPoint),
          geohash: listing.geohash || null,
          countryCode: listing.countryCode || null,
          state: listing.state || null,
          acceptedPayment: listing.acceptedPayment || {
            cash: true, paypal: false, venmo: false, trades: false
          },
          eventId: listing.eventId || null,
          eventName: listing.eventName || null,
          /* Copied from the event at listing time rather than referenced, so
           * the hold-timing logic never needs a second read — and so editing
           * an event later cannot retroactively move every listing's clock. */
          eventStartDate: listing.eventStartDate || null,
          eventEndDate: listing.eventEndDate || null,
          status: listing.status || 'active',
          updatedAt: fb.serverTimestamp()
        };
        Object.keys(rollup).forEach(function (k) {
          /* Omitting bestDealScore rather than writing null is what keeps
           * priceless listings out of the Good Deal sort — that query filters
           * on bestDealScore > 0, and a missing field is never returned. */
          if (k === 'bestDealScore' && rollup[k] === null) return;
          body[k] = rollup[k];
        });
        if (rollup.bestDealScore === null && !isNew) body.bestDealScore = fb.deleteField();

        if (isNew) {
          body.createdAt = fb.serverTimestamp();
          body.viewCount = 0;
          body.requestCount = 0;
          body.hotScore = 0;
          body.openReportCount = 0;
          batch.set(ref, body);
        } else {
          batch.update(ref, body);
        }

        var keep = {};
        entries.forEach(function (e, i) {
          var eid = e.id || U.uid('ge_');
          keep[eid] = 1;
          batch.set(fb.doc(col('listings', ref.id, 'gameEntries'), eid), {
            /* Duplicated from the parent listing on purpose. Firestore rules
             * evaluate each write in a batch against the *pre-batch* database
             * state, so a rule that resolved ownership with
             * get(/listings/$(listingId)) would fail on the very first save —
             * the parent doesn't exist yet at the moment the entry is checked.
             * Carrying sellerId on the entry makes the check local to the
             * document being written, and saves a document read per entry. */
            sellerId: listing.sellerId,
            bggId: e.bggId || null,
            name: e.name || '',
            condition: e.condition || 'VG',
            tags: e.tags || [],
            photos: e.photos || [],
            askingPrice: typeof e.askingPrice === 'number' ? e.askingPrice : null,
            notes: e.notes || '',
            order: i,
            /* Hold/queue state is owned by the Cloud Function layer from M5
             * onward. Seeding the defaults here (rather than leaving the fields
             * absent) means those functions can update in place instead of
             * having to handle a missing-field case on every entry. */
            status: e.status || 'active',
            currentHoldRequestId: e.currentHoldRequestId || null,
            holdExpiresAt: e.holdExpiresAt || null,
            queueCount: e.queueCount || 0
          });
        });

        /* Entries removed during an edit have to be deleted explicitly —
         * overwriting the parent doesn't touch the subcollection. */
        var pruned = Promise.resolve([]);
        if (!isNew) {
          pruned = fb.getDocs(col('listings', ref.id, 'gameEntries')).then(function (qs) {
            qs.forEach(function (s) {
              if (!keep[s.id]) batch.delete(s.ref);
            });
          });
        }

        return pruned.then(function () { return batch.commit(); }).then(function () { return ref.id; });
      },

      deleteListing: function (id) {
        /* Entries first: deleting the parent leaves the subcollection orphaned
         * and unreachable but still billable. Firestore has no cascade. */
        return fb.getDocs(col('listings', id, 'gameEntries')).then(function (qs) {
          var batch = fb.writeBatch(db);
          qs.forEach(function (s) { batch.delete(s.ref); });
          batch.delete(docRef('listings', id));
          return batch.commit();
        });
      },

      /* The feed query. See the header note on the one-range-filter rule for
       * why "near me" mode narrows so little server-side. */
      queryListings: function (filters, cursor) {
        var f = filters || {};
        var pipeline = buildPipeline(f);
        var lim = f.limit || CFG.PAGE_SIZE;

        if (f.near) {
          /* 9 cell queries, unioned. Each is capped so a dense metro can't turn
           * one scroll into thousands of reads; the trade-off is that near-mode
           * results are a bounded sample rather than a true paginated set,
           * which is why the UI doesn't offer "load more" with a radius on. */
          var bounds = Geo.queryBounds(f.near.lat, f.near.lng, f.near.radiusMi);
          var perCell = Math.max(20, Math.ceil(lim * 2 / bounds.length) * 2);
          return Promise.all(bounds.map(function (b) {
            return fb.getDocs(fb.query(col('listings'),
              fb.where('status', '==', 'active'),
              fb.orderBy('geohash'),
              fb.startAt(b.start),
              fb.endAt(b.end),
              fb.limit(perCell)
            )).catch(function (err) {
              console.warn('[tabled] geo cell query failed', b.start, err);
              return { forEach: function () {} };
            });
          })).then(function (snaps) {
            var seen = {}, items = [];
            snaps.forEach(function (qs) {
              qs.forEach(function (s) {
                if (seen[s.id]) return;
                seen[s.id] = 1;
                items.push(snapData(s));
              });
            });
            return { items: pipeline(items).slice(0, lim), cursor: null, exhausted: true };
          });
        }

        var clauses = [fb.where('status', '==', 'active')];
        var term = f.q ? searchTerm(f.q) : null;

        /* Exactly one array-contains is allowed per query, so text search wins
         * it when present and category falls through to the client. */
        if (term) clauses.push(fb.where('searchTokens', 'array-contains', term));
        else if (f.category) clauses.push(fb.where('categories', 'array-contains', f.category));
        if (f.sellerId) clauses.push(fb.where('sellerId', '==', f.sellerId));
        if (f.eventId) clauses.push(fb.where('eventId', '==', f.eventId));

        if (f.sort === 'deal') {
          clauses.push(fb.where('bestDealScore', '>', 0));
          clauses.push(fb.orderBy('bestDealScore', 'desc'));
        } else if (f.sort === 'hot') {
          clauses.push(fb.orderBy('hotScore', 'desc'));
        } else {
          clauses.push(fb.orderBy('createdAt', 'desc'));
        }

        if (cursor) clauses.push(fb.startAfter(cursor));
        /* Over-fetch: client-side filters (condition, tags, blocks) will thin
         * this out, and a page that renders 4 cards because 20 were filtered
         * away reads as a bug. */
        clauses.push(fb.limit(lim * 2));

        return fb.getDocs(fb.query.apply(null, [col('listings')].concat(clauses))).then(function (qs) {
          var raw = [], last = null;
          qs.forEach(function (s) { raw.push(snapData(s)); last = s; });
          return {
            items: pipeline(raw).slice(0, lim),
            cursor: last,
            exhausted: raw.length < lim * 2
          };
        });
      },

      /* Non-owners must never get write access to someone else's listing doc,
       * so the counter goes through a callable instead of a client increment.
       * Fire-and-forget: a lost view count is not worth a visible error. */
      bumpView: function (id) {
        return callable('bumpListingCounter', { listingId: id, field: 'viewCount' })
          .catch(function () {});
      },
      bumpRequestCount: function (id) {
        return callable('bumpListingCounter', { listingId: id, field: 'requestCount' })
          .catch(function () {});
      },

      /* ---- Photos ---- */

      uploadPhoto: function (uid, blob) {
        var path = 'listings/' + uid + '/' + U.uid('p_') + '.jpg';
        var r = fb.storageRef(storage, path);
        return fb.uploadBytes(r, blob, { contentType: 'image/jpeg' })
          .then(function () { return fb.getDownloadURL(r); });
      },

      /* ---- Safety ---- */

      submitReport: function (report) {
        var id = report.reporterId + '_' + report.targetType + '_' + report.targetId;
        return fb.setDoc(docRef('reports', id), {
          targetType: report.targetType,
          targetId: report.targetId,
          contextRequestId: report.contextRequestId || null,
          reason: report.reason,
          note: report.note || '',
          reporterId: report.reporterId,
          createdAt: fb.serverTimestamp(),
          status: 'open'
        });
      },

      block: function (uid, targetUid) {
        return fb.setDoc(docRef('users', uid, 'blocked', targetUid), {
          createdAt: fb.serverTimestamp()
        });
      },
      unblock: function (uid, targetUid) {
        return fb.deleteDoc(docRef('users', uid, 'blocked', targetUid));
      },
      loadBlocked: function (uid) {
        return fb.getDocs(col('users', uid, 'blocked')).then(function (qs) {
          var out = [];
          qs.forEach(function (s) { out.push(s.id); });
          return out;
        });
      },

      /* ---- Requests & chat (M4) ---- */

      /* M5: creation goes through the callable, which assigns queue position
       * inside a transaction. The client sends only what it's asking for —
       * every denormalized field on the request is filled in server-side from
       * documents the client can't forge. */
      createRequest: function (listingId, gameEntryId, trade) {
        return callable('createRequest', Object.assign({
          listingId: listingId,
          gameEntryId: gameEntryId
        }, trade || {}));
      },

      getRequest: function (id) {
        return fb.getDoc(docRef('requests', id)).then(snapData);
      },

      /* Live, because the counterparty can confirm or decline a time while
       * you're looking at the thread. */
      watchRequest: function (id, cb) {
        return fb.onSnapshot(docRef('requests', id), function (s) {
          cb(s.exists() ? snapData(s) : null);
        }, function (err) {
          console.error('[tabled] request watch failed', err);
        });
      },

      /* Two listeners rather than one OR query. Firestore's or() would need its
       * own composite index and returns a single merged cursor that's harder to
       * page; two equality queries reuse simple indexes and merge fine here
       * because the result set is bounded by how many trades one person has
       * open at once. */
      watchMyRequests: function (uid, cb) {
        var asBuyer = [], asSeller = [];
        var seenBuyer = false, seenSeller = false;

        function emit() {
          /* Wait for both sides before the first emit, or the dashboard paints
           * "no requests" and then jumps. */
          if (!seenBuyer || !seenSeller) return;
          var merged = asBuyer.concat(asSeller);
          merged.sort(function (a, b) {
            return (U.toDate(b.updatedAt) || 0) - (U.toDate(a.updatedAt) || 0);
          });
          cb(merged);
        }

        function listen(field, assign, mark) {
          return fb.onSnapshot(fb.query(col('requests'),
            fb.where(field, '==', uid),
            fb.orderBy('updatedAt', 'desc'),
            fb.limit(100)
          ), function (qs) {
            var rows = [];
            qs.forEach(function (s) { rows.push(snapData(s)); });
            assign(rows);
            mark();
            emit();
          }, function (err) {
            console.error('[tabled] requests watch failed (' + field + ')', err);
            mark();
            emit();
          });
        }

        var un1 = listen('buyerId', function (r) { asBuyer = r; }, function () { seenBuyer = true; });
        var un2 = listen('sellerId', function (r) { asSeller = r; }, function () { seenSeller = true; });
        return function () { un1(); un2(); };
      },

      watchMessages: function (requestId, cb) {
        return fb.onSnapshot(fb.query(col('requests', requestId, 'messages'),
          fb.orderBy('createdAt', 'asc'),
          fb.limit(500)
        ), function (qs) {
          var rows = [];
          qs.forEach(function (s) {
            var d = s.data();
            d.id = s.id;
            /* A just-sent message has a null serverTimestamp until the server
             * acknowledges it. Stamping it locally keeps optimistic sends in
             * order instead of jumping to the top of the thread. */
            d.pending = s.metadata && s.metadata.hasPendingWrites;
            if (!d.createdAt && d.pending) d.createdAt = Date.now();
            rows.push(d);
          });
          cb(rows);
        }, function (err) {
          console.error('[tabled] messages watch failed', err);
        });
      },

      sendMessage: function (requestId, senderId, text) {
        var ref = fb.doc(col('requests', requestId, 'messages'));
        return fb.setDoc(ref, {
          senderId: senderId,
          text: text,
          createdAt: fb.serverTimestamp()
        }).then(function () {
          /* Denormalized onto the parent so the dashboard can show a preview
           * and an unread dot from one document read per thread, instead of
           * opening every message subcollection it lists. */
          return fb.updateDoc(docRef('requests', requestId), {
            lastMessageAt: fb.serverTimestamp(),
            lastMessageText: text.slice(0, 140),
            lastMessageSenderId: senderId,
            updatedAt: fb.serverTimestamp()
          });
        });
      },

      updateRequest: function (id, patch) {
        return fb.updateDoc(docRef('requests', id),
          Object.assign({}, patch, { updatedAt: fb.serverTimestamp() }));
      },

      markRead: function (id, isBuyer) {
        var patch = {};
        patch[isBuyer ? 'lastReadBuyerAt' : 'lastReadSellerAt'] = fb.serverTimestamp();
        /* Deliberately not touching updatedAt — reading a thread must not
         * reorder everyone's dashboard. */
        return fb.updateDoc(docRef('requests', id), patch).catch(function () {});
      },

      /* ---- Auto-book (M6) ---- */

      /* Which of a seller's increments are already taken. Readable by any
       * signed-in user by design — you have to know what's gone to be offered
       * what's left — and it leaks nothing beyond "this person is busy then",
       * which is the entire purpose of publishing availability. */
      getBookedSlots: function (sellerId) {
        return fb.getDocs(fb.query(
          col('users', sellerId, 'bookedSlots'),
          fb.where('startsAt', '>=', new Date()),
          fb.limit(500)
        )).then(function (qs) {
          var out = [];
          qs.forEach(function (s) { out.push(s.id); });
          return out;
        }).catch(function (err) {
          /* A failure here must not hide the whole picker — worst case we
           * offer a taken slot and the callable rejects it with the right
           * message, which is a far better outcome than an empty list. */
          console.warn('[tabled] booked slots read failed', err);
          return [];
        });
      },

      bookSlot: function (requestId, date, startTime) {
        return callable('bookSlot', {
          requestId: requestId, date: date, startTime: startTime
        });
      },

      /* ---- Completion & reviews (M7) ---- */

      /* Marks MY side of the trade. Completion happens server-side only when
       * both sides have done it — the client is never told to "complete" a
       * trade, only to say that it did what it said it would. */
      confirmSold: function (requestId) {
        return callable('confirmSold', { requestId: requestId });
      },

      /* Deterministic id: {requestId}_{reviewerId}. That is what makes a review
       * once-only — rules cannot count documents, but they can deny an update,
       * and a second attempt at the same id IS an update. */
      createReview: function (review) {
        var id = review.requestId + '_' + review.reviewerId;
        return fb.setDoc(docRef('reviews', id), {
          requestId: review.requestId,
          reviewerId: review.reviewerId,
          revieweeId: review.revieweeId,
          reviewerName: review.reviewerName || '',
          reviewerPhoto: review.reviewerPhoto || null,
          gameName: review.gameName || '',
          rating: review.rating,
          comment: review.comment || '',
          createdAt: fb.serverTimestamp()
        }).then(function () { return id; });
      },

      getReviews: function (revieweeId) {
        return fb.getDocs(fb.query(col('reviews'),
          fb.where('revieweeId', '==', revieweeId),
          fb.orderBy('createdAt', 'desc'),
          fb.limit(50)
        )).then(function (qs) {
          var out = [];
          qs.forEach(function (s) { var d = s.data(); d.id = s.id; out.push(d); });
          return out;
        }).catch(function (err) {
          console.warn('[tabled] reviews read failed', err);
          return [];
        });
      },

      /* Which of my completed trades have I already reviewed? Read once and
       * used to decide whether the dashboard shows a prompt — cheaper than a
       * per-row existence check. */
      getMyReviewedRequestIds: function (uid) {
        return fb.getDocs(fb.query(col('reviews'),
          fb.where('reviewerId', '==', uid),
          fb.limit(200)
        )).then(function (qs) {
          var out = [];
          qs.forEach(function (s) { out.push(s.data().requestId); });
          return out;
        }).catch(function () { return []; });
      },

      /* ---- Verification fee (M8) ----
       * Returns a Stripe Checkout URL to redirect to. Nothing about payment is
       * decided here or anywhere else on the client — only the signed webhook
       * may mark a fee paid. */
      startFeeCheckout: function (requestId) {
        return callable('createFeeCheckoutSession', {
          requestId: requestId,
          /* Validated server-side against an allowlist. Sent so a local build
           * returns to localhost rather than production. */
          returnUrl: location.origin
        });
      },

      /* ---- Events (M9) ----
       * Open creation, same trust model as listings: no curated allowlist and
       * no approval step, backed by the existing report mechanism. Otherwise
       * every convention anyone wants to sell at has to be seeded by hand. */
      createEvent: function (event) {
        var ref = fb.doc(col('events'));
        return fb.setDoc(ref, {
          name: event.name,
          venue: event.venue || '',
          startDate: event.startDate,
          endDate: event.endDate,
          timeZone: event.timeZone || null,
          createdBy: myUid,
          createdAt: fb.serverTimestamp()
        }).then(function () { return ref.id; });
      },

      getEvent: function (id) {
        return fb.getDoc(docRef('events', id)).then(snapData);
      },

      /* Upcoming and currently-running events. An event that ended yesterday is
       * not a thing anyone wants to list against, so the cutoff is endDate
       * rather than startDate. */
      listEvents: function () {
        return fb.getDocs(fb.query(col('events'),
          fb.where('endDate', '>=', new Date()),
          fb.orderBy('endDate', 'asc'),
          fb.limit(50)
        )).then(function (qs) {
          var out = [];
          qs.forEach(function (s) { out.push(snapData(s)); });
          return out.sort(function (a, b) {
            return (U.toDate(a.startDate) || 0) - (U.toDate(b.startDate) || 0);
          });
        }).catch(function (err) {
          console.warn('[tabled] events read failed', err);
          return [];
        });
      }
    };
  }

  /* ================= Demo backend ========================================== */
  /* Everything the cloud backend does, against an in-memory object graph. This
   * exists so the app is inspectable before any console setup — and so a broken
   * Firebase config degrades to "sample data" instead of a white screen. */

  function DemoBackend() {
    var KEY = 'tabled.demo.v1';
    var db = load();

    var subs = [];

    function load() {
      try {
        var raw = localStorage.getItem(KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          /* A demo store saved by an older build won't have the M4 collections.
           * Backfill rather than reseeding, so anything already posted survives
           * the upgrade. */
          parsed.requests = parsed.requests || [];
          parsed.messages = parsed.messages || {};
          parsed.slots = parsed.slots || {};
          parsed.reviews = parsed.reviews || {};
          parsed.events = parsed.events || {};
          return parsed;
        }
      } catch (e) { /* fall through to seed */ }
      return seed();
    }
    function save() {
      try { localStorage.setItem(KEY, JSON.stringify(db)); }
      catch (e) {
        U.toast('Demo storage is full — photos are not saved in demo mode', 'warn');
      }
      /* Stand-in for Firestore's snapshot fan-out. Deferred a tick so a caller
       * that saves and then navigates isn't re-entered mid-write. */
      setTimeout(function () {
        subs.slice().forEach(function (fn) { fn(); });
      }, 0);
    }

    /* Returns an unsubscribe, matching onSnapshot's contract exactly — views
     * must not need to know which backend they're talking to. */
    function subscribe(fn) {
      subs.push(fn);
      setTimeout(fn, 0);
      return function () {
        var i = subs.indexOf(fn);
        if (i !== -1) subs.splice(i, 1);
      };
    }

    function seed() {
      var now = Date.now();
      var people = [
        { id: 'demo_ava',  displayName: 'Ava Delgado', bio: 'Heavy euros and anything with a deck-builder in it.', generalArea: 'Riverside', lat: 30.305, lng: -81.687, tradeCount: 14, avgRating: 4.9, reviewCount: 12, verifiedSeller: true },
        { id: 'demo_theo', displayName: 'Theo Ranjit', bio: 'Downsizing the shelf. Everything sleeved.', generalArea: 'San Marco', lat: 30.312, lng: -81.651, tradeCount: 6, avgRating: 4.7, reviewCount: 5, verifiedSeller: true },
        { id: 'demo_nell', displayName: 'Nell Fischer', bio: 'Co-op and legacy games mostly.', generalArea: 'North Jacksonville', lat: 30.407, lng: -81.652, tradeCount: 2, avgRating: 5, reviewCount: 2, verifiedSeller: false }
      ];
      var games = {
        '174430': { id: '174430', name: 'Gloomhaven', yearPublished: 2017, imageUrl: null, categories: ['Adventure', 'Exploration', 'Fantasy', 'Fighting'], mechanics: ['Cooperative Game', 'Hand Management', 'Modular Board'], suggestedPrice: 120 },
        '167791': { id: '167791', name: 'Terraforming Mars', yearPublished: 2016, imageUrl: null, categories: ['Economic', 'Environmental', 'Science Fiction'], mechanics: ['Card Drafting', 'Hand Management', 'Tile Placement'], suggestedPrice: 62 },
        '224517': { id: '224517', name: 'Brass: Birmingham', yearPublished: 2018, imageUrl: null, categories: ['Economic', 'Industry / Manufacturing'], mechanics: ['Hand Management', 'Network Building'], suggestedPrice: 68 },
        '266192': { id: '266192', name: 'Wingspan', yearPublished: 2019, imageUrl: null, categories: ['Animals', 'Card Game', 'Educational'], mechanics: ['Dice Rolling', 'Engine Building', 'Set Collection'], suggestedPrice: 45 },
        '295947': { id: '295947', name: 'Cascadia', yearPublished: 2021, imageUrl: null, categories: ['Animals', 'Environmental', 'Puzzle'], mechanics: ['Pattern Building', 'Tile Placement'], suggestedPrice: 30 }
      };

      var listings = [];
      var entries = {};
      function mk(seller, hours, title, ful, rows, views, reqs) {
        var id = 'demo_l' + (listings.length + 1);
        var p = people.filter(function (x) { return x.id === seller; })[0];
        var pt = { lat: p.lat, lng: p.lng };
        var l = {
          id: id, sellerId: p.id, sellerName: p.displayName, sellerPhoto: null,
          title: title, fulfillment: ful,
          locationLabel: p.generalArea, geoPoint: pt, geohash: Geo.encode(pt.lat, pt.lng, 9),
          countryCode: 'US', state: 'FL',
          eventId: null, status: 'active',
          createdAt: now - hours * 3600000, updatedAt: now - hours * 3600000,
          viewCount: views, requestCount: reqs, hotScore: 0, openReportCount: 0
        };
        var es = rows.map(function (r, i) {
          return {
            id: id + '_e' + i, bggId: r[0], name: games[r[0]].name,
            condition: r[1], tags: r[2] || [], photos: [], askingPrice: r[3],
            notes: '', order: i, status: 'active',
            currentHoldRequestId: null, holdExpiresAt: null, queueCount: 0
          };
        });
        var roll = buildRollup(l, es, games);
        Object.keys(roll).forEach(function (k) { l[k] = roll[k]; });
        l.hotScore = hotScore(l);
        entries[id] = es;
        listings.push(l);
      }

      mk('demo_ava', 3, 'Shelf cleanout — heavy euros', { pickup: true, shipping: true, inPersonAtEvent: false },
        [['224517', 'LN', ['Sleeved cards', 'Smoke-free home'], 45], ['167791', 'VG', ['Punched', '3D-printed insert'], 40]], 88, 3);
      mk('demo_theo', 20, '', { pickup: true, shipping: false, inPersonAtEvent: false },
        [['174430', 'G', ['Punched', 'All expansions included', 'Painted minis'], 85]], 210, 1);
      mk('demo_nell', 50, 'Light games, great shape', { pickup: true, shipping: true, inPersonAtEvent: false },
        [['266192', 'LN', ['Sleeved cards', 'Pet-free home'], 32], ['295947', 'NIS', [], 26]], 41, 2);
      mk('demo_ava', 120, '', { pickup: false, shipping: true, inPersonAtEvent: false },
        [['295947', 'VG', ['Premium playmat'], 18]], 132, 5);

      var users = {};
      people.forEach(function (p) {
        users[p.id] = {
          id: p.id, displayName: p.displayName, photoURL: null, bio: p.bio,
          generalArea: p.generalArea, geoPoint: { lat: p.lat, lng: p.lng },
          geohash: Geo.encode(p.lat, p.lng, 9), countryCode: 'US', state: 'FL',
          createdAt: now - 90 * 86400000,
          tradeCount: p.tradeCount, avgRating: p.avgRating, reviewCount: p.reviewCount,
          verifiedSeller: p.verifiedSeller, availabilityWindows: [],
          openReportCount: 0, restricted: false
        };
      });

      return {
        users: users, games: games, listings: listings, entries: entries,
        blocked: {}, reports: {}, requests: [], messages: {}, slots: {}, reviews: {}, events: {}
      };
    }

    function clone(o) { return o ? JSON.parse(JSON.stringify(o)) : o; }

    return {
      kind: 'demo',

      getUser: function (uid) { return Promise.resolve(clone(db.users[uid]) || null); },

      ensureProfile: function (authUser) {
        if (!db.users[authUser.uid]) {
          db.users[authUser.uid] = {
            id: authUser.uid,
            displayName: authUser.displayName || 'You (demo)',
            photoURL: authUser.photoURL || null,
            bio: '', generalArea: '', geoPoint: null, geohash: null,
            createdAt: Date.now(), tradeCount: 0, avgRating: null, reviewCount: 0,
            verifiedSeller: false, availabilityWindows: [], openReportCount: 0, restricted: false
          };
          save();
        }
        return Promise.resolve(clone(db.users[authUser.uid]));
      },

      saveProfile: function (uid, patch) {
        var u = db.users[uid] || {};
        /* Must stay in step with the writable list in CloudBackend.saveProfile.
         * A field missing here is silently dropped while Store.me() still shows
         * it — the in-memory profile and the stored one diverge, and the bug
         * only surfaces on reload or when someone else reads the profile. */
        ['displayName', 'bio', 'photoURL', 'generalArea', 'geoPoint', 'geohash',
          'countryCode', 'state', 'availabilityWindows', 'timeZone'].forEach(function (k) {
          if (patch[k] !== undefined) u[k] = patch[k];
        });
        db.users[uid] = u;
        save();
        return Promise.resolve();
      },

      /* No geocoding API in demo mode — drop a jittered point near downtown
       * Jacksonville so the radius filter is still exercisable.
       *
       * The US-only rejection is faked here too, crudely, by looking for a few
       * obviously-foreign words. This exists so the rejection PATH is
       * exercisable without Firebase; it is not the geo-lock. The real gate is
       * in functions/index.js and cannot be reached from demo mode at all. */
      geocodeArea: function (text) {
        if (/\b(london|paris|toronto|berlin|tokyo|sydney|madrid|dublin|rome|vancouver|montreal|uk|england|france|germany|japan|australia|canada|mexico)\b/i
            .test(String(text))) {
          var err = new Error('Tabled is only available in the United States right now.');
          err.code = 'functions/out-of-range';
          return Promise.reject(err);
        }
        var base = { lat: 30.3322, lng: -81.6557 };
        var p = Geo.jitter(base.lat, base.lng, 6);
        return Promise.resolve({
          label: text, lat: p.lat, lng: p.lng, geohash: Geo.encode(p.lat, p.lng, 9),
          countryCode: 'US', state: 'FL', demo: true
        });
      },

      getGame: function (bggId) { return Promise.resolve(clone(db.games[String(bggId)]) || null); },
      getGames: function (ids) {
        var map = {};
        U.uniq(ids || []).forEach(function (id) {
          if (db.games[String(id)]) map[String(id)] = clone(db.games[String(id)]);
        });
        return Promise.resolve(map);
      },

      getListing: function (id) {
        var l = db.listings.filter(function (x) { return x.id === id; })[0];
        return Promise.resolve(clone(l) || null);
      },
      getEntries: function (id) { return Promise.resolve(clone(db.entries[id]) || []); },

      saveListing: function (listingId, listing, entries, gamesById) {
        var id = listingId || U.uid('l_');
        var existing = db.listings.filter(function (x) { return x.id === id; })[0];
        var l = existing || {
          id: id, createdAt: Date.now(), viewCount: 0, requestCount: 0,
          hotScore: 0, openReportCount: 0
        };
        ['sellerId', 'sellerName', 'sellerPhoto', 'title', 'fulfillment',
          'locationLabel', 'geoPoint', 'geohash', 'countryCode', 'state',
          'acceptedPayment', 'eventId', 'eventName', 'eventStartDate',
          'eventEndDate', 'status'].forEach(function (k) {
          if (listing[k] !== undefined) l[k] = listing[k];
        });
        l.status = l.status || 'active';
        l.updatedAt = Date.now();
        var rollup = buildRollup(l, entries, gamesById);
        Object.keys(rollup).forEach(function (k) { l[k] = rollup[k]; });
        l.hotScore = hotScore(l);

        /* Seed the same hold/queue defaults the cloud path writes. Leaving them
         * undefined here would let the demo backend produce entries the M5
         * functions couldn't update in place — and the divergence would only
         * show up much later, in the one environment that's hard to test. */
        db.entries[id] = entries.map(function (e, i) {
          var c = clone(e);
          c.id = c.id || (id + '_e' + i);
          c.order = i;
          c.sellerId = listing.sellerId;
          c.status = c.status || 'active';
          c.currentHoldRequestId = c.currentHoldRequestId || null;
          c.holdExpiresAt = c.holdExpiresAt || null;
          c.queueCount = c.queueCount || 0;
          return c;
        });
        if (!existing) db.listings.push(l);
        save();
        return Promise.resolve(id);
      },

      deleteListing: function (id) {
        db.listings = db.listings.filter(function (x) { return x.id !== id; });
        delete db.entries[id];
        save();
        return Promise.resolve();
      },

      queryListings: function (filters, cursor) {
        var lim = (filters && filters.limit) || CFG.PAGE_SIZE;
        var all = clone(db.listings).map(function (l) {
          l.hotScore = hotScore(l);
          return l;
        });
        var items = buildPipeline(filters)(all);
        var start = cursor || 0;
        return Promise.resolve({
          items: items.slice(start, start + lim),
          cursor: start + lim,
          exhausted: start + lim >= items.length
        });
      },

      bumpView: function (id) {
        var l = db.listings.filter(function (x) { return x.id === id; })[0];
        if (l) { l.viewCount = (l.viewCount || 0) + 1; save(); }
        return Promise.resolve();
      },
      bumpRequestCount: function (id) {
        var l = db.listings.filter(function (x) { return x.id === id; })[0];
        if (l) { l.requestCount = (l.requestCount || 0) + 1; save(); }
        return Promise.resolve();
      },

      /* Photos live as data URLs in demo mode. They're capped hard because
       * localStorage is ~5MB total and a single phone photo can eat a fifth
       * of it even after downscaling. */
      uploadPhoto: function (uid, blob) {
        return new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onload = function () { resolve(fr.result); };
          fr.onerror = function () { reject(new Error('Could not read image')); };
          fr.readAsDataURL(blob);
        });
      },

      submitReport: function (report) {
        db.reports[report.reporterId + '_' + report.targetType + '_' + report.targetId] = clone(report);
        save();
        return Promise.resolve();
      },
      block: function (uid, target) {
        (db.blocked[uid] = db.blocked[uid] || {})[target] = Date.now();
        save();
        return Promise.resolve();
      },
      unblock: function (uid, target) {
        if (db.blocked[uid]) delete db.blocked[uid][target];
        save();
        return Promise.resolve();
      },
      loadBlocked: function (uid) {
        return Promise.resolve(Object.keys(db.blocked[uid] || {}));
      },

      /* ---- Requests & chat (M4), demo edition ----
       * onSnapshot is faked with a tiny subscriber list that fires on every
       * save(). Coarse — every watcher re-reads on any change — but the demo
       * dataset is a handful of documents, and it means the chat view exercises
       * the same real-time code path it will use against Firestore. */

      /* M5 queue logic, mirrored from the createRequest callable. Kept
       * faithful to it — including refusing a self-request and returning an
       * existing thread instead of a duplicate — so demo mode exercises the
       * real behaviour rather than a simplified stand-in that hides bugs. */
      createRequest: function (listingId, gameEntryId, trade) {
        trade = trade || {};
        var listing = db.listings.filter(function (l) { return l.id === listingId; })[0];
        if (!listing) return Promise.reject(new Error('No such listing'));
        var entry = (db.entries[listingId] || []).filter(function (e) { return e.id === gameEntryId; })[0];
        if (!entry) return Promise.reject(new Error('No such game'));
        if (listing.sellerId === myUid) return Promise.reject(new Error("You can't request your own listing"));
        if (entry.status === 'sold') return Promise.reject(new Error('That game is already sold'));

        /* Mirrors the callable: trades only where the seller opted in, and the
         * offered game must be genuinely free to offer. */
        if (trade.proposalType === 'trade' &&
            !(listing.acceptedPayment && listing.acceptedPayment.trades === true)) {
          return Promise.reject(new Error("This seller isn't taking trades"));
        }
        var offeredEntry = null;
        if (trade.offeredGameEntryId) {
          var ol = db.listings.filter(function (l) { return l.id === trade.offeredListingId; })[0];
          if (!ol) return Promise.reject(new Error("Can't find the listing you're offering from"));
          if (ol.sellerId !== myUid) return Promise.reject(new Error('You can only offer your own listings'));
          offeredEntry = (db.entries[trade.offeredListingId] || []).filter(function (e) {
            return e.id === trade.offeredGameEntryId;
          })[0];
          if (!offeredEntry) return Promise.reject(new Error("Can't find the game you're offering"));
          if (offeredEntry.status === 'sold') return Promise.reject(new Error("You've already sold that one"));
          if (offeredEntry.status === 'reserved') {
            return Promise.reject(new Error('That game is already on the table in another trade'));
          }
          if (offeredEntry.status === 'onHold') {
            return Promise.reject(new Error("Someone is already in a queue for that game — you can't offer it in a trade too"));
          }
        }

        var open = db.requests.filter(function (r) {
          return r.gameEntryId === gameEntryId && CFG.isOpenRequest(r.status);
        });
        var mine = open.filter(function (r) { return r.buyerId === myUid; })[0];
        if (mine) {
          return Promise.resolve({ requestId: mine.id, queuePosition: mine.queuePosition, existing: true });
        }

        var position = open.length;
        var id = U.uid('r_');
        var me = db.users[myUid] || {};
        var now = Date.now();
        var deadline = now + CFG.QUEUE.holdHours * 3600000;

        db.requests.push({
          id: id, listingId: listingId, gameEntryId: gameEntryId,
          buyerId: myUid, sellerId: listing.sellerId,
          buyerName: me.displayName || 'Buyer', buyerPhoto: me.photoURL || null,
          sellerName: listing.sellerName || '', sellerPhoto: listing.sellerPhoto || null,
          listingTitle: listing.title || '', gameName: entry.name || 'Game',
          coverPhoto: (entry.photos && entry.photos[0]) || listing.coverPhoto || null,
          askingPrice: typeof entry.askingPrice === 'number' ? entry.askingPrice : null,
          status: position === 0 ? 'onHold' : 'queued',
          queuePosition: position,
          holdExpiresAt: position === 0 ? deadline : null,
          promotedAt: position === 0 ? now : null,
          proposalType: trade.proposalType === 'trade' ? 'trade' : 'purchase',
          offeredListingId: trade.offeredListingId || null,
          offeredGameEntryId: trade.offeredGameEntryId || null,
          offeredGameName: offeredEntry ? (offeredEntry.name || 'Game') : null,
          offeredItemDescription: trade.offeredItemDescription || null,
          additionalCashOffered: typeof trade.additionalCashOffered === 'number'
            ? trade.additionalCashOffered : null,
          eventId: listing.eventId || null,
          eventEndDate: listing.eventEndDate || null,
          proposedTime: null, proposedBy: null, scheduledTime: null,
          method: null, bookedSlotId: null, feePaid: false,
          lastMessageAt: null, lastMessageText: '', lastMessageSenderId: null,
          lastReadBuyerAt: null, lastReadSellerAt: null,
          createdAt: now, updatedAt: now
        });
        db.messages[id] = [];

        entry.status = 'onHold';
        if (position === 0) {
          entry.currentHoldRequestId = id;
          entry.holdExpiresAt = deadline;
        }
        entry.queueCount = position + 1;
        if (offeredEntry) {
          offeredEntry.status = 'reserved';
          offeredEntry.reservedByRequestId = id;
        }
        listing.requestCount = (listing.requestCount || 0) + 1;

        save();
        return Promise.resolve({ requestId: id, queuePosition: position, existing: false });
      },

      /* Mirror of resyncQueue in functions/index.js. Derived from the open
       * request set every time rather than incremented — a counter that drifts
       * once stays wrong, and "3 waiting" with two people in the queue is
       * worse than no queue display at all. */
      resyncQueue: function (listingId, gameEntryId) {
        var entry = (db.entries[listingId] || []).filter(function (e) { return e.id === gameEntryId; })[0];
        if (!entry) return;
        var open = db.requests.filter(function (r) {
          return r.gameEntryId === gameEntryId && CFG.isOpenRequest(r.status);
        }).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });

        var now = Date.now();
        if (!open.length) {
          entry.queueCount = 0;
          if (entry.status !== 'sold') {
            entry.status = 'active';
            entry.currentHoldRequestId = null;
            entry.holdExpiresAt = null;
          }
          return;
        }
        open.forEach(function (r, i) {
          r.queuePosition = i;
          if (i === 0 && r.status === 'queued') {
            /* A promoted holder gets a fresh full window, not the remainder
             * of the window the previous holder burned through. */
            r.status = 'onHold';
            r.holdExpiresAt = now + CFG.QUEUE.holdHours * 3600000;
            r.promotedAt = now;
            r.updatedAt = now;
          }
        });
        entry.queueCount = open.length;
        if (entry.status !== 'sold') {
          entry.status = 'onHold';
          entry.currentHoldRequestId = open[0].id;
          entry.holdExpiresAt = open[0].holdExpiresAt || (now + CFG.QUEUE.holdHours * 3600000);
        }
      },

      getRequest: function (id) {
        return Promise.resolve(clone(find(id)) || null);
      },

      watchRequest: function (id, cb) {
        return subscribe(function () { cb(clone(find(id)) || null); });
      },

      watchMyRequests: function (uid, cb) {
        return subscribe(function () {
          var mine = db.requests.filter(function (r) {
            return r.buyerId === uid || r.sellerId === uid;
          });
          mine.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
          cb(clone(mine));
        });
      },

      watchMessages: function (requestId, cb) {
        return subscribe(function () { cb(clone(db.messages[requestId] || [])); });
      },

      sendMessage: function (requestId, senderId, text) {
        (db.messages[requestId] = db.messages[requestId] || []).push({
          id: U.uid('m_'), senderId: senderId, text: text, createdAt: Date.now()
        });
        var r = find(requestId);
        if (r) {
          r.lastMessageAt = Date.now();
          r.lastMessageText = text.slice(0, 140);
          r.lastMessageSenderId = senderId;
          r.updatedAt = Date.now();
        }
        save();
        return Promise.resolve();
      },

      updateRequest: function (id, patch) {
        var r = find(id);
        if (r) {
          var wasOpen = CFG.isOpenRequest(r.status);
          var wasHolding = ['proposedTime', 'scheduled'].indexOf(r.status) !== -1 && !!r.bookedSlotId;
          Object.keys(patch).forEach(function (k) { r[k] = patch[k]; });
          r.updatedAt = Date.now();
          this.releaseSlotIfDropped(r, wasHolding);
          /* Stands in for the onRequestStatusChange trigger: when a request
           * leaves the open set, whoever is behind it moves up. */
          if (wasOpen && !CFG.isOpenRequest(r.status)) {
            this.resyncQueue(r.listingId, r.gameEntryId);
            /* And a trade proposal that closed without completing hands the
             * offered game back. Completion is excluded — confirmSold marks it
             * sold, and releasing it here would relist a traded-away game. */
            if (r.offeredGameEntryId && r.status !== 'completed') {
              var oe = (db.entries[r.offeredListingId] || []).filter(function (x) {
                return x.id === r.offeredGameEntryId;
              })[0];
              if (oe) { oe.status = 'active'; oe.reservedByRequestId = null; }
            }
          }
        }
        save();
        return Promise.resolve();
      },

      /* Demo-only. Stands in for advanceExpiredHolds so the promotion path is
       * exercisable without waiting 24 hours or deploying a scheduler. */
      runExpirySweep: function (nowMs) {
        var self0 = this;
        var now = nowMs || Date.now();
        var touched = {}, expired = 0, reverted = 0;
        db.requests.forEach(function (r) {
          if (r.status === 'onHold' && r.holdExpiresAt && r.holdExpiresAt <= now) {
            r.status = 'expired'; r.updatedAt = now;
            touched[r.listingId + '/' + r.gameEntryId] = [r.listingId, r.gameEntryId];
            expired++;
          } else if (r.status === 'proposedTime' && r.holdExpiresAt && r.holdExpiresAt <= now) {
            /* The buyer already acted by proposing; a slow seller shouldn't
             * cost them their place. Back to holder with a fresh window. */
            r.status = 'onHold';
            r.proposedTime = null;
            r.proposedBy = null;
            r.holdExpiresAt = now + CFG.QUEUE.holdHours * 3600000;
            r.updatedAt = now;
            self0.releaseSlotIfDropped(r, true);
            reverted++;
          } else if (r.status === 'scheduled' && r.scheduledTime) {
            var t = U.toDate(r.scheduledTime);
            if (t && t.getTime() + CFG.QUEUE.graceHours * 3600000 <= now) {
              r.status = 'expired'; r.updatedAt = now;
              touched[r.listingId + '/' + r.gameEntryId] = [r.listingId, r.gameEntryId];
              expired++;
            }
          }
        });
        var self = this;
        Object.keys(touched).forEach(function (k) {
          self.resyncQueue(touched[k][0], touched[k][1]);
        });
        save();
        return Promise.resolve({ expired: expired, reverted: reverted });
      },

      markRead: function (id, isBuyer) {
        var r = find(id);
        if (r) r[isBuyer ? 'lastReadBuyerAt' : 'lastReadSellerAt'] = Date.now();
        save();
        return Promise.resolve();
      },

      /* ---- Auto-book (M6), demo edition ----
       * Mirrors the bookSlot callable, including the exclusivity failure — the
       * demo store is a plain object, so "the key already exists" has to be
       * checked explicitly where Firestore's .create() does it for us. */
      getBookedSlots: function (sellerId) {
        var now = Date.now();
        return Promise.resolve(Object.keys(db.slots || {}).filter(function (id) {
          var s = db.slots[id];
          return s.sellerId === sellerId && s.startsAtMs > now;
        }));
      },

      bookSlot: function (requestId, date, startTime) {
        var r = find(requestId);
        if (!r) return Promise.reject(new Error('No such request'));
        if (r.buyerId !== myUid) return Promise.reject(new Error('Only the buyer can claim a slot'));
        if (r.queuePosition !== 0) return Promise.reject(new Error("It isn't your turn yet"));

        var seller = db.users[r.sellerId] || {};
        var windows = seller.availabilityWindows || [];
        var tz = seller.timeZone;
        if (!windows.length || !tz) {
          return Promise.reject(new Error("This seller hasn't set any availability"));
        }
        if (!TimeSlots.withinWindows(windows, date, startTime, TimeSlots.SLOT_MINUTES)) {
          return Promise.reject(new Error("That time isn't in the seller's availability"));
        }
        var startsAtMs = TimeSlots.zonedToUtc(date, startTime, tz);
        if (startsAtMs <= Date.now()) {
          return Promise.reject(new Error('That time has already passed'));
        }

        db.slots = db.slots || {};
        var id = TimeSlots.slotId(r.sellerId, date, startTime);
        if (db.slots[id]) {
          return Promise.reject(new Error('Someone just took that slot — pick another'));
        }

        if (r.bookedSlotId && r.bookedSlotId !== id) delete db.slots[r.bookedSlotId];

        db.slots[id] = {
          sellerId: r.sellerId, date: date, startTime: startTime,
          endTime: TimeSlots.toHHMM(TimeSlots.toMinutes(startTime) + TimeSlots.SLOT_MINUTES),
          startsAtMs: startsAtMs, requestId: requestId,
          gameEntryId: r.gameEntryId, listingId: r.listingId,
          buyerId: myUid, createdAt: Date.now()
        };

        r.status = 'proposedTime';
        r.proposedTime = new Date(startsAtMs);
        r.proposedBy = myUid;
        r.method = 'pickup';
        r.bookedSlotId = id;
        r.holdExpiresAt = Date.now() + CFG.QUEUE.holdHours * 3600000;
        r.updatedAt = Date.now();

        save();
        return Promise.resolve({ slotId: id, startsAtMs: startsAtMs, requestId: requestId });
      },

      /* ---- Completion & reviews (M7), demo edition ----
       * Mirrors confirmSold, including the part that matters: nothing
       * completes until BOTH sides have confirmed. */
      confirmSold: function (requestId) {
        var r = find(requestId);
        if (!r) return Promise.reject(new Error('No such request'));
        var isBuyer = r.buyerId === myUid;
        var isSeller = r.sellerId === myUid;
        if (!isBuyer && !isSeller) return Promise.reject(new Error('Not your trade'));
        if (r.status === 'completed') return Promise.resolve({ already: true, completed: true });
        if (r.status !== 'scheduled') {
          return Promise.reject(new Error('Agree a time first - confirming comes after that'));
        }

        var field = isBuyer ? 'buyerConfirmedAt' : 'sellerConfirmedAt';
        if (r[field]) return Promise.resolve({ already: true, completed: false });
        var other = isBuyer ? 'sellerConfirmedAt' : 'buyerConfirmedAt';
        var now = Date.now();
        r[field] = now;
        r.updatedAt = now;

        if (!r[other]) {
          save();
          return Promise.resolve({
            already: false, completed: false, waitingOn: isBuyer ? 'seller' : 'buyer'
          });
        }

        r.status = 'completed';
        r.completedAt = now;
        /* No config doc in demo mode, so the waiver is treated as active -
         * same default the callable uses, and for the same reason. */
        r.feePaid = true;
        r.feeWaived = true;
        this.releaseSlotIfDropped(r, true);

        var entry = (db.entries[r.listingId] || []).filter(function (e) {
          return e.id === r.gameEntryId;
        })[0];
        if (entry) {
          entry.status = 'sold';
          entry.currentHoldRequestId = null;
          entry.holdExpiresAt = null;
          entry.queueCount = 0;
        }

        var closed = 0;
        db.requests.forEach(function (x) {
          if (x.id === requestId) return;
          if (x.gameEntryId !== r.gameEntryId) return;
          if (!CFG.isOpenRequest(x.status)) return;
          x.status = 'expired';
          x.closedReason = 'itemSold';
          x.updatedAt = now;
          closed++;
        });

        [r.buyerId, r.sellerId].forEach(function (uid) {
          var u = db.users[uid];
          if (u) u.tradeCount = (u.tradeCount || 0) + 1;
        });

        /* A completed trade moves TWO games. */
        if (r.offeredGameEntryId && r.offeredListingId) {
          var oe2 = (db.entries[r.offeredListingId] || []).filter(function (x) {
            return x.id === r.offeredGameEntryId;
          })[0];
          if (oe2) {
            oe2.status = 'sold';
            oe2.reservedByRequestId = null;
            oe2.currentHoldRequestId = null;
            oe2.holdExpiresAt = null;
            oe2.queueCount = 0;
          }
        }

        [r.listingId, r.offeredListingId].filter(Boolean).forEach(function (lid) {
          var all = db.entries[lid] || [];
          if (all.length && all.every(function (e) { return e.status === 'sold'; })) {
            var l = db.listings.filter(function (x) { return x.id === lid; })[0];
            if (l) { l.status = 'archived'; l.archivedAt = now; }
          }
        });

        save();
        return Promise.resolve({ already: false, completed: true, closedOthers: closed });
      },

      createReview: function (review) {
        db.reviews = db.reviews || {};
        var id = review.requestId + '_' + review.reviewerId;
        if (db.reviews[id]) return Promise.reject(new Error('You already reviewed this trade'));
        db.reviews[id] = Object.assign({ id: id, createdAt: Date.now() }, review);

        /* Stands in for onReviewCreate: recompute from the whole set rather
         * than folding into a running average, which drifts on any retry. */
        var ratings = Object.keys(db.reviews)
          .map(function (k) { return db.reviews[k]; })
          .filter(function (r) { return r.revieweeId === review.revieweeId; })
          .map(function (r) { return Number(r.rating); })
          .filter(function (n) { return n >= 1 && n <= 5; });
        var u = db.users[review.revieweeId];
        if (u && ratings.length) {
          var avg = ratings.reduce(function (a, b) { return a + b; }, 0) / ratings.length;
          u.avgRating = Math.round(avg * 100) / 100;
          u.reviewCount = ratings.length;
        }
        save();
        return Promise.resolve(id);
      },

      getReviews: function (revieweeId) {
        var out = Object.keys(db.reviews || {})
          .map(function (k) { return clone(db.reviews[k]); })
          .filter(function (r) { return r.revieweeId === revieweeId; })
          .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        return Promise.resolve(out);
      },

      getMyReviewedRequestIds: function (uid) {
        return Promise.resolve(Object.keys(db.reviews || {})
          .map(function (k) { return db.reviews[k]; })
          .filter(function (r) { return r.reviewerId === uid; })
          .map(function (r) { return r.requestId; }));
      },

      createEvent: function (event) {
        db.events = db.events || {};
        var id = U.uid('ev_');
        db.events[id] = Object.assign({ id: id, createdBy: myUid, createdAt: Date.now() }, event);
        save();
        return Promise.resolve(id);
      },
      getEvent: function (id) {
        return Promise.resolve(clone((db.events || {})[id]) || null);
      },
      listEvents: function () {
        var now = Date.now();
        return Promise.resolve(Object.keys(db.events || {})
          .map(function (k) { return clone(db.events[k]); })
          .filter(function (e) { return (U.toDate(e.endDate) || 0) >= now; })
          .sort(function (a, b) {
            return (U.toDate(a.startDate) || 0) - (U.toDate(b.startDate) || 0);
          }));
      },

      /* Demo mode has no Stripe. Settling directly is honest here precisely
       * because it is obviously fake — there is no card, no session, and the
       * banner says so. It exercises the badge recompute, which is the part
       * with actual logic in it. */
      startFeeCheckout: function (requestId) {
        var r = find(requestId);
        if (!r) return Promise.reject(new Error('No such trade'));
        if (r.sellerId !== myUid) return Promise.reject(new Error('Only the seller pays this fee'));
        if (r.status !== 'completed') return Promise.reject(new Error('That trade is not complete'));
        if (r.feePaid) return Promise.reject(new Error('That trade is already settled'));

        r.feePaid = true;
        r.feePaidAt = Date.now();
        r.feeAmountCents = CFG.FEE.cents;

        var unpaid = db.requests.filter(function (x) {
          return x.sellerId === r.sellerId && x.status === 'completed' && x.feePaid === false;
        });
        var u = db.users[r.sellerId];
        if (u) u.verifiedSeller = unpaid.length === 0;

        save();
        return Promise.resolve({ demo: true });
      },

      /* Stands in for the onSlotHoldChange trigger. */
      releaseSlotIfDropped: function (r, wasHolding) {
        if (!wasHolding) return;
        var stillHolding = ['proposedTime', 'scheduled'].indexOf(r.status) !== -1 && r.bookedSlotId;
        if (stillHolding) return;
        if (r.bookedSlotId && db.slots) delete db.slots[r.bookedSlotId];
        r.bookedSlotId = null;
      }
    };

    function find(id) {
      return db.requests.filter(function (r) { return r.id === id; })[0];
    }
  }

  /* ================= Session ============================================== */

  function notify() { listeners.forEach(function (fn) { fn(); }); }

  /* ---- My requests, watched once for the whole app -----------------------
   * The dashboard and the nav's unread badge both need this list live. One
   * subscription feeds both: two would double the read cost of every message
   * anyone sends, for identical data. */
  var myRequests = [];
  var requestSubs = [];
  var stopRequestWatch = null;

  function onMyRequests(cb) {
    requestSubs.push(cb);
    cb(myRequests);
    return function () {
      var i = requestSubs.indexOf(cb);
      if (i !== -1) requestSubs.splice(i, 1);
    };
  }

  function startRequestWatch() {
    if (stopRequestWatch) stopRequestWatch();
    stopRequestWatch = backend.watchMyRequests(myUid, function (list) {
      myRequests = list;
      requestSubs.slice().forEach(function (fn) { fn(myRequests); });
    });
  }

  /* A thread is unread when the last message arrived after you last opened it
   * AND you didn't send it. Both halves matter: without the second, your own
   * message marks your own thread unread. */
  function isUnread(r) {
    if (!r.lastMessageAt || r.lastMessageSenderId === myUid) return false;
    var mine = r.buyerId === myUid ? r.lastReadBuyerAt : r.lastReadSellerAt;
    if (!mine) return true;
    return (U.toDate(r.lastMessageAt) || 0) > (U.toDate(mine) || 0);
  }

  function unreadCount() {
    return myRequests.filter(isUnread).length;
  }

  /* Called by firebase-config.js on sign-in, or by app.js with a fake user in
   * demo mode. Everything the views need is loaded here so the first render
   * after boot is already complete rather than three staggered repaints. */
  function startSession(authUser) {
    myUid = authUser.uid;
    return backend.ensureProfile(authUser)
      .then(function (profile) {
        myProfile = profile;
        return backend.loadBlocked(myUid);
      })
      .then(function (list) {
        blockedSet = Object.create(null);
        list.forEach(function (id) { blockedSet[id] = true; });
        startRequestWatch();
        notify();
        return myProfile;
      });
  }

  function endSession() {
    if (stopRequestWatch) { stopRequestWatch(); stopRequestWatch = null; }
    myRequests = [];
    myUid = null;
    myProfile = null;
    blockedSet = Object.create(null);
    notify();
  }

  return {
    /* ---- wiring ---- */
    useCloud: function (fb, db, storage, fns) { backend = CloudBackend(fb, db, storage, fns); },
    useDemo: function () { backend = DemoBackend(); },
    isDemo: function () { return !backend || backend.kind === 'demo'; },
    onChange: function (fn) { listeners.push(fn); },

    startSession: startSession,
    endSession: endSession,
    uid: function () { return myUid; },
    me: function () { return myProfile; },
    setMe: function (p) { myProfile = p; notify(); },
    isMe: function (uid) { return !!myUid && myUid === uid; },

    /* ---- blocking (kept in memory; the feed filters against it on every
     * query, so it has to be synchronous) ---- */
    isBlocked: function (uid) { return !!blockedSet[uid]; },
    blockedList: function () { return Object.keys(blockedSet); },
    block: function (target) {
      return backend.block(myUid, target).then(function () {
        blockedSet[target] = true;
        notify();
      });
    },
    unblock: function (target) {
      return backend.unblock(myUid, target).then(function () {
        delete blockedSet[target];
        notify();
      });
    },

    /* ---- passthrough ---- */
    getUser: function (uid) { return backend.getUser(uid); },
    saveProfile: function (patch) {
      return backend.saveProfile(myUid, patch).then(function () {
        myProfile = Object.assign({}, myProfile, patch);
        notify();
        return myProfile;
      });
    },
    geocodeArea: function (t) { return backend.geocodeArea(t); },
    getGame: function (id) { return backend.getGame(id); },
    getGames: function (ids) { return backend.getGames(ids); },
    getListing: function (id) { return backend.getListing(id); },
    getEntries: function (id) { return backend.getEntries(id); },
    saveListing: function (id, listing, entries, games) { return backend.saveListing(id, listing, entries, games); },
    deleteListing: function (id) { return backend.deleteListing(id); },
    queryListings: function (f, c) { return backend.queryListings(f, c); },
    bumpView: function (id) { return backend.bumpView(id); },
    bumpRequestCount: function (id) { return backend.bumpRequestCount(id); },
    uploadPhoto: function (blob) { return backend.uploadPhoto(myUid, blob); },
    submitReport: function (r) { return backend.submitReport(r); },

    /* ---- requests & chat (M4) + hold/queue (M5) ---- */
    createRequest: function (listingId, gameEntryId, trade) {
      return backend.createRequest(listingId, gameEntryId, trade);
    },

    /* My own game entries that are genuinely free to put on the table: active,
     * unsold, not already reserved in another trade, and not mid-queue. */
    myOfferableEntries: function () {
      return Store.queryListings({ sellerId: myUid, sort: 'new', limit: 30 })
        .then(function (page) {
          return Promise.all(page.items.map(function (l) {
            return backend.getEntries(l.id).then(function (es) {
              return es.filter(function (e) { return e.status === 'active'; })
                .map(function (e) {
                  return { listingId: l.id, listingTitle: l.title, entry: e };
                });
            });
          }));
        }).then(function (groups) {
          return groups.reduce(function (a, b) { return a.concat(b); }, []);
        });
    },

    /* Do I already have an open request on this game entry?
     *
     * Answered from the live myRequests subscription rather than by querying,
     * because that subscription is already streaming every request I'm party
     * to. A per-entry query on the listing page would be one extra read per
     * game, per view, for data sitting in memory. */
    myRequestFor: function (gameEntryId) {
      for (var i = 0; i < myRequests.length; i++) {
        var r = myRequests[i];
        if (r.gameEntryId === gameEntryId && r.buyerId === myUid && CFG.isOpenRequest(r.status)) {
          return r;
        }
      }
      return null;
    },

    getBookedSlots: function (sellerId) { return backend.getBookedSlots(sellerId); },

    /* ---- completion & reviews (M7) ---- */
    confirmSold: function (requestId) { return backend.confirmSold(requestId); },
    startFeeCheckout: function (requestId) { return backend.startFeeCheckout(requestId); },

    /* ---- events (M9) ---- */
    createEvent: function (e) { return backend.createEvent(e); },
    getEvent: function (id) { return backend.getEvent(id); },
    listEvents: function () { return backend.listEvents(); },

    /* Completed trades of mine, as SELLER, that still owe a fee. The buyer
     * never owes anything, so this is deliberately one-sided. */
    unpaidFees: function () {
      return myRequests.filter(function (r) {
        return r.sellerId === myUid && r.status === 'completed' && r.feePaid === false;
      });
    },
    createReview: function (review) { return backend.createReview(review); },
    getReviews: function (revieweeId) { return backend.getReviews(revieweeId); },
    getMyReviewedRequestIds: function () { return backend.getMyReviewedRequestIds(myUid); },

    /* Have I confirmed my side of this trade yet? Derived rather than stored
     * per-viewer, since the request already carries both timestamps. */
    myConfirmation: function (r) {
      if (!r || !myUid) return null;
      if (r.buyerId === myUid) return r.buyerConfirmedAt || null;
      if (r.sellerId === myUid) return r.sellerConfirmedAt || null;
      return null;
    },
    theirConfirmation: function (r) {
      if (!r || !myUid) return null;
      if (r.buyerId === myUid) return r.sellerConfirmedAt || null;
      if (r.sellerId === myUid) return r.buyerConfirmedAt || null;
      return null;
    },
    bookSlot: function (requestId, date, startTime) {
      return backend.bookSlot(requestId, date, startTime);
    },

    /* Demo only — stands in for the advanceExpiredHolds scheduler so queue
     * promotion is testable without waiting a day. Absent in cloud mode. */
    runExpirySweep: function (nowMs) {
      return backend.runExpirySweep
        ? backend.runExpirySweep(nowMs)
        : Promise.reject(new Error('Expiry runs server-side in cloud mode'));
    },
    getRequest: function (id) { return backend.getRequest(id); },
    watchRequest: function (id, cb) { return backend.watchRequest(id, cb); },
    watchMessages: function (id, cb) { return backend.watchMessages(id, cb); },
    sendMessage: function (id, text) { return backend.sendMessage(id, myUid, text); },
    updateRequest: function (id, patch) { return backend.updateRequest(id, patch); },
    markRead: function (id, isBuyer) { return backend.markRead(id, isBuyer); },
    onMyRequests: onMyRequests,
    myRequests: function () { return myRequests; },
    isUnread: isUnread,
    unreadCount: unreadCount,

    /* ---- exposed for views and tests ---- */
    buildRollup: buildRollup,
    tokenize: tokenize,
    searchTerm: searchTerm,
    hotScore: hotScore
  };
})();
