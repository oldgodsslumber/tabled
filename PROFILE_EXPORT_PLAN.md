# Plan — Export your profile as plain text ("take my list off-app")

**Goal.** A seller can turn their Tabled profile into a block of plain text they
can paste into a Facebook group post, a Reddit thread, a Discord channel, or a
BGG geeklist — so the people still trading in those venues can see the whole
inventory at a glance without an account.

**Status:** steps 1–3 built, bug-fixed and re-verified (build `20260901c`) — `CFG.EXPORT`, `js/export.js`,
`Store.exportInventory` in both backends, `U.copyText`, and the profile modal
with a live preview, character counter, copy and download. Facebook is the only
format so far; the picker appears automatically once `CFG.EXPORT.FORMATS` has a
second entry. Steps 4–6 outstanding. See §12 for what two testing passes found
and what changed as a result.

---

## 1. The one decision that shapes everything

"Export as a table" is not one format. The venues people actually paste into
disagree about what a table *is*:

| Venue | Renders markdown pipes? | Monospace? | What actually works |
|---|---|---|---|
| Reddit (post/comment) | Yes | No | markdown pipe table |
| Facebook (post/comment) | **No** | **No** | one game per line, ` · ` separators |
| Discord / BGG forums | No (BBCode) | Yes, in code fences | fixed-width padded ASCII table |
| Spreadsheet / email | n/a | n/a | CSV |

A single output that hedges between these is bad everywhere. Facebook is the
worst case: it strips nothing but aligns nothing — a padded ASCII table collapses
into ragged garbage in its proportional font, and pipe characters show up as
literal pipes. So the feature ships **four named formats behind a picker**, all
generated from one intermediate row model.

That's the whole reason this is more than a `join('\n')`.

---

## 2. Where it lives

Own-profile only (`mine === true` in [views-profile.js:113](js/views-profile.js#L113)).

- An **`Export list`** ghost button in the existing `.profile-actions` row, next
  to *Edit profile* / *Watchlist* / *New listing*.
- Opens `U.modal('Export your list', …)` — the app already has a modal helper
  with scrim, Escape handling and `close()` ([util.js](js/util.js)), so no new
  overlay machinery.
- No new route. This is a transient action, not a page; a `#/export` route would
  drop an empty shell into browser history and the back-button path.

Visitors do not get this. Exporting *someone else's* inventory to Facebook is a
scraping affordance, not a sharing one.

---

## 3. Data sourcing — the real work

The profile shows listings 12 at a time via `mountListings` →
`Store.queryListings({sellerId, statuses, sort, limit}, cursor)`
([views-profile.js:221](js/views-profile.js#L221)). Exporting "what's on screen"
would silently emit only the first page — exactly the failure that makes a seller
stop trusting the feature.

**New store method: `Store.exportInventory(uid, opts)`**

1. Page `queryListings({sellerId, statuses:['active'], sort:'new', limit:50})`
   until `exhausted`, or until `CFG.EXPORT.MAX_LISTINGS` (200).
2. For each listing, `Store.getEntries(listing.id)`
   ([store.js:377](js/store.js#L377)) — the per-game facts live on the
   `gameEntries` subcollection, not the parent: `name`, `condition`,
   `askingPrice`, `tags`, `notes`, `contents`, `status`. The parent rollup carries
   only denormalized aggregates, too lossy to export.
3. Run those `getEntries` calls through a **concurrency-limited pool (6 at a
   time)**, not `Promise.all` over 200 listings — otherwise opening the modal
   fires 200 simultaneous subcollection reads.
4. Skip entries whose `status !== 'active'` (on hold / sold) unless the user opts
   to include them.

Both backends must implement it — cloud and demo. A method present in one and
missing in the other diverges silently, which the file already warns about at
[store.js:1171](js/store.js#L1171).

**Cost note.** Worst case ≈204 document reads per export. Cache the result on the
modal instance so switching formats, toggling columns, or re-sorting never
refetches.

---

## 4. The intermediate row model

Every formatter consumes the same array, built once:

```js
{
  title:     'Brass: Birmingham',   // entry.name, falling back to the game doc
  bggId:     '224517',              // or null — needed for BGG geeklist output
  condition: 'LN',                  // raw key; label via CFG.condition(key).label
  price:     45,                    // number or null
  tags:      ['Sleeved cards'],
  notes:     'Box has a small dent',
  contents:  ['Cornish Mine expansion'],  // lots only
  listingId: 'abc123',
  url:       'https://…/#/listing/abc123'
}
```

Two shape rules worth stating up front:

- **A lot is one row, not N rows.** `contents` renders inline as
  `Brass: Birmingham (+ Cornish Mine, promo tiles)`. Exploding a lot into rows
  implies the pieces are separately purchasable, which is the opposite of what a
  lot means ([store.js:456](js/store.js#L456)).
- **Never emit a condition label as stored data.** `CFG.CONDITIONS` is the source
  of truth; export resolves key → label at render time via `CFG.condition()`,
  same as every other view.

**URL derivation.** There's no canonical-origin constant in the codebase today.
Add `CFG.EXPORT.ORIGIN = null` and compute
`CFG.EXPORT.ORIGIN || (location.origin + location.pathname)` — correct on
`tabled-2ad11.web.app`, on a custom domain, and on localhost, with an override
available if the app is ever served from a path that shouldn't be shared.

---

## 5. The four formatters

Each is a pure `rows[] → string`. Pure means the live preview, the clipboard
copy, the `.txt` download and any future test all run the same code with no drift.

### A. Reddit (markdown table) — default

```
**Kevin's board game list — Jacksonville, FL**

| Game | Condition | Price |
|:--|:--|--:|
| Brass: Birmingham | Like New | $45 |
| Ark Nova *(+ Marine Worlds)* | Very Good | $60 |
| Wingspan | Good | $30 |

*Local pickup or meet-up. Cash, Venmo. Full list & photos: <url>*
```

Escape `|` inside titles as `\|` — a game named `Fire & Ice | Redux` would
otherwise split a cell and shear the whole table.

### B. Facebook / plain (line per game)

```
Kevin's board game list · Jacksonville, FL

• Brass: Birmingham · Like New · $45
• Ark Nova (+ Marine Worlds) · Very Good · $60
• Wingspan · Good · $30

Local pickup or meet-up. Cash, Venmo.
Full list & photos: <url>
```

No pipes, no padding, no leading spaces. Blank lines between header, body and
footer — Facebook collapses single newlines in some surfaces but always keeps the
paragraph break.

**Separator revised during build.** The first draft used ` — `, on the reasoning
that an ASCII `-` reads as a stray mid-sentence hyphen in a proportional font.
That holds, but em dashes are common *inside* game titles (`Twilight Imperium:
Prophecy of Kings — Shattered Ascension`), which left a reader no way to tell
where the title stopped and the condition began. The separator is now ` · ` — a
middle dot is effectively absent from board game names and still reads as
punctuation rather than a hyphen.

### C. Monospace (Discord / BGG code block)

Columns padded to the widest cell, wrapped in a fenced block (toggleable — BGG
forums want `[c]…[/c]` instead). Truncate titles past `CFG.EXPORT.MAX_TITLE` (40)
with `…` so one *Twilight Imperium: Prophecy of Kings* doesn't push every row past
Discord's wrap width.

### D. CSV

`Game,Condition,Price,Tags,Notes,Link` with RFC-4180 quoting (double the quotes;
wrap any field containing a comma, quote or newline). This is the one that makes
the export useful for a group's shared spreadsheet, and it's ~15 lines of code.

### E. Optional — BGG geeklist BBCode

We already carry `bggId`, so `[thing=224517][/thing]` auto-links to the real game
page on BGG. High value for exactly this audience and nearly free. Ship it if D
lands easily; drop it without regret if not.

---

## 6. Modal UI

```
┌ Export your list ─────────────────────────────┐
│ Format:  [Reddit] [Facebook] [Monospace] [CSV]│
│                                               │
│ Include: [x] Condition  [x] Price             │
│          [ ] Tags       [ ] Notes             │
│          [ ] Per-game links                   │
│          [ ] Items on hold                    │
│ Sort:    (Name ▾ | Price high→low | Newest)   │
│                                               │
│ ┌───────────────────────────────────────────┐ │
│ │ live preview — monospace, selectable,     │ │
│ │ scrollable, readonly textarea             │ │
│ └───────────────────────────────────────────┘ │
│ 1,284 characters · 23 games                   │
│                                               │
│           [Download .txt]  [Copy]             │
└───────────────────────────────────────────────┘
```

- The preview is a **real `<textarea readonly>`**, not a `<pre>`. On iOS Safari
  the clipboard API is unreliable outside a direct user gesture; a textarea makes
  the fallback "it's already selected, hit Copy" instead of a dead button.
- **Copy:** `navigator.clipboard.writeText()` → on rejection `select()` +
  `document.execCommand('copy')` → on failure `U.toast('Select the text above and
  copy')`. Nothing in the codebase touches the clipboard yet, so this is the first
  instance — put it in `util.js` as `U.copyText(str)` so the listing page can
  reuse it for share links later.
- The **character counter is not decoration.** Reddit comments cap at 10,000
  characters; a 60-game list with notes and links blows straight through it. At
  90% of `CFG.EXPORT.LIMITS[format]` the counter turns warn-colored and a line
  appears: *"Longer than a Reddit comment allows — try turning off Notes, or post
  it in two parts."*
- Column toggles and sort re-render from the cached rows. Zero refetch.

---

## 7. Privacy

The text leaves the app's control the moment it's pasted, so the boundary belongs
in the generator, not in UI copy.

**Included:** display name, `generalArea` (already server-side jittered —
[store.js:350](js/store.js#L350)), game rows, accepted payment methods,
fulfillment mode, profile URL.

**Never included, at any toggle setting:** `geoPoint`, `geohash`, email, phone,
`availabilityWindows`, buyer names, or anything from the request/thread layer.
Availability is a deliberate omission — "Saturdays 10am–2pm, Jacksonville" posted
publicly next to a name is a meet-up schedule handed to strangers, and the in-app
flow already does scheduling safely.

One footnote line in the modal: *"This posts your name and general area publicly.
Meet-up details stay in the app."*

---

## 8. Business tension — worth stating plainly

This feature helps people transact off-platform, which cuts against the
marketplace. That's the ask, and it's defensible (it meets sellers where their
audience already is), but the output should be biased toward pulling traffic back:

- The footer link to the profile is **always present and not toggleable**.
- Per-game links default **off** — they bloat every format, and the profile link
  already does the job.
- Fire an analytics event on copy — `{format, gameCount}` — so it's measurable
  whether exports feed inbound traffic or drain it.

---

## 9. Files touched

| File | Change |
|---|---|
| [js/config.js](js/config.js) | New `EXPORT` block: `MAX_LISTINGS`, `MAX_TITLE`, per-venue `LIMITS`, `ORIGIN`, `FORMATS`. Export it from the `return {}` at [config.js:472](js/config.js#L472). Bump `BUILD`. |
| **`js/export.js`** (new) | `window.ExportList` — row builder + the four pure formatters. No DOM, no Firestore. |
| [js/store.js](js/store.js) | `exportInventory()` in **both** `CloudBackend` and the demo backend. |
| [js/util.js](js/util.js) | `copyText()` with the three-tier fallback; add to the exports at [util.js:293](js/util.js#L293). |
| [js/views-profile.js](js/views-profile.js) | Export button in `.profile-actions`; `openExportModal()` + wiring. |
| [css/](css/) | `.export-modal` grid, format tab chips, preview textarea, counter warn state. |
| [index.html](index.html) | `<script src="js/export.js?v=…">` before `views-profile.js`; bump every `?v=` stamp. |

No Firestore rules changes — this reads only listings and `gameEntries` the seller
already owns and already reads on this page.

**Cache-bust discipline:** `CFG.BUILD` and every `?v=` stamp in
[index.html:146-162](index.html#L146-L162) move together, or the browser serves
yesterday's app and the feature appears not to exist.

---

## 10. Build order

1. `CFG.EXPORT` + `js/export.js` with the row model and the Facebook formatter.
   Testable against hand-built row arrays with no backend at all.
2. `Store.exportInventory` (cloud + demo) with the concurrency pool.
3. Modal + preview + `U.copyText`, Facebook format only, end to end.
4. Reddit, Monospace, CSV formatters + the format picker.
5. Column toggles, sort, character counter and its warning.
6. Optional: BGG BBCode; a "copy in two parts" splitter for over-limit lists.

Steps 1–3 are a shippable feature on their own. Everything after is breadth.

---

## 11. Test notes

- Seller with 0 active listings → modal shows an empty state, not an empty box.
- A lot with 4 `contents` → one row, contents inline, not four rows.
- A game titled `Fire & Ice | Redux` → does not shear the Reddit table.
- `askingPrice: null` → never `$NaN`. **Revised during build:** the column
  formats keep `U.money`'s `—`, but the line formats separate facts with em
  dashes, so `—` collided with the separators and produced
  `Wingspan — Good — —`. Line formats say `Ask` instead (`priceInline` in
  [js/export.js](js/export.js)).
- 60 games with notes → counter goes warn, guidance line appears.
- Demo mode (`kind: 'demo'`) and cloud mode produce identical text for the same
  inventory.

---

## 12. What testing found

Two independent passes after steps 1–3 landed: one on the pure logic (Node + a
`vm` harness), one driving the real app in Chromium against the demo backend and
pasting the output into a `contenteditable` and a `<textarea>`. Both found the
fulfillment bug independently. Everything below is fixed in `20260901b`.

**Two that mattered**

1. **Cloud pagination was dropping listings — and not only from the export.**
   `queryListings` over-fetches `lim * 2` docs and returns `slice(0, lim)`, but
   it took its cursor from the *last fetched* doc and computed `exhausted` from
   the *fetched* count. Two distinct defects: page 2 resumed past the surplus
   (docs 51–100 silently gone), and a short-but-over-full page called itself the
   last one (a 60-listing seller got 50 and no "Load more"). This is
   pre-existing and shared — the feed and the profile's own listing sections had
   it too. Fixed by cursoring off the last **returned** row and testing
   `passed.length <= lim` alongside the fetch count. Verified across 14 boundary
   sizes plus a 1-in-3 client-filtered set: no gaps, no duplicates.

2. **`fulfillment` is a boolean map, not a string.** `{pickup: true,
   inPersonAtEvent: false}` — a listing can offer both, which is why it is
   shaped like `acceptedPayment`. `terms()` keyed a map with the object, so
   `"[object Object]"` matched no label and **"Local pickup." never appeared in
   any export.** This one was mine: the plan modeled the field from memory and
   the code never checked the real shape.

**The rest**

- Sold copies were labelled `ON HOLD`. The two real entry statuses (`sold`,
  `reserved`) mean opposite things to a buyer, so they now get distinct labels.
- A newline or tab in a game title, tag or display name broke the
  one-game-per-line contract. All free text is flattened in the row model now.
- An em dash *inside* a title was indistinguishable from the field separator —
  the reason for the ` · ` change in §5B.
- `terms()` and the truncation notice printed under an empty list, advertising
  an inventory that isn't there. Zero rows now stops after the empty line.
- A missing `user.id` published a `#/profile/undefined` link. The line is now
  omitted rather than broken.
- `truncated` was set when the inventory landed *exactly* on `MAX_LISTINGS`.
- A failed `getEntries` silently emptied a listing. It's counted and surfaced in
  the output now — a seller must never be handed a quietly short list to post.
- `U.copyText(text, el)` copied `el.value` rather than `text` (execCommand
  copies the selection). Harmless in the one live call site, wrong as a utility;
  the element is only reused when its value matches. It also rejected on a
  synchronous `writeText` throw despite a "never rejects" contract, which killed
  the copy button with no toast.
- Copy reported success on an empty preview. Copy and Download are disabled
  unless there is something to paste.
- A formatter that throws blanked the preview, which looked exactly like an
  empty inventory. It now says which format failed.
- The 90% counter turned orange with no explanation. It says why.
- The modal was not dismissed by hash navigation, so it sat over the feed with
  the page still scroll-locked.
- Non-array `tags`, negative/`Infinity`/numeric-string prices no longer throw or
  print `$-5` / `$Infinity` / `$NaN`.

**Confirmed clean:** a 64-combination privacy sweep with `geoPoint`, `geohash`,
email, phone, `availabilityWindows`, buyer name and a street `locationLabel`
planted on both the user and listing objects leaked nothing into any output. The
concurrency pool never exceeded 6, ordering held under randomized latency, and
paging terminated against a backend that never reports itself exhausted.
Clipboard round-trip kept `•` and `—` with no mojibake in both paste targets;
the download is valid UTF-8 with no BOM.

**Known, not fixed**

- `U.modal` does not move or trap focus, so tabbing past the last control walks
  into the page behind the modal. Pre-existing and app-wide — a fix belongs in
  `U.modal`, not here, and it would touch every modal in the app.
- A wrapped bullet's continuation line starts flush left in a narrow
  proportional-font paste. Inherent to the no-leading-whitespace decision, since
  indentation is exactly what Facebook does not preserve.
- The §8 analytics event on copy is not implemented.
- A middle dot *inside* a game title re-creates the separator collision in
  miniature (`Sherlock Holmes · Consulting Detective`). Far rarer than em dashes
  in titles, so ` · ` remains the right trade; noted rather than chased.
- `Local pickup or In person at an event.` reads awkwardly — the capital "I"
  comes from the shared `CFG.FULFILLMENT` label, which other views render too.
  Not worth diverging the vocabulary over.

**Re-verified in Chromium after the fixes** (build `20260901c`): all of the above
confirmed fixed against the original reproductions, with net-zero listener
accumulation across close-by-Escape / × / scrim / navigation. Regression pass on
the shared paging change found none — feed 34/34 with Load more clearing, profile
active 30/30, sold 15/15, watchlist 8/8, no duplicate cards anywhere. Two things
the pass could NOT cover, both environmental: the cloud `queryListings` fix
itself (no emulator or credentials — demo mode runs a different, untouched
implementation), and forcing a `getEntries` rejection to exercise the `failed`
counter end-to-end (`collectInventory` calls the backend object directly, which
is closure-private and unreachable from the console; the formatter's handling of
`failed` was verified, the store-side counting only by code read).

Two fixes landed from that pass: the over-limit message no longer advises turning
off Notes (there is no toggle yet, and notes are off by default, so the advice
was both impossible and useless), and the empty-inventory counter now uses the
warn colour — the preview shows a complete-looking stub, so a muted grey line
under it was easy to read past while Copy sat greyed out with no explanation.
