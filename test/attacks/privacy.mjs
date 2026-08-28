/* Tabled — adversarial suite: PRIVACY and COMPLETION INTEGRITY.
 *
 * The two things that would hurt most if they broke:
 *   1. A thread (its messages, its meeting address) leaking to anyone who is
 *      not one of the two people in it.
 *   2. A completed trade being editable, or a tradeCount being inflatable, so
 *      that "12 trades, 5 stars" stops meaning anything.
 *
 * Every attack below is supposed to FAIL. A rejection is a PASS.
 *
 * RUN
 *   firebase emulators:start --only auth,firestore,functions --project demo-tabled
 *   node test/attacks/privacy.mjs
 */
import {
  check, step, expectReject, until, summarize,
  makeUser, makeSeller, createListing, nextSlot, acceptProposal, completeTrade,
  PROJECT,
  doc, getDoc, setDoc, updateDoc, collection, serverTimestamp
} from '../harness.mjs';
import { getDocs, deleteDoc } from 'firebase/firestore';

/* Seeding a document that NO client may create (notifications are
 * function-written and no function writes them yet) needs an admin write. The
 * Firestore emulator accepts `Authorization: Bearer owner` as the admin SDK.
 * This is a fixture, not an attack. */
const REST = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
async function adminWrite(path, fields) {
  const res = await fetch(`${REST}/${path}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) throw new Error(`admin seed failed ${res.status}: ${await res.text()}`);
  return res.json();
}

const S = (v) => ({ stringValue: v });
const B = (v) => ({ booleanValue: v });

async function tradeCountOf(u, uid) {
  const s = await getDoc(doc(u.db, 'users', uid));
  return s.data().tradeCount;
}

async function main() {
  step('Cast: seller, buyer, a second buyer, and Eve — a signed-in stranger');
  const sam = await makeSeller('p-sam', 'Sam Seller');
  const ada = await makeUser('p-ada', 'Ada Buyer');
  const ben = await makeUser('p-ben', 'Ben Buyer');
  const cy = await makeUser('p-cy', 'Cy Buyer');
  const dee = await makeUser('p-dee', 'Dee Buyer');
  const eve = await makeUser('p-eve', 'Eve Eavesdropper');
  const sam2 = await makeSeller('p-sam2', 'Sam Two');
  const users = [sam, ada, ben, cy, dee, eve, sam2];
  check('7 accounts created', users.every((u) => !!u.uid));

  const { listingId, entryIds } = await createListing(sam, 'Shelf cleanout', [
    { name: 'Brass: Birmingham', askingPrice: 45 },
    { name: 'Cascadia', askingPrice: 18 },
    { name: 'Wingspan', askingPrice: 40 },
    { name: 'Ark Nova', askingPrice: 60 }
  ]);
  check('listing with 4 entries created', entryIds.length === 4, listingId);

  /* ---------------------------------------------------------------- 1. THREAD
   * An open thread between Ada and Sam, with a message in it. */
  step('1. A third party and someone else\'s thread');
  const adaReqId = (await ada.call('createRequest',
    { listingId, gameEntryId: entryIds[0] })).requestId;
  await setDoc(doc(collection(ada.db, 'requests', adaReqId, 'messages')), {
    senderId: ada.uid, text: 'Is the insert included?', createdAt: serverTimestamp()
  });
  const adaMsgs = await getDocs(collection(ada.db, 'requests', adaReqId, 'messages'));
  check('the buyer can read her own thread (control)', adaMsgs.size === 1, `${adaMsgs.size} msgs`);
  const samRead = await getDoc(doc(sam.db, 'requests', adaReqId));
  check('the seller can read the request (control)', samRead.exists());

  await expectReject('Eve cannot read the request document',
    getDoc(doc(eve.db, 'requests', adaReqId)), 'permission-denied');
  await expectReject('Eve cannot list the messages subcollection',
    getDocs(collection(eve.db, 'requests', adaReqId, 'messages')), 'permission-denied');
  await expectReject('Eve cannot read a single message by id',
    getDoc(doc(eve.db, 'requests', adaReqId, 'messages', adaMsgs.docs[0].id)),
    'permission-denied');
  await expectReject('Eve cannot query requests she is not in',
    getDocs(collection(eve.db, 'requests')), 'permission-denied');

  step('2. Injecting into, and forging inside, a thread');
  await expectReject('Eve cannot post into the thread',
    setDoc(doc(collection(eve.db, 'requests', adaReqId, 'messages')), {
      senderId: eve.uid, text: 'buy my crypto', createdAt: serverTimestamp()
    }), 'permission-denied');
  await expectReject('Eve cannot post into the thread wearing Ada\'s senderId',
    setDoc(doc(collection(eve.db, 'requests', adaReqId, 'messages')), {
      senderId: ada.uid, text: 'I will pay double', createdAt: serverTimestamp()
    }), 'permission-denied');
  await expectReject('Ada cannot forge a message FROM Sam in her own thread',
    setDoc(doc(collection(ada.db, 'requests', adaReqId, 'messages')), {
      senderId: sam.uid, text: 'sure, $5 is fine', createdAt: serverTimestamp()
    }), 'permission-denied');
  await expectReject('nobody can edit a sent message',
    updateDoc(doc(ada.db, 'requests', adaReqId, 'messages', adaMsgs.docs[0].id),
      { text: 'rewritten' }), 'permission-denied');
  await expectReject('nobody can delete a sent message',
    deleteDoc(doc(ada.db, 'requests', adaReqId, 'messages', adaMsgs.docs[0].id)),
    'permission-denied');
  await expectReject('Eve cannot write the request document',
    updateDoc(doc(eve.db, 'requests', adaReqId), { status: 'cancelled' }),
    'permission-denied');

  step('3. markRead only touches your own side');
  let ok = true;
  await updateDoc(doc(ada.db, 'requests', adaReqId), { lastReadBuyerAt: serverTimestamp() })
    .catch((e) => { ok = false; check('the buyer can mark her own side read', false, e.message); });
  if (ok) check('the buyer can mark her own side read', true);

  await expectReject('the buyer cannot write lastReadSellerAt',
    updateDoc(doc(ada.db, 'requests', adaReqId), { lastReadSellerAt: serverTimestamp() }),
    'permission-denied');
  /* If the write above was accepted, was it actually stored? "Accepted" and
     "persisted" are different claims, and only the second one is a leak of the
     other person's unread state. */
  const foreign = await getDoc(doc(sam.db, 'requests', adaReqId));
  check('...and if it was accepted, it did NOT land on the seller\'s side',
    !foreign.data().lastReadSellerAt,
    `lastReadSellerAt=${foreign.data().lastReadSellerAt}`);
  await expectReject('the buyer cannot write BOTH sides in one patch',
    updateDoc(doc(ada.db, 'requests', adaReqId), {
      lastReadBuyerAt: serverTimestamp(), lastReadSellerAt: serverTimestamp()
    }), 'permission-denied');
  await expectReject('the seller cannot write lastReadBuyerAt',
    updateDoc(doc(sam.db, 'requests', adaReqId), { lastReadBuyerAt: serverTimestamp() }),
    'permission-denied');
  await expectReject('markRead cannot smuggle a status change alongside it',
    updateDoc(doc(ada.db, 'requests', adaReqId), {
      lastReadBuyerAt: serverTimestamp(), status: 'scheduled'
    }), 'permission-denied');
  /* Same broad rule, adjacent consequence: the dashboard preview fields are
     not on its blacklist either, so a participant can write a message preview
     attributed to the other person without any message existing. */
  let spoofed = false;
  await updateDoc(doc(ada.db, 'requests', adaReqId), {
    lastMessageText: 'sure, I will take $5 for it',
    lastMessageSenderId: sam.uid, lastMessageAt: serverTimestamp()
  }).then(() => { spoofed = true; }).catch(() => {});
  check('a participant cannot forge the dashboard message preview as the other person',
    !spoofed, spoofed
      ? 'buyer wrote lastMessageText + lastMessageSenderId=<seller> with no such message'
      : 'refused');

  await expectReject('Eve cannot mark someone else\'s thread read',
    updateDoc(doc(eve.db, 'requests', adaReqId), { lastReadBuyerAt: serverTimestamp() }),
    'permission-denied');

  /* -------------------------------------------------------- 4. CONFIRM GATES */
  step('4. confirmSold refuses everything that is not a scheduled trade of yours');
  await expectReject('Eve cannot confirm a trade she is not part of',
    eve.call('confirmSold', { requestId: adaReqId }), 'permission-denied|Not your trade');
  await expectReject('confirming an onHold request is refused ("agree a time first")',
    ada.call('confirmSold', { requestId: adaReqId }), 'failed-precondition|time first');

  const slot = nextSlot();
  await ada.call('bookSlot', { requestId: adaReqId, date: slot.date, startTime: slot.startTime });
  const proposed = await getDoc(doc(sam.db, 'requests', adaReqId));
  check('booking put the request in proposedTime (control)',
    proposed.data().status === 'proposedTime', `status=${proposed.data().status}`);
  await expectReject('confirming a proposedTime request is refused too',
    ada.call('confirmSold', { requestId: adaReqId }), 'failed-precondition|time first');
  await expectReject('and the seller cannot confirm it either',
    sam.call('confirmSold', { requestId: adaReqId }), 'failed-precondition|time first');
  await expectReject('a queued third buyer cannot confirm the front-runner\'s trade',
    ben.call('confirmSold', { requestId: adaReqId }), 'permission-denied|Not your trade');

  /* ------------------------------------------------- 5. tradeCount, exactly 1 */
  step('5. tradeCount increments EXACTLY once per completed trade');
  const samBefore = await tradeCountOf(sam, sam.uid);
  const adaBefore = await tradeCountOf(ada, ada.uid);
  await acceptProposal(sam, adaReqId);
  await ada.call('confirmSold', { requestId: adaReqId });
  await sam.call('confirmSold', { requestId: adaReqId });
  await until('the trade to complete', async () => {
    const s = await getDoc(doc(sam.db, 'requests', adaReqId));
    return s.data().status === 'completed' ? s : null;
  });
  await until('tradeCount to land', async () =>
    (await tradeCountOf(sam, sam.uid)) === samBefore + 1);
  check('one completed trade = +1 for both parties',
    (await tradeCountOf(sam, sam.uid)) === samBefore + 1 &&
    (await tradeCountOf(ada, ada.uid)) === adaBefore + 1,
    `sam ${samBefore}->${await tradeCountOf(sam, sam.uid)} ada ${adaBefore}->${await tradeCountOf(ada, ada.uid)}`);

  /* Hammering confirmSold after the fact is the obvious double-count attempt. */
  const spam = [];
  for (let i = 0; i < 4; i++) {
    spam.push(ada.call('confirmSold', { requestId: adaReqId }).catch((e) => e.code));
    spam.push(sam.call('confirmSold', { requestId: adaReqId }).catch((e) => e.code));
  }
  const spamRes = await Promise.all(spam);
  check('re-confirming a completed trade is idempotent, not a double count',
    (await tradeCountOf(sam, sam.uid)) === samBefore + 1 &&
    (await tradeCountOf(ada, ada.uid)) === adaBefore + 1,
    `sam=${await tradeCountOf(sam, sam.uid)} ada=${await tradeCountOf(ada, ada.uid)} results=${JSON.stringify(spamRes)}`);

  step('5b. Racing both sides\' confirmations concurrently');
  /* A fresh seller so the count under test starts clean and nothing else on
     Sam's account can mask a double increment. */
  const l2 = await createListing(sam2, 'Race bait', [{ name: 'Root', askingPrice: 30 }]);
  const cyReqId = (await cy.call('createRequest',
    { listingId: l2.listingId, gameEntryId: l2.entryIds[0] })).requestId;
  const slot2 = nextSlot();
  await cy.call('bookSlot', { requestId: cyReqId, date: slot2.date, startTime: slot2.startTime });
  await acceptProposal(sam2, cyReqId);
  const race = [];
  for (let i = 0; i < 5; i++) {
    race.push(cy.call('confirmSold', { requestId: cyReqId }).catch((e) => e.code || 'err'));
    race.push(sam2.call('confirmSold', { requestId: cyReqId }).catch((e) => e.code || 'err'));
  }
  const raceRes = await Promise.all(race);
  await until('the raced trade to complete', async () => {
    const s = await getDoc(doc(sam2.db, 'requests', cyReqId));
    return s.data().status === 'completed' ? s : null;
  });
  /* Give any late transaction retry a chance to land a second increment. */
  await new Promise((r) => setTimeout(r, 2000));
  const sam2Count = await tradeCountOf(sam2, sam2.uid);
  const cyCount = await tradeCountOf(cy, cy.uid);
  check('10 concurrent confirmSold calls still produce exactly one trade each',
    sam2Count === 1 && cyCount === 1,
    `seller=${sam2Count} buyer=${cyCount} results=${JSON.stringify(raceRes)}`);

  /* ------------------------------------------------------------- 6. THE FREEZE */
  step('6. A completed trade is frozen');
  await expectReject('cannot reopen a completed trade',
    updateDoc(doc(sam.db, 'requests', adaReqId), { status: 'scheduled' }), 'permission-denied');
  await expectReject('cannot cancel a completed trade',
    updateDoc(doc(ada.db, 'requests', adaReqId), { status: 'cancelled' }), 'permission-denied');
  await expectReject('cannot rewrite scheduledTime after completion',
    updateDoc(doc(sam.db, 'requests', adaReqId), { scheduledTime: new Date() }),
    'permission-denied');
  await expectReject('cannot write closedReason after completion',
    updateDoc(doc(sam.db, 'requests', adaReqId), { closedReason: 'itemSold' }),
    'permission-denied');
  await expectReject('cannot rewrite completedAt after completion',
    updateDoc(doc(sam.db, 'requests', adaReqId), { completedAt: new Date() }),
    'permission-denied');
  await expectReject('cannot swap the counterparty on a completed trade',
    updateDoc(doc(sam.db, 'requests', adaReqId), { buyerId: eve.uid }), 'permission-denied');
  await expectReject('cannot flip messagesArchived to hide a thread from the sweep',
    updateDoc(doc(sam.db, 'requests', adaReqId), { messagesArchived: true }),
    'permission-denied');
  await expectReject('cannot delete a completed request',
    deleteDoc(doc(sam.db, 'requests', adaReqId)), 'permission-denied');

  /* Marking read is the ONE write the freeze deliberately lets through
     (firestore.rules, the first `allow update` on /requests). Asserted as
     intended behaviour so a future tightening shows up here rather than as a
     silent UX regression. */
  let readOk = true;
  await updateDoc(doc(sam.db, 'requests', adaReqId), { lastReadSellerAt: serverTimestamp() })
    .catch((e) => { readOk = false; });
  check('BY DESIGN: marking read still works on a completed trade', readOk);

  /* The same cross-side write that section 3 got away with, retried here. On a
     completed trade the broad `allow update` at firestore.rules L421 is out of
     play (it requires status != 'completed'), leaving only the per-side rule at
     L414 — which refuses. That contrast is the proof of where the section-3
     hole lives: not in the markRead rule, but in the broad rule beside it. */
  await expectReject('the cross-side markRead write IS refused once the freeze removes the broad rule',
    updateDoc(doc(ada.db, 'requests', adaReqId), { lastReadSellerAt: serverTimestamp() }),
    'permission-denied');

  /* Messages: the rules put no status gate on message create. */
  let postedAfterCompletion = false;
  await setDoc(doc(collection(ada.db, 'requests', adaReqId, 'messages')), {
    senderId: ada.uid, text: 'thanks, great trade!', createdAt: serverTimestamp()
  }).then(() => { postedAfterCompletion = true; }).catch(() => {});
  check('OBSERVED: message create is still allowed on a completed thread',
    true, postedAfterCompletion
      ? 'a new message CAN be posted after completion (the composer stays open in views-thread.js, so this looks intended) — but the parent-doc half of Store.sendMessage is frozen, see next check'
      : 'refused');
  if (postedAfterCompletion) {
    await expectReject('...while the lastMessage* half of the same sendMessage is refused',
      updateDoc(doc(ada.db, 'requests', adaReqId), {
        lastMessageAt: serverTimestamp(), lastMessageText: 'thanks, great trade!',
        lastMessageSenderId: ada.uid, updatedAt: serverTimestamp()
      }), 'permission-denied');
  }

  /* ------------------------------------------------------ 7. MEETING ADDRESS */
  step('7. The meeting address, from the outside');
  const deeReqId = (await dee.call('createRequest',
    { listingId, gameEntryId: entryIds[1] })).requestId;
  const slot3 = nextSlot();
  await dee.call('bookSlot', { requestId: deeReqId, date: slot3.date, startTime: slot3.startTime });
  await acceptProposal(sam, deeReqId);

  await expectReject('Eve cannot release an address into a trade she is not in',
    eve.call('releaseMeetingAddress',
      { requestId: deeReqId, address: '123 Fake St, Jacksonville FL', ttlMs: 3600000 }),
    'permission-denied|Not your trade');
  await expectReject('Eve cannot confirmPickup on someone else\'s trade',
    eve.call('confirmPickup', { requestId: deeReqId }), 'permission-denied|Not your trade');

  /* Try the real callable first; if ADDRESS_ENC_KEY is not configured in this
     emulator, seed the doc directly so the recipient check is still exercised
     (the check runs before decryption, so a dummy ciphertext is enough). */
  let released = null;
  try {
    await sam.call('releaseMeetingAddress',
      { requestId: deeReqId, address: '1 Riverside Ave, Jacksonville FL', ttlMs: 3600000 });
    released = 'callable';
  } catch (e) {
    released = `seeded (${e.code || e.message})`;
    await adminWrite(`meetingDetails/${deeReqId}`, {
      requestId: S(deeReqId), senderId: S(sam.uid), recipientId: S(dee.uid),
      ciphertext: S('not-a-real-blob'),
      expireAt: { timestampValue: new Date(Date.now() + 3600000).toISOString() }
    });
  }
  check(`an address is on file for the Sam/Dee trade (${released})`, true);

  await expectReject('Eve cannot read the meetingDetails document directly',
    getDoc(doc(eve.db, 'meetingDetails', deeReqId)), 'permission-denied');
  await expectReject('neither can the RECIPIENT read it directly — it is callable-only',
    getDoc(doc(dee.db, 'meetingDetails', deeReqId)), 'permission-denied');
  await expectReject('nor can the sender overwrite it from a client',
    setDoc(doc(sam.db, 'meetingDetails', deeReqId), { ciphertext: 'x' }), 'permission-denied');
  await expectReject('Eve cannot readMeetingAddress for a trade she is not in',
    eve.call('readMeetingAddress', { requestId: deeReqId }),
    'permission-denied|not shared');
  await expectReject('the SENDER cannot read the address back through the callable either',
    sam.call('readMeetingAddress', { requestId: deeReqId }),
    'permission-denied|not shared');
  if (released === 'callable') {
    let got = null;
    await dee.call('readMeetingAddress', { requestId: deeReqId })
      .then((r) => { got = r.address; }).catch((e) => { got = `ERR ${e.code}`; });
    check('the intended recipient CAN read it (control)',
      got === '1 Riverside Ave, Jacksonville FL', String(got));
  }
  await expectReject('Eve cannot read the messageArchive either',
    getDoc(doc(eve.db, 'messageArchive', adaReqId)), 'permission-denied');

  /* --------------------------------------------------------- 8. NOTIFICATIONS */
  step('8. Notifications are function-only and read-flag-only');
  await expectReject('Eve cannot create a notification on Ada\'s account',
    setDoc(doc(eve.db, 'users', ada.uid, 'notifications', `fake-${Date.now()}`), {
      type: 'itemSold', text: 'Your bank needs you', read: false,
      createdAt: serverTimestamp()
    }), 'permission-denied');
  await expectReject('Ada cannot create a notification on her OWN account',
    setDoc(doc(ada.db, 'users', ada.uid, 'notifications', `self-${Date.now()}`), {
      type: 'itemSold', text: 'self-issued', read: false, createdAt: serverTimestamp()
    }), 'permission-denied');

  const notifId = `seeded-${Date.now()}`;
  await adminWrite(`users/${ada.uid}/notifications/${notifId}`,
    { type: S('itemSold'), text: S('Your game sold'), read: B(false) });
  await expectReject('Eve cannot read Ada\'s notifications',
    getDoc(doc(eve.db, 'users', ada.uid, 'notifications', notifId)), 'permission-denied');
  await expectReject('Eve cannot list Ada\'s notifications',
    getDocs(collection(eve.db, 'users', ada.uid, 'notifications')), 'permission-denied');
  let flipped = true;
  await updateDoc(doc(ada.db, 'users', ada.uid, 'notifications', notifId), { read: true })
    .catch(() => { flipped = false; });
  check('the owner can flip `read` (control)', flipped);
  await expectReject('the owner cannot rewrite a notification\'s text',
    updateDoc(doc(ada.db, 'users', ada.uid, 'notifications', notifId), { text: 'edited' }),
    'permission-denied');
  await expectReject('the owner cannot delete a notification',
    deleteDoc(doc(ada.db, 'users', ada.uid, 'notifications', notifId)), 'permission-denied');
  await expectReject('Eve cannot flip a flag on Ada\'s notification',
    updateDoc(doc(eve.db, 'users', ada.uid, 'notifications', notifId), { read: false }),
    'permission-denied');

  /* ------------------------------------------------------ 9. BLOCKED, WATCHES */
  step('9. Block list and watchlist are private');
  await setDoc(doc(ada.db, 'users', ada.uid, 'blocked', eve.uid),
    { createdAt: serverTimestamp() });
  await setDoc(doc(ada.db, 'users', ada.uid, 'watches', listingId),
    { listingId, createdAt: serverTimestamp() });

  await expectReject('Eve cannot read whether Ada blocked her',
    getDoc(doc(eve.db, 'users', ada.uid, 'blocked', eve.uid)), 'permission-denied');
  await expectReject('Eve cannot list Ada\'s block list',
    getDocs(collection(eve.db, 'users', ada.uid, 'blocked')), 'permission-denied');
  await expectReject('Eve cannot add herself to Ada\'s block list',
    setDoc(doc(eve.db, 'users', ada.uid, 'blocked', sam.uid), { createdAt: serverTimestamp() }),
    'permission-denied');
  await expectReject('Eve cannot remove herself from Ada\'s block list',
    deleteDoc(doc(eve.db, 'users', ada.uid, 'blocked', eve.uid)), 'permission-denied');
  await expectReject('the seller cannot see who is watching his listing',
    getDoc(doc(sam.db, 'users', ada.uid, 'watches', listingId)), 'permission-denied');
  await expectReject('Eve cannot list Ada\'s watchlist',
    getDocs(collection(eve.db, 'users', ada.uid, 'watches')), 'permission-denied');

  /* A blocked person must not be able to message you. */
  const benReqId = (await ben.call('createRequest',
    { listingId, gameEntryId: entryIds[2] })).requestId;
  await setDoc(doc(sam.db, 'users', sam.uid, 'blocked', ben.uid),
    { createdAt: serverTimestamp() });
  await expectReject('a buyer blocked by the seller cannot message him',
    setDoc(doc(collection(ben.db, 'requests', benReqId, 'messages')), {
      senderId: ben.uid, text: 'hello again', createdAt: serverTimestamp()
    }), 'permission-denied');

  /* --------------------------------------------------------------- 10. EMAIL */
  step('10. Email is nowhere in a user document');
  const publicView = await getDoc(doc(eve.db, 'users', sam.uid));
  const keys = Object.keys(publicView.data());
  const emailish = keys.filter((k) => /e-?mail/i.test(k));
  const leaks = Object.entries(publicView.data())
    .filter(([, v]) => typeof v === 'string' && /@/.test(v));
  check('a stranger reading a profile sees no email field',
    emailish.length === 0 && leaks.length === 0,
    `keys=${keys.join(',')}${leaks.length ? ` LEAK=${JSON.stringify(leaks)}` : ''}`);

  /* ---- summary ---- */
  const failedCount = await summarize(users);
  process.exit(failedCount ? 1 : 0);
}

main().catch((err) => {
  console.error('\n\x1b[31mSuite aborted:\x1b[0m', err);
  process.exit(2);
});
