# Multi-user tests

These run against the **Firebase Emulator Suite**, never a real project.

```sh
# 1. once, if you have no JDK — the Firestore emulator is a Java process
winget install Microsoft.OpenJDK.21

# 2. deps (test/node_modules is gitignored)
cd test && npm install

# 3. emulators, in their own terminal, from the repo root
firebase emulators:start --only auth,firestore,functions --project demo-tabled

# 4. the suite
node test/trade-e2e.mjs
```

## Why this exists

Demo mode cannot test a trade. It is per-browser `localStorage` with one seeded
user, so two accounts can never see each other and a two-party trade is
structurally impossible. It also mirrors the server logic *without being the
server*: no `firestore.rules`, no Cloud Functions, no triggers — which is
exactly where every recent bug has lived (the `verifiedSeller` create rule, the
`latlng` methods in `geoOk`, `geoPoint` writes being denied outright, and the
transaction read-ordering bug that stopped any trade from ever completing).

So these tests drive real signed-in users through the real rules and the real
`functions/index.js`.

## Safety

The project id is `demo-tabled`. The Firebase CLI treats any id beginning with
`demo-` as offline-only, and the test process holds no credentials. These
scripts **cannot** reach `tabled-2ad11` — with the emulators down they fail to
connect rather than falling through to production.

## Layout

| file | what it is |
|---|---|
| `harness.mjs` | shared helpers: users, listings, slots, assertions. Import this. |
| `trade-e2e.mjs` | the happy path — 5 users, 2 trades, list → queue → schedule → confirm → review |
| `attacks/` | adversarial scripts: each one tries to break a specific invariant |

`harness.mjs` deliberately mirrors `CloudBackend` in `js/store.js` field for
field. When the two drift, these tests fail with a `permission-denied` from the
real rules rather than silently testing a shape the app never writes — that is
the point of mirroring rather than inventing a fixture.

Emulator state persists between runs, so every script gets a fresh per-run
identity suffix (`RUN` in `harness.mjs`). Re-running does not require
restarting the emulators, and scripts can safely run concurrently.
