/* Tabled — adversarial suite: REPUTATION AND REVIEWS.
 *
 * Every trust signal on a profile (tradeCount, avgRating, reviewCount,
 * verifiedSeller, openReportCount, restricted, vip, staffRole) is denormalized
 * and function-owned. This script attacks the whole surface with real signed-in
 * users, the real firestore.rules and the real functions/index.js:
 *
 *   1. self-writes of every trust field, and writes to someone else's profile
 *   2. review eligibility — scheduled-only trade, someone else's trade,
 *      a nonexistent request, self-review, and an unrelated third party
 *   3. the {requestId}_{reviewerId} doc id that makes a review once-only
 *   4. rating validation — 0, 6, "5", NaN, Infinity, null, missing, 4.5
 *   5. immutability — no update, no delete, by anyone
 *   6. the arithmetic: avgRating/reviewCount from onReviewCreate against the
 *      mean actually implied by the accepted reviews, and tradeCount against
 *      the number of completed trades
 *
 * A refusal is a PASS. A write that lands is a finding.
 *
 * SAFETY: project id `demo-tabled` — offline-only, no credentials in process.
 *
 * RUN
 *   firebase emulators:start --only auth,firestore,functions --project demo-tabled
 *   node test/attacks/reputation.mjs
 */
import {
  check, step, expectReject, until, summarize,
  makeUser, makeSeller, createListing, nextSlot, acceptProposal, completeTrade,
  doc, getDoc, setDoc, updateDoc, serverTimestamp
} from '../harness.mjs';
import { deleteDoc, collection, getDocs, query, where } from 'firebase/firestore';

const findings = [];
function finding(text) { findings.push(text); }

/* A review body with every field the app writes, so a rejection is about the
 * thing under test and not a shape the rules never see. */
function reviewBody(reviewer, revieweeId, requestId, rating, extra) {
  return {
    requestId, reviewerId: reviewer.uid, revieweeId,
    reviewerName: reviewer.displayName, reviewerPhoto: null,
    gameName: 'Brass: Birmingham', rating,
    comment: 'attack payload', createdAt: serverTimestamp(),
    ...(extra || {})
  };
}
function writeReview(reviewer, revieweeId, requestId, rating, opts) {
  const o = opts || {};
  const id = o.id || `${requestId}_${reviewer.uid}`;
  const body = reviewBody(reviewer, revieweeId, requestId, rating, o.extra);
  if (o.dropRating) delete body.rating;
  return setDoc(doc(reviewer.db, 'reviews', id), body);
}

async function profile(u, uid) {
  return (await getDoc(doc(u.db, 'users', uid || u.uid))).data();
}

async function main() {
  const users = {};
  step('Cast: a seller, two honest buyers, an attacker and a bystander');
  users.sam = await makeSeller('rep-sam', 'Sam Seller');
  users.ada = await makeUser('rep-ada', 'Ada Buyer');
  users.ben = await makeUser('rep-ben', 'Ben Buyer');
  users.mal = await makeUser('rep-mal', 'Mal Attacker');
  users.vic = await makeUser('rep-vic', 'Vic Bystander');
  const { sam, ada, ben, mal, vic } = users;
  check('five users have profiles', Object.values(users).every((u) => u.uid));

  /* Two listings so a completed trade and a merely-scheduled one can coexist:
     completing every entry on a listing archives it. */
  const A = await createListing(sam, 'Shelf cleanout A', [
    { name: 'Brass: Birmingham', askingPrice: 45 },
    { name: 'Cascadia', askingPrice: 18 }
  ]);
  const B = await createListing(sam, 'Shelf cleanout B', [
    { name: 'Wingspan', askingPrice: 30 },
    { name: 'Azul', askingPrice: 22 }
  ]);

  step('Three real completed trades, plus one that only ever gets scheduled');
  const reqAda1 = await completeTrade(sam, ada, A.listingId, A.entryIds[0]);
  const reqBen = await completeTrade(sam, ben, A.listingId, A.entryIds[1]);
  const reqAda2 = await completeTrade(sam, ada, B.listingId, B.entryIds[0]);
  check('three trades completed', !!(reqAda1 && reqBen && reqAda2),
    `${reqAda1} ${reqBen} ${reqAda2}`);

  const malRes = await mal.call('createRequest',
    { listingId: B.listingId, gameEntryId: B.entryIds[1] });
  const reqMal = malRes.requestId;
  const slot = nextSlot();
  await mal.call('bookSlot', { requestId: reqMal, date: slot.date, startTime: slot.startTime });
  await acceptProposal(sam, reqMal);
  const malSnap = await getDoc(doc(mal.db, 'requests', reqMal));
  check('a fourth trade is scheduled but NOT completed',
    malSnap.data().status === 'scheduled', `status=${malSnap.data().status}`);

  /* ------------------------------------------------------------------ 1 */
  step('1. Nobody writes their own trust signals');
  const trustFields = {
    /* Every value here must DIFFER from what the profile already holds:
       changed() is a diff, so re-sending an identical value affects no key and
       is (correctly) a no-op the rules allow. Sending openReportCount: 0 and
       restricted: false at a profile that already has them was a bug in this
       test, not a hole in the rules. */
    tradeCount: 999, avgRating: 5, reviewCount: 500, verifiedSeller: true,
    openReportCount: 7, restricted: true, vip: true, staffRole: 'admin',
    vipUntil: new Date('2030-01-01'), vipGrantedBy: 'self', vipReason: 'because'
  };
  for (const [field, value] of Object.entries(trustFields)) {
    await expectReject(`owner cannot set their own ${field}`,
      updateDoc(doc(mal.db, 'users', mal.uid), { [field]: value }),
      'permission-denied');
  }
  await expectReject('owner cannot smuggle tradeCount alongside a legitimate bio edit',
    updateDoc(doc(mal.db, 'users', mal.uid), { bio: 'hello', tradeCount: 42 }),
    'permission-denied');
  await expectReject('a full setDoc overwrite cannot reset the counters either',
    setDoc(doc(mal.db, 'users', mal.uid), {
      displayName: 'Mal Attacker', bio: '', tradeCount: 77, avgRating: 5,
      reviewCount: 77, restricted: false, openReportCount: 0
    }),
    'permission-denied');
  await expectReject('a stranger cannot write the seller\'s reputation',
    updateDoc(doc(mal.db, 'users', sam.uid), { avgRating: 1, reviewCount: 900 }),
    'permission-denied');
  await expectReject('a stranger cannot restrict someone else',
    updateDoc(doc(mal.db, 'users', vic.uid), { restricted: true }),
    'permission-denied');
  await expectReject('a profile cannot be deleted to wipe a bad history',
    deleteDoc(doc(mal.db, 'users', mal.uid)),
    'permission-denied');

  const samT = await profile(sam);
  check('the seller\'s tradeCount survived the assault untouched',
    samT.tradeCount === 3, `tradeCount=${samT.tradeCount}`);

  /* ------------------------------------------------------------------ 2 */
  step('2. A review needs a COMPLETED trade you were a party to');
  await expectReject('no review on a merely-scheduled trade',
    writeReview(mal, sam.uid, reqMal, 1), 'permission-denied');
  await expectReject('a non-party cannot review off someone else\'s completed trade',
    writeReview(mal, sam.uid, reqAda1, 1), 'permission-denied');
  await expectReject('a non-party cannot review the BUYER off someone else\'s trade',
    writeReview(mal, ada.uid, reqAda1, 1), 'permission-denied');
  await expectReject('no review against a request that does not exist',
    writeReview(mal, sam.uid, 'no-such-request-id', 5), 'permission-denied');
  await expectReject('nobody can review themselves',
    writeReview(ada, ada.uid, reqAda1, 5), 'permission-denied');
  await expectReject('an unauthenticated shape (reviewerId != caller) is refused',
    setDoc(doc(mal.db, 'reviews', `${reqAda1}_${mal.uid}`),
      reviewBody(mal, sam.uid, reqAda1, 5, { reviewerId: ada.uid })),
    'permission-denied');

  /* ------------------------------------------------------------------ 3 */
  step('3. The doc id is what makes a review once-only');
  let ok1 = true;
  await writeReview(ada, sam.uid, reqAda1, 5)
    .catch((e) => { ok1 = false; check('a real buyer can review after completion', false, e.message); });
  if (ok1) check('a real buyer can review after completion', true, '5 stars');

  await expectReject('the same review id cannot be written twice (that is an update)',
    writeReview(ada, sam.uid, reqAda1, 1), 'permission-denied');
  await expectReject('a second review under a DIFFERENT id on the same trade is refused',
    writeReview(ada, sam.uid, reqAda1, 1, { id: `${reqAda1}_${ada.uid}_2` }),
    'permission-denied');
  await expectReject('a review filed under the counterparty\'s id is refused',
    writeReview(ada, sam.uid, reqAda1, 1, { id: `${reqAda1}_${sam.uid}` }),
    'permission-denied');
  await expectReject('a random doc id is refused even with a valid body',
    writeReview(ada, sam.uid, reqAda1, 1, { id: `zzz-${Date.now()}` }),
    'permission-denied');
  await expectReject('an id whose requestId prefix points at another trade is refused',
    writeReview(ada, sam.uid, reqAda1, 1, { id: `${reqAda2}_${ada.uid}` }),
    'permission-denied');

  /* ------------------------------------------------------------------ 4 */
  step('4. rating must be a number in 1..5');
  const badRatings = [
    ['0', 0], ['6', 6], ['-1', -1], ['a string "5"', '5'], ['NaN', NaN],
    ['Infinity', Infinity], ['null', null], ['a boolean', true],
    ['a map', { value: 5 }]
  ];
  for (const [label, value] of badRatings) {
    await expectReject(`rating ${label} is refused`,
      writeReview(ben, sam.uid, reqBen, value), 'permission-denied');
  }
  await expectReject('a review with no rating field at all is refused',
    writeReview(ben, sam.uid, reqBen, null, { dropRating: true }), 'permission-denied');

  /* The rules say `rating is number` and 1..5 — not `is int`. 4.5 is therefore
     accepted BY DESIGN as written; asserted so the behaviour is pinned, and
     noted rather than claimed as a break. */
  let fractional = true;
  await writeReview(ben, sam.uid, reqBen, 4.5)
    .catch((e) => { fractional = false; check('fractional rating 4.5 is accepted (rules say `is number`, not `is int`)', false, e.message); });
  if (fractional) check('fractional rating 4.5 is accepted (rules say `is number`, not `is int`)', true,
    'documented behaviour of firestore.rules:489 — not a break');

  /* ------------------------------------------------------------------ 5 */
  step('5. Reviews are immutable');
  const rid = `${reqAda1}_${ada.uid}`;
  await expectReject('the author cannot edit their own review',
    updateDoc(doc(ada.db, 'reviews', rid), { rating: 1, comment: 'dispute' }),
    'permission-denied');
  await expectReject('the author cannot delete their own review',
    deleteDoc(doc(ada.db, 'reviews', rid)), 'permission-denied');
  await expectReject('the reviewee cannot edit a review of themselves',
    updateDoc(doc(sam.db, 'reviews', rid), { rating: 5 }), 'permission-denied');
  await expectReject('the reviewee cannot delete a bad review',
    deleteDoc(doc(sam.db, 'reviews', rid)), 'permission-denied');
  await expectReject('a stranger cannot delete a review',
    deleteDoc(doc(mal.db, 'reviews', rid)), 'permission-denied');

  /* ------------------------------------------------------------------ 6 */
  step('6. The arithmetic behind the badge');
  async function waitCount(uid, n) {
    return until(`reviewCount ${n} on ${uid}`, async () => {
      const d = await profile(sam, uid);
      return d.reviewCount === n ? d : null;
    }).catch((e) => ({ error: e.message }));
  }
  const after2 = await waitCount(sam.uid, 2);
  check('avgRating is the true mean over two reviews from two reviewers',
    after2 && !after2.error && after2.avgRating === 4.75 && after2.reviewCount === 2,
    after2 && after2.error ? after2.error
      : `avgRating=${after2.avgRating} (expected 4.75 from 5 and 4.5) reviewCount=${after2.reviewCount}`);

  /* Reviewing the same person again from a DIFFERENT completed trade is
     legitimate — two trades, two experiences. */
  let second = true;
  await writeReview(ada, sam.uid, reqAda2, 1)
    .catch((e) => { second = false; check('the same buyer may review the same seller again from a second completed trade', false, e.message); });
  if (second) check('the same buyer may review the same seller again from a second completed trade', true);

  const after3 = await waitCount(sam.uid, 3);
  const expected3 = Math.round(((5 + 4.5 + 1) / 3) * 100) / 100;
  check('the average moves correctly after the third review',
    after3 && !after3.error && after3.avgRating === expected3 && after3.reviewCount === 3,
    after3 && after3.error ? after3.error
      : `avgRating=${after3.avgRating} (expected ${expected3}) reviewCount=${after3.reviewCount}`);

  /* Ground truth from the collection itself, not from the profile. */
  const snap = await getDocs(query(collection(sam.db, 'reviews'),
    where('revieweeId', '==', sam.uid)));
  const ratings = snap.docs.map((d) => Number(d.data().rating));
  const trueAvg = Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100;
  const live = await profile(sam);
  check('profile counters match the reviews collection exactly',
    live.reviewCount === ratings.length && live.avgRating === trueAvg,
    `profile=${live.avgRating}/${live.reviewCount} collection=${trueAvg}/${ratings.length} [${ratings.join(',')}]`);

  check('tradeCount matches the number of completed trades for every party',
    live.tradeCount === 3 && (await profile(ada)).tradeCount === 2
      && (await profile(ben)).tradeCount === 1 && (await profile(mal)).tradeCount === 0,
    `sam=${live.tradeCount} ada=${(await profile(ada)).tradeCount} ben=${(await profile(ben)).tradeCount} mal=${(await profile(mal)).tradeCount}`);

  /* ------------------------------------------------------------------ 7 */
  step('7. Does a completed trade license a review of an UNRELATED person?');
  /* Ada really did complete a trade with Sam — so she satisfies "participant in
     a completed trade". But she points revieweeId at Vic, who was nowhere near
     it. The create rule checks the caller is a party to the request; it never
     checks the REVIEWEE is the counterparty. */
  const vicBefore = await profile(vic);
  let drive = false;
  /* Both of Ada's earlier review slots are spent, so mint a third completed
     trade to give her a fresh, legitimately-earned {requestId}_{reviewerId}. */
  const C = await createListing(sam, 'Shelf cleanout C', [{ name: 'Ark Nova', askingPrice: 60 }]);
  /* Not harness completeTrade(): Mal is still sitting on the earliest bookable
     slot with a scheduled trade, so this one has to claim a later one. */
  const reqAda3 = await (async () => {
    const r = await ada.call('createRequest',
      { listingId: C.listingId, gameEntryId: C.entryIds[0] })
      .catch((e) => { throw new Error(`createRequest(C): ${e.code} ${e.message}`); });
    const s = nextSlot(undefined, 3 * 24 * 3600000);
    await ada.call('bookSlot', { requestId: r.requestId, date: s.date, startTime: s.startTime })
      .catch((e) => { throw new Error(`bookSlot(${s.date} ${s.startTime}): ${e.code} ${e.message}`); });
    await acceptProposal(sam, r.requestId);
    await ada.call('confirmSold', { requestId: r.requestId });
    await sam.call('confirmSold', { requestId: r.requestId });
    await until('third Ada trade to complete', async () => {
      const d = await getDoc(doc(sam.db, 'requests', r.requestId));
      return d.data().status === 'completed' ? d : null;
    });
    return r.requestId;
  })();
  try {
    await writeReview(ada, vic.uid, reqAda3, 1, { extra: { comment: 'drive-by' } });
    drive = true;
  } catch (e) { /* refused — the invariant holds */ }

  if (drive) {
    const vicAfter = await until('vic reputation to move', async () => {
      const d = await profile(vic);
      return d.reviewCount > (vicBefore.reviewCount || 0) ? d : null;
    }).catch((e) => ({ error: e.message }));
    check('a completed trade does NOT license reviewing an unrelated third party',
      false,
      `review of ${vic.displayName} (who was never in request ${reqAda3}) was ACCEPTED; `
      + `vic now reviewCount=${vicAfter && vicAfter.reviewCount} avgRating=${vicAfter && vicAfter.avgRating}`);
    finding('reviews create rule (firestore.rules:485-495) never checks revieweeId is the '
      + 'counterparty of the request — any party to any completed trade can post an '
      + 'unlimited-in-aggregate stream of 1-star reviews at arbitrary strangers, one per '
      + 'completed trade, and onReviewCreate folds them into the victim\'s avgRating.');
  } else {
    check('a completed trade does NOT license reviewing an unrelated third party', true);
  }

  /* Sam's own counters must not have been disturbed by section 7. */
  const samFinal = await profile(sam);
  check('the seller\'s counters are unchanged by the third-party probe',
    samFinal.reviewCount === 3, `reviewCount=${samFinal.reviewCount}`);

  /* ------------------------------------------------------------------ 8 */
  step('8. An EARNED restriction cannot be scrubbed by its owner');
  /* The interesting direction: not "can I set restricted: true on myself" but
     "can I clear the flag five reports just put there". Five distinct reporters
     trip USER_RESTRICT_AT in onReportCreate (functions/index.js:595). */
  const eve = await makeUser('rep-eve', 'Eve Reporter');
  users.eve = eve;
  for (const r of [sam, ada, ben, vic, eve]) {
    await setDoc(doc(r.db, 'reports', `${r.uid}_user_${mal.uid}`), {
      reporterId: r.uid, targetType: 'user', targetId: mal.uid,
      reason: 'scam', status: 'open', createdAt: serverTimestamp()
    });
  }
  const restricted = await until('mal to be restricted by the circuit breaker', async () => {
    const d = await profile(sam, mal.uid);
    return d.restricted === true ? d : null;
  }).catch((e) => ({ error: e.message }));
  check('five reports restrict the account (function-written)',
    restricted && !restricted.error,
    restricted && restricted.error ? restricted.error
      : `openReportCount=${restricted.openReportCount} restricted=${restricted.restricted}`);

  await expectReject('the restricted user cannot clear their own restricted flag',
    updateDoc(doc(mal.db, 'users', mal.uid), { restricted: false }),
    'permission-denied');
  await expectReject('the restricted user cannot zero their own openReportCount',
    updateDoc(doc(mal.db, 'users', mal.uid), { openReportCount: 0 }),
    'permission-denied');
  await expectReject('the reported user cannot delete the reports against them',
    deleteDoc(doc(mal.db, 'reports', `${sam.uid}_user_${mal.uid}`)),
    'permission-denied');
  const still = await profile(sam, mal.uid);
  check('the restriction and its count survived',
    still.restricted === true && still.openReportCount === 5,
    `restricted=${still.restricted} openReportCount=${still.openReportCount}`);

  if (findings.length) {
    console.log('\n\x1b[33mFindings:\x1b[0m');
    findings.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }
  const failed = await summarize(Object.values(users));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\n\x1b[31mSuite aborted:\x1b[0m', err);
  process.exit(2);
});
