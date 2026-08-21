#!/usr/bin/env node
/* Bootstrap the first admin.
 *
 * setUserRole is admin-only, which leaves an obvious chicken-and-egg problem:
 * there is no admin to call it. This script closes that loop from a machine
 * that already holds a service-account key.
 *
 * It is deliberately NOT a deployed callable. A "make me an admin" endpoint
 * sitting in production — however it is guarded — is a permanent
 * privilege-escalation surface for the sake of a one-time action. A script run
 * locally leaves nothing behind.
 *
 * ---- Usage ----
 *
 *   1. Firebase console -> Project settings -> Service accounts
 *      -> "Generate new private key". Save it OUTSIDE this repo.
 *      (.gitignore blocks *-adminsdk-*.json as a backstop, but keeping the
 *       file elsewhere entirely is better than relying on that.)
 *
 *   2. From the functions/ directory:
 *
 *      GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json \
 *        node scripts/grant-role.js <email-or-uid> admin
 *
 *      Roles: admin | moderator | none
 *
 *   3. DELETE THE KEY when you're done. It is the whole project.
 *
 * ---- The gotcha ----
 *
 * Custom claims live in the ID token. An already-signed-in user carries a
 * token issued before the grant and will keep getting permission-denied from
 * firestore.rules until it refreshes — up to an hour. Tell them to sign out
 * and back in, or reload; the app forces a refresh on boot.
 */

const admin = require('firebase-admin');

const [, , who, roleArg] = process.argv;

if (!who || !roleArg) {
  console.error('Usage: node scripts/grant-role.js <email-or-uid> <admin|moderator|none>');
  process.exit(1);
}

const role = roleArg === 'none' ? null : roleArg;
if (role !== null && role !== 'admin' && role !== 'moderator') {
  console.error("Role must be 'admin', 'moderator' or 'none'.");
  process.exit(1);
}

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('GOOGLE_APPLICATION_CREDENTIALS is not set — point it at a service-account key.');
  process.exit(1);
}

admin.initializeApp();

(async () => {
  try {
    /* Accept either an email or a raw uid, because you will have one or the
     * other to hand and looking the wrong one up is friction for no reason. */
    const user = who.includes('@')
      ? await admin.auth().getUserByEmail(who)
      : await admin.auth().getUser(who);

    await admin.auth().setCustomUserClaims(user.uid, role ? { role } : {});

    /* Mirrored onto the profile so the console can list staff. Display only —
     * the claim is what rules actually trust. */
    await admin.firestore().collection('users').doc(user.uid)
      .set({ staffRole: role }, { merge: true });

    await admin.firestore().collection('adminActions').add({
      action: 'setUserRole',
      targetType: 'user',
      targetId: user.uid,
      reason: 'bootstrap via scripts/grant-role.js',
      actorUid: 'script',
      actorName: 'grant-role.js',
      actorRole: 'script',
      result: { role },
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`${user.email || user.uid} -> ${role || 'no role'}`);
    console.log('They must sign out and back in (or reload) before it takes effect —');
    console.log('custom claims only reach the client on the next ID token refresh.');
    process.exit(0);
  } catch (err) {
    console.error('Failed:', err.message);
    process.exit(1);
  }
})();
