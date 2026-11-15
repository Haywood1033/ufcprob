// lib/simulator.js — Monte Carlo fight simulation, every bout on a card in one pass. Each run:
//   1. the winner is drawn from the fitted win probability;
//   2. round by round, the fight ends by knockout or submission at the fitted per-minute hazards
//      (the winner's power against the loser's vulnerability, larger for bigger favorites);
//      if nobody finishes, it goes to the judges;
//   3. fantasy stats are drawn for the time actually fought: significant strikes from each side's
//      landing rate against the other's absorption rate (winners land a bit more), takedowns and
//      knockdowns the same way, control time from takedowns.
// Bouts are independent of each other; within a bout every market (moneyline, method, round,
// distance, DFS points) is counted from the same runs, so correlations come for free.

const { makeRng } = require('./rng');
const { methodRoundProbs } = require('./ratings');

const METHODS = ['KO', 'SUB', 'DEC'];
// DraftKings Classic fantasy scoring: every strike landed 0.2, a significant strike another 0.2
// (0.4 in all), takedown 5, reversal 5, knockdown 10, control time 0.03 a second; win bonus 90 / 70 /
// 45 / 40 / 40 by round, 30 by decision, +25 for a win inside the first minute.
const SCORING = { strike: 0.2, sig: 0.2, td: 5, rev: 5, kd: 10, ctrlSec: 0.03, win: [90, 70, 45, 40, 40], decision: 30, quick: 25 };
// How much more (winner) or less (loser) of each stat a fighter gets than their matchup rate, and
// how much each varies fight to fight. Fitted so simulated winners and losers match real ones
// (docs/BUILD-READOUT.md, "Fantasy points").
// Each stat: [multiplier when the fighter wins, when they lose].
const TUNE = { sig: [1.11, 0.79], oth: [1.25, 0.78], td: [1.31, 0.69], ctrl: [1.4, 0.675], kd: 0.7, sigSd: 0.35, othSd: 0.6, ctrlSd: 0.9 };

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
    const othA = new Uint16Array(S), othB = new Uint16Array(S), ctlA = new Float32Array(S), ctlB = new Float32Array(S), T = TUNE;
    const cls = bt.cls;
    const rSigA = matchRate(bt.A.style.sigF15, bt.B.style.sigA15, cls.sig15) / 15, rSigB = matchRate(bt.B.style.sigF15, bt.A.style.sigA15, cls.sig15) / 15;
    const rTdA = matchRate(bt.A.style.tdF15, bt.B.style.tdA15, cls.td15) / 15, rTdB = matchRate(bt.B.style.tdF15, bt.A.style.tdA15, cls.td15) / 15;
    const rKdA = matchRate(bt.A.style.kdF15, bt.B.style.kdA15, cls.kd15) / 15, rKdB = matchRate(bt.B.style.kdF15, bt.A.style.kdA15, cls.kd15) / 15;
    // Fantasy-only stats; a fighter or class without them (older callers) contributes none.
    const z = v => v || 0;
    const rOthA = z(matchRate(z(bt.A.style.othF15), z(bt.B.style.othA15), z(cls.oth15))) / 15, rOthB = z(matchRate(z(bt.B.style.othF15), z(bt.A.style.othA15), z(cls.oth15))) / 15;
    const rCtlA = z(matchRate(z(bt.A.style.ctrlF15), z(bt.B.style.ctrlA15), z(cls.ctrl15))) / 15, rCtlB = z(matchRate(z(bt.B.style.ctrlF15), z(bt.A.style.ctrlA15), z(cls.ctrl15))) / 15;
    const rRevA = z(bt.A.style.revF15) / 15, rRevB = z(bt.B.style.revF15) / 15;
    for (let k = 0; k < S; k++) {
      const aWins = rng.uniform() < bt.pA;
      const h = aWins ? bt.hazA : bt.hazB;
      let m = 2, r = bt.rounds, t = 300;
      for (let rd = 1; rd <= bt.rounds; rd++) {
        const tot = (h.ko + h.sub) * (rd === 1 ? 1 : h.later ?? 1);
        const fin = 1 - Math.exp(-5 * tot);
        if (rng.uniform() < fin) {
          m = rng.uniform() < h.ko / (h.ko + h.sub) ? 0 : 1; r = rd;
          // Time within the round from the truncated exponential.
          const u = rng.uniform();
          t = Math.max(5, Math.min(300, (-Math.log(1 - u * fin) / tot) * 60));
          break;
        }
      }
      const mins = (r - 1) * 5 + t / 60;
      winner[k] = aWins ? 0 : 1; method[k] = m; endRound[k] = r; elapsed[k] = mins * 60;
      // Stats for the time fought; the winner tends to have the better of the exchanges.
      const up = (w, x) => (aWins === x ? w[0] : w[1]), ln = sd => Math.exp(rng.normal() * sd - (sd * sd) / 2);
      const sa = poisson(rng, rSigA * mins * up(T.sig, true) * ln(T.sigSd)), sb = poisson(rng, rSigB * mins * up(T.sig, false) * ln(T.sigSd));
      const oa = poisson(rng, rOthA * mins * up(T.oth, true) * ln(T.othSd)), ob = poisson(rng, rOthB * mins * up(T.oth, false) * ln(T.othSd));
      const ta = poisson(rng, rTdA * mins * up(T.td, true)), tb = poisson(rng, rTdB * mins * up(T.td, false));
      const ra = poisson(rng, rRevA * mins), rb = poisson(rng, rRevB * mins);
      let ka = poisson(rng, rKdA * mins * T.kd), kb = poisson(rng, rKdB * mins * T.kd);
      if (m === 0) { if (aWins) ka = Math.max(ka, rng.uniform() < 0.55 ? 1 : 0); else kb = Math.max(kb, rng.uniform() < 0.55 ? 1 : 0); }
      // Control time in seconds; the two fighters can't control for longer than the fight lasted.
      let ca = rCtlA * mins * up(T.ctrl, true) * ln(T.ctrlSd), cb = rCtlB * mins * up(T.ctrl, false) * ln(T.ctrlSd);
      const room = mins * 60 * 0.95; if (ca + cb > room) { const f = room / (ca + cb); ca *= f; cb *= f; }
      sigA[k] = sa; sigB[k] = sb; tdA[k] = ta; tdB[k] = tb; othA[k] = oa; othB[k] = ob; ctlA[k] = ca; ctlB[k] = cb;
      const bonus = m === 2 ? SCORING.decision : SCORING.win[r - 1] + (r === 1 && t <= 60 ? SCORING.quick : 0);
      const pts = (sg, ot, td, rv, kd, ct) => SCORING.strike * (sg + ot) + SCORING.sig * sg + SCORING.td * td + SCORING.rev * rv + SCORING.kd * kd + SCORING.ctrlSec * ct;
      ptsA[k] = pts(sa, oa, ta, ra, ka, ca) + (aWins ? bonus : 0);
      ptsB[k] = pts(sb, ob, tb, rb, kb, cb) + (aWins ? 0 : bonus);
    }
    return { id: bt.id, rounds: bt.rounds, sims: S, winner, method, endRound, elapsed, ptsA, ptsB, sigA, sigB, tdA, tdB, othA, othB, ctlA, ctlB };
  });
}

// Distribution of one fighter's count (strikes or takedowns) across the runs: mean, median, the
// 10th–90th percentile range, the mean when it goes the distance, and P(over) for prop lines.
function countDist(arr, method, lines) {
  const S = arr.length, sorted = Uint16Array.from(arr).sort();
  let sum = 0, dSum = 0, dN = 0;
  for (let k = 0; k < S; k++) { sum += arr[k]; if (method[k] === 2) { dSum += arr[k]; dN++; } }
  const at = p => sorted[Math.min(S - 1, Math.floor(p * S))];
  const over = line => { let lo = 0, hi = S; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] > line) hi = mid; else lo = mid + 1; } return (S - lo) / S; };
  return { mean: +(sum / S).toFixed(1), p10: at(0.1), p50: at(0.5), p90: at(0.9), ifDistance: dN ? +(dSum / dN).toFixed(1) : null, lines: lines(at(0.5)).map(line => ({ line, over: +over(line).toFixed(4) })) };
}
const SIG_LINES = med => { const c = Math.max(4.5, Math.round(med / 5) * 5 - 0.5); return [c - 15, c - 5, c + 5, c + 15].map(x => +x.toFixed(1)).filter(x => x > 0); };
const TD_LINES = () => [0.5, 1.5, 2.5, 3.5];

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
    stats: {
      sig: { A: countDist(sim.sigA, sim.method, SIG_LINES), B: countDist(sim.sigB, sim.method, SIG_LINES) },
      td: { A: countDist(sim.tdA, sim.method, TD_LINES), B: countDist(sim.tdB, sim.method, TD_LINES) },
    },
  };
}

module.exports = { TUNE, simulateCard, summarizeBout, SCORING, METHODS, poisson, matchRate, methodRoundProbs };
