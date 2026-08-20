# Tabled

A mobile-first web app for buying, selling and trading used board games locally —
the listing and discovery half of what Facebook Marketplace and Reddit do badly
for this hobby. Built against `board_game_marketplace_spec.md`.

**This build covers M1–M10** — every milestone in both spec documents — plus a
US-only geo-lock. See
[Where this build stops](#where-this-build-stops) for exactly what's in and what
isn't.

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

Index creation takes a few minutes. Queries fail with a clear error until they
finish building.

### 4. Storage — needs Blaze

**Storage → Get started.** Note that Firebase now requires the **Blaze plan** to
enable Cloud Storage on newly created projects, so this and the Functions step
below unblock together. Then:

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

**Don't run two deploys at once.** Concurrent deploys collide with
`HTTP 409: the resource is being created and therefore can not be updated yet`,
and a Firestore-trigger function caught mid-creation can land as an HTTPS
function instead. Those can't be converted in place — the fix is
`firebase functions:delete <name> --region us-central1` and redeploy.

### 5b. Stripe — needed before the fee waiver ends

Three secrets in total. All three currently hold the sentinel
`PLACEHOLDER_SET_A_REAL_KEY`, which exists so the codebase deploys: `defineSecret`
refuses to deploy *anything* if a referenced secret is absent, so one
unconfigured integration would otherwise block all fifteen functions. Each
function checks for the sentinel and fails with a clear message rather than
sending a fake key upstream.

```sh
# Geocoding — enable the Geocoding API in Google Cloud Console, create a key,
# restrict it to that API.
firebase functions:secrets:set GEOCODING_API_KEY

# Stripe — dashboard.stripe.com → Developers → API keys
firebase functions:secrets:set STRIPE_SECRET_KEY

# Stripe webhook — see below for where this value comes from
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET

firebase deploy --only functions
```

**Wiring the webhook.** In the Stripe dashboard → Developers → Webhooks, add an
endpoint pointing at the deployed `stripeWebhook` URL
(`firebase functions:list` will show it), subscribed to
**`checkout.session.completed`**. Stripe then shows a signing secret starting
`whsec_` — that is the value for `STRIPE_WEBHOOK_SECRET`.

Use Stripe **test mode** keys until you actually want to take money. Test mode
has its own webhook endpoint and its own signing secret; they are not
interchangeable with live ones.

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

## How the queue works (M5)

**Requests can only be created by a Cloud Function.** `firestore.rules` denies
client creates on `requests` outright. This is the one structural constraint the
milestone imposes, and it isn't optional:

- Queue position can't be computed by the client, because a client that writes
  its own `queuePosition` can write `0`.
- It can't be assigned by an `onCreate` trigger either — between the write and
  the trigger the document exists with a position nobody validated, and two
  simultaneous requests would both read "the queue is empty".
- Only a transaction that reads the current queue and writes the new request
  together is correct, and that has to be a function.

A consequence worth knowing: every guard the old client-create rule applied —
blocking, restriction, no self-requests, nothing arriving pre-scheduled — had to
be **re-established inside the callable**, because the admin SDK bypasses rules
entirely. Moving a check server-side means rewriting it there, not assuming it
comes along.

**Queue state is derived, never incremented.** `resyncQueue()` recalculates
positions, entry status, holder and `queueCount` from the open request set every
time it runs. An incremented counter drifts the first time a write is retried or
lost, and a listing that says "3 waiting" with two people in the queue is worse
than showing nothing. Being derived also makes the whole thing idempotent, which
is why the expiry sweep can safely resync entries the trigger will resync again.

**A promoted holder gets a fresh full window**, not the remainder of the one the
previous holder burned through. They've only just been told it's their turn.

**Three expiry cases, deliberately different:**

| Case | What happens |
|---|---|
| Holder never landed on a time within 24h | Expires, queue moves up |
| Seller never answered a proposal | Reverts to `onHold` with a **fresh** window — the buyer already acted, and a slow seller shouldn't cost them their place |
| Scheduled time passed with no completion | Expires after a 12h grace cushion (the no-show case) |

**A queued buyer can chat but cannot propose a time.** That's the holder's turn
to take, enforced in the rules; the UI just doesn't offer a button that would be
rejected.

**`proposedTime` and `scheduledTime` are Timestamps, not epoch numbers.** This
mattered exactly where predicted: `advanceExpiredHolds` runs range queries
against `scheduledTime`, and Firestore sorts numbers and Timestamps as *separate
type groups* — a mix produces silently wrong sweep results rather than an error.

---

## Auto-book (M6)

**One standing weekly availability per seller**, not per listing. A seller's
free Saturday is a fact about the seller; duplicating it per listing means it's
wrong on most of them within a month.

**Exclusivity is the document ID.** `bookedSlots/{sellerId}_{date}_{startTime}`
plus `.create()`, which fails if the document exists. No transaction, no
locking — the uniqueness of a primary key *is* the lock. Keyed on the seller
rather than the listing, so the same person can't be booked twice at once from
two different listings. There's a test for exactly that case.

That ID is **construct-only, never parsed**. Firebase UIDs are alphanumeric so
the underscore separator is unambiguous in production, but that's a property of
the UID format, not a guarantee of this string — the demo backend's `demo_theo`
already breaks it. Every caller has `date` and `startTime` as fields already.

**Booking produces `proposedTime`, never `scheduled`.** Auto-book and chat
negotiation are two ways of *arriving* at a proposal; what happens after is
identical, and the seller still gets the final Confirm/Decline.

**Slot release is a trigger, not a call site.** A slot has to be freed on
decline, cancel, expiry and completion. One trigger handles all of them, however
the request got there — and it *has* to be server-side anyway, because the rules
deny every client write to `bookedSlots`.

### Timezones, and why this file is more than arithmetic

"Saturday 10:00" is a wall-clock time, not an instant. It means 10:00 where the
**seller** is, because that's who has to be somewhere. But a 50-mile radius
crosses US zone lines in several places and shipping listings are nationwide, so
the buyer may be elsewhere — and this is a scheduling tool, where being an hour
off is the one failure that actually wastes someone's afternoon.

So the seller's IANA zone is stored alongside their windows, windows are
interpreted in it, and everything becomes a real instant before it's stored or
compared. Buyers see slots in **their own** local time, with the seller's clock
in brackets when the zones differ.

`zonedToUtc()` does this without a date library via the Intl offset trick, in
two passes — the offset depends on the instant you're trying to find, and a
single pass lands an hour out on DST boundaries. Note that JS `Date` parsing is
no help here: `new Date('2026-08-22 10:00')` uses the *runtime's* zone, which is
exactly the wrong one. Verified against EST/EDT, cross-zone offsets, Arizona's
no-DST quirk, and a spring-forward boundary.

---

## Completion & trust (M7)

**A trade completes only when BOTH sides say it did.** That is the whole design.
The app can never observe money changing hands outside it, but it *can* observe
two people independently agreeing that it happened — and that agreement is the
one thing neither side can fake alone.

Which is exactly why completion is a Cloud Function and not a client write. A
seller able to mark their own trades complete could manufacture a trade history,
and every trust signal on the profile becomes decorative.

**Completing one trade does a lot at once**, atomically:

| | |
|---|---|
| The request | `completed`, `completedAt` stamped |
| The game entry | `sold`, queue cleared |
| Everyone else queued | closed with `closedReason: 'itemSold'` |
| Both users | `tradeCount` +1 — a trade is symmetric, both sides turned up |
| The listing | archived if every game in it has now sold |

Closing the queue explicitly matters. Anyone still waiting is waiting for
something that no longer exists, and telling them beats letting them find out
when their hold silently lapses — so the thread says "this game sold to someone
else" rather than a bare "expired".

**Archival runs after the transaction, not inside it.** Deciding it needs a read
of every sibling entry, and a transaction that reads a whole subcollection to
settle one boolean is a contention magnet on a busy listing. Worst case is a
listing that stays `active` with everything sold for a moment.

### The fee waiver is decided at completion, not at fee time

`confirmSold` reads `config/global.feeWaiverEndDate` and stamps `feePaid` there
and then. That is what makes the spec's promise true: a trade completed during
the waiver stays free **forever**, even after the cutoff passes.

A missing config doc is treated as waived. The fee system doesn't exist yet, and
defaulting to unpaid would strip the Verified badge off every seller the moment
M8 ships.

### Reviews

The review itself is a client write — the rules can fully express who may write
one (a participant in a completed trade, once, immutably), so a callable would
add a hop without adding a guarantee.

**"Once" is enforced by the document id.** `reviews/{requestId}_{reviewerId}`.
Rules cannot count documents, but they can deny an *update*, and a second
attempt at the same id is an update. Without that, one person could review the
same trade repeatedly and walk an average wherever they liked.

**The average cannot be a client write**, for the same reason as `tradeCount` —
anyone able to set their own `avgRating` would. `onReviewCreate` recomputes it
from the whole collection rather than folding into a running average, which
drifts on any retry and can't be repaired without the full set anyway.

**Reviews are immutable and public.** No edit, no delete. An editable review is
a review that can be traded away during a dispute.

---

## Verification fees (M8)

**The fee does not gate the sale.** It cannot — the app has no visibility into
cash changing hands outside it, so gating on the sale would be unenforceable
theatre. It gates a status the app *fully* controls: whether a profile shows
**Verified**.

This is a seller-to-platform charge. The actual game sale — the $30, the $50,
whatever it goes for — is never touched by the app, never routed through Stripe,
never processed here. That boundary has not moved since the original spec.

**Badge and count are deliberately separate.** `tradeCount` always reflects every
completed trade, paid or not, so a profile never looks artificially thin because
of a fee. `verifiedSeller` is a *current-standing* flag: true only while zero
completed trades carry an unpaid fee. One unpaid trade turns it off; paying turns
it back on. It's a status you maintain, not a threshold you cross once — and
there's a test asserting exactly that.

**Only the signed webhook may mark a fee paid.** `stripeWebhook` is a public
endpoint, so signature verification *is* the security model — without it anyone
could POST a fake "payment succeeded" and mint themselves a badge. Two details
carry that:

- It verifies against **`request.rawBody`**, not the parsed body. Firebase parses
  JSON by default, and a re-serialised body produces a different signature —
  which fails in a way that looks like a Stripe bug rather than our own.
- Nothing above the `constructEvent` call reads the payload.

The handler is idempotent by construction, because Stripe retries: setting a
boolean that is already true costs nothing. It answers **400** on a bad signature
so Stripe stops retrying, and **500** on a Firestore failure so Stripe *does* —
the payment already happened and the badge must eventually reflect it.

**The return URL is validated against an allowlist.** An open redirect here would
let anyone turn a Tabled checkout link into a phishing hop.

**Charging twice is refused at the callable**, not just hidden in the UI. That
turned out to matter: a listener-stacking bug in the dashboard fired the pay
handler twice on one tap, and the server rejected the second attempt exactly as
designed. The UI bug is fixed; the guard stays.

---

## Events & convention selling (M9)

The direct replacement for hunting through a BGG forum thread the week before a
con: a real, searchable, filterable, photo-backed listing scoped to one event.

**Open creation.** Any signed-in user can add an event — no allowlist, no
approval step. Same trust model as listings, backed by reporting rather than
gatekeeping, and it means nobody has to hand-seed every convention someone wants
to sell at. A duplicate or spam event gets reported like a duplicate listing.

**A third fulfillment option, not a location hack.** Selecting it requires
picking or creating an event, and copies that event's dates onto the listing —
copied rather than referenced, so hold timing never needs a second read, and so
editing an event later can't retroactively move every listing's clock.

### Three-phase hold timing

A flat 24h window is wrong in **both** directions for a convention:

| Phase | Hold behaviour | Why |
|---|---|---|
| Before it starts | **No expiry at all** | A listing made in October for a November con shouldn't expire its holder for not proposing a time at an event that doesn't exist yet |
| While it's running | **3 hours**, never past the event's end | A con lasts three days; a 24h hold takes the item off the market for a third of it |
| After it ends | **Force-expired** | The in-person opportunity is gone. The listing itself is untouched — a seller can switch it to shipping-only for whoever missed them |

The no-show grace shortens to **1 hour** for event listings too, for the same
reason: the next person in line needs their turn while the con is still on.

Implementation notes worth keeping:

- **"Paused" is `null`, not a far-future date.** `holdDeadlineFor()` returns
  null before the event starts, and the sweep skips null deadlines — so the
  pause needs no special case anywhere else.
- **Requests carry a denormalized `eventEndDate`.** Firestore cannot join, and a
  sweep that read the parent listing for every open request would be one extra
  read per request per run.
- **`resyncQueue` reads the listing** so a *promoted* holder gets the right kind
  of window — compressed at a live con, none at all before it starts.

Auto-book already constrains slots to the event window; `bookSlot` has rejected
out-of-window times since M6.

---

## Trade proposals (M10)

**A trade proposal is a request with a different payment shape attached.** Same
queue, same chat, same propose/confirm gate, same mutual completion. There is no
parallel system — that reuse is the entire reason this was cheap to add, and it
is the design decision to preserve if this ever grows.

**One deviation from the addendum.** It assumed a client write plus a follow-up
Firestore trigger to reserve the offered item. M5 had already moved request
creation into a callable, so the reservation happens **inside the same
transaction** instead — atomic rather than eventually consistent, which matters
when the thing being reserved is a single physical object.

### `acceptedPayment` is descriptive, with exactly one exception

Cash / PayPal / Venmo / Trades are metadata. None are processed by the app — the
same boundary as the game sale itself. **Trades** is the only one that does
anything: it decides whether the "Propose a trade" button appears. That single
functional effect is enforced server-side, not just hidden in the UI.

### The offered game is reserved on submission

Not when the proposal reaches the front of the queue. It's a single physical
object: letting it sit `active` while it's also on the table in an unrelated
trade is how the same game gets promised twice.

The cost is real and the UI says so — your game is off the market while a
speculative offer sits in someone else's queue. It releases automatically on
decline, cancel or expiry, via the same trigger that advances the queue.
Completion is deliberately excluded from that release: `confirmSold` marks it
**sold**, and releasing it to `active` there would put a traded-away game back
on the market.

A game that is already `reserved`, `onHold` or `sold` can't be offered — each
with its own message, because "that's in a queue" and "you already sold that"
need different responses from the person reading them.

### Completion moves two games

`confirmSold` marks **both** entries sold, archives **both** listings if either
is now empty, and counts the trade for both people. `tradeCount` already
incremented both sides at M7, since a trade is symmetric — that needed no
change.

### Unlisted offers

"Describe something I have" exists because most people's shelves aren't listed.
Nothing is reserved (there's no document to reserve), and per the addendum's open
question, nothing is recorded against the offerer's history unless the trade
actually completes.

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
- Hold & queue: server-assigned positions, "you're #3 in line", automatic
  promotion on cancel or expiry, 24h hold with a 12h no-show grace
- Auto-book: one standing weekly availability per seller, 30-minute slots,
  one-tap claiming with deterministic-ID exclusivity, timezone-correct
- Completion & trust: mutual sold-confirmation, listing archival, trade counts
  for both sides, immutable one-per-trade reviews with denormalized averages
- Verification fees: Stripe Checkout for the $0.25 per-trade fee, signed
  webhook, the Verified badge it gates, and the launch waiver that makes it
  moot until the cutoff
- Events: open creation, "in person at an event" as a third fulfillment
  option, event-scoped feed, and three-phase hold timing around the con
- Trade proposals: offer one of your own listings or describe an item, with
  the offered game reserved on submission; accepted-payment metadata and an
  "accepts trades" filter
- Full demo mode with no Firebase at all — including chat, via a small pub/sub
  that stands in for `onSnapshot`, so the views exercise the same real-time code
  path they'll use against Firestore

**Deliberately not built yet:**


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
