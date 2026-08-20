# Tabled — Local Board Game Marketplace — Vision Doc

## Audit Summary

**What was strong:** The core loop was clear from the start — browse/search, request, schedule, confirm, review — and the decisions that came out of the interview (no monetization in v1, sold requires mutual confirmation, real chat over a lighter request flow, fuzzy-geocoded location) all point toward a coherent, buildable v1.

**Filled in during audit:**
- Monetization: back on the table, with a mechanism that actually works. Rather than gating on the sale itself (unenforceable — the app has no visibility into cash changing hands outside it), it gates on the mutual sold-confirmation, which the app *does* control and can't be faked unilaterally. A seller pays a $0.25 Stripe Checkout fee per completed trade; paying it keeps their "Verified" badge current. This is a fee between seller and platform, not part of the buyer/seller sale — the original boundary (no in-app payment for the actual game sale) stays intact. Full design in the new Trade Verification & Fees section.
- Launch waiver: free until Dec 31, 2026 (`config/global.feeWaiverEndDate`), auto-satisfied without any Stripe call during the waiver — which also means the real Stripe integration (M8) doesn't have to be done before launch, just before the cutoff.
- Events & convention selling: open creation (any signed-in user), a third "in-person at event" fulfillment option, and hold timing that's paused before the event starts, compressed (3h/1h) once it's live, and force-expired once it ends. Full design in the new Events & Convention Selling section.
- BGG integration: on listing creation, hit BGG once via a Cloud Function proxy (CORS blocks direct browser calls to BGG), cache title/image/year/categories/mechanics into our own `games` collection, and pull the marketplace `pricehistory`/`marketplace` fields as a suggested price. Categories/mechanics then live locally for fast filtering — no live BGG calls on search.
- Sold confirmation: requires both buyer and seller to confirm, which is also what unlocks review-writing and increments trade count — prevents a seller unilaterally padding their own stats.
- Scheduling: real, open-ended chat (not just a structured propose/accept flow) — bigger build than the lightweight version, scoped into its own milestone below.
- Location: general area (e.g. "North Jacksonville") is geocoded to a *fuzzy/jittered* point for radius search. The text label is what's ever displayed; the precise point is never shown, so browsing never reveals anyone's actual location.
- Reporting & safety: context-specific report reason lists (listing/user/message), a `reports` collection, an auto-hide circuit breaker at 3 open reports on a listing / 5 on a user, and per-user blocking — all pulled into M1 rather than deferred, since a public marketplace with in-person meetups shouldn't ship without them. Full design in the new Reporting & Safety section below.
- Hold & queue: 24h hold timeout, 12h grace period after a missed scheduled time, automatic handoff to the next person in line via a scheduled Cloud Function. Full design in the new Hold, Queue & Auto-Book section.
- Auto-book: exclusive 30-min slots (not just informational windows), one standing weekly availability per seller applying across all their listings (not per-listing).
- Scheduling confirmation: neither chat-negotiated nor auto-booked times finalize on their own — both converge into a shared `proposedTime` status that requires explicit seller Confirm/Decline before becoming `scheduled`. A seller who never responds reverts the request to `onHold` (gentle) rather than costing the buyer their queue position.
- Auth: Google sign-in via Firebase Auth (this app's established stack default) — no password flow to build or secure, and it's a non-issue for this audience. Real email from Google is never surfaced to other users; only `displayName`/`photoURL` are public.
- Notifications: in-app only for v1 — no browser push, no service worker. A bell/badge in the header, backed by a lightweight `notifications` subcollection, covers queue advancement, proposed-time confirmations, new chat messages, and sold status. Push is a clean fast-follow later if wanted, but adds a service worker and permission-prompt flow that's out of scope for now.

**Assumptions made (please confirm or correct):**
- Promoted the old `games` array on each listing into a `gameEntries` subcollection. This is a direct consequence of the hold/queue decisions, not a new ask — array elements can't be updated atomically and independently the way each game entry's hold state now needs to be, so this was the only workable path once queueing was in scope. Flag if this restructuring causes friction with anything you'd already pictured.
- **A listing can bundle multiple games** (matches "host multiple games"), where each game in the bundle has its own condition, tags, and photos, but the whole listing shares one seller, one location, and one pickup/shipping setting. If you actually meant "a user has multiple separate listings" rather than "one listing, several games," this changes the data model — flag it if so.
- Condition scale seeded as: **NIS** (New in Shrink), **LN** (Like New, opened not played), **VG** (Very Good), **G** (Good), **F** (Fair/well-loved). Adjust the list if you want different tiers.
- Tags are a hardcoded, extensible list in `app.js` (sleeved cards, upgraded pieces, 3D-printed insert, premium mat, punched, painted minis, etc.) rather than an admin-managed collection — simpler for v1, easy to grow later.
- Firestore write permissions don't fit any of the three canned patterns from the build skill cleanly (public browsing + owner-only writes + counterparty-written reviews + two-participant-only chats). Custom per-collection rules are sketched below — read them before building, since this is the part most likely to need a second pass.
- View/request counters on listings are incremented via a Cloud Function callable rather than direct client writes to someone else's document, to avoid opening listing docs to arbitrary field writes from non-owners.
- Reviews are immutable once posted (no edit/delete) — standard trust-and-safety practice, keeps ratings honest.
- Mobile-first responsive design — this is replacing FB Marketplace and Reddit, both overwhelmingly used from a phone, especially for "message someone, meet up" flows.
- "Verified" badge means fees are fully current — it disappears the moment any completed trade has an unpaid fee, rather than requiring a minimum count. `tradeCount` itself always shows the real number regardless of payment status, so a profile never looks artificially inactive.

**Still open (needs your call before Claude Code starts):**
- The "hot" sort formula below (recent views + requests, decayed by age) is a reasonable default but arbitrary — confirm it's good enough or tell me what "hot" should actually weight.

---

## Overview

A mobile-first web app for buying, selling, and trading used board games locally — the listing and discovery half of what Facebook Marketplace and Reddit do badly for this hobby specifically. Sellers list one or more games with per-game condition, tags, and photos; buyers search and filter by game, category (via BGG), condition, and distance; the two parties chat in-app to negotiate pickup or shipping, and the sale is confirmed by both sides, which archives the listing and unlocks mutual reviews. The actual game sale is never processed by the app — money for the game changes hands independently. The only payment the app ever touches is an optional $0.25 platform fee a seller can pay per completed trade to keep their profile's "Verified" badge current.

## Views

1. **Browse/Feed** — the landing page after sign-in. Card grid of active listings, filterable by distance, category (BGG-sourced), condition, tags, fulfillment method. Sortable by New / Hot / Good Deal.
2. **Search results** — same card grid, driven by a text/category query (e.g. "worker placement games near me").
3. **Event detail / browse** — all listings tagged to one event (e.g. "PAX Unplugged 2026"), same filter/sort tools as the main feed, plus the event's venue and dates up top. This is the direct replacement for the BGG forum-thread approach.
4. **Listing detail** — full view of one listing: all games in the bundle, all photos, seller mini-profile, "Request this" button.
5. **Create/Edit listing** — BGG-backed game search-as-you-type, add multiple games to one listing, per-game condition/tags/photos, fulfillment method (pickup/shipping/in-person-at-event), location, and — if in-person-at-event is selected — pick an existing event or create a new one inline.
6. **Profile (own)** — avatar, bio, general area, member-since date, trade count, "Verified" badge (when fees are current), average rating, review list, active listings.
7. **Profile (other user's)** — same as above, read-only, plus a "Request a game" entry point.
8. **Dashboard** — my active requests (as buyer and as seller), each linking into its chat/schedule thread; my completed trades awaiting review; for sellers, a pending $0.25 verification-fee prompt on any completed trade that hasn't been paid yet.
9. **Chat/Request thread** — real-time messaging with the counterparty, scheduling controls (propose a pickup/ship time, or pick an auto-book slot), seller Confirm/Decline on the proposed time, mutual "confirm sold" buttons once scheduled.
10. **Sign-in gate** — Google sign-in via Firebase Auth, standard loading → sign-in → app pattern; never flash the app UI before auth state resolves.

## Data Model

**`users/{uid}`**
- `displayName`, `photoURL`, `bio` (string) — the only identity fields ever shown to other users. Google's real email (available via `auth.currentUser.email`) is never written into a public-facing field or displayed anywhere; all contact happens through in-app chat.
- `generalArea` (string, e.g. "North Jacksonville")
- `geoPoint` (Firestore GeoPoint, fuzzed/jittered from geocoded `generalArea`)
- `geohash` (string — see note under Location below)
- `createdAt`
- `tradeCount` (number, denormalized, incremented via Cloud Function on mutual sale confirmation — always the real count, unaffected by fee payment status)
- `avgRating`, `reviewCount` (denormalized)
- `verifiedSeller` (bool, denormalized — true only when the seller has zero completed trades with an unpaid fee; recomputed via Cloud Function on every trade completion and every fee payment)
- `availabilityWindows`: array of `{ dayOfWeek, startTime, endTime }` — one standing weekly schedule, applies to auto-book across all of this seller's listings (not set per-listing)

**`users/{uid}/bookedSlots/{sellerId_date_startTime}`** (subcollection, deterministic doc ID)
- `date`, `startTime`, `endTime` (30-min increment), `requestId`, `gameEntryId`
- The deterministic ID *is* the exclusivity mechanism: a second attempt to create the same slot ID simply fails, so no transaction or locking logic is needed to prevent double-booking. See Hold, Queue & Auto-Book below.

**`users/{uid}/notifications/{notificationId}`** (subcollection)
- `type` (queueAdvanced | timeProposed | timeConfirmed | timeDeclined | newMessage | itemSold | reportResolved)
- `message` (short display string), `relatedRequestId` (nullable), `relatedListingId` (nullable)
- `read` (bool, default false), `createdAt`

**`config/global`** (single doc, edited directly in the Firebase console — not app-writable)
- `feeWaiverEndDate` (timestamp, default **2026-12-31**) — completed trades before this date auto-satisfy the verification fee; see Trade Verification & Fees below.

**`events/{eventId}`**
- `name` (e.g. "PAX Unplugged 2026"), `venue` (text), `startDate`, `endDate`
- `createdBy`, `createdAt`

**`games/{bggId}`** — cached BGG data, one doc per distinct game ever listed
- `name`, `yearPublished`, `imageUrl`, `categories` (array), `mechanics` (array), `suggestedPrice` (from BGG marketplace data, nullable), `lastSyncedAt`

**`listings/{listingId}`**
- `sellerId`
- `title` (optional bundle label, e.g. "Game night clearout")
- `fulfillment`: `{ pickup: bool, shipping: bool, inPersonAtEvent: bool }`
- `locationLabel`, `geoPoint`, `geohash` (copied from seller at listing time)
- `eventId` (nullable — set when `fulfillment.inPersonAtEvent` is true)
- `eventStartDate`, `eventEndDate` (nullable, copied from the `events` doc at listing-creation time so hold-timing logic never needs a second lookup)
- `status`: active | archived (archived once every game in the bundle is sold)
- `createdAt`, `viewCount`, `requestCount`, `hotScore` (recomputed periodically, see Sorting below)

**`listings/{listingId}/gameEntries/{gameEntryId}`** (subcollection — promoted out of the old `games` array specifically because hold/queue state on each entry now changes independently and needs its own atomic updates, which array elements don't support well)
- `bggId`, `condition` (enum), `tags` (array), `photos` (array of Storage URLs), `askingPrice`
- `status`: active | onHold | sold
- `currentHoldRequestId` (nullable)
- `holdExpiresAt` (nullable — set whenever status becomes `onHold`)
- `queueCount` (denormalized, for "3 people waiting" display)

**`requests/{requestId}`**
- `listingId`, `gameEntryId` (which game in the bundle)
- `buyerId`, `sellerId`
- `status`: queued | onHold | proposedTime | scheduled | completed | cancelled | expired
- `queuePosition` (0 = current holder; 1, 2, 3... = waiting in line)
- `proposedTime`, `proposedBy` (nullable — set whenever a time is on the table but not yet seller-confirmed, whether it came from chat negotiation or a slot claim)
- `scheduledTime`, `method` (pickup/shipping), `bookedSlotId` (nullable, set if the proposal came from auto-book rather than chat negotiation)
- `feePaid` (bool, default false — set true only by the Stripe webhook handler once the seller's $0.25 verification fee for this completed trade clears; see Trade Verification & Fees below)
- `createdAt`

**`requests/{requestId}/messages/{messageId}`** (subcollection)
- `senderId`, `text`, `createdAt`

**`reviews/{reviewId}`**
- `requestId` (the completed trade this review is for)
- `reviewerId`, `revieweeId`
- `rating`, `comment`, `createdAt`

**`reports/{reporterId_targetType_targetId}`** — deterministic doc ID so a duplicate report on an already-open target overwrites instead of piling up
- `targetType`: listing | user | message | event
- `targetId`
- `contextRequestId` (nullable — set when the report came from a chat thread, so the thread is traceable later)
- `reason` (enum, scoped to `targetType` — see Reporting & Safety below)
- `note` (string, required only when `reason == 'other'`; for message reports, prefilled with the reported message's text as evidence)
- `reporterId`, `createdAt`, `status`: open | reviewed

**`users/{uid}/blocked/{blockedUid}`** (subcollection)
- `createdAt` — presence of this doc means `uid` has blocked `blockedUid`; checked when creating new `requests` docs or `messages`

## Write Permissions (custom — doesn't map to a single canned pattern)

- `users/{uid}`: public read; write only by `request.auth.uid == uid`, **except** `tradeCount`, `avgRating`, `reviewCount`, `verifiedSeller` — those four are Cloud-Function-only, never client-writable even by the profile's own owner. (Worth calling out: without this exception the original blanket "owner can write everything" rule would have let anyone set their own `verifiedSeller` to true directly — tightening this now closes that gap for the older denormalized fields too, not just the new one.)
- `users/{uid}/notifications/{notificationId}`: read and `read`-flag update only by `request.auth.uid == uid`; create only via the Cloud Function service account — never client-writable, so nobody can spam themselves (or anyone else) fake notifications.
- `listings/{listingId}`: public read where `status == 'active'`; create/update/delete only by `sellerId == request.auth.uid`. `viewCount`/`requestCount` increments go through a Cloud Function callable, not direct writes, so non-owners never need write access to someone else's listing.
- `events/{eventId}`: public read; create by any signed-in user; update/delete only by `createdBy`. No approval gate — same open-creation trust model as everything else in the app, backed by the existing report mechanism if someone creates a spam or duplicate event.
- `listings/{listingId}/gameEntries/{gameEntryId}`: public read; create/delete only by the parent listing's `sellerId`. Field-level state that changes via hold/queue advancement (`status`, `currentHoldRequestId`, `holdExpiresAt`, `queueCount`) is written only by the Cloud Function layer, not directly by either buyer or seller — this is what keeps the queue tamper-proof (a buyer can't just edit their own way to the front).
- `games/{bggId}`: public read; writes only via the Cloud Function service account (never directly from clients).
- `users/{uid}/bookedSlots/{slotId}`: create only, and only through a Cloud Function callable (`bookSlot`) that verifies the caller actually holds the current request (`queuePosition == 0`) before writing — a direct client write is deliberately not allowed here, since the deterministic-ID trick alone doesn't stop someone from claiming slots on requests that aren't theirs.
- `requests/{requestId}`: read/write only if `request.auth.uid in [buyerId, sellerId]`. Created by the buyer. One extra guard: a buyer can only push `status` to `proposedTime` (the chat-negotiation path) if `queuePosition == 0` — someone waiting in the queue can read and chat, but can't jump ahead by proposing a time before it's their turn. Once `status == 'completed'`, the doc is frozen to both participants — no further client writes at all. `feePaid` is set exclusively by the `stripeWebhook` function (which uses the admin SDK and isn't subject to these rules), so there's no path for a seller to just mark their own fee paid.
- `requests/{requestId}/messages/{messageId}`: read/write only if the requesting user is `buyerId` or `sellerId` on the parent request.
- `reviews/{reviewId}`: create allowed only if the requester was a participant on a `completed` request and hasn't already reviewed that request; no update or delete once created.
- `reports/{reportId}`: create only, by `request.auth.uid == reporterId`; no client read (reports are write-only from the client until an admin console exists to read them) and no update/delete except by an eventual admin role.
- `users/{uid}/blocked/{blockedUid}`: read/write only by `request.auth.uid == uid` — a user manages only their own block list, never anyone else's.

## Real-time vs. Fetch-once

- **Browse/Feed, Search results:** fetch-once with pagination (`limit` + `orderBy`), refetched on filter change. Deliberately *not* `onSnapshot` — a public feed with many concurrent viewers is exactly where listener leaks and read costs pile up.
- **Listing detail:** `onSnapshot` on the single listing doc, so status flips to "pending"/"sold" live while someone's looking at it.
- **Dashboard (my requests):** `onSnapshot` on `requests` where the user is buyer or seller — small, bounded result set, real-time is cheap here.
- **Chat thread:** `onSnapshot` on the messages subcollection — this is the one place real-time actually matters most.
- **Notification bell:** `onSnapshot` on `notifications` where `read == false` — small, bounded per user, drives the header badge count live.
- **Profile, reviews list:** fetch-once.

## External Integrations

**BoardGameGeek (via Cloud Function proxy — required, BGG's XML API has no CORS headers for direct browser calls):**
- `searchGames(query)` — proxies BGG's search endpoint, debounced client-side, returns candidate matches for the listing-creation autocomplete.
- `getGameDetails(bggId)` — proxies BGG's `thing` endpoint with `stats=1&marketplace=1&pricehistory=1`, parses the XML, writes/updates the cached `games/{bggId}` doc.
- BGG's rate limits are real but undocumented — never call on every keystroke; only on debounced search and on final selection.

**Geocoding** (to turn `generalArea` text into a `geoPoint`): any standard geocoding API (Google Geocoding, Mapbox) called from the same Cloud Function layer, since geocoding APIs typically also require a server-side key rather than a client-exposed one.

**Geo radius search note:** Firestore has no native "find within N miles" query. This needs geohashing (e.g., the `geofire` pattern: store a `geohash` string field, query a geohash range, then filter precisely client-side). Flagging this now because it's the kind of thing that's easy to discover *after* the data model is already built without it.

**Two more Cloud Functions for hold/queue/auto-book:**
- `advanceExpiredHolds` — scheduled function (Cloud Scheduler, every 15–30 min). Handles two kinds of expiry: (1) an `onHold` game entry whose holder never proposed a time within the hold window — expires the current request, promotes `queuePosition: 1` to holder, shifts the rest of the queue up, frees any `bookedSlot`; (2) a `proposedTime` request the seller never confirmed or declined — reverts it to `onHold` (buyer keeps `queuePosition: 0`, tries again) and releases the `bookedSlot` if one was attached. Case (2) is deliberately *not* treated as an expiration of the buyer's hold — they already acted by proposing, so a slow-to-respond seller shouldn't cost them their place in line. **For event-tagged listings**, the hold window itself is time-aware rather than a flat 24h: no expiry check runs at all while `now < listing.eventStartDate` (nothing to act on yet — the con hasn't started); once `now >= eventStartDate`, a compressed window applies (see Events & Convention Selling below); once `now > eventEndDate`, any still-open hold or proposal on that listing is force-expired outright, since the in-person opportunity is gone.
- `bookSlot` — callable function. Validates the caller is the current holder (`queuePosition == 0`) before writing the `bookedSlots` doc, then sets `requests.status = 'proposedTime'`, `proposedTime`/`proposedBy`, and `bookedSlotId`. Does **not** set `scheduled` directly — that still requires the seller to confirm.
- `respondToProposal` — callable function, seller-only. `confirm` → `requests.status = 'scheduled'`. `decline` → deletes the `bookedSlots` doc if one exists and reverts `requests.status` to `onHold`, leaving the buyer as holder to propose again (via chat or a different slot).
- `onMessageCreate` — Firestore trigger on `requests/{requestId}/messages/{messageId}` create. Writes a `newMessage` notification to whichever participant didn't send it. This, plus a notification write added into `advanceExpiredHolds`, `bookSlot`, and `respondToProposal`, is the entire notification system — no separate service, just each existing event also dropping a doc into the recipient's `notifications` subcollection.

**Stripe (verification fee only — never the actual game sale):**
- `createFeeCheckoutSession` — callable function, seller-only, for a specific `completed` request. Creates a $0.25 Stripe Checkout Session and returns the redirect URL. Stripe's secret key lives in Cloud Functions config/Secret Manager, never in client code.
- `stripeWebhook` — HTTP function, verifies the Stripe signature on incoming events. On `checkout.session.completed`: sets `requests.feePaid = true` and recomputes `users/{sellerId}.verifiedSeller` (true only if the seller has zero completed trades with `feePaid == false`).
- You'll need a Stripe account and API keys before M8 — that's a manual step outside what Claude Code can do for you, same category as the Firebase console steps in the build skill.

## Milestones

- **M1 — Core loop, no hard parts.** Auth, profile creation, manual (non-BGG) single-game listing create/edit/delete, plain browse feed (no geo, no BGG, no chat). Also ships in M1: the full report mechanism (listing/user/message, context-specific reason chips, `reports` collection), the auto-hide-on-report-threshold circuit breaker, and per-user blocking (`blocked` subcollection, checked before a new request or message can reach a blocked user). These don't depend on BGG, geo, or chat, so there's no reason to push them later — and a public marketplace shouldn't ship without them even in its earliest form.
- **M2 — BGG integration.** Cloud Function proxy, search-as-you-type on listing creation, cached `games` collection, suggested price display, multi-game bundle support.
- **M3 — Location & discovery.** Geocoding + geohash radius search, "near me" filter, category/tag/condition filters, New/Hot/Good-Deal sorting.
- **M4 — Requests & chat.** `requests` collection, real-time messaging subcollection, negotiated (chat-based) scheduling UI, dashboard view of active threads. First-come-first-served, no queue behind the first requester yet — that's M5.
- **M5 — Hold & queue.** Promote game entries to the `gameEntries` subcollection, add `queuePosition` and hold-expiry state, `advanceExpiredHolds` scheduled function. This is where "you're #2 in line" and automatic hold handoff start working.
- **M6 — Preset availability & auto-book.** Standing weekly `availabilityWindows` on the seller profile, 30-min slot generation, `bookSlot` callable with deterministic-ID exclusivity, dashboard surfacing of open slots to the current holder.
- **M7 — Completion & trust.** Mutual sold-confirmation flow, listing archival, trade count increment, review write/display, profile polish (photo upload, bio, avg rating).
- **M8 — Trade verification & fees.** Stripe Checkout integration for the $0.25 per-trade fee, webhook handler, `verifiedSeller` computation, "Verified" badge on profile. Free until `feeWaiverEndDate` (default Dec 31, 2026) via auto-satisfied `feePaid` — so this milestone needs to land before that date, not before initial launch.
- **M9 — Events & convention selling.** `events` collection (open creation), third fulfillment option, event-aware hold timing in `advanceExpiredHolds` (paused pre-event, compressed during, force-expired after), event-scoped browse/detail view, auto-book slots constrained to the event window. Depends on M5/M6 (hold/queue and auto-book need to exist first to be made event-aware).

## Sorting Definitions

- **New:** `createdAt` descending. Trivial.
- **Hot:** `hotScore = (viewCount * 1) + (requestCount * 5), decayed by listing age` — recomputed on a scheduled Cloud Function (e.g. hourly) rather than on every read, since recalculating per-query would be expensive. Treat this formula as a placeholder — tune once you see real usage.
- **Good Deal:** sort by `(suggestedPrice - askingPrice) / suggestedPrice` descending, using the BGG-sourced suggested price. Falls back to hiding this sort option for games with no BGG price data.

## Scope Edges (out of scope for v1)

- No payment processing for the actual game sale — money for the game itself always changes hands outside the app. The only payment surface in the app is the optional $0.25 per-trade verification fee (M8), which is a seller-to-platform transaction, not part of the sale.
- No admin/moderation dashboard (though the `flagged` field ships in M1 as a hook for later).
- No shipping label generation or carrier integration — if shipping is selected, the actual mailing address is exchanged inside the chat, never stored as a structured field.
- No push notifications in v1 (open question above — call it before M4 if you want it in scope).
- Single language, no localization.

## Reporting & Safety (M1)

Three separate entry points, each with its own short reason list — never one generic dropdown trying to cover every case:

- **Report a listing:** Misleading photos/condition · Suspected scam or counterfeit · Prohibited/unsafe item · Spam or duplicate listing · Something else
- **Report a user/profile:** No-show — didn't honor a scheduled meetup · Harassment or inappropriate messages · Suspected scam · Fake or bot profile · Something else
- **Report a chat message:** Harassment/inappropriate · Suspected scam attempt · Something else (auto-prefills the reported message's text into `note` as evidence)
- **Report an event:** Duplicate of an existing event · Wrong dates/venue · Spam or not a real event · Something else

**UX pattern:** tapping a reason chip *is* the submission (toast confirmation, no second screen). Only "Something else" reveals a required one-line text field before submitting. Common cases stay one tap; the escape hatch costs one sentence, never a form.

**Auto-hide circuit breaker:** a listing is automatically pulled from the public feed (status forced to a hidden state, not deleted) once it accumulates **3 open reports**; a user profile is similarly restricted (can't create new listings or requests) at **5 open reports**. Both thresholds are just starting points — expect to tune them once real usage shows whether they're too sensitive or not sensitive enough. This is a placeholder circuit breaker, not a replacement for an eventual admin review console — it exists so the report button *does something* before that console exists.

**Blocking:** available from a user's profile and from an open chat thread. Blocking is instant and self-protective (no review needed) — it prevents the blocked user from creating new `requests` against the blocker or sending further `messages` in shared threads. This is separate from reporting: report flags something for later review, block stops it right now.

## Hold, Queue & Auto-Book (M5–M6)

**Queue mechanics:** the first request on a game entry becomes the holder (`queuePosition: 0`). Anyone requesting after that joins the queue in order (`queuePosition: 1, 2, 3...`) rather than being turned away — the listing shows "3 people waiting" via the denormalized `queueCount`.

**Hold timeout:** the current holder has **24 hours** to either auto-book a slot or land on a time in chat. If a scheduled time comes and goes with no mutual "picked up" confirmation, there's a further **12-hour grace period** before that hold is treated as expired too. Both numbers are starting points, not locked in — easy to tune once real usage shows whether 24h feels generous or stingy.

**Expiry → advancement:** the `advanceExpiredHolds` scheduled function does the handoff automatically — expires the lapsed holder, promotes whoever's next, shifts the rest of the queue up, and frees any `bookedSlot` the outgoing holder had claimed so it becomes available again. The newly-promoted holder sees a prompt to book or propose a time, same as if they'd just been the first requester.

**The no-show connection:** a hold expiring because a *scheduled* time passed with no confirmation is functionally the same event as a no-show — worth surfacing a "Report no-show?" prompt to the seller at that moment, prefilled against the buyer who missed it, rather than making them navigate to the report flow separately.

**Two paths, one confirmation gate:** a time can get proposed either by chat negotiation or by auto-book — but neither one finalizes a `scheduled` request on its own. Both funnel into the same `proposedTime` status, and the seller always gets the final Confirm/Decline. Chat negotiation and auto-book are really just two different ways of *arriving* at a proposal; what happens after that point is identical.

**Auto-book, exclusive slots:** a seller sets one standing weekly availability (e.g. "Saturdays 10am–2pm") that applies across all their active listings — not configured per-listing. That window gets sliced into 30-minute increments. Whoever currently holds a game entry can claim an open increment in one tap, which reserves it (moves the request to `proposedTime`) — the deterministic `bookedSlots` doc ID (`{sellerId}_{date}_{startTime}`) is what makes the reservation exclusive, since a second claim attempt on the same slot simply fails to write. If the seller declines, the slot releases immediately and becomes claimable again. If the seller confirms, it becomes `scheduled`. This also means the same seller can't get double-booked across two *different* listings at the same time, since exclusivity is tracked per-seller, not per-listing.

**If the seller never responds:** a proposed time (from either path) that sits unconfirmed past the response window reverts to `onHold` automatically — the buyer keeps their holder position and tries again, rather than losing their place in line over something that wasn't their delay.

## Trade Verification & Fees (M8)

**The core mechanism:** the app can never know whether a sale happened outside it — but it does reliably know when a trade reaches mutual `completed` status, since that requires both buyer and seller to agree and can't be faked by either side alone. So the fee doesn't gate the sale (unenforceable); it gates a status the app fully controls: whether that seller's profile shows "Verified."

**The flow:** once a request hits `completed`, the seller sees a one-tap prompt — pay $0.25 via Stripe Checkout to keep this trade counted toward their verified standing, or skip it. Skipping has no other consequence; the trade still counts in their real `tradeCount`, it just doesn't count toward `verifiedSeller` staying true.

**Badge vs. count, kept separate:** `tradeCount` always reflects every completed trade, paid or not — a profile never looks artificially thin just because a fee went unpaid. `verifiedSeller` is a stricter, current-standing flag: true only when *zero* completed trades have an outstanding unpaid fee. One unpaid trade turns the badge off immediately; paying it turns the badge back on. This is a status you maintain, not a threshold you cross once.

**Why the client can't fake this:** `feePaid` and `verifiedSeller` are both written exclusively by the Stripe webhook handler using the admin SDK — Firestore rules block client writes to either field entirely, even by the account owner. The only way `feePaid` ever becomes true is a real, signature-verified Stripe event.

**Scope boundary, restated:** this fee is between the seller and the platform. The actual board game sale — the $30, $50, whatever changes hands for the game itself — is never touched by the app, never routed through Stripe, never processed here. That line hasn't moved.

**Launch waiver:** free until `config/global.feeWaiverEndDate` (default Dec 31, 2026). The same completion trigger that would normally prompt for Stripe Checkout just sets `feePaid = true` directly while the waiver is active — no Stripe call, no prompt shown to the seller at all. This means M8's actual Stripe wiring doesn't block launch; it only needs to be done before the waiver date. Nothing is retroactive: trades completed for free during the waiver stay free even after the cutoff passes.

## Events & Convention Selling (M9)

The direct replacement for hunting through a BGG forum thread before a con: a real, searchable, filterable, photo-backed listing scoped to a specific named event.

**Open creation, same as everything else.** Any signed-in user can create an `events` doc — no curated allowlist, no approval step. This matches the trust model used everywhere else in the app (public write access, backed by report/flag rather than gatekeeping), and it means you don't have to personally seed every convention someone wants to sell at. A duplicate or spam event is handled the same way a duplicate or spam listing is — report it.

**A third fulfillment option, not a location hack.** "In-person at event" sits alongside pickup and shipping. Selecting it (in Create/Edit listing) prompts picking an existing event or creating a new one inline, and copies that event's dates onto the listing so hold timing can react to them without a second lookup.

**Three-phase hold timing**, since a flat 24h window is wrong in both directions for a convention:
- **Before the event starts:** the hold simply doesn't expire. A listing made in October for a late-November con shouldn't penalize its holder for not proposing a pickup time in a con that doesn't exist yet.
- **Once the event is live:** compresses hard — default **3 hours** to propose or auto-book a time, **1 hour** grace period after a missed meetup. A con is only a few days long; turnover needs to be fast. (Same as the standard timeouts, these are starting points to tune once you see real usage.)
- **After the event ends:** any request still sitting in `onHold` or `proposedTime` on that listing gets force-expired. The listing itself isn't touched — a seller can still edit it to shipping-only afterward for someone who missed the window at the con — but the in-person queue for that item resets rather than sitting open indefinitely for an opportunity that's already closed.

**Auto-book stays scoped to the event window.** If a seller has a standing weekly availability *and* an event-tagged listing, slot generation for that listing should only ever offer increments that fall within `eventStartDate`–`eventEndDate`, not their regular weekly schedule — the point of an event listing is meeting at the con, not at their house next Tuesday.

## Done Definition

V1 is done when: a seller can create a listing with one or more BGG-verified games (condition, tags, photos, suggested price shown), it shows up in a nearby buyer's feed and in category search, the buyer can request it, the two can chat and land on a pickup or shipping plan, both sides confirm the sale, the listing archives itself into both users' trade history, and both people can leave each other a review that shows up on their public profile.

## Visual/UX Direction

Mobile-first, single-column card feed — closer to a cleaner, purpose-built Marketplace than a dense spreadsheet-style listing site. Light theme, big tap targets, photo-forward cards (the game's box art and the actual condition photos are doing most of the selling work here).

## Gotchas Worth Naming Now

- **Two buyers requesting the same game near-simultaneously:** resolved by the queue system now (M5) — first request becomes holder, the second is queued rather than turned away, so no request is ever just dropped.
- **Deletion semantics:** an unsold listing deleted by its seller is a hard delete (nothing to preserve). A *completed* trade is archived, not deleted, so trade history and reviews survive.
- **Auth gating:** standard loading → sign-in-prompt → app pattern; never flash the feed before auth state resolves.
- **Multi-user simultaneity in chat:** naturally handled since each message is its own document — no real conflict risk there.
