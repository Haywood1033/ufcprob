# ufcprob build readout

## Model

1. **Elo**, replayed through every bout in date order. K scales with how decisive the result was
   (round-1 finish 1.35×, later finishes 1.1–1.2×, unanimous 1×, majority 0.8×, split 0.6×), is
   1.3× for fighters with fewer than 3 UFC bouts, and layoffs over a year pull the rating 10% a
   year back toward 1500. Debutants start at 1470.
2. **Style**: per-15-minute significant strikes landed/absorbed, takedowns for/against,
   knockdowns and submission attempts, recency-weighted (2.5-year half-life) and regressed to the
   weight class with 30 minutes of prior. Finish power and vulnerability (KO/sub wins and losses
   per 15 minutes) carry 75 minutes of prior.
3. **Win model**: a logistic on the Elo gap, striking and grappling differentials, age gap, age
   past 34, reach, UFC experience and layoff — antisymmetric, fit by ridge-penalised maximum
   likelihood on earlier bouts only.
4. **Finish model**: per-minute KO and submission hazards from the class rate × (winner's power
   × loser's vulnerability)^α, scaled by how big a favourite the winner was (^γ); cKO, cSUB, α, γ
   fit by grid search on the likelihood of every past bout's method and round.
5. **Simulation**: 15,000 runs per bout; winner, then round-by-round finishes, else the judges;
   fantasy stats for the time fought. Every market comes from the same runs.
6. **Backtest and grading**: `/api/backtest` replays recent events leak-free against a coin flip,
   Elo alone and base rates; pre-fight snapshots are saved and graded after each card.

## Data

- **History:** the public scrape_ufc_stats dataset on GitHub (four CSVs mirrored weekly from UFCStats).
  - Events, results (method, round, time, scheduled rounds), per-round stats summed per fighter,
    and the tale of the tape.
  - 7,683 bouts since 2010 at the time of writing, every one with stats.
  - Results list fighters by name, so ids come from the tale-of-the-tape file. The ~1% of bouts
    involving two fighters who share a name are kept under one name id.
- **Cards, live status and debutants:** ESPN's MMA feeds.
  - The scoreboard gives bouts in start order, scheduled rounds and live status.
  - The core API gives card segments.
  - Athlete bios give height, reach, stance and birth date, used for debutants or when the
    dataset lacks them.
  - ESPN fighters are matched to history by name (accents, case, suffixes and word order
    tolerated); a fighter with no match is a debutant.
- **UFCStats.com directly:** not used. It serves a JavaScript challenge to servers.

## First real backtest (25 events, 310 bouts, Oct 2026)

| | Model | Elo alone | Base / coin |
| --- | --- | --- | --- |
| Winner log loss | 0.658 | 0.689 | 0.693 |
| Winner Brier | 0.233 | 0.248 | 0.250 |
| Who wins × how, log loss | 1.641 | | 1.746 |
| Goes the distance, Brier | 0.220 | | 0.229 |

Favourites won 62.6%. The finish scales fit to cKO 2.3, cSUB 2.3, α 0.75, γ 0. The grid was
widened after real data pushed cKO to the old edge.

## Known limits

- ESPN's feeds are undocumented. Field names were checked against a live probe (`/api/health?probe=1`).
- The dataset updates weekly, so a card from the last few days may show ESPN's winner before the
  method, round and time arrive.
- Control time is now real in history; DFS control points in the simulation are still modelled
  from takedowns.
- Mid-card the odds stay at pre-fight values; live status is display only.
- DFS scoring follows the common Classic format; check it against your site.
