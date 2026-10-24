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

UFCStats.com (event pages carry every bout's result and per-fighter totals; fighter pages add
reach, height, stance, date of birth) and ESPN's MMA scoreboard (card segments, scheduled
rounds, live status). Events since 2014.

## Known limits

- Page templates and feed shapes are unverified until `/api/health` runs against the real sites.
- Control time isn't on UFCStats event pages; DFS control points are estimated from takedowns.
- Mid-card the odds stay at pre-fight values; live status is display only.
- DFS scoring follows the common Classic format; check it against your site.
