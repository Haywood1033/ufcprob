// lib/parlay.js — every bet priced inside the fight simulation. Within a bout, legs are counted
// from the same runs (a fighter winning by knockout and "fight doesn't go the distance" move
// together); bouts are simulated independently, so cross-bout legs multiply exactly as they
// should — but still from the same run index, so one code path prices any ticket.
//
// Leg: { bout, market, side?, line?, dec? }
//   market: win | ko | sub | dec | itd (inside the distance) | distance | nodistance |
//           over | under (line in rounds, e.g. 2.5) | round (side wins in round `line`)

const MARKETS = ['win', 'ko', 'sub', 'dec', 'itd', 'distance', 'nodistance', 'over', 'under', 'round'];
const SIDED = new Set(['win', 'ko', 'sub', 'dec', 'itd', 'round']);

function legKey(l) { return `${l.bout}|${l.market}|${l.side || ''}|${l.line ?? ''}|${l.dec || 0}`; }

function hitFn(sim, leg) {
  const want = leg.side === 'B' ? 1 : 0;
  const line = Number(leg.line);
  switch (leg.market) {
    case 'win': return k => sim.winner[k] === want;
    case 'ko': return k => sim.winner[k] === want && sim.method[k] === 0;
    case 'sub': return k => sim.winner[k] === want && sim.method[k] === 1;
    case 'dec': return k => sim.winner[k] === want && sim.method[k] === 2;
    case 'itd': return k => sim.winner[k] === want && sim.method[k] !== 2;
    case 'distance': return k => sim.method[k] === 2;
    case 'nodistance': return k => sim.method[k] !== 2;
    case 'over': return k => sim.elapsed[k] > line * 300;
    case 'under': return k => sim.elapsed[k] <= line * 300;
    case 'round': return k => sim.winner[k] === want && sim.method[k] !== 2 && sim.endRound[k] === line;
    default: return null;
  }
}

function legSeries(card, leg) {
  if (!card._series) card._series = new Map();
  const key = legKey(leg);
  let out = card._series.get(key);
  if (out) return out;
  const sim = card.byId.get(leg.bout), S = sim.sims, f = hitFn(sim, leg);
  const hit = new Uint8Array(S); let sum = 0;
  for (let k = 0; k < S; k++) { hit[k] = f(k) ? 1 : 0; sum += hit[k]; }
  out = { hit, prob: sum / S };
  card._series.set(key, out);
  return out;
}

function validLeg(card, l) {
  if (!card.byId.has(l.bout) || !MARKETS.includes(l.market)) return false;
  if (SIDED.has(l.market) && l.side !== 'A' && l.side !== 'B') return false;
  if ((l.market === 'over' || l.market === 'under' || l.market === 'round') && !Number.isFinite(Number(l.line))) return false;
  return true;
}

// card: { byId: Map(boutId -> sim) } built from simulateCard's output.
function makeCard(sims) { return { byId: new Map(sims.map(s => [s.id, s])), sims: sims[0]?.sims || 0 }; }

function priceParlay(card, legs) {
  if (!legs.length) return { error: 'Add at least one leg.' };
  if (legs.some(l => !validLeg(card, l))) return { error: 'Unknown bout, market or side in a leg.' };
  const S = card.sims, series = legs.map(l => legSeries(card, l));
  let joint = 0;
  for (let k = 0; k < S; k++) { let h = 1; for (const x of series) if (!x.hit[k]) { h = 0; break; } joint += h; }
  joint /= S;
  const independent = series.reduce((a, x) => a * x.prob, 1);
  const allDec = legs.every(l => l.dec > 1), bookDecimal = allDec ? legs.reduce((a, l) => a * l.dec, 1) : null;
  return { legs: legs.map((l, i) => ({ ...l, prob: series[i].prob })), joint, independent, lift: independent ? joint / independent : null, fairDecimal: joint ? 1 / joint : null, bookDecimal, ev: allDec ? joint * bookDecimal - 1 : null };
}

function* combos(arr, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc.slice(); return; }
  for (let i = start; i <= arr.length - (k - acc.length); i++) { acc.push(arr[i]); yield* combos(arr, k, i + 1, acc); acc.pop(); }
}

// Best cross-bout tickets from candidate legs (one per bout). Guardrails as in the other apps:
// each leg has a real chance, with prices only +EV legs, and the ticket must cash often enough.
function autoParlays(card, candidates, { size = 3, count = 3, pool = 12, minLeg = 0.5, minJoint = 0.08 } = {}) {
  const priced = candidates.filter(c => validLeg(card, c)).map(c => { const prob = legSeries(card, c).prob; return { ...c, prob, ev: c.dec ? prob * c.dec - 1 : null }; });
  const byBook = priced.some(c => c.dec);
  const eligible = priced.filter(c => c.prob >= minLeg && (!byBook || (c.dec && c.ev > 0)));
  // One leg per bout: keep each bout's best.
  const best = new Map();
  for (const c of eligible) { const cur = best.get(c.bout); const v = byBook ? c.ev : c.prob; if (!cur || v > (byBook ? cur.ev : cur.prob)) best.set(c.bout, c); }
  const ranked = [...best.values()].sort((a, b) => (byBook ? b.ev - a.ev : b.prob - a.prob)).slice(0, pool);
  const n = Math.min(size, ranked.length);
  if (n < 2) return { byBook, parlays: [], note: `Not enough ${byBook ? '+EV priced ' : ''}legs with a ${Math.round(minLeg * 100)}%+ chance.` };
  const out = [];
  for (const c of combos(ranked, n)) { const r = priceParlay(card, c.map(({ bout, market, side, line, dec }) => ({ bout, market, side, line, dec }))); if (r.joint >= minJoint) out.push(r); }
  if (!out.length) return { byBook, parlays: [], note: `No ${n}-leg ticket cashes in at least ${Math.round(minJoint * 100)}% of simulations.` };
  out.sort((a, b) => (byBook ? b.ev - a.ev : b.joint - a.joint));
  return { byBook, parlays: out.slice(0, count), note: n < size ? `Only ${ranked.length} eligible legs, so these are ${n}-leg tickets.` : null };
}

module.exports = { MARKETS, legSeries, priceParlay, autoParlays, makeCard, validLeg };
