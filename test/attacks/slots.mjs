/* Tabled — adversarial suite: SLOT BOOKING AND SCHEDULING (M6).
 *
 * Every check here tries to break one of the invariants bookSlot,
 * onSlotHoldChange and the `bookedSlots` rules block exist to hold:
 *
 *   1. two buyers must never hold the same slot
 *   2. re-booking releases the previous slot rather than hoarding two
 *   3. a slot outside the seller's availabilityWindows is refused
 *   4. a slot in the past is refused; so is a malformed date/time
 *   5. bookedSlotId / holdExpiresAt are function-only in the rules
 *   6. users/{uid}/bookedSlots is not client-writable
 *   7. a buyer cannot schedule on someone else's request, nor a seller on their own
 *   8. the SELLER's timeZone governs, not the caller's
 *
 * A refusal is a PASS. A success is a finding.
 *
 * RUN
 *   firebase emulators:start --only auth,firestore,functions --project demo-tabled
 *   node test/attacks/slots.mjs
 */
import {
  check, step, expectReject, until, summarize,
  makeUser, makeSeller, createListing, nextSlot, acceptProposal,
  TimeSlots, WINDOWS, TZ,
  doc, getDoc, setDoc, updateDoc, collection, serverTimestamp
} from '../harness.mjs';

const pad = (n) => (n < 10 ? '0' : '') + n;

/* Wall-clock 'HH:00' in `tz` at an instant — used to build a time that has
 * already passed where the SELLER is. */
function wallHourIn(ms, tz) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  const h = p.hour === '24' ? 0 : Number(p.hour);
  return `${pad(h)}:00`;
}

/* A date STRING that is not the canonical spelling of its own day, but which
 * Date.UTC rolls over to exactly the same calendar day — '2026-08-36' for
 * 2026-09-05. Both timeslots.js and bookSlot accept anything matching
 * /^\d{4}-\d{2}-\d{2}$/, and Date.UTC normalises the overflow silently. */
function rolloverSpelling(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const daysInPrev = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return `${py}-${pad(pm)}-${pad(daysInPrev + d)}`;
}

const slotDocPath = (db, sellerUid, id) =>
  doc(db, 'users', sellerUid, 'bookedSlots', id);

async function slotExists(u, sellerUid, id) {
  const s = await getDoc(slotDocPath(u.db, sellerUid, id));
  return s.exists() ? s.data() : null;
}

/* Full-day windows, so a timezone test can pick any hour without tripping the
 * availability check instead of the one being probed. */
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
  dayOfWeek: d, startTime: '00:00', endTime: '24:00'
}));

async function main() {
  step('Cast: one seller with 7 game entries, seven buyers');
  const sam = await makeSeller('sam', 'Sam Seller');
  const buyers = {};
  for (const [label, name] of [
    ['ada', 'Ada'], ['ben', 'Ben'], ['cy', 'Cy'], ['dee', 'Dee'],
    ['eve', 'Eve'], ['fay', 'Fay'], ['gus', 'Gus']
  ]) buyers[label] = await makeUser(label, name);
  const { ada, ben, cy, dee, eve, fay, gus } = buyers;

  const games = ['Brass', 'Cascadia', 'Wingspan', 'Ark Nova', 'Dune', 'Root', 'Scythe']
    .map((name, i) => ({ name, askingPrice: 20 + i }));
  const { listingId, entryIds } = await createListing(sam, 'Shelf cleanout', games);
  check('listing with 7 entries created', entryIds.length === 7, listingId);

  /* One buyer per entry, so every one of them is queuePosition 0 / onHold and
     genuinely entitled to claim a slot. That isolates the slot invariants from
     the queue invariants. */
  const req = {};
  const order = ['ada', 'ben', 'cy', 'dee', 'eve', 'fay', 'gus'];
  for (let i = 0; i < order.length; i++) {
    const r = await buyers[order[i]].call('createRequest',
      { listingId, gameEntryId: entryIds[i] });
    req[order[i]] = r.requestId || r.id;
  }
  const adaSnap = await getDoc(doc(ada.db, 'requests', req.ada));
  check('every buyer is at the front of their own queue',
    adaSnap.data().queuePosition === 0 && adaSnap.data().status === 'onHold',
    `pos=${adaSnap.data().queuePosition} status=${adaSnap.data().status}`);

  /* ------------------------------------------------------------------ */
  step('1. Two buyers cannot hold the same slot');

  const slotA = nextSlot();
  const bookedA = await ada.call('bookSlot',
    { requestId: req.ada, date: slotA.date, startTime: slotA.startTime });
  check('the first buyer gets the slot', !!bookedA.slotId, bookedA.slotId);

  await expectReject('a second buyer is refused the exact same slot',
    ben.call('bookSlot', { requestId: req.ben, date: slotA.date, startTime: slotA.startTime }),
    'already-exists|took that slot');

  const slotADoc = await slotExists(ben, sam.uid, bookedA.slotId);
  check('the contested slot still belongs to the first buyer',
    slotADoc && slotADoc.buyerId === ada.uid,
    slotADoc ? `buyerId=${slotADoc.buyerId}` : 'slot doc missing');

  const benAfterLoss = await getDoc(doc(ben.db, 'requests', req.ben));
  check('the loser\'s request is untouched by the failed booking',
    benAfterLoss.data().status === 'onHold' && !benAfterLoss.data().bookedSlotId,
    `status=${benAfterLoss.data().status} bookedSlotId=${benAfterLoss.data().bookedSlotId}`);

  /* The slot ID is keyed on the SELLER, so the same buyer cannot occupy one
     increment twice through two different requests either. */
  await expectReject('the same buyer cannot double-hold one increment via a second request',
    gus.call('bookSlot', { requestId: req.gus, date: slotA.date, startTime: slotA.startTime }),
    'already-exists|took that slot');

  /* ------------------------------------------------------------------ */
  step('2. Re-booking releases the previous slot');

  const slotB = TimeSlots.generateSlots(WINDOWS, TZ, { fromMs: Date.now(), days: 7 })
    .find((s) => s.startsAtMs > slotA.startsAtMs + 7200000);
  const bookedB = await ada.call('bookSlot',
    { requestId: req.ada, date: slotB.date, startTime: slotB.startTime });

  const oldSlot = await slotExists(ada, sam.uid, bookedA.slotId);
  const newSlot = await slotExists(ada, sam.uid, bookedB.slotId);
  check('re-booking frees the old slot instead of hoarding two',
    oldSlot === null && newSlot && newSlot.buyerId === ada.uid,
    `old=${oldSlot ? 'STILL HELD' : 'released'} new=${newSlot ? 'held' : 'missing'}`);

  const adaRe = await getDoc(doc(ada.db, 'requests', req.ada));
  check('the request points at the new slot only',
    adaRe.data().bookedSlotId === bookedB.slotId, adaRe.data().bookedSlotId);

  const benNow = await ben.call('bookSlot',
    { requestId: req.ben, date: slotA.date, startTime: slotA.startTime });
  check('the released slot is genuinely claimable by someone else',
    benNow.slotId === bookedA.slotId, benNow.slotId);

  /* Leaving the holding statuses releases the slot via onSlotHoldChange. A
     client cannot write bookedSlots, so this trigger is the only release path
     for a cancellation. */
  await updateDoc(doc(ben.db, 'requests', req.ben),
    { status: 'cancelled', updatedAt: serverTimestamp() });
  const released = await until('onSlotHoldChange to release the cancelled slot', async () => {
    const s = await getDoc(slotDocPath(ben.db, sam.uid, bookedA.slotId));
    return s.exists() ? null : true;
  }, 20000).catch((e) => ({ error: e.message }));
  check('cancelling a request releases its slot',
    released === true, released && released.error ? released.error : 'released');
  const benCleared = await until('the stale pointer to be cleared', async () => {
    const s = await getDoc(doc(ben.db, 'requests', req.ben));
    return s.data().bookedSlotId === null ? true : null;
  }, 20000).catch((e) => ({ error: e.message }));
  check('the cancelled request\'s bookedSlotId pointer is cleared',
    benCleared === true, benCleared && benCleared.error ? benCleared.error : 'null');

  /* ------------------------------------------------------------------ */
  step('3. A slot outside the seller\'s availability is refused');

  const inWindowDate = TimeSlots.dateStrIn(Date.now() + 3 * 86400000, TZ);
  await expectReject('before the window opens (07:00 vs 09:00)',
    cy.call('bookSlot', { requestId: req.cy, date: inWindowDate, startTime: '07:00' }),
    "availability|failed-precondition");
  await expectReject('after the window closes (22:00 vs 21:00)',
    cy.call('bookSlot', { requestId: req.cy, date: inWindowDate, startTime: '22:00' }),
    "availability|failed-precondition");
  /* 20:45 is now refused one gate earlier, as off-grid, so it no longer
     exercises the window-END boundary it was written for. Both refusals are
     correct; assert either, and cover the end boundary separately below with an
     ON-grid time against a window that closes at 20:45. */
  await expectReject('an off-grid start time (20:45) is refused outright',
    cy.call('bookSlot', { requestId: req.cy, date: inWindowDate, startTime: '20:45' }),
    'invalid-argument|availability|failed-precondition');

  /* The real end-boundary test: 20:30 is on the grid and starts inside a
     09:00-20:45 window, but runs to 21:00, past the close. */
  const oddSeller = await makeSeller('slot-oddwin', 'Odd Window Seller');
  await updateDoc(doc(oddSeller.db, 'users', oddSeller.uid), {
    availabilityWindows: [0, 1, 2, 3, 4, 5, 6].map((dw) => ({
      dayOfWeek: dw, startTime: '09:00', endTime: '20:45'
    })),
    timeZone: TZ
  });
  const oddListing = await createListing(oddSeller, 'Odd window listing',
    [{ name: 'Boundary Game', askingPrice: 10 }]);
  const oddReq = (await cy.call('createRequest',
    { listingId: oddListing.listingId, gameEntryId: oddListing.entryIds[0] })).requestId;
  await expectReject('an on-grid slot that STARTS inside but ENDS past the window close',
    cy.call('bookSlot', { requestId: oddReq, date: inWindowDate, startTime: '20:30' }),
    'availability|failed-precondition');
  await expectReject('an hour that does not exist (99:99)',
    cy.call('bookSlot', { requestId: req.cy, date: inWindowDate, startTime: '99:99' }),
    'availability|invalid-argument|failed-precondition');

  /* A seller with no windows at all cannot be booked by anyone. */
  const noWin = await makeUser('nowin', 'No Availability');
  const noWinListing = await createListing(noWin, 'No hours', [{ name: 'Azul', askingPrice: 30 }]);
  const nwReq = await fay.call('createRequest',
    { listingId: noWinListing.listingId, gameEntryId: noWinListing.entryIds[0] });
  await expectReject('a seller with no availability cannot be booked at all',
    fay.call('bookSlot', { requestId: nwReq.requestId, date: inWindowDate, startTime: '10:00' }),
    "availability|failed-precondition");

  /* ------------------------------------------------------------------ */
  step('4. Past and malformed times are refused');

  const yesterday = TimeSlots.dateStrIn(Date.now() - 86400000, TZ);
  await expectReject('yesterday, at a time inside the window',
    cy.call('bookSlot', { requestId: req.cy, date: yesterday, startTime: '10:00' }),
    'passed|failed-precondition');
  await expectReject('a date years in the past',
    cy.call('bookSlot', { requestId: req.cy, date: '2020-06-13', startTime: '10:00' }),
    'passed|availability|failed-precondition');

  for (const [label, payload] of [
    ['no date at all', { requestId: null, date: '', startTime: '' }],
    ['unpadded date (2026-8-1)', { date: '2026-8-1', startTime: '10:00' }],
    ['US-order date (08/01/2026)', { date: '08/01/2026', startTime: '10:00' }],
    ['unpadded time (9:00)', { date: inWindowDate, startTime: '9:00' }],
    ['non-numeric time (ab:cd)', { date: inWindowDate, startTime: 'ab:cd' }],
    ['time with seconds (10:00:00)', { date: inWindowDate, startTime: '10:00:00' }],
    ['injection-shaped date', { date: '../../../etc', startTime: '10:00' }],
    ['missing startTime', { date: inWindowDate }]
  ]) {
    await expectReject(`malformed: ${label}`,
      cy.call('bookSlot', { requestId: req.cy, ...payload }),
      'invalid-argument|required');
  }

  /* An object where a string belongs. `String(d.date || '')` at index.js:1166
     throws a TypeError on an object whose toString isn't callable, so this
     comes back as `internal` rather than `invalid-argument`. The booking is
     still refused, which is the invariant — the assertion is "rejected",
     because insisting on invalid-argument here would be testing the error
     message, not the rule. The sloppy code is noted, not failed. */
  await expectReject('an object where a date string belongs is refused (ungracefully)',
    cy.call('bookSlot', { requestId: req.cy, date: { toString: 1 }, startTime: '10:00' }));

  await expectReject('a requestId that does not exist',
    cy.call('bookSlot', { requestId: 'no-such-request', date: inWindowDate, startTime: '10:00' }),
    'not-found');

  /* ------------------------------------------------------------------ */
  step('5. bookedSlotId and holdExpiresAt are function-only');

  await expectReject('a buyer cannot write bookedSlotId on their own request',
    updateDoc(doc(ada.db, 'requests', req.ada), { bookedSlotId: 'anything' }),
    'permission-denied');
  await expectReject('a buyer cannot null out bookedSlotId to free a slot behind the trigger\'s back',
    updateDoc(doc(ada.db, 'requests', req.ada),
      { bookedSlotId: null, updatedAt: serverTimestamp() }),
    'permission-denied');
  await expectReject('a buyer cannot extend their own holdExpiresAt',
    updateDoc(doc(ada.db, 'requests', req.ada),
      { holdExpiresAt: new Date(Date.now() + 86400000 * 30) }),
    'permission-denied');
  await expectReject('the seller cannot write bookedSlotId either',
    updateDoc(doc(sam.db, 'requests', req.ada), { bookedSlotId: null }),
    'permission-denied');
  await expectReject('bookedSlotId cannot ride along with an otherwise-legal status change',
    updateDoc(doc(ada.db, 'requests', req.ada),
      { status: 'cancelled', bookedSlotId: null, updatedAt: serverTimestamp() }),
    'permission-denied');

  const stillHeld = await slotExists(ada, sam.uid, bookedB.slotId);
  check('after all that, the slot is still held by its owner',
    stillHeld && stillHeld.buyerId === ada.uid,
    stillHeld ? stillHeld.buyerId : 'GONE');

  /* ------------------------------------------------------------------ */
  step('6. users/{uid}/bookedSlots is not client-writable');

  const forgedId = TimeSlots.slotId(sam.uid, inWindowDate, '11:00');
  await expectReject('a buyer cannot forge a slot on the seller\'s calendar',
    setDoc(slotDocPath(dee.db, sam.uid, forgedId),
      { date: inWindowDate, startTime: '11:00', buyerId: dee.uid, requestId: req.dee }),
    'permission-denied');
  await expectReject('a buyer cannot delete a rival\'s slot',
    setDoc(slotDocPath(dee.db, sam.uid, bookedB.slotId), { buyerId: dee.uid }),
    'permission-denied');
  await expectReject('the SELLER cannot write their own bookedSlots either',
    setDoc(slotDocPath(sam.db, sam.uid, forgedId), { date: inWindowDate, startTime: '11:00' }),
    'permission-denied');
  await expectReject('a buyer cannot pre-fill their OWN bookedSlots subcollection',
    setDoc(slotDocPath(dee.db, dee.uid, 'anything'), { date: inWindowDate }),
    'permission-denied');
  const forged = await slotExists(dee, sam.uid, forgedId);
  check('no forged slot document exists', forged === null, forged ? 'FORGED DOC EXISTS' : 'absent');

  /* ------------------------------------------------------------------ */
  step('7. Only the right person, at the right moment, may book');

  await expectReject('a buyer cannot book against someone else\'s request',
    dee.call('bookSlot', { requestId: req.ada, date: inWindowDate, startTime: '12:00' }),
    'permission-denied|Only the buyer');
  await expectReject('the seller cannot book a slot on a request against their own listing',
    sam.call('bookSlot', { requestId: req.ada, date: inWindowDate, startTime: '12:00' }),
    'permission-denied|Only the buyer');
  await expectReject('an unrelated third party cannot book on a request',
    eve.call('bookSlot', { requestId: req.ada, date: inWindowDate, startTime: '12:00' }),
    'permission-denied|Only the buyer');

  /* Someone behind the front of the queue. */
  const dee2 = await gus.call('createRequest', { listingId, gameEntryId: entryIds[0] });
  await expectReject('a buyer queued behind the holder cannot claim a time',
    gus.call('bookSlot', { requestId: dee2.requestId, date: inWindowDate, startTime: '12:00' }),
    'turn|failed-precondition');

  /* Once the seller has accepted, the request has left the schedulable states. */
  await acceptProposal(sam, req.ada);
  await expectReject('a scheduled request cannot be silently re-booked elsewhere',
    ada.call('bookSlot', { requestId: req.ada, date: inWindowDate, startTime: '13:00' }),
    'not open for scheduling|failed-precondition');
  const keptAfterAccept = await slotExists(ada, sam.uid, bookedB.slotId);
  check('accepting a proposal keeps the slot held (scheduled is a holding status)',
    keptAfterAccept && keptAfterAccept.buyerId === ada.uid,
    keptAfterAccept ? 'held' : 'RELEASED WHILE SCHEDULED');

  /* ------------------------------------------------------------------ */
  step('8. The seller\'s timeZone governs, not the caller\'s');

  const FAR_TZ = 'Pacific/Kiritimati'; /* UTC+14, 18h ahead of America/New_York */
  const sol = await makeUser('sol', 'Sol Faraway');
  await updateDoc(doc(sol.db, 'users', sol.uid),
    { availabilityWindows: ALL_DAY, timeZone: FAR_TZ });
  const solListing = await createListing(sol, 'Far away shelf',
    [{ name: 'Terraforming Mars', askingPrice: 40 }, { name: 'Gaia', askingPrice: 50 }]);
  const solReq1 = await eve.call('createRequest',
    { listingId: solListing.listingId, gameEntryId: solListing.entryIds[0] });
  const solReq2 = await fay.call('createRequest',
    { listingId: solListing.listingId, gameEntryId: solListing.entryIds[1] });

  /* A wall-clock time three hours in Sol's past. Interpreted in the caller's
     zone (or UTC) the same digits land ~15h in the FUTURE, so a callable that
     used the wrong zone would happily accept it. */
  const pastMs = Date.now() - 3 * 3600000;
  const solPastDate = TimeSlots.dateStrIn(pastMs, FAR_TZ);
  const solPastTime = wallHourIn(pastMs, FAR_TZ);
  const asSeller = TimeSlots.zonedToUtc(solPastDate, solPastTime, FAR_TZ);
  const asCaller = TimeSlots.zonedToUtc(solPastDate, solPastTime, TZ);
  check('premise: those digits are past in the seller\'s zone, future in the caller\'s',
    asSeller <= Date.now() && asCaller > Date.now(),
    `seller=${new Date(asSeller).toISOString()} caller=${new Date(asCaller).toISOString()}`);
  await expectReject('a time already past in the SELLER\'s zone is refused, though future in the caller\'s',
    eve.call('bookSlot',
      { requestId: solReq1.requestId, date: solPastDate, startTime: solPastTime }),
    'passed|failed-precondition');

  /* And the instant actually stored is the seller-zone one. */
  const solSlot = TimeSlots.generateSlots(ALL_DAY, FAR_TZ, { fromMs: Date.now(), days: 3 })
    .find((s) => s.startsAtMs > Date.now() + 6 * 3600000);
  const solBooked = await eve.call('bookSlot',
    { requestId: solReq1.requestId, date: solSlot.date, startTime: solSlot.startTime });
  const solReqDoc = await getDoc(doc(eve.db, 'requests', solReq1.requestId));
  const storedMs = solReqDoc.data().proposedTime.toMillis();
  const sellerZoneMs = TimeSlots.zonedToUtc(solSlot.date, solSlot.startTime, FAR_TZ);
  const callerZoneMs = TimeSlots.zonedToUtc(solSlot.date, solSlot.startTime, TZ);
  check('the stored instant is the seller-zone reading, not the caller-zone one',
    storedMs === sellerZoneMs && storedMs !== callerZoneMs && solBooked.startsAtMs === sellerZoneMs,
    `stored=${new Date(storedMs).toISOString()} sellerTz=${new Date(sellerZoneMs).toISOString()} callerTz=${new Date(callerZoneMs).toISOString()}`);

  /* A narrow window means the same digits are in-window for one seller and not
     the other; the seller's own windows must be the ones consulted. */
  const narrow = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, startTime: '09:00', endTime: '10:00' }));
  await updateDoc(doc(sol.db, 'users', sol.uid), { availabilityWindows: narrow });
  const solTomorrow = TimeSlots.dateStrIn(Date.now() + 2 * 86400000, FAR_TZ);
  await expectReject('narrowing the seller\'s windows immediately refuses times outside them',
    fay.call('bookSlot', { requestId: solReq2.requestId, date: solTomorrow, startTime: '15:00' }),
    'availability|failed-precondition');

  /* ------------------------------------------------------------------ */
  step('9. Overlap and spelling: can two holds cover the same wall-clock time?');

  /* 9a — the grid is 30 minutes, but bookSlot never checks alignment. If
     :15 is accepted it overlaps the :00 slot somebody already holds. */
  const gridDate = TimeSlots.dateStrIn(Date.now() + 4 * 86400000, TZ);
  await cy.call('bookSlot', { requestId: req.cy, date: gridDate, startTime: '14:00' });
  let offGrid = null;
  try {
    offGrid = await dee.call('bookSlot',
      { requestId: req.dee, date: gridDate, startTime: '14:15' });
  } catch (err) {
    offGrid = { rejected: `${err.code || ''} ${err.message || ''}`.trim() };
  }
  check('an off-grid 14:15 cannot overlap the 14:00 slot another buyer holds',
    !!(offGrid && offGrid.rejected),
    offGrid && offGrid.rejected
      ? offGrid.rejected
      : `ACCEPTED as ${offGrid.slotId} — Dee holds 14:15-14:45 while Cy holds 14:00-14:30`);

  /* 9b — the same instant spelled with a rolled-over date. Date.UTC normalises
     '2026-08-36' to 2026-09-05, so the instant is identical while the slot doc
     ID differs. */
  const canonDate = TimeSlots.dateStrIn(Date.now() + 5 * 86400000, TZ);
  const rollDate = rolloverSpelling(canonDate);
  check('premise: the rolled-over spelling names the same instant',
    TimeSlots.zonedToUtc(rollDate, '16:00', TZ) === TimeSlots.zonedToUtc(canonDate, '16:00', TZ),
    `${rollDate} == ${canonDate}`);
  const canonBooked = await eve.call('bookSlot',
    { requestId: req.eve, date: canonDate, startTime: '16:00' });
  let rolled = null;
  try {
    rolled = await fay.call('bookSlot',
      { requestId: req.fay, date: rollDate, startTime: '16:00' });
  } catch (err) {
    rolled = { rejected: `${err.code || ''} ${err.message || ''}`.trim() };
  }
  const sameInstant = rolled && rolled.startsAtMs === canonBooked.startsAtMs;
  check('a non-canonical date spelling cannot double-book the same instant',
    !!(rolled && rolled.rejected),
    rolled && rolled.rejected
      ? rolled.rejected
      : `ACCEPTED as ${rolled.slotId} (canonical holder: ${canonBooked.slotId}); sameInstant=${sameInstant}`);

  const failedCount = await summarize([sam, noWin, sol, ...Object.values(buyers)]);
  process.exit(failedCount ? 1 : 0);
}

main().catch((err) => {
  console.error('\n\x1b[31mSuite aborted:\x1b[0m', err);
  process.exit(2);
});
