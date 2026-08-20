# Tabled

A mobile-first web app for buying, selling and trading used board games locally —
the listing and discovery half of what Facebook Marketplace and Reddit do badly
for this hobby. Built against `board_game_marketplace_spec.md`.

**This build covers M1–M4.** See [Where this build stops](#where-this-build-stops)
for exactly what's in and what isn't.

No build step, no bundler, no npm for the web app itself. Classic scripts plus
one ES module for the Firebase bootstrap, the same shape as the other apps in
this stack.

---

## Run it right now

```sh
cd d:/claudecode/tabled
python -m http.server 8791
# open http://127.0.0.1:8791
```

The live project (`tabled-2ad11`) is wired into `js/firebase-config.js`, so this
talks to real Firestore once the console steps below are done.

**To work against sample data instead, add `?demo=1`:**

```
http://127.0.0.1:8791/index.html?demo=1
```

That forces the local sample-data backend even with the real project configured
— sample listings, a fake signed-in user, everything in localStorage. Use it for
previewing UI changes and for the browser tests, so neither writes to
production. It's not a security hole and can't become one: demo mode reads
nothing from Firestore, writes nothing to it, and grants no permission. The
banner stays visible the whole time so sample data is never mistaken for real.

Use a real HTTP server, not `file://`. The Firebase bootstrap is an ES module
and modules are blocked over `file://` by CORS rules.

---

## Going live: the Firebase console steps

These are the manual parts. Nothing in the code can do them for you.

### 1. The project — done

Project **`tabled-2ad11`**, already pasted into `js/firebase-config.js`.

`measurementId` (`G-XW6L79S81R`) is recorded in a comment but **not wired up** —
Analytics needs another SDK import and a consent story this app doesn't have
yet, and nothing reads from it.

### Why the API key is committed to a public repo

`js/firebase-config.js` contains a real Firebase API key, in version control, on
purpose. That is not a leak. A Firebase web API key is an *identifier*, not a
credential — it says which project a request is for, and grants nothing on its
own. Every web client necessarily ships it; there is no version of this app
where it stays secret.

What actually protects the project is `firestore.rules`, `storage.rules` and
Google Auth. Those are deployed and verified: an unauthenticated write to
`users/` or `games/` returns `PERMISSION_DENIED` today.

The keys that *are* credentials — geocoding, and Stripe at M8 — live in Cloud
Functions Secret Manager and never touch this repo. `.gitignore` carries
service-account patterns as a backstop.

Worth doing anyway: in **Google Cloud Console → APIs & Services → Credentials**,
restrict the browser key to HTTP referrers for your domains. It doesn't protect
data (the rules do that) but it stops someone else's site burning your quota.

Those values are public by design — a web client cannot hide them,
and Firebase doesn't expect it to. Security lives in `firestore.rules`,
`storage.rules` and Google Auth. **The keys that genuinely must stay secret
(geocoding, later Stripe) live in Cloud Functions and never appear in this
repo.**

### 2. Authentication

**Authentication → Sign-in method → Google → Enable.** Set a support email.

Then **Authentication → Settings → Authorized domains**, and add wherever you'll
serve from. `localhost` is there by default; `127.0.0.1` is **not** — add it, or
local sign-in fails with an unhelpful error.

### 3. Firestore — done

**Firestore, not Realtime Database.** The console lists both under Build, both
call themselves a database, and both have a "Rules" tab — but they are different
products with incompatible rule languages. Firestore rules are the
`rules_version` / `service cloud.firestore` DSL in `firestore.rules`. Realtime
Database rules are **JSON**. Pasting one into the other's editor produces
`Line 1: Parse error` and nothing else, because line 1 of a Firestore rules file
isn't valid JSON.

You don't need to create it or paste anything: `firebase deploy` created the
database (`nam5`, Native mode) and released the rules. Don't hand-paste rules
into the console at all — the file in this repo is the source of truth, and
pasting is how the two drift apart.

```sh
firebase deploy --only firestore:rules,firestore:indexes
```

```sh
npm i -g firebase-tools     # already installed on this machine
firebase login
firebase use --add          # pick the project you just made
firebase deploy --only firestore:rules,firestore:indexes
```

Index creation takes a few minutes. Queries fail with a clear error until they
finish building.

### 4. Storage

**Storage → Get started.** Then:

```sh
firebase deploy --only storage
```

### 5. Cloud Functions — needs the Blaze plan

**This is the part with a cost implication.** Cloud Functions require the
pay-as-you-go **Blaze** plan. The free tier inside Blaze is generous (2M
invocations/month) and this app's usage at launch will round to zero, but it
does require a card on file. Set a budget alert while you're in there.

Everything in `functions/` is only reachable on Blaze. Without it, the app still
runs — you lose BGG search, geocoding, view counts, hot-score decay and the
auto-hide circuit breaker, and the UI degrades to manual game entry.

```sh
cd functions && npm install && cd ..

# Geocoding key — enable the Geocoding API in Google Cloud Console first,
# then create an API key and restrict it to that API.
firebase functions:secrets:set GEOCODING_API_KEY

firebase deploy --only functions
```

The scheduled function (`recomputeHotScores`) also needs the **Cloud Scheduler
API** enabled. The first deploy will prompt you with a link.

### 6. Hosting — two options

**Firebase Hosting:**

```sh
firebase deploy --only hosting
```

`firebase.json` is already configured: `index.html` is served `no-cache` (its
`?v=` stamps are what version everything else), and JS/CSS cache for a year.

**GitHub Pages** (`oldgodsslumber.github.io` is already an authorized domain):
Settings → Pages → deploy from `main` / root. The app works from a subpath
unchanged — every asset reference in `index.html` is relative, and routing is
hash-based, so `oldgodsslumber.github.io/tabled/` needs no base-href juggling
and no SPA rewrite rules.

Two Pages caveats:

- **No `no-cache` control.** Pages sets its own headers, so the `?v=` stamps in
  `index.html` are doing all the cache-busting work. Bump `CFG.BUILD` and every
  stamp together on each deploy or people keep the old app.
- **Add the Pages origin to Authorized domains** in Firebase Auth, or Google
  sign-in fails there with an unhelpful error. `oldgodsslumber.github.io` is
  already added.

---

## What lives where

| File | What it is |
|---|---|
| `js/config.js` | Every tunable: condition tiers, tag list, report reasons, thresholds, Hot weights, BGG categories. Start here to change vocabulary. |
| `js/util.js` | Escaping, DOM helpers, toast, modal, formatting, client-side photo resize. |
| `js/geo.js` | Geohash encode, 9-cell query bounds, haversine, privacy jitter. Loaded by both browser and (mirrored) functions. |
| `js/store.js` | The data layer. Cloud + demo backends behind one interface, plus the rollup builder and filter pipeline. |
| `js/bgg.js` | Client half of the BGG proxy, with a small offline catalog for demo mode. |
| `js/safety.js` | Report sheet and blocking. |
| `js/views-*.js` | Feed, listing detail, create/edit, profile + settings, thread, dashboard. |
| `js/app.js` | Router, shell, auth gate. |
| `js/firebase-config.js` | **Paste your config here.** ES module, loaded last. |
| `functions/index.js` | BGG proxy, geocoding, counters, hot recompute, auto-hide. |
| `firestore.rules` | Per-collection rules, including M4–M9 collections ruled ahead of time. |

**Cache-busting:** every `?v=` stamp in `index.html` must match `CFG.BUILD` in
`js/config.js`. Bump both on every change, or the browser will happily serve a
mix of old and new files and the fix you just made will not reach it.

---

## Three things the spec didn't anticipate

These came out of building it. All three are load-bearing.

### 1. Listings carry a denormalized rollup of their game entries

Every filter in the spec — category, condition, tags, price — lives on a
`gameEntries` document. But the feed queries `listings`, and **Firestore cannot
filter a parent document by the contents of its subcollection.** There is no
join.

So every write recomputes a rollup onto the listing doc: `categories`,
`mechanics`, `conditions`, `tags`, `bggIds`, `gameNames`, `minPrice`,
`maxPrice`, `bestDealScore`, `coverPhoto`, `entryCount`, `searchTokens`. The
subcollection stays authoritative; the rollup is a query index that happens to
be made of fields.

This also makes the feed cheap: 24 cards cost 24 document reads, not 24 reads
plus 24 subcollection queries.

If the two ever disagree, the subcollection wins — `Store.buildRollup()` rebuilds
from it.

### 2. "Near me" can't be combined with server-side filtering

Firestore allows **one range filter per query**. Distance search spends it on
the geohash range. So when a radius is active, category / condition / tags /
text all narrow on the client instead, over a bounded sample from nine geohash
cells.

Two consequences you can see in the UI:

- Near-mode results are a bounded sample, not a paginated set, so there's
  deliberately no "Load more" with a radius on — it would re-show the same cards.
- Very dense areas could in principle push results past the per-cell cap. Not a
  problem at launch scale; worth revisiting if a metro ever gets thousands of
  active listings.

### 3. Text search is prefix-indexed at write time

Firestore has no full-text search and no "starts with" on arrays. So
`Store.tokenize()` stores *every prefix* of every word in the listing's title
and game names — "gloomhaven" becomes `gl, glo, gloo, gloom, …` — and search
does `array-contains` against the prefix. The cost is paid once on write instead
of on every query.

Capped at 300 tokens and 12 characters per prefix (`CFG.SEARCH`). Long titles
also store their whole word so an exact search still hits.

If search ever needs to cover bios, notes, or fuzzy matching, that's the point
to move to Algolia or Typesense rather than growing this.

---

## Decisions worth knowing about

**Hot is requests-weighted hard.** `(views + requests × 20) / (ageHours + 2)^1.5`
— Hacker-News-shaped gravity. Two real requests outrank a hundred idle views,
because a view is a thumb scrolling past and a request is intent. The formula
lives in **two places** (`CFG.HOT` and `functions/index.js`) because the client
computes it live for brand-new listings that the hourly job hasn't reached yet.
Change both together.

**Locations are fuzzed once, server-side, and stored.** `geocodeArea` displaces
the geocoder's answer by up to 1.5 miles, uniformly by area, and returns only
the displaced point. The true coordinate is never returned, never logged, never
stored. Fuzzing on *read* instead would be worthless — anyone watching a point
could average the jitter away.

**Denormalized fields are Cloud-Function-only, including for the document's
owner.** `verifiedSeller`, `tradeCount`, `avgRating`, `viewCount`, `hotScore`,
`openReportCount` and all hold/queue state are blocked by `firestore.rules` even
for the account they belong to. A blanket "owner can write their own doc" rule
would let anyone set their own Verified badge.

**Email is never surfaced.** `js/firebase-config.js` doesn't even pass
`user.email` through to the app, so nothing downstream can render it by
accident.

**Tabled is US-only, enforced in one place.** Every `geoPoint` in the system —
on a user, on a listing — comes out of the `geocodeArea` Cloud Function, so
gating that one function gates the whole app. It sends `components=country:US`,
which is a *hard filter* (Google returns ZERO_RESULTS for a foreign address, it
doesn't match it), then independently verifies the returned country code,
because a malformed `components` parameter is silently ignored by the API and
would turn the filter back into no filter with nothing in the response to say
so.

A non-US area **blocks the save** rather than saving without distance search.
That distinction is the entire point — the generic "geocoding failed" path is
deliberately non-fatal, and swallowing the out-of-region rejection alongside it
would let a non-US listing through the gate built to stop it.

`firestore.rules` adds a coarse bounding-box check as defence-in-depth against a
modified client writing a `geoPoint` directly. Be precise about what that
catches: it rejects other continents, and it cannot reject Toronto or Monterrey
— no rectangle separates the US from Canada and Mexico, since reaching Alaska at
72°N necessarily covers all of Canada. It's a sanity check, not the gate. Don't
grow it into a polygon chasing cases the function already handles exactly.

Widening to a US territory is a one-line edit in **three** places
(`CFG.GEO.countries`, `ALLOWED_COUNTRIES` in `functions/index.js`, and the rules
box). Note that Google's geocoder treats US territories as *separate countries*:
Puerto Rico is `PR`, Guam `GU`, the USVI `VI` — none of them match `country:US`.

**Auto-hide is a circuit breaker, not moderation.** 3 open reports hides a
listing; 5 restricts a user from creating anything new. Deterministic report IDs
(`{reporter}_{type}_{target}`) mean one person can't inflate a count by
reporting twice. An owner can still open and edit a hidden listing — they just
can't un-hide it. Message and event reports are recorded but carry no automatic
consequence, because auto-hiding chat messages on a report count is trivially
weaponizable between two people already arguing.

**Reports are write-only from the client.** Nobody can read the collection — not
even the person who filed. A readable report collection tells a bad actor
exactly how close they are to a threshold. Read them in the Firebase console
until an admin view exists.

---

## How requests and chat work (M4)

**One request per game entry, not per listing.** Someone who only wants the
Wingspan out of a three-game bundle shouldn't have to ask for all three, so the
request button lives on each game.

**M4 is first-come-first-served.** The queue that lets a second person wait in
line is M5. Until then, a game with an open request says so instead of quietly
opening a second competing thread. The check runs twice — once on render, once
immediately before the write — so losing the race reads as "someone got there
first" rather than producing two threads for one game.

**A proposed time never schedules itself.** Either side can propose; the
*seller* always confirms. This is enforced in `firestore.rules`, not just in the
UI — without that rule a buyer could propose a time and immediately mark it
scheduled themselves, which is the entire gate the spec describes. Declining
returns the buyer to holder state rather than ending the request: they proposed
in good faith and shouldn't lose their place over a time that didn't suit.

**Scheduling changes are also posted into the chat.** A state change that only
appears in a header the other person has to notice is a state change that gets
missed.

**Unread is derived, not stored as a counter.** Each request carries
`lastMessageAt` / `lastMessageSenderId` and a per-role `lastReadBuyerAt` /
`lastReadSellerAt`. A thread is unread when the last message is newer than your
read mark *and you didn't send it* — without that second half, your own message
marks your own thread unread. Marking read is deliberately allowed even on a
frozen `completed` request (it's per-user bookkeeping, not trade state) and
deliberately does **not** touch `updatedAt`, so reading a thread doesn't
reorder everyone's dashboard.

**One subscription, two consumers.** The dashboard and the nav's unread badge
both read from a single `Store.onMyRequests` stream. Two subscriptions would
double the read cost of every message anyone sends, for identical data.

**Views that hold Firestore listeners must expose a teardown.** `app.js`
replaces `#view` on every route change, which drops DOM listeners for free — but
a Firestore listener is not a DOM listener. It survives its element, keeps
billing reads, and keeps calling back into a detached tree. `ThreadView` and
`DashboardView` are torn down explicitly in the router, and each also checks
`document.body.contains(root)` in its callbacks as a second line of defence.

**Deferred from M4 on purpose:** the in-app notification bell and
`notifications` subcollection. The dashboard badge already covers new messages
and pending proposals, and the remaining notification types the spec lists
(`queueAdvanced`, `timeConfirmed`) belong to events that don't exist until
M5/M6. Building the collection now would mean writing rules for notifications
nothing can yet generate.

---

## Where this build stops

**Working now (M1–M4):**

- Google sign-in, profile creation and editing, settings
- Create / edit / delete listings, multi-game bundles, per-game condition, tags,
  photos, price and notes
- Client-side photo downscale + upload to Storage
- BGG search-as-you-type, cached `games` collection, box art, suggested price,
  "% under BGG" deal badges
- Browse feed and search with New / Hot / Good Deal sorts
- Filters: distance, category, condition, tags, fulfillment
- Geocoding + fuzzing + geohash radius search, **locked to the United States**
  (50 states + DC), with `countryCode`/`state` stored on users and listings
- Reporting (listing / user / message / event reason sets), auto-hide circuit
  breaker, per-user blocking
- Per-game requests, real-time chat, propose → seller confirms/declines,
  dashboard split by role, unread badge, cancel/decline
- Full demo mode with no Firebase at all — including chat, via a small pub/sub
  that stands in for `onSnapshot`, so the views exercise the same real-time code
  path they'll use against Firestore

**Deliberately not built yet:**

- **M5 — Hold & queue.** `gameEntries` already carries `status`,
  `currentHoldRequestId`, `holdExpiresAt` and `queueCount`, seeded to defaults
  and locked to functions in the rules, so M5 updates them in place rather than
  migrating.
- **M6 — Auto-book.** `bookedSlots` is ruled (client writes denied) but unused.
- **M7 — Completion & reviews.** The thread's confirmed-time card says outright
  that marking a trade complete is a later milestone. `completed` is currently
  unreachable from the client — the rules only permit the statuses M4 uses, so
  nothing can slip into a frozen state before mutual confirmation exists.
  Review rules are written and enforce one-per-trade, participants-only,
  immutable.
- **M8 — Stripe fees.** `verifiedSeller` renders as a badge and is already
  unwritable by clients. Nothing charges anything.
- **M9 — Events.** "In person at an event" is visible but disabled in the create
  form. `events` rules and the event-scoped index exist.

The `feeWaiverEndDate` in `config/global` is not created by any code — add it by
hand in the console when you get to M8.

---

## Testing

There's no test runner in the repo, but two things are worth re-running after
changes to the data layer:

- `node --check js/*.js functions/*.js` catches syntax errors before a browser does.
- The pure logic in `store.js` and `geo.js` — rollups, tokenizer, filter
  pipeline, geohash, jitter — is deliberately dependency-free and testable in
  plain Node with a small `document`/`localStorage` shim.

---

## Known rough edges

- **Rules files use `//` comments only.** Firebase Security Rules do not accept
  `/* */` block comments — they fail to parse, and the reported line numbers
  point at the file header and the `service` declaration rather than at the
  comment itself, which sends you looking in the wrong place. Both
  `firestore.rules` and `storage.rules` were originally written with block
  comments and had to be converted. Don't reintroduce them.

- **Composite indexes.** The first time you hit a filter combination that isn't
  in `firestore.indexes.json`, the query fails. The browser console error
  carries a one-click link to create exactly the missing index — the feed's
  error state says so explicitly rather than showing a generic failure.
- **BGG rate limits are real and undocumented.** Search is debounced to 450ms
  and cached per query string for the page's lifetime. A 429 surfaces as "BGG is
  rate-limiting us", never as a silent retry loop.
- **BGG's `thing` endpoint answers cold requests with HTTP 202 and an empty
  body**, meaning "queued, ask again". `bggFetch` retries up to 3 times with
  backoff. Treating 202 as success would cache an empty game record.
- **`suggestedPrice` is often null.** It's the median of USD marketplace
  listings and needs at least three of them. Games with no price data simply
  drop out of the Good Deal sort rather than sorting as if they were free.
- **`functions/geo.js` is a hand-copy of `js/geo.js`.** `firebase deploy` only
  uploads `functions/`, so a `require('../js/geo.js')` works locally and fails
  in production. If you change the geohash encoding, change both — a mismatch
  would file listings into cells the client never queries, with no error
  anywhere to explain why they vanished from distance search.
