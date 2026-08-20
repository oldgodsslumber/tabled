# Tabled — Trade Proposals & Payment Preferences (Addendum Vision Doc)

This extends `board_game_marketplace_spec.md` (the main Tabled vision doc) — it assumes that doc's collections, milestones, and conventions, and only documents what's new or changed. Read this alongside it, not instead of it.

## Audit Summary

**What was strong / a clean fit:** all three asks turned out to be extensions of infrastructure that already exists rather than new systems. A trade proposal is structurally a `request` with a different payment shape attached — same hold/queue, same chat, same `proposedTime` → seller-confirm gate, same mutual-completion flow from M4–M7. That reuse is the core design decision here.

**Filled in during this pass:**
- A trade proposal (with or without an existing listing) is just `requests.proposalType = 'trade'` instead of `'purchase'`, with extra fields for what's being offered. It goes through the identical queue/chat/confirm/complete pipeline already built — no parallel system.
- Accepted payment methods (`cash`, `paypal`, `venmo`, `trades`) live on the listing as purely informational metadata. None of them are ever processed by the app — this is the same boundary as the actual game sale itself: the app displays what a seller is open to, and everything after that happens outside it. Only "Trades" has any functional effect: it's what gates whether the "Propose a Trade" button even shows on that listing.

**Assumptions made (please confirm or correct):**
- When someone offers one of their *own existing listings* as part of a trade proposal (the first ask), that gameEntry is locked to a new `reserved` status the moment the proposal is submitted — not just once they become the queue holder. Reasoning: it's a real, undupliable physical item, and letting it sit fully "active" while it's also on the table in an unrelated trade risks it getting committed twice. If the proposal is declined, cancelled, or expires, it reverts to `active` automatically. Flag if you pictured something looser (e.g., only reserving it once the proposal reaches the top of the queue).
- Cash top-up is one-directional and free-text/negotiated, not a structured bidirectional field — a proposer can note "my Catan + $10" as an `additionalCashOffered` amount, but the actual number isn't validated or enforced by the app; it's just displayed to the seller as part of the offer, same as everything else that gets finalized in chat.
- Trade proposals count toward `tradeCount` and unlock reviews for **both** participants on completion, same as a normal purchase — a trade is symmetric, both sides gave something up.

**Still open:**
- Should "describe an item I have" (the second ask — a trade offer with no listing behind it) contribute anything to the offering user's public trade history if the trade falls through, or does it only ever matter if the trade completes? My assumption is the latter (nothing recorded unless completed) — flag if you want unlisted offers tracked differently.

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

## Suggested Milestone

**M10 — Trade proposals & payment preferences.** Depends on M4 (requests/chat must exist) and M7 (mutual completion logic needs to exist before it can be extended to handle two gameEntries). Doesn't depend on M8/M9 — trade proposals and event listings are independent extensions of the same request system and don't interact with each other.
