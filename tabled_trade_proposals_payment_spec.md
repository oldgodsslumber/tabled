# Tabled — Trade Proposals & Payment Preferences (Addendum Vision Doc)

This extends `board_game_marketplace_spec.md` (the main Tabled vision doc) — it assumes that doc's collections, milestones, and conventions, and only documents what's new or changed. Read this alongside it, not instead of it.

## Audit Summary

**What was strong / a clean fit:** all three asks turned out to be extensions of infrastructure that already exists rather than new systems. A trade proposal is structurally a `request` with a different payment shape attached — same hold/queue, same chat, same `proposedTime` → seller-confirm gate, same mutual-completion flow from M4–M7. That reuse is the core design decision here.

**Filled in during this pass:**
- A trade proposal (with or without an existing listing) is just `requests.proposalType = 'trade'` instead of `'purchase'`, with extra fields for what's being offered. It goes through the identical queue/chat/confirm/complete pipeline already built — no parallel system.
- Accepted payment methods (`cash`, `paypal`, `venmo`, `trades`) live on the listing as purely informational metadata. None of them are ever processed by the app — this is the same boundary as the actual game sale itself: the app displays what a seller is open to, and everything after that happens outside it. Only "Trades" has any functional effect: it's what gates whether the "Propose a Trade" button even shows on that listing.
- A beta-only data usage tracker: feature-tagged Firestore read/write counting plus a loop/anomaly detector, specifically aimed at catching the same kind of `onSnapshot`-triggers-write-triggers-reread bug that blew the Firestore quota on the PegaWorld war room app. Gated by a config flag so it's easy to turn off once beta ends.

**Assumptions made (please confirm or correct):**
- When someone offers one of their *own existing listings* as part of a trade proposal (the first ask), that gameEntry is locked to a new `reserved` status the moment the proposal is submitted — not just once they become the queue holder. Reasoning: it's a real, undupliable physical item, and letting it sit fully "active" while it's also on the table in an unrelated trade risks it getting committed twice. If the proposal is declined, cancelled, or expires, it reverts to `active` automatically. Flag if you pictured something looser (e.g., only reserving it once the proposal reaches the top of the queue).
- Cash top-up is one-directional and free-text/negotiated, not a structured bidirectional field — a proposer can note "my Catan + $10" as an `additionalCashOffered` amount, but the actual number isn't validated or enforced by the app; it's just displayed to the seller as part of the offer, same as everything else that gets finalized in chat.
- Trade proposals count toward `tradeCount` and unlock reviews for **both** participants on completion, same as a normal purchase — a trade is symmetric, both sides gave something up.

**Still open:**
- Should "describe an item I have" (the second ask — a trade offer with no listing behind it) contribute anything to the offering user's public trade history if the trade falls through, or does it only ever matter if the trade completes? My assumption is the latter (nothing recorded unless completed) — flag if you want unlisted offers tracked differently.
- Beta data tracker: the anomaly threshold below (200 reads/min per collection as the loop-detector trip point) is a starting guess, not a measured number — expect to tune it once real beta traffic shows what's actually normal.

## New / Changed Views

- **Listing detail:** a second action button, **"Propose a Trade,"** appears alongside "Request this" only when `acceptedPayment.trades == true`. Opens a short flow: offer one of your own active listing items, *or* describe an item you have that isn't listed (name/BGG lookup, condition, tags, photo), optionally add a cash top-up note, then submit — which creates a `requests` doc the same way a normal purchase request does.
- **Create/Edit listing:** new **"Accepted Payment"** section — checkboxes for Cash, PayPal, Venmo, Trades. Purely descriptive; doesn't gate anything except the trade-proposal button described above.
- **Browse/Feed, Search results:** new filter chip for accepted payment type (e.g. "Accepts trades") alongside the existing distance/category/condition/tag filters.

## Data Model Additions

**`listings/{listingId}`** — new field
- `acceptedPayment`: `{ cash: bool, paypal: bool, venmo: bool, trades: bool }`

**`listings/{listingId}/gameEntries/{gameEntryId}`** — extended `status` enum
- `status`: active | onHold | **reserved** | sold — `reserved` is new, set when this specific game entry is the offered side of an active trade proposal elsewhere (see Assumptions above), released back to `active` if that proposal falls through.

**`requests/{requestId}`** — new fields
- `proposalType`: `'purchase' | 'trade'` (default `'purchase'`)
- `offeredListingId`, `offeredGameEntryId` (nullable — set when the proposer offered one of their own existing listings)
- `offeredItemDescription` (nullable object, set when the proposer described an item with no listing behind it): `{ bggId (nullable), name, condition, tags, photos }`
- `additionalCashOffered` (nullable number — informational only, never validated or processed by the app)

## Write Permission Additions

- `listings/{listingId}.acceptedPayment`: covered by the existing owner-only listing write rule — no new rule needed.
- `listings/{listingId}/gameEntries/{gameEntryId}.status` transitions to/from `reserved`: same as the existing hold/queue state — Cloud-Function-only, not directly client-writable, for the same tamper-resistance reason `onHold`/`sold` already are.
- `requests/{requestId}` trade fields: covered by the existing "buyer or seller of this request" rule; no new access needed since these are just additional fields on a doc whose permissions are already scoped correctly.

## Cloud Function Changes

- **Trade proposal creation** (client write, same as a normal purchase request — no new callable needed): if `offeredGameEntryId` is set, a Firestore trigger on `requests` create immediately sets that gameEntry's `status` to `reserved`.
- **`advanceExpiredHolds`** (existing, M5): on expiring or cancelling a `proposalType: 'trade'` request, also releases the offered gameEntry back to `active` if one was reserved.
- **Mutual completion logic** (existing, M7): extended so that for a `proposalType: 'trade'` request with `offeredGameEntryId` set, completion marks **both** gameEntries `sold` (the target and the offered one), archives both parent listings if now fully sold, and increments `tradeCount` for both participants rather than just the seller.

## Beta Data Usage Tracker

This is exactly the kind of thing worth building *before* real beta traffic starts, not after — the failure mode it's designed to catch is the same one that took down the PegaWorld war room app: an `onSnapshot` listener that triggers a write, which retriggers the same listener, quietly burning through the daily read quota until everything 429s. That bug was only found by reading raw browser network logs after the fact. The goal here is to catch that pattern automatically, in near-real-time, across every beta tester's session — not just yours.

**Don't rebuild what Firebase already gives you for free.** The console's own Firestore usage tab, Storage usage tab, and Functions invocation counts already show accurate totals with zero code. Storage bandwidth specifically — likely the single biggest cost driver for this app, since it's photo-heavy — is already tracked there per-project, per-day. Point yourself at those first. What they *don't* show is which screen or feature caused a given spike, which is the actual gap worth filling.

**What gets built instead: feature-attributed counting, not just totals.** A thin logging wrapper sits around the app's existing Firestore read/write helper functions (one central place, not sprinkled through every call site) and tags each operation with two things: the collection it touched, and a short feature tag for what the user was doing (`browseFeed`, `listingDetail`, `chatThread`, `dashboard`, `autoBook`, etc.). Counts accumulate in memory for the session rather than writing to Firestore on every single read — that would defeat the purpose by adding its own read/write overhead — and flush periodically (~every 60s) plus once more on page unload.

**The loop detector is the actual point.** If reads against any single collection cross a threshold within a short rolling window (starting guess: 200 reads/minute for one session), that session immediately flushes early and gets flagged, rather than waiting out the normal 60-second cycle. This is specifically aimed at catching a read-loop bug within minutes of a beta tester triggering it, instead of after they've been quietly blowing through quota for hours.

**Where it lives:** gated by a new `config/global.betaMetricsEnabled` flag (same doc already holding `feeWaiverEndDate`) so it's a one-line flip to turn off once beta ends, rather than a permanent piece of the app that keeps costing a little forever.

**A small viewer, not a build-out admin console.** A single `beta-metrics.html` page (own file, not part of the main app's routing) queries the `betaMetrics` collection directly and renders: totals by collection, totals by feature tag, and any session with an anomaly flag surfaced at the top. This is a diagnostic tool for you, not a user-facing feature — it doesn't need the polish or permission complexity anything else in this app has.

### Data Model

**`betaMetrics/{sessionId}`**
- `uid`, `startedAt`, `endedAt`
- `readsByCollection`, `writesByCollection` (maps: collection name → count)
- `readsByFeature`, `writesByFeature` (maps: feature tag → count)
- `bggProxyCalls` (number — tracked separately since BGG's rate limit, not cost, is the risk there)
- `anomalyFlags` (array of strings, e.g. `"rapid-read-loop:gameEntries"`)

### Write Permissions

- `betaMetrics/{sessionId}`: create/update only by the session's own `uid`; no client read (this is a write-only firehose from the app's perspective — reading it back for analysis happens through the `beta-metrics.html` viewer, which you'd run with your own elevated access, or simply via direct queries in the Firebase console).
- `config/global.betaMetricsEnabled`: same as `feeWaiverEndDate` — edited directly in the Firebase console, not app-writable.

### Suggested Placement

Unlike the trade-proposal work above, this one shouldn't sit at the end of the milestone list — its entire value is watching beta traffic from day one, so it needs to exist before real testers start using M1. I'd build this early and layer it in as each later milestone lands, rather than treating it as its own late-sequence milestone: the feature tags just need to expand as new views (M2's BGG search, M5's queue, M9's event browsing) come online.

## Suggested Milestone

**M10 — Trade proposals & payment preferences.** Depends on M4 (requests/chat must exist) and M7 (mutual completion logic needs to exist before it can be extended to handle two gameEntries). Doesn't depend on M8/M9 — trade proposals and event listings are independent extensions of the same request system and don't interact with each other.
