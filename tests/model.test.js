// Parsers, model, simulator, pricing and DFS tests over the synthetic world (tests/fixtures.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { installMockFetch } = require('./fixtures');
const ufc = require('../lib/ufcstats');
const { boutRows } = require('../lib/store');
const { prepare, fighterAt, features, calibrate, winProb, hazards, scaledHazards, methodRoundProbs, DEFAULTS } = require('../lib/ratings');
const { simulateCard, summarizeBout, SCORING } = require('../lib/simulator');
const { makeCard, priceParlay, autoParlays } = require('../lib/parlay');
const { parseBook } = require('../lib/book');
const { parseSalaries, projections, simSample, cardFighters } = require('../lib/dfs');
const Opt = require('../lib/dfs-optimizer');
const { text, rows, cells } = require('../lib/html');

const NOW = '2026-10-24T15:00:00Z';
const realNow = Date.now;
test.before(() => { const off = Date.parse(NOW) - realNow(); Date.now = () => realNow() + off; });
test.after(() => { Date.now = realNow; });

async function history() {
  const evs = await ufc.fetchEvents('completed');
  const all = [];
  for (const e of evs.slice(0, 120)) all.push(...boutRows(await ufc.fetchEvent(e.id)));
  return all.sort((a, b) => a.date.localeCompare(b.date) || b.order - a.order);
}

test('html helpers decode entities and read tables', () => {
  assert.equal(text('<p> Jos&eacute; &amp; <b>Aldo</b>&#39;s </p>'), 'José & Aldo\'s');
  const r = rows('<table><tr class="x"><td>1</td><td><p>a</p><p>b</p></td></tr><tr class="y"><td>2</td></tr></table>', /x/);
  assert.equal(r.length, 1);
  assert.equal(cells(r[0].html).length, 2);
});

test('UFCStats parsers: events, completed and upcoming bouts, fighter page', async () => {
  const w = installMockFetch({ now: NOW });
  try {
    const done = await ufc.fetchEvents('completed');
    assert.ok(done.length > 150);
    const ev = await ufc.fetchEvent(done[0].id);
    assert.equal(ev.bouts.length, 12);
    assert.equal(ev.bouts[0].order, 0);
    assert.equal(ev.bouts[0].rounds, 5);
    const b = ev.bouts.find(x => x.completed);
    assert.equal(b.result, 'a');
    assert.ok(['KO', 'SUB', 'DEC'].includes(b.bucket));
    assert.ok(b.stats.a.sig >= 0 && b.stats.b.sig >= 0);
    const up = await ufc.fetchEvent(w.upcoming.id);
    assert.ok(up.bouts.every(x => !x.completed && x.a.id && x.b.id));
    const f = await ufc.fetchFighter(b.a.id);
    assert.ok(f.reachIn > 60 && /^\d{4}-\d\d-\d\d$/.test(f.dob));
    assert.equal(ufc.methodBucket('KO/TKO'), 'KO');
    assert.equal(ufc.methodBucket('S-DEC'), 'DEC');
    assert.equal(ufc.methodBucket('DQ'), 'OTHER');
  } finally { w.restore(); }
});

test('Elo moves toward the winner; fighter state is leak-free', async () => {
  const w = installMockFetch({ now: NOW });
  try {
    const bouts = await history();
    const prep = prepare(bouts);
    const b = bouts.find(x => x.result === 'a');
    const ra = prep.byFighter.get(b.a.id).recs.find(r => r.fightId === b.fightId);
    assert.ok(ra.eloAfter > ra.eloBefore, 'winner gains');
    // State before the bout's date must not include the bout itself.
    const before = fighterAt(prep, b.a.id, b.date, b.weightClass);
    assert.ok(!before.recent.some(r => r.date >= b.date));
    const after = fighterAt(prep, b.a.id, '2099-01-01', b.weightClass);
    assert.ok(after.ufcFights >= before.ufcFights + 1);
    // Features are antisymmetric: swapping the fighters negates them.
    const A = fighterAt(prep, b.a.id, b.date), B = fighterAt(prep, b.b.id, b.date);
    const x = features(A, B, {}, {}, b.date), y = features(B, A, {}, {}, b.date);
    x.forEach((v, i) => assert.ok(Math.abs(v + y[i]) < 1e-9));
    const params = calibrate(prep, bouts);
    const p = winProb(params, x), q = winProb(params, y);
    assert.ok(Math.abs(p + q - 1) < 1e-9);
  } finally { w.restore(); }
});

test('method/round probabilities sum to 1 and respect the round count', () => {
  const pr = methodRoundProbs({ ko: 0.03, sub: 0.01 }, 3);
  const total = pr.KO.reduce((a, b) => a + b, 0) + pr.SUB.reduce((a, b) => a + b, 0) + pr.DEC;
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.equal(pr.KO.length, 3);
  assert.ok(methodRoundProbs({ ko: 0, sub: 0 }, 5).DEC === 1);
});

function toyBouts() {
  const mk = (id, sig, td) => ({ id, style: { sigF15: sig, sigA15: 60, tdF15: td, tdA15: 1.5, kdF15: 0.3, kdA15: 0.3, subF15: 0.5, subA15: 0.5 } });
  const cls = { sig15: 60, td15: 1.5, kd15: 0.3, sub15: 0.5, ko15: 0.25, subw15: 0.12 };
  return [
    { id: 'b1', rounds: 3, pA: 0.7, hazA: { ko: 0.03, sub: 0.01 }, hazB: { ko: 0.02, sub: 0.01 }, A: mk('f1', 70, 1), B: mk('f2', 55, 3), cls },
    { id: 'b2', rounds: 5, pA: 0.45, hazA: { ko: 0.01, sub: 0.02 }, hazB: { ko: 0.04, sub: 0.005 }, A: mk('f3', 60, 2), B: mk('f4', 62, 0.5), cls },
  ];
}

test('simulator: win share, methods and rounds add up; DFS bonus only for winners', () => {
  const sims = simulateCard(toyBouts(), { sims: 8000, seed: 5 });
  const s = summarizeBout(sims[0]);
  assert.ok(Math.abs(s.pA - 0.7) < 0.02);
  const m = s.methods;
  assert.ok(Math.abs(m.A.KO + m.A.SUB + m.A.DEC + m.B.KO + m.B.SUB + m.B.DEC - 1) < 1e-9);
  assert.ok(Math.abs(s.endsInRound.reduce((a, b) => a + b, 0) + s.distance - 1) < 1e-9);
  assert.equal(s.endsInRound.length, 3);
  assert.equal(summarizeBout(sims[1]).endsInRound.length, 5);
  const sim = sims[0];
  for (let k = 0; k < 200; k++) {
    if (sim.method[k] === 2) assert.equal(sim.elapsed[k], 900);
    const loser = sim.winner[k] === 0 ? sim.ptsB[k] : sim.ptsA[k];
    assert.ok(loser < SCORING.decision + 200);
  }
});

test('parlays: same-fight correlation, impossible combos, cross-bout independence', () => {
  const sims = simulateCard(toyBouts(), { sims: 10000, seed: 8 });
  const card = makeCard(sims);
  const ko = priceParlay(card, [{ bout: 'b1', market: 'ko', side: 'A' }, { bout: 'b1', market: 'nodistance' }]);
  assert.ok(Math.abs(ko.joint - ko.legs[0].prob) < 1e-9, 'a KO win never goes the distance');
  assert.ok(ko.lift > 1);
  assert.equal(priceParlay(card, [{ bout: 'b1', market: 'dec', side: 'A' }, { bout: 'b1', market: 'under', line: 1.5 }]).joint, 0);
  const x = priceParlay(card, [{ bout: 'b1', market: 'win', side: 'A' }, { bout: 'b2', market: 'win', side: 'B' }]);
  assert.ok(Math.abs(x.lift - 1) < 0.05, 'different bouts are independent');
  assert.ok(priceParlay(card, [{ bout: 'nope', market: 'win', side: 'A' }]).error);
  const a = priceParlay(card, [{ bout: 'b1', market: 'win', side: 'A' }]).joint, b = priceParlay(card, [{ bout: 'b1', market: 'win', side: 'B' }]).joint;
  assert.ok(Math.abs(a + b - 1) < 1e-9);
  const auto = autoParlays(card, [{ bout: 'b1', market: 'win', side: 'A' }, { bout: 'b2', market: 'win', side: 'B' }], { size: 2, minLeg: 0.5, minJoint: 0.05 });
  assert.equal(auto.parlays[0].legs.length, 2);
});

test('book parsing: markets, totals, distance, skipped lines', () => {
  const bouts = [{ id: 'b1', a: { id: 'x', name: 'José Aldo' }, b: { id: 'y', name: 'Max Holloway' } }];
  const { rows, skipped } = parseBook('Jose Aldo, ml, +150\nMax Holloway, ko, 3.5\nAldo vs Holloway, over 2.5, -120\nJose Aldo vs Max Holloway, no distance, +110\nSomeone Else, ml, +100\nMax Holloway, flying knee, +2000', bouts);
  assert.equal(rows.length, 3, JSON.stringify(rows));
  assert.deepEqual(rows[0], { bout: 'b1', market: 'win', side: 'A', dec: 2.5, raw: '+150' });
  assert.equal(rows[1].side, 'B');
  assert.equal(rows[2].market, 'nodistance');
  assert.equal(skipped.length, 3);
});

test('DFS: projections add up and lineups never pair opponents', () => {
  const sims = simulateCard(toyBouts().concat(toyBouts().map((b, i) => ({ ...b, id: `c${i}`, A: { ...b.A, id: `g${i}a` }, B: { ...b.B, id: `g${i}b` } }))), { sims: 6000, seed: 3 });
  const card = makeCard(sims);
  const bouts = sims.map(s => ({ id: s.id, pA: summarizeBout(s).pA, pB: 1 - summarizeBout(s).pA }));
  const names = { b1: ['f1', 'f2'], b2: ['f3', 'f4'], c0: ['g0a', 'g0b'], c1: ['g1a', 'g1b'] };
  const payload = { bouts: bouts.map(b => ({ ...b, a: { id: names[b.id][0], name: `F ${names[b.id][0]}` }, b: { id: names[b.id][1], name: `F ${names[b.id][1]}` } })) };
  const fighters = cardFighters(payload);
  const csv = ['Position,Name + ID,Name,ID,Roster Position,Salary', ...fighters.map((f, i) => `F,${f.name} (${i}),${f.name},${i},F,${7000 + i * 300}`)].join('\n');
  const sal = parseSalaries(csv, fighters);
  assert.equal(sal.rows.length, 8);
  const proj = projections(payload, card, sal.rows);
  for (const p of proj) assert.ok(Math.abs(p.points - (p.split.strikes + p.split.takedowns + p.split.other + p.split.bonus)) < 0.2);
  const smp = simSample(payload, card, proj.map(p => p.id));
  const sample = { n: smp.n, ids: smp.ids, data: new Int16Array(Buffer.from(smp.data, 'base64').buffer.slice(0)) };
  const pool = proj.map(p => ({ id: p.id, name: p.name, salary: Math.round(p.salary * 0.8), points: p.points, ceiling: p.p90 }));
  const opponents = payload.bouts.map(b => [b.a.id, b.b.id]);
  // 8 fighters, 4 bouts, 6 slots: with the opponents rule no lineup is possible; without it, some are.
  assert.equal(Opt.buildSimLineups(pool, sample, { count: 3, opponents }).lineups.length, 0);
  const free = Opt.buildSimLineups(pool, sample, { count: 3 });
  assert.ok(free.lineups.length >= 1);
  const exact = Opt.buildLineups(pool, { count: 1, opponents: opponents.slice(0, 1) });
  const ids = exact.lineups[0].players.map(p => p.id);
  assert.ok(!(ids.includes('f1') && ids.includes('f2')));
});
