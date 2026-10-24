// lib/backtest.js — leak-free backtest over recent completed events. Each event's bouts are
// predicted from fighter state built only on earlier bouts (fighterAt's date filter), with the
// win and finish models refit only on earlier bouts every REFIT events, then graded.
//
// Scores: winner log loss and Brier against a coin flip and against Elo alone (the same logistic
// with only the Elo gap), the six-way outcome (who wins × how) against base rates, goes-the-
// distance Brier, and calibration of the favourite's probability.

const { loadHistory } = require('./store');
const { prepare, fighterAt, features, calibrate, winProb, hazards, scaledHazards, methodRoundProbs, fitLogistic, sigmoid } = require('./ratings');

const REFIT = 8;
const BINS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9, 1.0001];
const clip = p => Math.min(1 - 1e-4, Math.max(1e-4, p));

async function runBacktest({ events = 25, warmupBouts = 400, history = null } = {}) {
  const hist = history || await loadHistory();
  const bouts = hist.bouts;
  const prep = prepare(bouts);
  const eventIds = [...new Set(bouts.map(b => b.eventId))];
  const firstEligible = bouts.findIndex((_, i) => i >= warmupBouts);
  const eligible = eventIds.filter(id => bouts.findIndex(b => b.eventId === id) >= firstEligible);
  const targets = eligible.slice(-events);
  let params = null, eloW = null, fitted = -Infinity;
  const rows = [], perEvent = [];
  targets.forEach((eid, n) => {
    const evBouts = bouts.filter(b => b.eventId === eid && b.result === 'a');
    if (!evBouts.length) return;
    const date = evBouts[0].date;
    const firstIdx = bouts.findIndex(b => b.eventId === eid);
    if (!params || n - fitted >= REFIT) {
      const earlier = bouts.slice(0, firstIdx);
      params = calibrate(prep, earlier, hist.fighters, { warmup: Math.min(300, Math.floor(earlier.length / 3)) });
      // Elo-only baseline fit on the same earlier bouts.
      const X = [], Y = [];
      earlier.forEach((b, i) => { if (i < 300 || b.result !== 'a') return; const A = fighterAt(prep, b.a.id, b.date, b.weightClass), B = fighterAt(prep, b.b.id, b.date, b.weightClass); const x = [(A.elo - B.elo) / 100]; X.push(x, [-x[0]]); Y.push(1, 0); });
      eloW = X.length >= 200 ? fitLogistic(X, Y)[0] : 0.4;
      fitted = n;
    }
    let correct = 0;
    for (const b of evBouts) {
      const A = fighterAt(prep, b.a.id, date, b.weightClass), B = fighterAt(prep, b.b.id, date, b.weightClass);
      const pA = winProb(params, features(A, B, hist.fighters.get(b.a.id), hist.fighters.get(b.b.id), date)); // a = actual winner
      const pElo = sigmoid(eloW * (A.elo - B.elo) / 100);
      const hA = scaledHazards(hazards(A, B, A.class, pA), params.finish), hB = scaledHazards(hazards(B, A, B.class, 1 - pA), params.finish);
      const prA = methodRoundProbs(hA, b.rounds), prB = methodRoundProbs(hB, b.rounds);
      const sum = a => a.reduce((x, y) => x + y, 0);
      const out = { KO: pA * sum(prA.KO), SUB: pA * sum(prA.SUB), DEC: pA * prA.DEC };
      const distModel = pA * prA.DEC + (1 - pA) * prB.DEC;
      const went = b.bucket === 'DEC' ? 1 : 0;
      const fav = Math.max(pA, 1 - pA);
      rows.push({ pWin: pA, pElo, fav, favWon: pA >= 0.5 ? 1 : 0, outcome: b.bucket in out ? out[b.bucket] : null, bucket: b.bucket, distModel, went });
      if (pA >= 0.5) correct++;
    }
    perEvent.push({ eventId: eid, date, bouts: evBouts.length, picksRight: correct, name: null });
  });
  const mean = f => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  const base = { KO: 0, SUB: 0, DEC: 0 };
  for (const r of rows) if (r.bucket in base) base[r.bucket]++;
  const nOut = base.KO + base.SUB + base.DEC;
  const scored = rows.filter(r => r.outcome !== null);
  const distRate = mean(r => r.went);
  return {
    generatedAt: new Date().toISOString(), source: hist.source, events: perEvent.length, bouts: rows.length,
    winner: {
      accuracy: mean(r => r.favWon),
      logLoss: { model: -mean(r => Math.log(clip(r.pWin))), elo: -mean(r => Math.log(clip(r.pElo))), coin: Math.log(2) },
      brier: { model: mean(r => (1 - r.pWin) ** 2), elo: mean(r => (1 - r.pElo) ** 2), coin: 0.25 },
    },
    outcome: { logLoss: { model: -scored.reduce((s, r) => s + Math.log(clip(r.outcome)), 0) / scored.length, base: -scored.reduce((s, r) => s + Math.log(clip(0.5 * base[r.bucket] / nOut)), 0) / scored.length } },
    distance: { brier: { model: mean(r => (r.distModel - r.went) ** 2), base: mean(r => (distRate - r.went) ** 2) }, rate: distRate },
    calibration: BINS.slice(0, -1).map((lo, i) => { const inBin = rows.filter(r => r.fav >= lo && r.fav < BINS[i + 1]); return { lo, hi: Math.min(1, BINS[i + 1]), n: inBin.length, predicted: inBin.length ? inBin.reduce((s, r) => s + r.fav, 0) / inBin.length : null, actual: inBin.length ? inBin.reduce((s, r) => s + r.favWon, 0) / inBin.length : null }; }),
    perEvent: perEvent.reverse(),
  };
}

module.exports = { runBacktest };
