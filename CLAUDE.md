# ufcprob

UFC fight simulator: win, method and round odds, props, parlays priced inside the simulation, DFS with an exact lineup optimizer, fight breakdowns, best plays, live status and an accuracy record.

One of the owner's seven sibling apps (cfbprob, golfprob, hrprob, nascarprob, nflprob, nhlprob,
ufcprob), each its own repo and Vercel project, sharing the same stack and design kit.

## Layout

- `lib/dataset.js`: fight history (every UFC bout since 2010, round-by-round stats, fighter
  physicals) from a public CSV dataset (`UFC_DATASET_BASE`); `lib/espn.js` for cards and live status.
- `lib/ratings.js`, `lib/simulator.js`: fighter ratings (finish half-life `UFC_FINISH_HL`) and the
  fight simulator.
- `lib/card.js`: the card and its pre-fight freeze; `lib/lock.js` write-once locks
  (`ufc_snapshots` for the card, `ufc_plays` for Best plays), sealed at the first bout.
- `lib/plays.js`, `lib/parlay.js`, `lib/book.js`, `lib/dfs.js`, `lib/dfs-optimizer.js`: products.
- `lib/lean.js`: the lean indicators on each bout (thresholds mirrored in `app.html`).
- `lib/grading.js`, `lib/backtest.js`: accuracy. `docs/BUILD-READOUT.md`: the model in detail.

## Rules specific to this app

- The pre-fight card and plays lock at the first bout and show Won/Lost after; numbers must not
  update during or after fights.

- **Touch-screen scrolling:** on touch screens the document never scrolls: `html`/`body` are a
  fixed-height column (top bar, tab bar, then `#scroller`, the only thing that scrolls; the event
  header is moved into it at startup). Desktop keeps the sticky bars and document scrolling. Why:
  on Chrome for iOS, document scrolling made the browser toolbar slide in and out and left the page
  resting ~120px down with the first rows under the pinned bars (measured and fixed in nflprob first).
  Don't reintroduce document-level scrolling or `position: sticky/fixed` bars on touch screens;
  scroll code goes through `getScroll`/`setScroll`; never run layout code on a height-only `resize`;
  sideways-scrolling boxes keep `overflow-y: hidden`. The app page is served `no-store`.

## How to work in this repo

- **Commands:** `npm test` runs the test suite (synthetic data, no network). After editing
  `app.html`, extract its `<script>` block and run `node --check` on it.
- **Deploy:** Vercel deploys `main` automatically; there's no build step. Pushing straight to `main`
  is fine for this project. A hard refresh (Cmd+Shift+R) may be needed after a deploy.
- **Secrets:** the database URL and any keys live in Vercel's environment variables. Refer to
  variable names only; never put values in code, commits or messages.
- **Stack:** Vercel serverless functions in `api/` (one file per route, `_util.js` shared), model
  and data code in `lib/`, the whole frontend in one `app.html` (vanilla JS, no framework), optional
  Postgres via `lib/db.js` (`DATABASE_URL`, `POSTGRES_URL` or the Prisma/Supabase variants).

## House rules (the owner's preferences)

- **Data first, honestly reported.** Model changes are checked on real past games (a leak-free
  replay: each day predicted only from earlier days) before they're called improvements, and
  results are reported as measured, including when a change doesn't help.
- **Public pages speak plainly.** No internal jargon, debug chips or "how we built it" notes on the
  page: that knowledge stays in the code and docs.
- **Picks lock.** Anything shown as the day's pick is saved write-once before the first start and
  never changes after; a database that doesn't answer writes nothing and shows "unconfirmed".
- **Never** put an AI model name in commits or code.
