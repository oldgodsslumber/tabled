# Tabled — what's waiting on you

Snapshot taken 2026-08-21, after the admin console shipped.

## One thing I couldn't do (needs your hand)

Deleting deployed functions is blocked in auto mode. Tabled is now **free** —
Stripe is removed from all the code, but the two dead functions are still
deployed. Delete them (nothing calls them; the webhook was never wired):

```sh
firebase functions:delete createFeeCheckoutSession stripeWebhook --region us-central1 --force
firebase functions:secrets:destroy STRIPE_SECRET_KEY
firebase functions:secrets:destroy STRIPE_WEBHOOK_SECRET
```

Then a normal `firebase deploy --only functions` to sync the rest.

## Current state

| | |
|---|---|
| M1–M10 (both spec documents) | ✅ built, tested, deployed |
| US geo-lock | ✅ |
| Lots (several games sold as one unit) | ✅ |
| Admin console + VIP | ✅ |
| Firestore, Storage, rules, 22 indexes | ✅ deployed and probe-verified |
| 17 Cloud Functions, Node 22 | ✅ live |

Eleven browser suites plus a headless store suite, all green.

---

## 1. Bootstrap yourself as admin

Otherwise the moderation console is unreachable in production — `setUserRole`
is admin-only, and there is no admin yet.

```sh
cd functions
GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json \
  node scripts/grant-role.js you@example.com admin
```

Key: Firebase console → Project settings → Service accounts → Generate new
private key. **Delete it afterwards** — it is the whole project.

Then sign out and back in. Custom claims only arrive with a fresh ID token.

To click around it first without any of that: `?demo=1&role=admin`. That grants
nothing real — demo mode is pure localStorage.

## 2. Register with BoardGameGeek — the long pole

**BGG search is dead in production right now.** Their XML API stopped being open
as of the 2025-07-02 policy; every request needs a Bearer token from a
registered application, and unregistered calls get a flat 401.

Draft application text is in `BGG_APPLICATION.md`. Two things to know going in:

- Tabled is **commercial** by their definition (the verification fee is a user
  payment), though their policy gives a free commercial licence under 100 paying
  users.
- **Approval is not guaranteed.** BGG reserve the right to decline anything that
  competes with their business, and they run a marketplace.

Approval takes "a week or more" and blocks version selection and collection
import entirely. Worth sending today.

When the token arrives:

```sh
firebase functions:secrets:set BGG_API_TOKEN
firebase deploy --only functions:searchGames,functions:getGameDetails
```

## 3. Geocoding key — ten minutes

Still a placeholder, so `geocodeArea` throws `failed-precondition` on every
call before it ever reaches Google — silently, since that branch logs nothing.
Nothing in the database has a `geoPoint`, distance search returns nothing, the
safe-spot picker has no centre, and the address flow degrades to storing a bare
ZIP. The most visible hole in the live app, and the one that looks healthy in
the logs.

Enable the Geocoding API in Google Cloud Console, create a key, restrict it to
that API, then:

```sh
firebase functions:secrets:set GEOCODING_API_KEY
firebase deploy --only functions:geocodeArea
```

## 4. Run one real trade end to end

Everything has been verified in **demo mode**, which mirrors the server logic
faithfully but is not the server. The live app has never had a real trade
through it.

Before inviting anyone in, sign in for real and push one listing through
request → queue → schedule → complete. That is the pass most likely to surface a
rules or callable mismatch that demo mode structurally cannot catch, and it is
cheap compared to finding it with a real user watching.

---

## Set the Firestore TTL policies (console, 2 minutes)

Firestore → TTL → create policy for each:
- `meetingDetails` on field `expireAt` — self-deletes released addresses
- `messageArchive` on field `expireAt` — self-deletes archived threads

The functions already delete on schedule; TTL is the backstop if one is ever
skipped. Without it, an unconfirmed address or a missed archive would persist.

## Also outstanding, lower priority

- **Official "Powered by BGG" logo** — currently a text mark. A licence
  condition before going public.
- **BGG Phases 2 and 4** — version selection and collection import, both blocked
  on approval above.
