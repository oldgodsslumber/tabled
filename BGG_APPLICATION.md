# BGG API application — draft text

Register at **https://boardgamegeek.com/applications** → "create an application".

BGG warn a response may take **a week or more**. Phases 2 (version selection)
and 4 (collection import) are blocked until a token arrives, so this is the
long pole — send it before building anything that depends on it.

---

## Answer honestly: this is a **commercial** application

BGG's own definition: *"if your application will be showing advertising or
offering users any benefit in exchange for payment, it is considered
commercial."*

Tabled charges sellers $0.25 per completed trade to keep a "Verified" badge
current. That is a user payment, so it's commercial — even though the fee is
currently waived until 31 December 2026 and no money has changed hands.

Declaring non-commercial to get a faster approval would be a
misrepresentation that could get the licence withdrawn later, which is far
worse than waiting.

Their stated policy for payment-monetized apps: *"we usually offer a free
commercial license until you have 100 paying users."* So this should cost
nothing for a long while.

## Be aware of the real risk before you send it

BGG reserve the right to decline: *"any application which, in our judgment,
competes with any part of BGG's business, or which harms us in any way, may
be denied."*

**BGG runs its own marketplace. Tabled is a marketplace.** They may read that
as competing. The draft below leans into the difference — local, in-person,
no payment processing, no shipping infrastructure — because that difference
is real and is the strongest honest case. It is not a guarantee.

If they decline, the manual-entry path already built becomes the product
rather than the fallback, and Phases 2 and 4 don't happen.

---

## Draft — application description

> Tabled is a mobile-first web app for buying, selling and trading used board
> games **locally and in person**, within the United States only. It exists to
> replace the two places this currently happens badly: Facebook Marketplace
> listings with no structured game data, and BGG forum threads used to
> coordinate before conventions.
>
> **How BGG data would be used.** On listing creation, a seller searches for
> the game they're selling and picks the matching entry. We call `search`
> once per debounced query and `thing` once when a game is selected, then
> cache the result in our own database keyed by BGG id — so a game already
> listed by anyone is never fetched again. Cached fields are name, year,
> image, categories, mechanics, and marketplace price data used to show
> sellers a suggested price. All calls are server-side from Cloud Functions,
> serialized with a 5-second gap. We would also like to use `thing` with
> `versions=1` so sellers can identify which printing they own, and
> `collection` so a user can import their own library rather than retyping it.
>
> **Attribution.** The "Powered by BGG" mark is displayed, linking to
> BoardGameGeek, wherever BGG-sourced data appears.
>
> **On overlap with the BGG Marketplace.** Tabled is deliberately local and
> in-person: listings are geo-restricted to the United States, discovery is by
> distance from the buyer, and the app coordinates meeting up — including
> scheduling around a specific convention. Tabled never processes payment for
> a game; money changes hands directly between the two people, and the app has
> no payment rails, no shipping labels and no carrier integration. It is a way
> for people in the same town to find each other, not a storefront. If you
> consider any part of this to overlap with the BGG Marketplace in a way you
> aren't comfortable with, we would genuinely rather hear that now and adjust
> than proceed on a misunderstanding.

## Fields you'll likely be asked for

| | |
|---|---|
| Application name | Tabled |
| URL | https://github.com/oldgodsslumber/tabled (add the live URL once hosted) |
| Type | Commercial |
| Monetization | User payments — $0.25 per completed trade, currently waived until 2026-12-31 |
| Approximate users | Pre-launch, zero |
| Server or client calls | Server-side, from Firebase Cloud Functions |

---

## When the token arrives

```sh
firebase functions:secrets:set BGG_API_TOKEN
firebase deploy --only functions:searchGames,functions:getGameDetails
```

Then confirm it works — a 401 here means the token is wrong, unapproved, or
the request reached the `www` subdomain:

```sh
curl -s -H "Authorization: Bearer <token>" \
  "https://boardgamegeek.com/xmlapi2/thing?id=224517" | head -c 300
```

**Before going public**, replace the text "Powered by BGG" mark with one of
BGG's official logo files, sized so the text stays legible. That is a licence
condition, not a preference.
