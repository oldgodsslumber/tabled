# Wikidata proof of concept

A branch (`wikidata-poc`) that sources board-game data from **Wikidata** instead
of BoardGameGeek — built so you can show a working end-to-end flow without
waiting on BGG's approval, which BGG closed their API behind in July 2025.

## Why this exists

BGG's XML API now requires a registered, approved application and a Bearer
token, and **approval may be refused** because BGG runs a competing marketplace.
This branch proves Tabled works without them.

## The decisive advantage: it runs client-side

Wikidata's endpoints send `Access-Control-Allow-Origin: *`, so the browser can
call them directly. BGG has no CORS and now needs a token, forcing a Cloud
Function proxy. Wikidata needs **no proxy, no key, no approval, no deploy** — so
the whole create-a-listing flow works straight from the demo link.

## Show it

Serve the folder and open the PoC URL:

```
python -m http.server 8791
# then open:
http://127.0.0.1:8791/index.html?demo=1&source=wikidata
```

Sign in (demo), tap **Sell**, and search for a game — Wingspan, Gloomhaven,
Catan, Terraforming Mars, Pandemic. The results, year, categories and BGG id are
all pulled live from Wikidata. Post the listing; it renders with the real data.

`?source=wikidata` is the switch. Without it the app behaves exactly as before
(BGG proxy in cloud mode, sample catalogue in demo). The flag works against the
live project too, not just demo.

## What it does well

- **Popular games are well covered** — the titles people actually trade.
- **Real BGG ids** come through when Wikidata has them (~3,200 of ~4,000
  games), so a Wikidata-sourced game and a future BGG-sourced one share one
  cache key.
- One SPARQL call returns candidates *with* details — a single round trip where
  BGG needed two.
- **Two ways in, UNION'd: the "board game" class OR a BoardGameGeek id (P2339).**
  The BGG-id branch is the important one — it's the strongest signal that an
  entity is a real, tradeable tabletop game, and it rescues titles filed under a
  *neighbouring* class. Azul, for example, is tagged "tabletop game" (the parent
  of "board game", so even a subclass walk can't reach it) but carries BGG id
  230802, so it's found anyway. This is also why the reachable set is larger
  than a pure class match suggests.

## What it can't do (be honest about these when showing it)

- **Coverage is a few thousand games vs BGG's 150,000+.** The long tail is thin.
  A title can still be missing entirely — it isn't in Wikidata, or it's there
  with neither the board-game class nor a BGG id — and manual entry backs up
  anything absent. (This is also editable: Azul *was* unreachable until someone
  added the right statements to its Wikidata item, which is the flip side of an
  open source — the gaps are fixable, by anyone, including us.)
- **No box art, reliably.** Wikidata's image property is often a components
  photo or even the designer's portrait, not the cover. The code shows whatever
  image exists; sometimes that's nothing useful.
- **No marketplace pricing**, so no suggested price and no "Good Deal" sort for
  Wikidata games — same position as a hand-entered game.
- **No version/printing data**, so this can't feed a version-selection feature.
- **Genres are Wikidata's vocabulary** ("card game", "tile-based game"), which
  won't line up with BGG's fixed category strings — so a Wikidata game may not
  match the category filter dropdown.

## The verdict

Wikidata is a **viable fallback if BGG refuses** — better than manual-only,
because it still gives categories, years and ids for the games most people
trade. It is **not a full replacement**: use it as tier 2 behind BGG, not
instead of it.

## How it's wired

- `js/wikidata.js` — the client. `search()` and `details()` return the same
  shapes BGG's do, so `js/bgg.js` delegates to it when the flag is set and
  nothing downstream changes.
- The `bggId` field carries a real BGG id when present, else the Wikidata Q-id
  prefixed `wd_`.
- Attribution is source-aware: a Wikidata game shows "Game data from Wikidata
  (CC0)", a BGG game shows "Powered by BGG". Both are licence conditions.

To make this the default (e.g. if BGG says no), set `CFG.GAME_SOURCE =
'wikidata'` in `js/config.js` and the flag is no longer needed.
