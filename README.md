# ufcprob

UFC fight simulator: win, method and round odds, props, parlays priced inside the simulation,
DFS projections with an exact lineup optimizer, fight breakdowns, best plays, live status and an
honest accuracy record. Same stack and design kit as golfprob, nflprob, hrprob and nascarprob:
Vercel serverless functions, optional Supabase Postgres, one `app.html`.

## Deploy

1. Import the repo in Vercel (framework preset: Other). No build step.
2. Nothing to backfill. Fight history (every UFC bout since 2010 with round-by-round stats and
   control time, plus fighter reach, height, stance and birth date) loads from the public
   [scrape_ufc_stats](https://github.com/Greco1899/scrape_ufc_stats) dataset on GitHub, a weekly
   mirror of UFCStats. UFCStats itself serves a browser challenge to servers, so it isn't called.
   Cards, running order, rounds, live status and bios for debutants come from ESPN.
3. Optional: set `DATABASE_URL` or `POSTGRES_URL` (Supabase Postgres; Project Settings → Database → Connection string → URI, transaction pooler, port 6543) to keep each card's pre-fight projection and
   grade it on the Accuracy tab once results reach the dataset.
4. Open `/api/health`: it loads both sources and fails (HTTP 503, `ok: false`) on empty or stale
   data, not just on errors. It also checks how many fighters on the next card matched history.

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
| `/api/sync` | Reloads the dataset and grades saved snapshots (weekly cron) |
| `/api/status`, `/api/health` | What history is loaded; source checks (`?event=` audits one event) |

## Tests

`npm test` runs everything against a synthetic world (`tests/fixtures.js`): fake fighters, fake
cards, served as the dataset CSVs and ESPN's feed shapes, through the real handlers. See `docs/BUILD-READOUT.md` for the model.
