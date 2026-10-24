// lib/simulator.js — Monte Carlo fight simulation, every bout on a card in one pass. Each run:
//   1. the winner is drawn from the fitted win probability;
//   2. round by round, the fight ends by knockout or submission at the fitted per-minute hazards
//      (the winner's power against the loser's vulnerability, larger for bigger favourites);
//      if nobody finishes, it goes to the judges;
//   3. fantasy stats are drawn for the time actually fought: significant strikes from each side's
//      landing rate against the other's absorption rate (winners land a bit more), takedowns and
//      knockdowns the same way, control time from takedowns.
// Bouts are independent of each other; within a bout every market (moneyline, method, round,
// distance, DFS points) is counted from the same runs, so correlations come for free.

const { makeRng } = require('./rng');
const { methodRoundProbs } = require('./ratings');

const METHODS = ['KO', 'SUB', 'DEC'];
// Classic-format fantasy scoring (verify against your site's rules page).
const SCORING = { sig: 0.2, td: 5, kd: 10, ctrlSec: 0.03, win: [90, 70, 45, 40, 40], decision: 30, quick: 25 };

function poisson(rng, mean) {
  if (mean <= 0) return 0;
  if (mean > 30) return Math.max(0, Math.round(mean + rng.normal() * Math.sqrt(mean)));
  let L = Math.exp(-mean), k = 0, p = 1;
  do { k++; p *= rng.uniform(); } while (p > L);
  return k - 1;
}

// log5-style matchup rate: what A lands per 15 against what B usually absorbs, vs the class rate.
const matchRate = (forA, againstB, cls) => (cls > 0 ? (forA * againstB) / cls : (forA + againstB) / 2);

// bouts: [{ id, rounds, pA, hazA: {ko,sub}, hazB: {ko,sub}, A, B (fighter objects with style), cls }]
function simulateCard(bouts, { sims = 15000, seed = 1 } = {}) {
  const rng = makeRng(seed);
  const S = sims;
  return bouts.map(bt => {
    const winner = new Uint8Array(S), method = new Uint8Array(S), endRound = new Uint8Array(S);
    const elapsed = new Float32Array(S), ptsA = new Float32Array(S), ptsB = new Float32Array(S);
    const sigA = new Uint16Array(S), sigB = new Uint16Array(S), tdA = new Uint8Array(S), tdB = new Uint8Array(S);
    const cls = bt.cls;
    const rSigA = matchRate(bt.A.style.sigF15, bt.B.style.sigA15, cls.sig15) / 15, rSigB = matchRate(bt.B.style.sigF15, bt.A.style.sigA15, cls.sig15) / 15;
    const rTdA = matchRate(bt.A.style.tdF15, bt.B.style.tdA15, cls.td15) / 15, rTdB = matchRate(bt.B.style.tdF15, bt.A.style.tdA15, cls.td15) / 15;
    const rKdA = matchRate(bt.A.style.kdF15, bt.B.style.kdA15, cls.kd15) / 15, rKdB = matchRate(bt.B.style.kdF15, bt.A.style.kdA15, cls.kd15) / 15;
    for (let k = 0; k < S; k++) {
      const aWins = rng.uniform() < bt.pA;
      const h = aWins ? bt.hazA : bt.hazB, tot = h.ko + h.sub;
      let m = 2, r = bt.rounds, t = 300;
      for (let rd = 1; rd <= bt.rounds; rd++) {
        const fin = 1 - Math.exp(-5 * tot);
        if (rng.uniform() < fin) {
          m = rng.uniform() < h.ko / tot ? 0 : 1; r = rd;
          // Time within the round from the truncated exponential.
          const u = rng.uniform();
          t = Math.max(5, Math.min(300, (-Math.log(1 - u * fin) / tot) * 60));
          break;
        }
      }
      const mins = (r - 1) * 5 + t / 60;
      winner[k] = aWins ? 0 : 1; method[k] = m; endRound[k] = r; elapsed[k] = mins * 60;
      // Stats for the time fought; the winner tends to have the better of the exchanges.
      const wa = aWins ? 1.12 : 0.88, wb = aWins ? 0.88 : 1.12;
      const gA = Math.exp(rng.normal() * 0.35 - 0.06), gB = Math.exp(rng.normal() * 0.35 - 0.06);
      const sa = poisson(rng, rSigA * mins * wa * gA), sb = poisson(rng, rSigB * mins * wb * gB);
      const ta = poisson(rng, rTdA * mins * wa), tb = poisson(rng, rTdB * mins * wb);
      let ka = poisson(rng, rKdA * mins * 0.7), kb = poisson(rng, rKdB * mins * 0.7);
      if (m === 0) { if (aWins) ka = Math.max(ka, rng.uniform() < 0.55 ? 1 : 0); else kb = Math.max(kb, rng.uniform() < 0.55 ? 1 : 0); }
      const ca = Math.min(mins * 60, ta * 70 * (0.5 + rng.uniform())), cb = Math.min(mins * 60, tb * 70 * (0.5 + rng.uniform()));
      sigA[k] = sa; sigB[k] = sb; tdA[k] = ta; tdB[k] = tb;
      const bonus = m === 2 ? SCORING.decision : SCORING.win[r - 1] + (r === 1 && t <= 60 ? SCORING.quick : 0);
      ptsA[k] = SCORING.sig * sa + SCORING.td * ta + SCORING.kd * ka + SCORING.ctrlSec * ca + (aWins ? bonus : 0);
      ptsB[k] = SCORING.sig * sb + SCORING.td * tb + SCORING.kd * kb + SCORING.ctrlSec * cb + (aWins ? 0 : bonus);
    }
    return { id: bt.id, rounds: bt.rounds, sims: S, winner, method, endRound, elapsed, ptsA, ptsB, sigA, sigB, tdA, tdB };
  });
}

function q(arr, p) { const s = Float32Array.from(arr).sort(); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); }

// Market summary of one simulated bout.
function summarizeBout(sim) {
  const S = sim.sims, R = sim.rounds;
  const c = { A: { KO: 0, SUB: 0, DEC: 0 }, B: { KO: 0, SUB: 0, DEC: 0 } };
  const ends = new Array(R).fill(0); let dist = 0;
  const totals = { 0.5: 0, 1.5: 0, 2.5: 0, 3.5: 0, 4.5: 0 };
  const byRound = { A: new Array(R).fill(0), B: new Array(R).fill(0) };
  for (let k = 0; k < S; k++) {
    const side = sim.winner[k] ? 'B' : 'A', m = METHODS[sim.method[k]];
    c[side][m]++;
    if (m === 'DEC') dist++; else { ends[sim.endRound[k] - 1]++; byRound[side][sim.endRound[k] - 1]++; }
    for (const line of Object.keys(totals)) if (sim.elapsed[k] > Number(line) * 300) totals[line]++;
  }
  const f = v => v / S;
  const pA = f(c.A.KO + c.A.SUB + c.A.DEC);
  const mean = a => +(a.reduce((x, y) => x + y, 0) / S).toFixed(1);
  return {
    pA, pB: 1 - pA,
    methods: { A: { KO: f(c.A.KO), SUB: f(c.A.SUB), DEC: f(c.A.DEC) }, B: { KO: f(c.B.KO), SUB: f(c.B.SUB), DEC: f(c.B.DEC) } },
    distance: f(dist), insideDistance: 1 - f(dist),
    endsInRound: ends.map(f), winsInRound: { A: byRound.A.map(f), B: byRound.B.map(f) },
    over: Object.fromEntries(Object.entries(totals).filter(([l]) => Number(l) < R).map(([l, v]) => [l, f(v)])),
    dfs: { A: { mean: mean(sim.ptsA), p10: q(sim.ptsA, 0.1), p50: q(sim.ptsA, 0.5), p90: q(sim.ptsA, 0.9) }, B: { mean: mean(sim.ptsB), p10: q(sim.ptsB, 0.1), p50: q(sim.ptsB, 0.5), p90: q(sim.ptsB, 0.9) } },
    sig: { A: mean(sim.sigA), B: mean(sim.sigB) }, td: { A: mean(sim.tdA), B: mean(sim.tdB) },
  };
}

module.exports = { simulateCard, summarizeBout, SCORING, METHODS, poisson, matchRate, methodRoundProbs };
