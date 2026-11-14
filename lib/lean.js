// lib/lean.js — the lean indicators on each bout: how firmly the model sides with the favorite,
// and whether it expects a finish or a decision. Same win thresholds as nflprob's moneyline lean.
// Both come straight from the stored win and distance chances, so the locked card, the backtest
// and the live record all sort bouts the same way. app.html mirrors these thresholds.
//
// Checked on the last 150 events (1,825 bouts, each predicted only from earlier bouts, Nov 2026):
//   Strong lean 468 bouts, favorite won 74.8% · Lean 615, 65.9% · Toss-up 742, 54.4%
//   Finish likely 426 bouts, 70.0% finished · Decision likely 376, 66.2% went the distance

const WIN = [['strong', 'Strong lean (65%+)'], ['lean', 'Lean (57–65%)'], ['tossup', 'Toss-up (under 57%)']];
const PACE = [['finish', 'Finish likely (60%+)'], ['decision', 'Decision likely (60%+)'], ['open', 'Could go either way']];

// p: either fighter's win chance (0–1).
function winLean(p) {
  const fav = Math.max(p, 1 - p);
  return fav >= 0.65 ? 'strong' : fav >= 0.57 ? 'lean' : 'tossup';
}
// distance: the chance the bout goes to the judges (0–1).
function paceLean(distance) {
  return 1 - distance >= 0.6 ? 'finish' : distance >= 0.6 ? 'decision' : 'open';
}

// rows: [{ fav, favWon, dist, went }] → how each tier did.
function summarize(rows) {
  const tier = (list, label, pred, hit) => ({ label, n: list.length, predicted: list.length ? list.reduce((s, r) => s + pred(r), 0) / list.length : null, hit: list.filter(hit).length });
  return {
    win: WIN.map(([k, label]) => ({ tier: k, ...tier(rows.filter(r => winLean(r.fav) === k), label, r => r.fav, r => r.favWon) })),
    pace: PACE.map(([k, label]) => ({ tier: k, ...tier(rows.filter(r => paceLean(r.dist) === k), label, r => (k === 'decision' ? r.dist : 1 - r.dist), r => (k === 'decision' ? r.went : !r.went)) })),
  };
}

module.exports = { winLean, paceLean, summarize, WIN, PACE };
