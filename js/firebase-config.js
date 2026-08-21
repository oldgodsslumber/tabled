/* Tabled — Firebase bootstrap (ES module, loaded last).
 *
 * PASTE YOUR CONFIG BELOW. Until you do, the app runs in demo mode with sample
 * listings in localStorage — fully browsable, nothing shared, nothing saved
 * anywhere but this browser.
 *
 * These values are public by design. A web client cannot hide them, and Firebase
 * does not expect it to: security comes from firestore.rules, storage.rules and
 * Google Auth, never from keeping the API key secret. The keys that DO need
 * hiding (geocoding, Stripe) live in Cloud Functions and never appear here.
 *
 * On the console's snippet: it shows `import ... from "firebase/app"`, which is
 * bare-module syntax that only resolves under a bundler. This app has no build
 * step, so the same SDK is imported from its gstatic CDN URLs instead. Same
 * library, same pinned version, no npm.
 *
 * Setup steps are in README.md. The short version:
 *   1. Create a project, add a Web app, paste its config here.
 *   2. Enable Google sign-in under Authentication.
 *   3. Create a Firestore database and publish firestore.rules.
 *   4. Enable Storage and publish storage.rules.
 *   5. Authorize your domain under Authentication → Settings.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField,
  collection, getDocs, query, where, orderBy, limit, startAfter, startAt, endAt,
  serverTimestamp, increment, writeBatch, onSnapshot, GeoPoint
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut as fbSignOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';
import {
  getFunctions, httpsCallable
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCSEJmQufJ1hTwbLbg1kfpLXR-xAqvbOHs',
  authDomain: 'tabled-2ad11.firebaseapp.com',
  projectId: 'tabled-2ad11',
  storageBucket: 'tabled-2ad11.firebasestorage.app',
  messagingSenderId: '248565786396',
  appId: '1:248565786396:web:91a8aa6ec9e1824532fcd9'
  /* measurementId: 'G-XW6L79S81R' — Analytics is not wired up. Adding it means
   * another SDK import and a consent story we don't have yet, and nothing in
   * the app reads from it. The ID is recorded here for when that changes. */
};

/* Cloud Functions region. Must match the region in functions/index.js — a
 * mismatch produces a CORS error rather than a helpful one, which is a
 * miserable thing to debug from the symptom alone. */
const FUNCTIONS_REGION = 'us-central1';

const configured = Object.keys(firebaseConfig).every(
  (k) => firebaseConfig[k] && !String(firebaseConfig[k]).startsWith('PASTE_')
);

/* `?demo=1` forces the local sample-data backend even when the real project is
 * configured. This is for previewing UI changes and for automated browser tests
 * without writing to production.
 *
 * It is not a security hole and can't become one: demo mode is pure
 * localStorage. It reads nothing from Firestore, writes nothing to it, and
 * grants no permission — the rules are untouched and unreachable. The env
 * banner stays visible throughout so nobody mistakes sample data for real. */
const forceDemo = /(?:^|[?&])demo=1(?:&|$)/.test(location.search);

if (!configured) {
  App.useDemo('firebase-config.js still holds placeholders');
} else if (forceDemo) {
  App.useDemo('forced by ?demo=1');
} else {
  try {
    const app = initializeApp(firebaseConfig);
    const db = getFirestore(app);
    const auth = getAuth(app);
    const storage = getStorage(app);
    const functions = getFunctions(app, FUNCTIONS_REGION);

    /* Store and BGG are classic scripts and can't `import`, so the modular SDK's
     * functions are handed to them as a plain object instead. One place knows
     * about module syntax; everything downstream stays a normal script. */
    const fb = {
      doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField,
      collection, getDocs, query, where, orderBy, limit, startAfter, startAt, endAt,
      serverTimestamp, increment, writeBatch, onSnapshot, GeoPoint,
      storageRef, uploadBytes, getDownloadURL, deleteObject,
      httpsCallable
    };

    /* Popup rather than redirect, everywhere. On iOS/WebKit signInWithRedirect
     * silently fails when authDomain differs from the page origin — WebKit
     * partitions the auth handler's storage and the redirect returns with no
     * session, no error. The popup posts the credential straight back. */
    const provider = new GoogleAuthProvider();

    App.useCloud({
      fb, db, storage, functions,
      callable: (name, payload) =>
        httpsCallable(functions, name)(payload || {}).then((r) => r.data),
      signIn: () => signInWithPopup(auth, provider),
      signOut: () => fbSignOut(auth)
    });

    onAuthStateChanged(auth, async (user) => {
      if (!user) { App.setUser(null); return; }

      /* Force a token refresh so a role granted since the last sign-in is
       * actually present. Custom claims only reach the client when the ID
       * token is reissued, and Firebase does that roughly hourly on its own —
       * so without this, a newly-promoted admin gets permission-denied from
       * the rules for up to an hour, which looks exactly like a broken build.
       *
       * A failure here is non-fatal: fall back to whatever the cached token
       * says rather than blocking sign-in over a role most users don't have. */
      let role = null;
      try {
        const token = await user.getIdTokenResult(true);
        role = (token.claims && token.claims.role) || null;
      } catch (err) {
        console.warn('[tabled] could not refresh ID token for role claim', err);
      }

      App.setUser({
        uid: user.uid,
        displayName: user.displayName,
        photoURL: user.photoURL,
        role
        /* user.email is deliberately not passed through. Nothing downstream
         * should be able to accidentally render it or write it to a doc. */
      });
    });
  } catch (err) {
    console.error('[tabled] Firebase failed to initialize', err);
    App.useDemo('Firebase initialization threw: ' + err.message);
  }
}
