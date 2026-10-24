// lib/ratings.js — fighter strength, style and the fitted fight model.
//
// 1. Elo, replayed through every bout in date order. K grows with how decisive the result was
//    (early finish > late finish > unanimous > split decision), is larger for fighters with few
//    UFC bouts, and a long layoff pulls a rating part of the way back to average. Debutants start
//    below average (DEBUT_ELO): UFC debutants win less than half their fights.
// 2. Style, as of any date: per-15-minute rates (significant strikes landed and absorbed,
//    takedowns for and against, knockdowns, submission attempts) and finish tendencies (how a
//    fighter wins and how they lose), recency-weighted (half-life HALF_LIFE_YEARS) and regressed
//    toward the weight class average.
// 3. calibrate() replays history using only earlier bouts and fits, by maximum likelihood:
//    - the win model: a logistic on the Elo gap, striking and grappling edges, age, reach,
//      experience and layoff;
//    - the finish model: knockout and submission hazards built log5-style from the winner's
//      power against the loser's vulnerability, scaled by how big a favourite the winner was,
//      fitted to the method and round every past bout ended in.

const DEBUT_ELO = 1470, BASE_ELO = 1500, K = 36;
const HALF_LIFE_YEARS = 2.5;
const PRIOR_MINUTES = 30;          // style rates carry two fights' worth of class-average prior
const PRIOR_RESULTS = 3;           // finish tendencies carry three results of prior
const PRIOR_FINISH_MIN = 75;       // finish power/vulnerability carry five fights' worth of prior
const YEAR = 365.25 * 864e5;

const minutesOf = b => (b.endRound ? (b.endRound - 1) * 5 + (b.endTime || 300) / 60 : b.rounds * 5);
const yearsBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / YEAR;

function kMultiplier(b) {
  const m = String(b.method || '').toUpperCase();
  if (b.bucket === 'KO' || b.bucket === 'SUB') return b.endRound === 1 ? 1.35 : b.endRound === 2 ? 1.2 : 1.1;
  if (/S-DEC/.test(m)) return 0.6;
  if (/M-DEC/.test(m)) return 0.8;
  return 1;
}

// Replay every bout. Returns per-fighter records (each carrying the Elo before and after) and
// per-class averages for the style priors.
function prepare(bouts) {
  const elo = new Map(), n = new Map(), last = new Map(), byFighter = new Map();
  const classSum = new Map();
  const getElo = (id, date) => {
    let e = elo.has(id) ? elo.get(id) : DEBUT_ELO;
    const l = last.get(id);
    if (l) { const idle = yearsBetween(l, date); if (idle > 1) e = BASE_ELO + (e - BASE_ELO) * Math.pow(0.9, idle - 1); }
    return e;
  };
  for (const b of bouts) {
    if (!b.a?.id || !b.b?.id) continue;
    const mins = minutesOf(b);
    const counted = b.result === 'a' || b.result === 'draw';
    const ea = getElo(b.a.id, b.date), eb = getElo(b.b.id, b.date);
    let na = ea, nb = eb;
    if (counted) {
      const exp = 1 / (1 + Math.pow(10, (eb - ea) / 400));
      const s = b.result === 'a' ? 1 : 0.5;
      const k = K * kMultiplier(b);
      const ka = k * ((n.get(b.a.id) || 0) < 3 ? 1.3 : 1), kb = k * ((n.get(b.b.id) || 0) < 3 ? 1.3 : 1);
      na = ea + ka * (s - exp); nb = eb - kb * (s - exp);
    }
    const st = b.stats;
    for (const [me, op, eBefore, eAfter, oppElo, side] of [[b.a, b.b, ea, na, eb, 'a'], [b.b, b.a, eb, nb, ea, 'b']]) {
      const won = b.result === 'a' ? (side === 'a' ? 1 : 0) : b.result === 'draw' ? 0.5 : null;
      const mine = st?.[side] || {}, theirs = st?.[side === 'a' ? 'b' : 'a'] || {};
      const rec = {
        date: b.date, fightId: b.fightId, opp: op.id, oppName: op.name, won, bucket: b.bucket, method: b.method, endRound: b.endRound, endTime: b.endTime,
        rounds: b.rounds, minutes: mins, weightClass: b.weightClass, women: b.women, title: b.title,
        eloBefore: eBefore, eloAfter: eAfter, oppElo,
        sigF: mine.sig ?? null, sigA: theirs.sig ?? null, kdF: mine.kd ?? null, kdA: theirs.kd ?? null, tdF: mine.td ?? null, tdA: theirs.td ?? null, subF: mine.sub ?? null, subA: theirs.sub ?? null,
      };
      if (!byFighter.has(me.id)) byFighter.set(me.id, { id: me.id, name: me.name, recs: [] });
      byFighter.get(me.id).recs.push(rec);
      // class averages (per fighter-minute) for priors
      if (st) {
        const key = b.weightClass || 'all';
        const c = classSum.get(key) || { min: 0, sig: 0, kd: 0, td: 0, sub: 0, ko: 0, subW: 0, fights: 0, wins: 0, winKO: 0, winSUB: 0 };
        c.min += mins; c.sig += mine.sig || 0; c.kd += mine.kd || 0; c.td += mine.td || 0; c.sub += mine.sub || 0;
        if (won === 1) { c.wins++; if (b.bucket === 'KO') { c.ko++; c.winKO++; } if (b.bucket === 'SUB') { c.subW++; c.winSUB++; } }
        c.fights++;
        classSum.set(key, c);
      }
    }
    elo.set(b.a.id, na); elo.set(b.b.id, nb);
    n.set(b.a.id, (n.get(b.a.id) || 0) + 1); n.set(b.b.id, (n.get(b.b.id) || 0) + 1);
    last.set(b.a.id, b.date); last.set(b.b.id, b.date);
  }
  const all = [...classSum.values()].reduce((t, c) => { for (const k of Object.keys(c)) t[k] = (t[k] || 0) + c[k]; return t; }, {});
  const classes = new Map([...classSum.entries()].map(([k, c]) => [k, classRates(c.fights >= 60 ? c : all)]));
  classes.set('all', classRates(all));
  return { byFighter, classes };
}

function classRates(c) {
  const per15 = v => (c.min ? (15 * v) / c.min : 0);
  return { sig15: per15(c.sig), kd15: per15(c.kd), td15: per15(c.td), sub15: per15(c.sub), ko15: per15(c.ko), subw15: per15(c.subW), koShare: c.wins ? c.winKO / c.wins : 0.32, subShare: c.wins ? c.winSUB / c.wins : 0.18 };
}

// A fighter as of `date` (only bouts strictly before it): Elo, record, style, finish profile.
function fighterAt(prep, id, date, weightClass) {
  const f = prep.byFighter.get(id);
  const cls = prep.classes.get(weightClass) || prep.classes.get('all');
  const recs = f ? f.recs.filter(r => r.date < date) : [];
  const lastRec = recs.at(-1);
  let elo = lastRec ? lastRec.eloAfter : DEBUT_ELO;
  if (lastRec) { const idle = yearsBetween(lastRec.date, date); if (idle > 1) elo = BASE_ELO + (elo - BASE_ELO) * Math.pow(0.9, idle - 1); }
  let wMin = 0; const s = { sigF: 0, sigA: 0, kdF: 0, kdA: 0, tdF: 0, tdA: 0, subF: 0, subA: 0 };
  let wins = 0, losses = 0, draws = 0, wW = 0, wL = 0, winKO = 0, winSUB = 0, winDEC = 0, lossKO = 0, lossSUB = 0, lossDEC = 0, koW15 = 0, koL15 = 0, subW15 = 0, subL15 = 0;
  for (const r of recs) {
    const w = Math.pow(0.5, yearsBetween(r.date, date) / HALF_LIFE_YEARS);
    if (r.won === 1) wins++; else if (r.won === 0) losses++; else if (r.won === 0.5) draws++;
    if (r.sigF !== null) { wMin += w * r.minutes; for (const k of Object.keys(s)) s[k] += w * (r[k] || 0); }
    if (r.won === 1) { wW += w; if (r.bucket === 'KO') { winKO += w; koW15 += w; } else if (r.bucket === 'SUB') { winSUB += w; subW15 += w; } else winDEC += w; }
    if (r.won === 0) { wL += w; if (r.bucket === 'KO') { lossKO += w; koL15 += w; } else if (r.bucket === 'SUB') { lossSUB += w; subL15 += w; } else lossDEC += w; }
  }
  const rate = (x, prior) => (15 * (x + (PRIOR_MINUTES * prior) / 15)) / (wMin + PRIOR_MINUTES);
  const finRate = (x, prior) => (15 * (x + (PRIOR_FINISH_MIN * prior) / 15)) / (wMin + PRIOR_FINISH_MIN);
  return {
    id, name: f?.name || null, elo, ufcFights: recs.filter(r => r.won !== null).length, record: { w: wins, l: losses, d: draws },
    lastDate: lastRec?.date || null, layoffDays: lastRec ? Math.round((Date.parse(date) - Date.parse(lastRec.date)) / 864e5) : null,
    style: {
      sigF15: rate(s.sigF, cls.sig15), sigA15: rate(s.sigA, cls.sig15), kdF15: rate(s.kdF, cls.kd15), kdA15: rate(s.kdA, cls.kd15),
      tdF15: rate(s.tdF, cls.td15), tdA15: rate(s.tdA, cls.td15), subF15: rate(s.subF, cls.sub15), subA15: rate(s.subA, cls.sub15),
    },
    // Finish power and vulnerability per 15 minutes fought, regressed to the class rate.
    power: { ko15: finRate(koW15, cls.ko15), sub15: finRate(subW15, cls.subw15) },
    vuln: { ko15: finRate(koL15, cls.ko15), sub15: finRate(subL15, cls.subw15) },
    finishProfile: {
      winKO: (winKO + PRIOR_RESULTS * cls.koShare) / (wW + PRIOR_RESULTS), winSUB: (winSUB + PRIOR_RESULTS * cls.subShare) / (wW + PRIOR_RESULTS),
      lossKO: (lossKO + PRIOR_RESULTS * cls.koShare) / (wL + PRIOR_RESULTS), lossSUB: (lossSUB + PRIOR_RESULTS * cls.subShare) / (wL + PRIOR_RESULTS),
      rawWins: { KO: wins ? recs.filter(r => r.won === 1 && r.bucket === 'KO').length : 0, SUB: recs.filter(r => r.won === 1 && r.bucket === 'SUB').length, DEC: recs.filter(r => r.won === 1 && r.bucket === 'DEC').length },
      rawLosses: { KO: recs.filter(r => r.won === 0 && r.bucket === 'KO').length, SUB: recs.filter(r => r.won === 0 && r.bucket === 'SUB').length, DEC: recs.filter(r => r.won === 0 && r.bucket === 'DEC').length },
    },
    minutes: +wMin.toFixed(1),
    recent: [...recs].reverse().slice(0, 8).map(r => ({ date: r.date, opp: r.oppName, won: r.won, method: r.method, bucket: r.bucket, round: r.endRound, time: r.endTime, title: r.title })),
    class: cls,
  };
}

const ageAt = (dob, date) => (dob ? yearsBetween(dob, date) : null);

// Win-model features for A vs B, antisymmetric (swap = negate), so orientation never matters.
function features(A, B, physA = {}, physB = {}, date) {
  const ageA = ageAt(physA.dob, date), ageB = ageAt(physB.dob, date);
  const age = ageA !== null && ageB !== null ? Math.max(-12, Math.min(12, ageA - ageB)) / 5 : 0;
  // Age matters more past the mid-30s: an older-than-34 term on top of the plain gap.
  const old = ageA !== null && ageB !== null ? (Math.max(0, ageA - 34) - Math.max(0, ageB - 34)) / 3 : 0;
  const reach = physA.reachIn && physB.reachIn ? Math.max(-10, Math.min(10, physA.reachIn - physB.reachIn)) / 5 : 0;
  const lay = d => (d === null ? 0 : Math.max(0, Math.log((d + 30) / 210)));
  return [
    (A.elo - B.elo) / 100,
    ((A.style.sigF15 - A.style.sigA15) - (B.style.sigF15 - B.style.sigA15)) / 20,
    ((A.style.tdF15 - A.style.tdA15) - (B.style.tdF15 - B.style.tdA15)) / 2,
    age, old, reach,
    Math.log1p(A.ufcFights) - Math.log1p(B.ufcFights),
    lay(A.layoffDays) - lay(B.layoffDays),
  ];
}
const FEATURE_NAMES = ['Elo gap', 'Striking edge', 'Grappling edge', 'Age gap', 'Age past 34', 'Reach', 'UFC experience', 'Layoff'];

const sigmoid = z => 1 / (1 + Math.exp(-z));
function fitLogistic(X, y, { ridge = 4, iters = 60 } = {}) {
  const k = X[0].length; let w = new Array(k).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(k).fill(0), H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < X.length; i++) {
      const p = sigmoid(X[i].reduce((s, x, j) => s + x * w[j], 0)), r = p * (1 - p);
      for (let a = 0; a < k; a++) { g[a] += (y[i] - p) * X[i][a]; for (let c = 0; c < k; c++) H[a][c] += r * X[i][a] * X[i][c]; }
    }
    for (let a = 0; a < k; a++) { g[a] -= ridge * w[a]; H[a][a] += ridge; }
    // Newton step: solve H d = g
    const A = H.map((row, i) => [...row, g[i]]);
    for (let i = 0; i < k; i++) { let p = i; for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r; [A[i], A[p]] = [A[p], A[i]]; for (let r = i + 1; r < k; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c <= k; c++) A[r][c] -= f * A[i][c]; } }
    const d = new Array(k).fill(0);
    for (let i = k - 1; i >= 0; i--) { let s = A[i][k]; for (let c = i + 1; c < k; c++) s -= A[i][c] * d[c]; d[i] = s / A[i][i]; }
    w = w.map((v, i) => v + d[i]);
    if (Math.max(...d.map(Math.abs)) < 1e-6) break;
  }
  return w;
}

// Finish hazards (per minute) when `W` beats `L`, before the fitted scale factors.
// Each side's factor enters as a ratio to the class rate; the fitted exponent `alpha` decides how
// far individual history moves the hazard from the class rate (0 = class rate for everyone).
function hazards(W, L, cls, pW) {
  const r = (v, c) => Math.max(0.05, v / Math.max(1e-4, c));
  return { koBase: cls.ko15 / 15, subBase: cls.subw15 / 15, koRatio: r(W.power.ko15, cls.ko15) * r(L.vuln.ko15, cls.ko15), subRatio: r(W.power.sub15, cls.subw15) * r(L.vuln.sub15, cls.subw15), dom: Math.max(0.2, pW / 0.5) };
}

// Probability of each (method, round) given the winner, from per-minute hazards over 5-minute
// rounds: constant within a round, scaled by `h.later` from round 2 on (finishes cluster early).
// Returns { KO:[r1..rR], SUB:[...], DEC }.
const roundMult = (h, r) => (r === 0 ? 1 : h.later ?? 1);
function methodRoundProbs(h, rounds) {
  const out = { KO: [], SUB: [], DEC: 0 };
  let surv = 1;
  for (let r = 0; r < rounds; r++) {
    const tot = (h.ko + h.sub) * roundMult(h, r);
    const fin = 1 - Math.exp(-5 * tot);
    const share = h.ko + h.sub ? h.ko / (h.ko + h.sub) : 0;
    out.KO.push(surv * fin * share); out.SUB.push(surv * fin * (1 - share));
    surv *= 1 - fin;
  }
  out.DEC = surv;
  return out;
}
function scaledHazards(raw, fin) { const m = Math.pow(raw.dom, fin.gamma), a = fin.alpha ?? 0.5; return { ko: raw.koBase * Math.pow(raw.koRatio, a) * fin.cKO * m, sub: raw.subBase * Math.pow(raw.subRatio, a) * fin.cSUB * m, later: fin.later ?? 1 }; }

const DEFAULTS = { win: [0.55, 0.15, 0.1, -0.05, -0.12, 0.06, 0.05, -0.05], finish: { cKO: 1, cSUB: 1, gamma: 0.6, alpha: 0.5, later: 1 } };

// Leak-free replay → fitted win and finish models. `fromIdx` bouts of warm-up are skipped.
function calibrate(prep, bouts, physicals = new Map(), { warmup = 300, finishHalfLife = Number(process.env.UFC_FINISH_HL || 2) } = {}) {
  const X = [], Y = [], fin = [];
  bouts.forEach((b, i) => {
    if (i < warmup || b.result !== 'a' || !b.a?.id || !b.b?.id) return;
    const A = fighterAt(prep, b.a.id, b.date, b.weightClass), B = fighterAt(prep, b.b.id, b.date, b.weightClass);
    const x = features(A, B, physicals.get(b.a.id), physicals.get(b.b.id), b.date);
    X.push(x); Y.push(1); X.push(x.map(v => -v)); Y.push(0);
    if (b.bucket === 'KO' || b.bucket === 'SUB' || b.bucket === 'DEC') fin.push({ A, B, b, x });
  });
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  out.samples = X.length / 2;
  if (X.length >= 600) out.win = fitLogistic(X, Y);
  if (fin.length >= 300) {
    // Grid search for the finish scales on the likelihood of how and when each bout ended.
    let best = { ll: -Infinity };
    // Recent bouts count more: finish rates drift (recent cards finish more than 2010s ones did).
    const lastDate = fin.at(-1).b.date;
    const rows = fin.map(({ A, B, b, x }) => { const pW = sigmoid(x.reduce((s, v, j) => s + v * out.win[j], 0)); return { raw: hazards(A, B, A.class, pW), b, w: finishHalfLife > 0 ? Math.pow(0.5, yearsBetween(b.date, lastDate) / finishHalfLife) : 1 }; });
    const score = f => {
      let ll = 0;
      for (const { raw, b, w } of rows) {
        const pr = methodRoundProbs(scaledHazards(raw, f), b.rounds);
        const p = b.bucket === 'DEC' ? pr.DEC : (pr[b.bucket][(b.endRound || 1) - 1] || 1e-6);
        ll += w * Math.log(Math.max(1e-6, p));
      }
      return ll;
    };
    for (const later of [0.45, 0.6, 0.75, 1]) for (const cKO of [1, 1.5, 2.2, 3.2, 4.6]) for (const cSUB of [1, 1.5, 2.2, 3.2]) for (const gamma of [0, 0.4, 0.8]) for (const alpha of [0.25, 0.5, 0.75, 1]) {
      const f = { cKO, cSUB, gamma, alpha, later }, ll = score(f);
      if (ll > best.ll) best = { ll, ...f };
    }
    // Refine the scales and the later-round factor around the best point.
    for (let pass = 0; pass < 2; pass++) for (const key of ['cKO', 'cSUB', 'later']) for (const m of [0.8, 0.9, 1.1, 1.25]) {
      const f = { ...best, [key]: +(best[key] * m).toFixed(3) };
      if (key === 'later' && f.later > 1.2) continue;
      const ll = score(f);
      if (ll > best.ll) best = { ...f, ll };
    }
    out.finish = { cKO: best.cKO, cSUB: best.cSUB, gamma: best.gamma, alpha: best.alpha, later: best.later };
    out.finishSamples = rows.length;
  }
  return out;
}

function winProb(params, x) { return sigmoid(x.reduce((s, v, j) => s + v * params.win[j], 0)); }

module.exports = { DEBUT_ELO, prepare, fighterAt, features, FEATURE_NAMES, fitLogistic, hazards, methodRoundProbs, scaledHazards, calibrate, winProb, minutesOf, ageAt, sigmoid, DEFAULTS };
