#!/usr/bin/env node
/* Wipe the testing-era data at the BoardGameGeek cutover.
 *
 * Tabled ran its early testing on Wikidata + hand-entered games. When BGG
 * becomes the real source, that test activity should not carry into launch --
 * fake listings, fake trades, fake reviews, and a homegrown game cache that BGG
 * supersedes. This script clears it from a machine holding a service-account
 * key, the same way scripts/grant-role.js bootstraps the first admin.
 *
 * It is deliberately NOT a deployed callable. A "delete everything" endpoint in
 * production is a permanent foot-gun no guard makes safe; a local script run
 * once leaves nothing behind.
 *
 * ---- What it does ----
 *
 *   1. EXPORTS gameSubmissions (the log of hand-entered games -- titles that
 *      weren't in BGG or Wikidata) to a JSON file FIRST, so the one genuinely
 *      irreplaceable thing survives the wipe.
 *   2. Deletes, in full (documents + subcollections): listings, requests,
 *      reviews, reports, adminActions, meetingDetails, messageArchive,
 *      safeSpots, events, gameSubmissions.
 *   3. Deletes games whose source is 'wikidata' or 'manual' (BGG-sourced games,
 *      if any exist, are kept -- they're the definitive data).
 *   4. Users, per --mode:
 *        keep-users (default) -- KEEP each profile's identity (name, photo, bio,
 *          ZIP/geo, availability, promo, vip) but RESET its reputation counters
 *          (tradeCount, avgRating, reviewCount, openReportCount, restricted) and
 *          clear its notifications + bookedSlots, so a tester doesn't launch
 *          looking like a veteran.
 *        wipe-all -- delete user documents entirely (and their subcollections).
 *
 *   The `config` collection is always left untouched.
 *
 * ---- Usage ----
 *
 *   1. Firebase console -> Project settings -> Service accounts
 *      -> "Generate new private key". Save it OUTSIDE this repo.
 *
 *   2. From the functions/ directory:
 *
 *      GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json \
 *        node scripts/reset-testdata.js --confirm [--mode=keep-users|wipe-all] [--out=file.json]
 *
 *      Without --confirm it does a DRY RUN: it prints what it would delete and
 *      still writes the gameSubmissions export, but deletes nothing.
 *
 *   3. DELETE THE KEY when you're done.
 */

const admin = require('firebase-admin');
const fs = require('fs');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : dflt;
};

const confirm = has('--confirm');
const mode = val('--mode', 'keep-users');
const outFile = val('--out', 'gameSubmissions-export.json');

if (mode !== 'keep-users' && mode !== 'wipe-all') {
  console.error("--mode must be 'keep-users' or 'wipe-all'.");
  process.exit(1);
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('GOOGLE_APPLICATION_CREDENTIALS is not set — point it at a service-account key.');
  process.exit(1);
}

admin.initializeApp();
const db = admin.firestore();

/* Collections wiped in full. `config` is intentionally absent; `users` and
 * `games` are handled specially below. */
const WIPE_WHOLE = [
  'listings', 'requests', 'reviews', 'reports', 'adminActions',
  'meetingDetails', 'messageArchive', 'safeSpots', 'events', 'gameSubmissions'
];

/* Fields reset to a pristine account on keep-users. Everything else on the user
 * doc (displayName, photoURL, bio, generalArea, geoPoint, geohash, countryCode,
 * state, availabilityWindows, timeZone, promo, vip*, createdAt) is preserved. */
const USER_COUNTER_RESET = {
  tradeCount: 0,
  avgRating: null,
  reviewCount: 0,
  openReportCount: 0,
  restricted: false
};

async function countCollection(name) {
  const snap = await db.collection(name).count().get();
  return snap.data().count;
}

async function exportSubmissions() {
  const snap = await db.collection('gameSubmissions').get();
  const rows = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  fs.writeFileSync(outFile, JSON.stringify(rows, null, 2));
  console.log(`  exported ${rows.length} gameSubmissions -> ${outFile}`);
  return rows.length;
}

(async () => {
  try {
    console.log(`\nProject: ${admin.app().options.projectId || '(from credentials)'}`);
    console.log(`Mode:    ${mode}`);
    console.log(confirm ? 'RUN: data WILL be deleted.\n' : 'DRY RUN: nothing will be deleted (pass --confirm to execute).\n');

    // 1. Always export first -- even on a dry run, so you can eyeball it.
    await exportSubmissions();

    // Report sizes up front.
    for (const c of WIPE_WHOLE) {
      console.log(`  ${c}: ${await countCollection(c)} docs`);
    }
    const usersCount = await countCollection('users');
    console.log(`  users: ${usersCount} docs (${mode})`);

    if (!confirm) {
      console.log('\nDry run complete. Re-run with --confirm to delete.');
      process.exit(0);
    }

    // 2. Wipe whole collections (recursiveDelete clears subcollections too:
    //    listings/*/gameEntries and requests/*/messages).
    for (const c of WIPE_WHOLE) {
      await db.recursiveDelete(db.collection(c));
      console.log(`  wiped ${c}`);
    }

    // 3. games: drop only the testing sources; keep anything BGG-sourced.
    let gamesDropped = 0;
    for (const src of ['wikidata', 'manual']) {
      const snap = await db.collection('games').where('source', '==', src).get();
      for (const d of snap.docs) { await d.ref.delete(); gamesDropped++; }
    }
    console.log(`  dropped ${gamesDropped} games (wikidata/manual)`);

    // 4. users.
    if (mode === 'wipe-all') {
      await db.recursiveDelete(db.collection('users'));
      console.log('  wiped users');
    } else {
      const snap = await db.collection('users').get();
      for (const d of snap.docs) {
        // Clear activity subcollections, keep identity.
        await db.recursiveDelete(d.ref.collection('notifications'));
        await db.recursiveDelete(d.ref.collection('bookedSlots'));
        await d.ref.update(USER_COUNTER_RESET);
      }
      console.log(`  reset ${snap.size} users (counters cleared, identity kept)`);
    }

    console.log('\nReset complete. Remember to delete the service-account key.');
    process.exit(0);
  } catch (err) {
    console.error('\nReset failed:', err);
    process.exit(1);
  }
})();
