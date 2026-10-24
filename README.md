# ufcprob

UFC fight simulator: win, method and round odds, props, parlays priced inside the simulation,
DFS projections with an exact lineup optimizer, fight breakdowns, best plays, live status and an
honest accuracy record. Same stack and design kit as golfprob, nflprob, hrprob and nascarprob:
Vercel serverless functions, optional Supabase Postgres, one `app.html`.

## Deploy

1. Import the repo in Vercel (framework preset: Other). No build step.
2. Optional but recommended: set `DATABASE_URL` to a Supabase Postgres connection string.
   Without it the model runs on the last 70 events fetched live.
3. Backfill (with a database): open `/api/sync` and repeat until `remaining` and
   `fightersRemaining` are both 0 (events since 2014, then fighter physicals).
4. Open `/api/health` first: it fetches UFCStats and ESPN and shows what came back. The page
   templates and feed shapes were written from memory, so this is where a change shows up.

## Routes

| Route | What it does |
| --- | --- |
| `/` | The app |
| `/api/card?event=` | Card payload: bouts, fighters, win/method/round odds, DFS means, reasons |
| `/api/events` | Upcoming and recent events for the picker |
| `/api/plays` (POST `{book}`) | Best plays; pasted prices switch sections to value ranking |
| `/api/parlay` (POST `{legs}`) | Prices a custom ticket inside the simulation |
| `/api/dfs` (POST `{csv}`) | Projections, the run-by-run sample and opponent pairs for the optimizer |
| `/api/live?date=` | ESPN live status for a card |
| `/api/backtest?events=25` | Leak-free backtest |
| `/api/grades` | Graded pre-fight snapshots |
| `/api/sync` | History backfill (weekly cron grades too) |
| `/api/status`, `/api/health` | What history is loaded; source checks (`?event=` audits one event) |

## Tests

`npm test` runs everything against a synthetic world (`tests/fixtures.js`): fake fighters, fake
cards, UFCStats-style HTML, the real handlers. See `docs/BUILD-READOUT.md` for the model.
