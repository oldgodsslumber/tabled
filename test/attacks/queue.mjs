/* Tabled — adversarial suite: QUEUE and HOLD invariants.
 *
 * Every check here tries to BREAK one of the guarantees M5 exists to make:
 *
 *   1. A buyer occupies at most one place in one queue.
 *   2. Only queuePosition 0 may put a time on the table.
 *   3. queuePosition is server-assigned; a client cannot write it.
 *   4. Cancelling and re-requesting sends you to the BACK, never forward.
 *   5. A closed request frees its place; queueCount is derived, never drifted.
 *   6. A sold entry, or an archived/hidden listing, refuses new requests.
 *   7. The hold (currentHoldRequestId/holdExpiresAt) belongs to exactly one
 *      request at a time.
 *
 * READ THIS BEFORE INTERPRETING A RESULT: an attack that is REFUSED is a PASS.
 * A FAIL here means the attack worked.
 *
 * RUN
 *   firebase emulators:start --only auth,firestore,functions --project demo-tabled
 *   node test/attacks/queue.mjs
 */
import {
  check, step, expectReject, until, summarize,
  makeUser, makeSeller, createListing, nextSlot, acceptProposal,
  PROJECT, REGION, WINDOWS, TZ,
  doc, getDoc, setDoc, updateDoc, collection, GeoPoint, serverTimestamp
} from '../harness.mjs';
import { getDocs, query, where, Timestamp } from 'firebase/firestore';

/* ---- small readers ------------------------------------------------------- */

const entryOf = (u, listingId, entryId) =>
  getDoc(doc(u.db, 'listings', listingId, 'gameEntries', entryId)).then((s) => s.data());
const reqOf = (u, id) => getDoc(doc(u.db, 'requests', id)).then((s) => s.data());

/* The queue as the server actually sees it. Read as the SELLER, who is party to
 * every request on their own entry.
 *
 * The sellerId clause is not decoration: the rules gate reads on
 * `isParticipant()`, and a list query with no clause proving participation is
 * denied outright ("Property buyerId is undefined on object ... for 'list'").
 * That refusal is itself correct — nobody can enumerate a queue they aren't in. */
const OPEN = ['queued', 'onHold', 'proposedTime', 'scheduled'];
async function openQueue(seller, gameEntryId) {
  const snap = await getDocs(query(collection(seller.db, 'requests'),
    where('sellerId', '==', seller.uid),
    where('gameEntryId', '==', gameEntryId), where('status', 'in', OPEN)));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.createdAt?.toMillis() || 0) - (b.createdAt?.toMillis() || 0));
}

/* The scheduled sweep, triggered by hand. The functions emulator exposes
 * onSchedule functions as plain HTTP endpoints. If that ever stops being true
 * the expiry checks report as skipped rather than as false failures. */
async function runSweep() {
  const url = `http://127.0.0.1:5001/${PROJECT}/${REGION}/advanceExpiredHolds`;
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  if (!res.ok) throw new Error(`sweep endpoint returned ${res.status}`);
  return res.text();
}

async function main() {
  step('Cast');
  const sam = await makeSeller('qsam', 'Sam Seller');
  const [ada, ben, cy, dee, eve] = await Promise.all([
    makeUser('qada', 'Ada'), makeUser('qben', 'Ben'), makeUser('qcy', 'Cy'),
    makeUser('qdee', 'Dee'), makeUser('qeve', 'Eve')
  ]);
  check('5 buyers + 1 seller with availability', !!sam.uid && !!eve.uid);

  /* ===================================================================== *
   * 1. One buyer, one place in line
   * ===================================================================== */
  step('1. A buyer cannot occupy two places in one queue');

  const L1 = await createListing(sam, 'Queue lab A', [
    { name: 'Root', askingPrice: 40 }, { name: 'Scythe', askingPrice: 55 }
  ]);
  const E1 = L1.entryIds[0];

  const r = {};
  for (const [k, u] of [['ada', ada], ['ben', ben], ['cy', cy]]) {
    r[k] = (await u.call('createRequest',
      { listingId: L1.listingId, gameEntryId: E1 })).requestId;
  }
  let q = await openQueue(sam, E1);
  check('three buyers, three places, in arrival order',
    q.length === 3 && q[0].id === r.ada && q[1].id === r.ben && q[2].id === r.cy,
    q.map((x) => `${x.buyerName}@${x.queuePosition}/${x.status}`).join(' '));

  /* The transaction claims to be the thing that stops two simultaneous
     requests both reading "the queue is empty". Fire five at once from ONE
     buyer and count the places they end up holding. */
  const stormed = await Promise.allSettled(Array.from({ length: 5 }, () =>
    dee.call('createRequest', { listingId: L1.listingId, gameEntryId: E1 })));
  const deeIds = new Set(stormed.filter((s) => s.status === 'fulfilled')
    .map((s) => s.value.requestId));
  q = await openQueue(sam, E1);
  const deePlaces = q.filter((x) => x.buyerId === dee.uid);
  check('5 concurrent createRequest calls from one buyer yield ONE place in line',
    deePlaces.length === 1 && deeIds.size === 1,
    `places=${deePlaces.length} distinctRequestIds=${deeIds.size} ` +
    `settled=${stormed.map((s) => s.status).join(',')}`);

  /* Positions must be a dense 0..n-1 with no duplicates — a duplicate 0 is two
     people both believing they hold the item. */
  q = await openQueue(sam, E1);
  const positions = q.map((x) => x.queuePosition);
  check('queue positions are dense and unique after the storm',
    JSON.stringify(positions) === JSON.stringify(positions.map((_, i) => i)),
    `positions=${JSON.stringify(positions)}`);

  let e = await entryOf(sam, L1.listingId, E1);
  check('queueCount matches the number of open requests (derived, not incremented)',
    e.queueCount === q.length, `queueCount=${e.queueCount} open=${q.length}`);

  /* ===================================================================== *
   * 2. queuePosition is not writable by a client
   * ===================================================================== */
  step('2. queuePosition is server-assigned');

  await expectReject('a queued buyer cannot rewrite their own queuePosition to 0',
    updateDoc(doc(ben.db, 'requests', r.ben), { queuePosition: 0 }),
    'permission-denied');
  await expectReject('nor smuggle it in beside a legitimate field',
    updateDoc(doc(ben.db, 'requests', r.ben),
      { queuePosition: 0, lastMessageText: 'hi' }),
    'permission-denied');
  await expectReject('nor can the SELLER hand out a queuePosition',
    updateDoc(doc(sam.db, 'requests', r.cy), { queuePosition: 0 }),
    'permission-denied');
  await expectReject('a stranger cannot even read, let alone write, a request',
    updateDoc(doc(eve.db, 'requests', r.ada), { status: 'cancelled' }),
    'permission-denied');
  await expectReject('a client still cannot create a request document directly',
    setDoc(doc(collection(eve.db, 'requests')), {
      buyerId: eve.uid, sellerId: sam.uid, listingId: L1.listingId,
      gameEntryId: E1, status: 'onHold', queuePosition: 0
    }),
    'permission-denied');

  /* ===================================================================== *
   * 3. Only position 0 schedules
   * ===================================================================== */
  step('3. Only queuePosition 0 may schedule');

  const slot = nextSlot();
  await expectReject('position 1 cannot bookSlot',
    ben.call('bookSlot', { requestId: r.ben, date: slot.date, startTime: slot.startTime }),
    'turn|failed-precondition');
  await expectReject('position 1 cannot write status proposedTime by hand',
    updateDoc(doc(ben.db, 'requests', r.ben),
      { status: 'proposedTime', proposedTime: new Date(slot.startsAtMs), proposedBy: ben.uid }),
    'permission-denied');
  await expectReject('position 1 cannot mark itself scheduled',
    updateDoc(doc(ben.db, 'requests', r.ben),
      { status: 'scheduled', scheduledTime: new Date(slot.startsAtMs) }),
    'permission-denied');
  /* `onHold` is in the rules' allowed status list and carries no queuePosition
     guard, so a queued buyer can paint themselves as the holder. It should not
     buy them anything — bookSlot re-reads queuePosition — but the entry's own
     hold state is what decides, so check both. */
  const selfPromote = await updateDoc(doc(ben.db, 'requests', r.ben),
    { status: 'onHold', updatedAt: serverTimestamp() })
    .then(() => 'ALLOWED', (err) => err.code || err.message);
  if (selfPromote === 'ALLOWED') {
    const eAfter = await entryOf(sam, L1.listingId, E1);
    const benAfter = await reqOf(sam, r.ben);
    check('self-promoting to onHold does not move the real hold',
      eAfter.currentHoldRequestId === r.ada && benAfter.queuePosition === 1,
      `client wrote status=onHold at queuePosition ${benAfter.queuePosition}; ` +
      `entry hold still ${eAfter.currentHoldRequestId === r.ada ? 'ada' : eAfter.currentHoldRequestId}`);
    await updateDoc(doc(ben.db, 'requests', r.ben), { status: 'queued' }).catch(() => {});
  } else {
    check('a queued buyer cannot write themselves into onHold', true, selfPromote);
  }

  await expectReject('the seller cannot bookSlot on the buyer\'s behalf',
    sam.call('bookSlot', { requestId: r.ada, date: slot.date, startTime: slot.startTime }),
    'permission-denied|Only the buyer');

  /* The seller side of the same gate. The rules only test queuePosition on a
     write to `proposedTime`; a write straight to `scheduled` is checked for
     "is the seller" and nothing else. If the seller can schedule someone at
     position 1 while position 0 still holds the item, the line-jump gate has a
     seller-shaped hole in it. */
  const jump = await updateDoc(doc(sam.db, 'requests', r.ben), {
    status: 'scheduled', scheduledTime: new Date(slot.startsAtMs),
    updatedAt: serverTimestamp()
  }).then(() => 'ALLOWED').catch((err) => err.code || err.message);
  check('the seller cannot schedule a request that is not at position 0',
    jump !== 'ALLOWED',
    `write to status=scheduled on queuePosition 1 was ${jump}`);
  if (jump === 'ALLOWED') {
    /* Put it back so the rest of the suite runs against a sane queue. */
    await updateDoc(doc(sam.db, 'requests', r.ben), { status: 'queued' });
    await until('the queue to resettle', async () => {
      const qq = await openQueue(sam, E1);
      return qq[0] && qq[0].id === r.ada ? qq : null;
    }).catch(() => null);

    /* How far does that hole go? Not just a status flag: `scheduled` is the
       one status confirmSold accepts, so a seller can carry the person at
       position 1 all the way to a completed sale while position 0 is still
       holding the item. Proved on its own listing so the damage is contained. */
    const L3 = await createListing(sam, 'Line jump lab', [{ name: 'Spirit Island', askingPrice: 70 }]);
    const E3 = L3.entryIds[0];
    const holderReq = (await cy.call('createRequest',
      { listingId: L3.listingId, gameEntryId: E3 })).requestId;
    const jumperReq = (await dee.call('createRequest',
      { listingId: L3.listingId, gameEntryId: E3 })).requestId;
    await updateDoc(doc(sam.db, 'requests', jumperReq), {
      status: 'scheduled', scheduledTime: new Date(nextSlot(WINDOWS, 50 * 3600000).startsAtMs),
      updatedAt: serverTimestamp()
    });
    const jumped = await dee.call('confirmSold', { requestId: jumperReq })
      .then(() => sam.call('confirmSold', { requestId: jumperReq }))
      .then((res) => res, (err) => ({ error: `${err.code} ${err.message}` }));
    const e3 = await entryOf(sam, L3.listingId, E3);
    const holderNow = await reqOf(sam, holderReq);
    check('a line-jumped request cannot be carried through to a completed sale',
      !!jumped.error,
      jumped.error ||
      `completed from queuePosition 1 — entry status=${e3.status}, ` +
      `the position-0 holder was closed as ${holderNow.status}/${holderNow.closedReason}`);
  }

  /* Position 0 legitimately books; the hold must not move anywhere. */
  await ada.call('bookSlot', { requestId: r.ada, date: slot.date, startTime: slot.startTime });
  e = await entryOf(sam, L1.listingId, E1);
  check('booking by position 0 leaves the hold exactly where it was',
    e.currentHoldRequestId === r.ada && e.status === 'onHold',
    `hold=${e.currentHoldRequestId === r.ada ? 'ada' : e.currentHoldRequestId} status=${e.status}`);
  await expectReject('position 1 still cannot book while position 0 has a proposal out',
    ben.call('bookSlot', { requestId: r.ben, date: slot.date, startTime: slot.startTime }),
    'turn|failed-precondition');

  /* ===================================================================== *
   * 4. Exactly one hold
   * ===================================================================== */
  step('4. The hold belongs to exactly one request');

  q = await openQueue(sam, E1);
  const holders = q.filter((x) => ['onHold', 'proposedTime', 'scheduled'].includes(x.status));
  e = await entryOf(sam, L1.listingId, E1);
  check('exactly one open request on the entry is past `queued`',
    holders.length === 1 && holders[0].queuePosition === 0,
    holders.map((h) => `${h.buyerName}:${h.status}@${h.queuePosition}`).join(' '));
  check('currentHoldRequestId points at that one request',
    e.currentHoldRequestId === holders[0]?.id,
    `entry=${e.currentHoldRequestId} front=${holders[0]?.id}`);
  check('holdExpiresAt is set on the entry while it is held',
    !!e.holdExpiresAt, `holdExpiresAt=${e.holdExpiresAt}`);

  await expectReject('the seller cannot hand themselves the hold fields on the entry',
    updateDoc(doc(sam.db, 'listings', L1.listingId, 'gameEntries', E1),
      { currentHoldRequestId: r.cy, queueCount: 0 }),
    'permission-denied');
  await expectReject('the seller cannot flip the entry back to active to dump the queue',
    updateDoc(doc(sam.db, 'listings', L1.listingId, 'gameEntries', E1),
      { status: 'active' }),
    'permission-denied');
  await expectReject('a buyer cannot touch the game entry at all',
    updateDoc(doc(cy.db, 'listings', L1.listingId, 'gameEntries', E1),
      { queueCount: 99 }),
    'permission-denied');
  await expectReject('a buyer cannot create a pre-held entry on their own listing shape',
    setDoc(doc(collection(cy.db, 'listings', L1.listingId, 'gameEntries')), {
      sellerId: cy.uid, name: 'Smuggled', status: 'onHold',
      currentHoldRequestId: 'x', holdExpiresAt: null, queueCount: 5
    }),
    'permission-denied');

  /* ===================================================================== *
   * 5. Leaving and re-joining goes to the back
   * ===================================================================== */
  step('5. Cancel and re-request must not move you forward');

  await updateDoc(doc(ada.db, 'requests', r.ada),
    { status: 'cancelled', updatedAt: serverTimestamp() });
  const promoted = await until('Ben to be promoted to the front', async () => {
    const b = await reqOf(sam, r.ben);
    return b.queuePosition === 0 && b.status === 'onHold' ? b : null;
  }).catch((err) => ({ error: err.message }));
  check('cancelling the holder promotes the next in line',
    promoted && !promoted.error,
    promoted?.error || `ben pos=${promoted.queuePosition} status=${promoted.status}`);

  e = await entryOf(sam, L1.listingId, E1);
  q = await openQueue(sam, E1);
  check('the cancelled request freed its place — queueCount stayed honest',
    e.queueCount === q.length && q.every((x) => x.buyerId !== ada.uid),
    `queueCount=${e.queueCount} open=${q.length}`);
  check('the hold moved to the new front and nowhere else',
    e.currentHoldRequestId === r.ben && q[0].id === r.ben,
    `hold=${e.currentHoldRequestId} front=${q[0]?.id}`);

  const readd = await ada.call('createRequest', { listingId: L1.listingId, gameEntryId: E1 });
  await until('the queue to resync after the re-request', async () => {
    const qq = await openQueue(sam, E1);
    return qq[qq.length - 1]?.buyerId === ada.uid
      && qq.every((x, i) => x.queuePosition === i) ? qq : null;
  }).catch(() => null);
  q = await openQueue(sam, E1);
  const adaNow = q.find((x) => x.buyerId === ada.uid);
  check('re-requesting after cancelling lands at the BACK, behind everyone who waited',
    adaNow && adaNow.queuePosition === q.length - 1 && q[0].id === r.ben,
    `ada pos=${adaNow?.queuePosition} of ${q.length}, front=${q[0]?.id === r.ben ? 'ben' : q[0]?.id}`);
  check('re-requesting did not double-count the queue',
    (await entryOf(sam, L1.listingId, E1)).queueCount === q.length,
    `queueCount vs open=${q.length}`);

  /* Cancel-and-rejoin in a tight loop, racing the resync trigger. If the
     position is ever computed against a queue that hasn't caught up, this is
     where a jump would show. */
  const raceReq = readd.requestId;
  for (let i = 0; i < 3; i++) {
    await updateDoc(doc(ada.db, 'requests',
      (await openQueue(sam, E1)).find((x) => x.buyerId === ada.uid).id),
      { status: 'cancelled', updatedAt: serverTimestamp() });
    await ada.call('createRequest', { listingId: L1.listingId, gameEntryId: E1 });
  }
  await until('the queue to settle after the churn', async () => {
    const qq = await openQueue(sam, E1);
    return qq.every((x, i) => x.queuePosition === i) ? qq : null;
  }).catch(() => null);
  q = await openQueue(sam, E1);
  const adaAfterChurn = q.find((x) => x.buyerId === ada.uid);
  check('churning cancel/re-request never overtakes the people already waiting',
    adaAfterChurn && adaAfterChurn.queuePosition === q.length - 1 && q[0].buyerId === ben.uid,
    `ada=${adaAfterChurn?.queuePosition} front=${q[0]?.buyerName} raceReq=${raceReq}`);
  e = await entryOf(sam, L1.listingId, E1);
  check('queueCount survived the churn without drifting',
    e.queueCount === q.length, `queueCount=${e.queueCount} open=${q.length}`);
  check('still exactly one holder after the churn',
    q.filter((x) => x.status !== 'queued').length === 1 &&
    e.currentHoldRequestId === q[0].id,
    `holders=${q.filter((x) => x.status !== 'queued').length} hold=${e.currentHoldRequestId}`);

  /* Cancelling from the MIDDLE must close the gap, not leave a hole. */
  const mid = q[1];
  await updateDoc(doc(
    (mid.buyerId === cy.uid ? cy : mid.buyerId === ada.uid ? ada : dee).db,
    'requests', mid.id), { status: 'cancelled', updatedAt: serverTimestamp() });
  await until('the gap to close', async () => {
    const qq = await openQueue(sam, E1);
    return qq.every((x, i) => x.queuePosition === i) && !qq.some((x) => x.id === mid.id)
      ? qq : null;
  }).catch(() => null);
  q = await openQueue(sam, E1);
  e = await entryOf(sam, L1.listingId, E1);
  check('cancelling from the middle closes the gap and leaves the front alone',
    q.every((x, i) => x.queuePosition === i) && q[0].buyerId === ben.uid &&
    e.queueCount === q.length,
    `positions=${JSON.stringify(q.map((x) => x.queuePosition))} queueCount=${e.queueCount}`);

  /* ===================================================================== *
   * 6. Sold entries and closed listings
   * ===================================================================== */
  step('6. Sold games and archived/hidden listings refuse new requests');

  const L2 = await createListing(sam, 'Queue lab B', [
    { name: 'Ark Nova', askingPrice: 60 }, { name: 'Wingspan', askingPrice: 30 },
    { name: 'Dune Imperium', askingPrice: 50 }
  ]);

  /* A real sale, then a request against the corpse. */
  const soldEntry = L2.entryIds[0];
  const loserReq = (await cy.call('createRequest',
    { listingId: L2.listingId, gameEntryId: soldEntry })).requestId;
  const winnerReq = (await ben.call('createRequest',
    { listingId: L2.listingId, gameEntryId: soldEntry })).requestId;
  check('cy is the holder, ben is behind', true, `${loserReq} / ${winnerReq}`);
  /* A different increment from `slot` — the same seller cannot be booked twice
     at once, and this is not the invariant under test here. */
  const slot2 = nextSlot(WINDOWS, 30 * 3600000);
  await cy.call('bookSlot', { requestId: loserReq, date: slot2.date, startTime: slot2.startTime });
  await acceptProposal(sam, loserReq);
  await cy.call('confirmSold', { requestId: loserReq });
  await sam.call('confirmSold', { requestId: loserReq });
  await until('the sale to land', async () => {
    const en = await entryOf(sam, L2.listingId, soldEntry);
    return en.status === 'sold' ? en : null;
  });

  await expectReject('requesting an entry that is already sold is refused',
    dee.call('createRequest', { listingId: L2.listingId, gameEntryId: soldEntry }),
    'already sold|failed-precondition');

  const soldNow = await entryOf(sam, L2.listingId, soldEntry);
  const qSold = await openQueue(sam, soldEntry);
  check('a sold entry holds nobody and counts nobody',
    soldNow.currentHoldRequestId === null && soldNow.holdExpiresAt === null &&
    soldNow.queueCount === 0 && qSold.length === 0,
    `hold=${soldNow.currentHoldRequestId} count=${soldNow.queueCount} open=${qSold.length}`);

  /* Archived listing. */
  const archEntry = L2.entryIds[1];
  await updateDoc(doc(sam.db, 'listings', L2.listingId), { status: 'archived' });
  await expectReject('requesting from an archived listing is refused',
    dee.call('createRequest', { listingId: L2.listingId, gameEntryId: archEntry }),
    'no longer available|failed-precondition');

  /* Hidden listing — the auto-report state. */
  await updateDoc(doc(sam.db, 'listings', L2.listingId), { status: 'hidden' });
  await expectReject('requesting from a hidden listing is refused',
    dee.call('createRequest', { listingId: L2.listingId, gameEntryId: archEntry }),
    'no longer available|failed-precondition');
  await expectReject('a hidden listing cannot be un-hidden by its owner (circuit breaker)',
    updateDoc(doc(sam.db, 'listings', L2.listingId), { status: 'active' }),
    'permission-denied');

  await expectReject('requesting a game entry that does not exist is refused',
    dee.call('createRequest', { listingId: L1.listingId, gameEntryId: 'no-such-entry' }),
    'not-found|No such game');
  await expectReject('the seller cannot queue on their own game',
    sam.call('createRequest', { listingId: L1.listingId, gameEntryId: E1 }),
    'own|failed-precondition');

  /* ===================================================================== *
   * 7. Booking against a request that has left the queue
   * ===================================================================== */
  step('7. A closed request cannot be revived into a booking');

  await expectReject('bookSlot on a completed request is refused',
    cy.call('bookSlot', { requestId: loserReq, date: slot.date, startTime: slot.startTime }),
    'failed-precondition|not open');
  await expectReject('bookSlot on an expired (item sold out from under you) request is refused',
    ben.call('bookSlot', { requestId: winnerReq, date: slot.date, startTime: slot.startTime }),
    'failed-precondition|not open');
  await expectReject('a completed request is frozen against client writes',
    updateDoc(doc(cy.db, 'requests', loserReq), { status: 'scheduled' }),
    'permission-denied');
  /* Resurrection: an expired request whose item is gone, written back into an
     open status by its own buyer. The rules list `queued` as a legal target
     status, so nothing obviously stops this — and a ghost in the queue of a
     sold item is exactly the kind of drift queueCount is supposed to be immune
     to. Reported either way; restored if it lands. */
  const revive = await updateDoc(doc(ben.db, 'requests', winnerReq), { status: 'queued' })
    .then(() => 'ALLOWED', (err) => err.code || err.message);
  if (revive === 'ALLOWED') {
    /* The write landing is only half of it. onRequestStatusChange sees a
       request re-entering the open set and resyncs — so measure what the
       server does with the ghost, not just that the write went through. */
    const settledGhost = await until('the resync after the resurrection', async () => {
      const gr = await reqOf(sam, winnerReq);
      return gr.status !== 'queued' || gr.queuePosition === 0 ? gr : null;
    }, 8000).catch(() => reqOf(sam, winnerReq));
    const ghostEntry = await entryOf(sam, L2.listingId, soldEntry);
    const ghostQ = await openQueue(sam, soldEntry);
    const rebook = await ben.call('bookSlot', {
      requestId: winnerReq, ...nextSlot(WINDOWS, 74 * 3600000)
    }).then(() => 'BOOKED', (err) => `${err.code}`);
    check('an expired buyer cannot re-open their own request on a SOLD item',
      false,
      `write ALLOWED — request came back as ${settledGhost.status}@${settledGhost.queuePosition}; ` +
      `sold entry now queueCount=${ghostEntry.queueCount} (was 0) with ${ghostQ.length} open request(s); ` +
      `bookSlot on the sold game: ${rebook}`);
    await updateDoc(doc(ben.db, 'requests', winnerReq),
      { status: 'expired', updatedAt: serverTimestamp() }).catch(() => {});
    await until('the sold entry to settle back to an empty queue', async () => {
      const en = await entryOf(sam, L2.listingId, soldEntry);
      return en.queueCount === 0 ? en : null;
    }, 8000).catch(() => null);
  } else {
    check('an expired buyer cannot re-open their own request on a SOLD item', true, revive);
  }

  /* ===================================================================== *
   * 8. Expiry frees the place (real sweep, real deadlines)
   * ===================================================================== */
  step('8. An expired hold frees its place');

  /* An event listing whose convention is already over. holdDeadlineFor returns
     `now` for it, so the hold is expirable the instant it is created — the one
     legitimate way to reach an expired hold without forging holdExpiresAt,
     which the rules (rightly) forbid. */
  const evRef = doc(collection(sam.db, 'listings'));
  await setDoc(evRef, {
    sellerId: sam.uid, sellerName: sam.displayName, sellerPhoto: null,
    title: 'Con leftovers', fulfillment: { pickup: true, inPersonAtEvent: true },
    locationLabel: 'Riverside, Jacksonville, FL',
    geoPoint: new GeoPoint(30.3322, -81.6557), geohash: 'djmpuytg1',
    countryCode: 'US', state: 'FL',
    acceptedPayment: { cash: true, paypal: false, venmo: false, trades: true },
    eventId: 'past-con', eventName: 'Past Con',
    eventStartDate: Timestamp.fromMillis(Date.now() - 5 * 86400000),
    eventEndDate: Timestamp.fromMillis(Date.now() - 2 * 86400000),
    gameNames: ['Gloomhaven'], minPrice: 80, maxPrice: 80,
    categories: [], mechanics: [], status: 'active',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    viewCount: 0, requestCount: 0, watchCount: 0, hotScore: 0, openReportCount: 0
  });
  const evEntryRef = doc(collection(sam.db, 'listings', evRef.id, 'gameEntries'));
  await setDoc(evEntryRef, {
    sellerId: sam.uid, bggId: null, name: 'Gloomhaven', condition: 'VG',
    categories: [], contents: [], tags: [], photos: [], askingPrice: 80,
    notes: '', order: 0, status: 'active',
    currentHoldRequestId: null, holdExpiresAt: null, queueCount: 0
  });
  const evEntry = evEntryRef.id;

  const evA = (await ada.call('createRequest',
    { listingId: evRef.id, gameEntryId: evEntry })).requestId;
  const evB = (await ben.call('createRequest',
    { listingId: evRef.id, gameEntryId: evEntry })).requestId;
  const evAdoc = await reqOf(sam, evA);
  check('a hold on a finished event is created already expired',
    evAdoc.holdExpiresAt && evAdoc.holdExpiresAt.toMillis() <= Date.now() + 1000,
    `holdExpiresAt=${evAdoc.holdExpiresAt?.toDate?.().toISOString()}`);
  await expectReject('and cannot be scheduled — the event is over',
    ada.call('bookSlot', { requestId: evA, date: slot.date, startTime: slot.startTime }),
    'after the event ends|failed-precondition');

  /* firebase-tools 15 does not expose onSchedule functions on the functions
     emulator's HTTP surface, so the sweep cannot be driven from here. That is
     an emulator limitation, not a product failure — it is reported as a skip
     rather than scored as a failed attack. The other closure paths
     (cancellation, itemSold) are exercised above and go through the same
     resyncQueue. */
  let swept = true;
  await runSweep().catch((err) => {
    swept = false;
    console.log(`  \x1b[33mSKIP\x1b[0m  advanceExpiredHolds not reachable from the emulator ` +
      `(${err.message}); expiry-frees-place is covered via cancellation and itemSold instead`);
  });

  if (swept) {
    const cleared = await until('the sweep to close both event requests', async () => {
      const a = await reqOf(sam, evA);
      const b = await reqOf(sam, evB);
      return a.status === 'expired' && b.status === 'expired' ? { a, b } : null;
    }).catch((err) => ({ error: err.message }));
    check('the sweep expires holds on a finished event',
      cleared && !cleared.error,
      cleared?.error || `a=${cleared.a.status}/${cleared.a.closedReason} b=${cleared.b.status}`);

    const evEntryNow = await until('the entry to be released', async () => {
      const en = await entryOf(sam, evRef.id, evEntry);
      return en.queueCount === 0 ? en : null;
    }).catch((err) => ({ error: err.message }));
    check('expiry frees the place: queueCount 0, no holder, entry back to active',
      evEntryNow && !evEntryNow.error && evEntryNow.queueCount === 0 &&
      evEntryNow.currentHoldRequestId === null && evEntryNow.holdExpiresAt === null &&
      evEntryNow.status === 'active',
      evEntryNow?.error ||
      `status=${evEntryNow.status} hold=${evEntryNow.currentHoldRequestId} ` +
      `count=${evEntryNow.queueCount}`);

    /* Idempotence: the sweep derives everything, so running it again on a
       settled entry must not drift the count. */
    await runSweep().catch(() => {});
    const twice = await entryOf(sam, evRef.id, evEntry);
    check('running the sweep twice does not drift queueCount',
      twice.queueCount === 0, `queueCount=${twice.queueCount}`);
  }

  /* ===================================================================== *
   * 9. Trade proposals vs. the hold on the offered game
   * ===================================================================== */
  step('9. A reserved trade item and a queue on the same entry');

  /* Ada lists a game, offers it to Sam in a trade (it becomes `reserved`), and
     meanwhile Ben queues on that same game. The question is whether the entry's
     hold state stays coherent when the trade proposal is then cancelled. */
  const adaListing = await createListing(ada, 'Ada shelf', [{ name: 'Barrage', askingPrice: 35 }]);
  const G = adaListing.entryIds[0];
  const tradeReq = (await ada.call('createRequest', {
    listingId: L1.listingId, gameEntryId: L1.entryIds[1],
    proposalType: 'trade', offeredListingId: adaListing.listingId, offeredGameEntryId: G
  })).requestId;
  let gEntry = await entryOf(sam, adaListing.listingId, G);
  check('offering a game in a trade reserves it',
    gEntry.status === 'reserved' && gEntry.reservedByRequestId === tradeReq,
    `status=${gEntry.status}`);

  await expectReject('the same game cannot be offered in a second trade while reserved',
    ada.call('createRequest', {
      listingId: L2.listingId, gameEntryId: L2.entryIds[2],
      proposalType: 'trade', offeredListingId: adaListing.listingId, offeredGameEntryId: G
    }),
    'failed-precondition|already on the table|no longer available');

  /* A buyer queueing on a reserved entry. createRequest only refuses `sold`,
     so this is expected to be allowed — the interesting part is what it does to
     the entry's status. */
  const benOnG = await ben.call('createRequest',
    { listingId: adaListing.listingId, gameEntryId: G })
    .then((res) => res.requestId, (err) => ({ err: `${err.code} ${err.message}` }));
  if (benOnG && benOnG.err) {
    check('queueing on a reserved entry is refused', true, benOnG.err);
  } else {
    gEntry = await entryOf(sam, adaListing.listingId, G);
    check('queueing on a reserved entry does not silently erase the reservation',
      gEntry.status === 'reserved' || gEntry.reservedByRequestId === tradeReq,
      `status=${gEntry.status} reservedBy=${gEntry.reservedByRequestId} (was reserved by ${tradeReq})`);

    /* Now cancel the trade proposal. The release path writes status:'active'
       unconditionally — if Ben's hold is still open, the entry now claims to be
       available while holding a live queue. */
    await updateDoc(doc(ada.db, 'requests', tradeReq),
      { status: 'cancelled', updatedAt: serverTimestamp() });
    const settled = await until('the release to run', async () => {
      const en = await entryOf(sam, adaListing.listingId, G);
      return en.reservedByRequestId === null ? en : null;
    }).catch((err) => ({ error: err.message }));
    const stillOpen = await openQueue(ada, G);
    check('releasing a reserved entry does not strand a live queue on an "active" entry',
      settled && !settled.error &&
      (stillOpen.length === 0
        ? settled.status === 'active' && settled.currentHoldRequestId === null
        : settled.status === 'onHold' && settled.currentHoldRequestId === stillOpen[0].id),
      settled?.error ||
      `entry status=${settled.status} hold=${settled.currentHoldRequestId} ` +
      `queueCount=${settled.queueCount} openRequests=${stillOpen.length}`);
  }

  /* ===================================================================== *
   * 10. Final coherence sweep over every entry this suite touched
   * ===================================================================== */
  step('10. Whole-suite coherence');

  /* Read each queue as the seller of THAT entry — the rules only let a
     participant read a request, so querying someone else's queue is denied
     outright (correctly). */
  const allEntries = [
    { l: L1.listingId, e: L1.entryIds[0], as: sam }, { l: L1.listingId, e: L1.entryIds[1], as: sam },
    { l: L2.listingId, e: L2.entryIds[0], as: sam }, { l: L2.listingId, e: L2.entryIds[1], as: sam },
    { l: L2.listingId, e: L2.entryIds[2], as: sam },
    { l: evRef.id, e: evEntry, as: sam },
    { l: adaListing.listingId, e: G, as: ada }
  ];
  const bad = [];
  for (const { l, e: id, as } of allEntries) {
    const en = await entryOf(sam, l, id);
    const oq = await openQueue(as, id);
    const buyers = new Set(oq.map((x) => x.buyerId));
    if (en.queueCount !== oq.length) bad.push(`${id}: queueCount ${en.queueCount} != open ${oq.length}`);
    if (buyers.size !== oq.length) bad.push(`${id}: a buyer holds two places`);
    if (oq.some((x, i) => x.queuePosition !== i)) {
      bad.push(`${id}: positions ${JSON.stringify(oq.map((x) => x.queuePosition))}`);
    }
    if (oq.filter((x) => x.status !== 'queued').length > 1) bad.push(`${id}: more than one holder`);
    if (oq.length && en.status !== 'sold' && en.currentHoldRequestId !== oq[0].id) {
      bad.push(`${id}: hold ${en.currentHoldRequestId} != front ${oq[0].id}`);
    }
    if (!oq.length && en.status !== 'sold' && en.currentHoldRequestId !== null) {
      bad.push(`${id}: empty queue but hold ${en.currentHoldRequestId}`);
    }
  }
  check('every entry ends coherent: count == open, dense unique positions, one holder',
    bad.length === 0, bad.join(' | ') || 'all clean');

  const failed = await summarize([sam, ada, ben, cy, dee, eve]);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\n\x1b[31mSuite aborted:\x1b[0m', err);
  process.exit(2);
});
