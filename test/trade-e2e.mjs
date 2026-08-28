/* Tabled — multi-user trade end-to-end suite.
 *
 * Five real signed-in users push two trades all the way through the machine:
 * list -> request -> queue -> claim a slot -> both confirm -> review.
 *
 * WHY THIS EXISTS AND WHAT IT COVERS
 *
 * Demo mode cannot test this. It is per-browser localStorage with one seeded
 * user, so two accounts can never see each other and a two-party trade is
 * structurally impossible there. And demo mode mirrors the server logic without
 * being the server: it runs no firestore.rules and no Cloud Functions, which is
 * precisely where every recent bug has lived (the verifiedSeller create rule,
 * the latlng-methods geoOk rejection, geoPoint writes being denied outright).
 *
 * So this runs against the Firebase Emulator Suite with the REAL
 * firestore.rules and the REAL functions/index.js loaded.
 *
 * SAFETY
 *
 * The project id is `demo-tabled`. The Firebase CLI treats any id starting with
 * `demo-` as offline-only: it refuses to reach a real backend, and there are no
 * credentials in this process. This suite cannot touch tabled-2ad11 even if the
 * emulators are not running -- it fails to connect instead.
 *
 * RUN
 *   firebase emulators:start --only auth,firestore,functions --project demo-tabled
 *   node test/trade-e2e.mjs
 */
import {
  check, step, expectReject, until, summarize,
  makeUser, makeSeller, createListing, nextSlot, acceptProposal,
  WINDOWS, TZ,
  doc, getDoc, setDoc, updateDoc, collection, GeoPoint, serverTimestamp
} from './harness.mjs';

/* ---- the run ------------------------------------------------------------- */

async function main() {
  const users = {};
  step('Creating 5 users (auth + profile, through the real rules)');
  for (const [label, name] of [
    ['sam', 'Sam Seller'], ['ada', 'Ada Buyer'], ['ben', 'Ben Buyer'],
    ['cy', 'Cy Buyer'], ['dee', 'Dee Buyer']
  ]) {
    users[label] = await makeUser(label, name);
    check(`profile created for ${name}`, !!users[label].uid, users[label].uid);
  }
  const { sam, ada, ben, cy, dee } = users;

  /* geoPoint is read back rather than assumed: setDoc resolving only means the
     write was accepted, and the bug this guards against was a silent rejection
     of exactly this field. */
  const samDoc = await getDoc(doc(sam.db, 'users', sam.uid));
  check('geoPoint actually persisted (latlng rules regression)',
    samDoc.exists() && samDoc.data().geoPoint instanceof GeoPoint,
    samDoc.exists() ? JSON.stringify(samDoc.data().geoPoint) : 'no doc');

  step('Seller sets availability and lists two games');
  const windows = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
    dayOfWeek: d, startTime: '09:00', endTime: '21:00'
  }));
  await updateDoc(doc(sam.db, 'users', sam.uid),
    { availabilityWindows: windows, timeZone: TZ });

  const { listingId, entryIds } = await createListing(sam, 'Shelf cleanout', [
    { name: 'Brass: Birmingham', askingPrice: 45, condition: 'LN' },
    { name: 'Cascadia', askingPrice: 18, condition: 'VG' }
  ]);
  check('listing + 2 game entries created', entryIds.length === 2, listingId);

  step('Rules say no to the things they exist to refuse');
  await expectReject('a buyer cannot write the seller\'s listing',
    updateDoc(doc(ada.db, 'listings', listingId), { title: 'hijacked' }),
    'permission-denied');
  await expectReject('nobody can create a request document directly',
    setDoc(doc(collection(ada.db, 'requests')), {
      buyerId: ada.uid, sellerId: sam.uid, listingId, status: 'queued', queuePosition: 0
    }),
    'permission-denied');
  await expectReject('a user cannot inflate their own tradeCount',
    updateDoc(doc(ada.db, 'users', ada.uid), { tradeCount: 99 }),
    'permission-denied');

  step('Three buyers queue for the same game');
  const reqs = {};
  for (const [label, u] of [['ada', ada], ['ben', ben], ['cy', cy]]) {
    const res = await u.call('createRequest', { listingId, gameEntryId: entryIds[0] });
    reqs[label] = res.requestId || res.id;
    check(`${u.displayName} got queue position ${res.queuePosition}`,
      typeof res.queuePosition === 'number', JSON.stringify(res));
  }
  const adaReq = await getDoc(doc(sam.db, 'requests', reqs.ada));
  const benReq = await getDoc(doc(sam.db, 'requests', reqs.ben));
  const cyReq = await getDoc(doc(sam.db, 'requests', reqs.cy));
  check('first buyer is position 0 and holds the game',
    adaReq.data().queuePosition === 0 && adaReq.data().status === 'onHold',
    `pos=${adaReq.data().queuePosition} status=${adaReq.data().status}`);
  check('second and third buyers are queued behind, in order',
    benReq.data().queuePosition === 1 && cyReq.data().queuePosition === 2 &&
    benReq.data().status === 'queued',
    `ben=${benReq.data().queuePosition} cy=${cyReq.data().queuePosition}`);

  /* Requesting twice is idempotent by design rather than an error: the callable
     hands back the request you already have. Asserting the queue did NOT grow
     is the part that matters -- a second queue slot for the same buyer would
     let someone hold two places in line. */
  const dupe = await ada.call('createRequest', { listingId, gameEntryId: entryIds[0] });
  const entryAfterDupe = await getDoc(
    doc(sam.db, 'listings', listingId, 'gameEntries', entryIds[0]));
  check('requesting the same game twice returns the existing request, not a second place in line',
    dupe.requestId === reqs.ada && dupe.existing === true &&
    entryAfterDupe.data().queueCount === 3,
    `id match=${dupe.requestId === reqs.ada} existing=${dupe.existing} queueCount=${entryAfterDupe.data().queueCount}`);
  await expectReject('the seller cannot request their own game',
    sam.call('createRequest', { listingId, gameEntryId: entryIds[0] }),
    'own|failed-precondition|permission');

  step('Only the front of the queue can claim a time');
  const slot = nextSlot(windows);
  await expectReject('second in queue is refused a slot',
    ben.call('bookSlot', { requestId: reqs.ben, date: slot.date, startTime: slot.startTime }),
    "turn|failed-precondition");

  const booked = await ada.call('bookSlot',
    { requestId: reqs.ada, date: slot.date, startTime: slot.startTime });
  const adaAfter = await getDoc(doc(sam.db, 'requests', reqs.ada));
  check('front of queue claims a slot, which PROPOSES a time',
    adaAfter.data().status === 'proposedTime',
    `status=${adaAfter.data().status} slot=${slot.date} ${slot.startTime} ${JSON.stringify(booked)}`);

  /* Booking is a proposal, not an agreement -- whoever proposes, the seller
     always gets the final say (js/views-thread.js respond()). Scheduling is a
     direct client write the rules permit, not a callable. */
  await acceptProposal(sam, reqs.ada);
  const scheduled = await getDoc(doc(sam.db, 'requests', reqs.ada));
  check('seller accepting the proposal schedules the trade',
    scheduled.data().status === 'scheduled',
    `status=${scheduled.data().status}`);

  await expectReject('a buyer cannot confirm their way past the completion gate',
    updateDoc(doc(ada.db, 'requests', reqs.ada),
      { status: 'completed', buyerConfirmedAt: new Date(), sellerConfirmedAt: new Date() }),
    'permission-denied');

  step('Completion needs BOTH sides');
  await ada.call('confirmSold', { requestId: reqs.ada });
  const halfway = await getDoc(doc(sam.db, 'requests', reqs.ada));
  check('one confirmation does not complete the trade',
    halfway.data().status === 'scheduled' && !!halfway.data().buyerConfirmedAt,
    `status=${halfway.data().status}`);

  await sam.call('confirmSold', { requestId: reqs.ada });
  const done = await until('the trade to complete', async () => {
    const s = await getDoc(doc(sam.db, 'requests', reqs.ada));
    return s.data().status === 'completed' ? s : null;
  });
  check('both confirmations complete the trade', done.data().status === 'completed');

  const soldEntry = await getDoc(
    doc(sam.db, 'listings', listingId, 'gameEntries', entryIds[0]));
  check('the game entry is marked sold', soldEntry.data().status === 'sold',
    `status=${soldEntry.data().status}`);

  step('The rest of the queue is closed out, not promoted');
  /* The item is gone, so the people behind it are waiting for something that no
     longer exists -- they are expired with a reason, not moved to the front. */
  const closedOut = await until('Ben and Cy to be closed out', async () => {
    const b = await getDoc(doc(sam.db, 'requests', reqs.ben));
    const c = await getDoc(doc(sam.db, 'requests', reqs.cy));
    return (b.data().status === 'expired' && c.data().status === 'expired')
      ? { b: b.data(), c: c.data() } : null;
  }).catch((e) => ({ error: e.message }));
  check('everyone still queued is expired with closedReason itemSold',
    closedOut && !closedOut.error && closedOut.b.closedReason === 'itemSold',
    closedOut && closedOut.error ? closedOut.error
      : `ben=${closedOut.b.status}/${closedOut.b.closedReason} cy=${closedOut.c.status}`);

  step('Reviews, and the counters they drive');
  /* Shape and id both matter: the rules pin the document id to
     {requestId}_{reviewerId} (that is what makes a review once-only) and read
     revieweeId, not subjectId. */
  let reviewed = true;
  await setDoc(doc(ada.db, 'reviews', `${reqs.ada}_${ada.uid}`), {
    requestId: reqs.ada, reviewerId: ada.uid, revieweeId: sam.uid,
    reviewerName: ada.displayName, reviewerPhoto: null, gameName: 'Brass: Birmingham',
    rating: 5, comment: 'Smooth handoff, game as described.', createdAt: serverTimestamp()
  }).catch((e) => { reviewed = false; check('buyer can review after completion', false, e.message); });
  if (reviewed) check('buyer can review after completion', true);

  await expectReject('the same buyer cannot review the same trade twice',
    setDoc(doc(ada.db, 'reviews', `${reqs.ada}_${ada.uid}`), {
      requestId: reqs.ada, reviewerId: ada.uid, revieweeId: sam.uid,
      rating: 1, comment: 'changed my mind', createdAt: serverTimestamp()
    }),
    'permission-denied');

  /* reviewCount specifically -- tradeCount already moved at completion, so
     accepting either would let this pass without the review trigger running. */
  const counted = await until('the seller reviewCount/avgRating to update', async () => {
    const s = await getDoc(doc(sam.db, 'users', sam.uid));
    const d = s.data();
    return d.reviewCount > 0 ? d : null;
  }).catch((e) => ({ error: e.message }));
  check('onReviewCreate updates the seller\'s reputation',
    counted && !counted.error && counted.avgRating === 5,
    counted && counted.error ? counted.error
      : `tradeCount=${counted.tradeCount} reviewCount=${counted.reviewCount} avgRating=${counted.avgRating}`);

  step('A second, independent trade on the other game');
  const deeRes = await dee.call('createRequest', { listingId, gameEntryId: entryIds[1] });
  const deeReq = deeRes.requestId || deeRes.id;
  const slot2 = nextSlot(windows.map((w) => ({ ...w })));
  await dee.call('bookSlot',
    { requestId: deeReq, date: slot2.date, startTime: slot2.startTime });
  await acceptProposal(sam, deeReq);
  await dee.call('confirmSold', { requestId: deeReq });
  await sam.call('confirmSold', { requestId: deeReq });
  const done2 = await until('the second trade to complete', async () => {
    const s = await getDoc(doc(sam.db, 'requests', deeReq));
    return s.data().status === 'completed' ? s : null;
  }).catch((e) => ({ error: e.message }));
  check('a second trade completes independently', done2 && !done2.error,
    done2 && done2.error ? done2.error : 'completed');

  /* ---- summary ---- */
  const failedCount = await summarize(Object.values(users));
  process.exit(failedCount ? 1 : 0);
}

main().catch((err) => {
  console.error('\n\x1b[31mSuite aborted:\x1b[0m', err);
  process.exit(2);
});
