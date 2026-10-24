// lib/plays.js — the Best plays tab: sides (moneyline), props (method, inside the distance, goes
// the distance) and 3/4/5-leg cross-bout parlays, each with reasons built from the numbers. With
// pasted prices a section ranks by expected value against the book; without, by model strength,
// and it says so (most likely is not the same as value).

const { legSeries, autoParlays } = require('./parlay');

const MIN_EV = 0.03;
const pct = (p, d = 0) => `${(p * 100).toFixed(d)}%`;
const american = p => (!p || p >= 1 ? '—' : p >= 0.5 ? `−${Math.round((100 * p) / (1 - p))}` : `+${Math.round((100 * (1 - p)) / p)}`);
const LABEL = { win: 'to win', ko: 'by KO/TKO', sub: 'by submission', dec: 'by decision', itd: 'inside the distance', distance: 'Goes the distance', nodistance: 'Doesn’t go the distance', over: 'Over', under: 'Under', round: 'in round' };

function fighterReasons(bout, side) {
  const me = side === 'A' ? bout.a : bout.b, op = side === 'A' ? bout.b : bout.a;
  const out = [];
  const eloGap = me.elo - op.elo;
  out.push(`Elo ${me.elo} vs ${op.elo} (${eloGap >= 0 ? '+' : '−'}${Math.abs(eloGap)}); ${me.record.w}-${me.record.l} in tracked UFC bouts`);
  const strike = (me.style.sigF15 - me.style.sigA15) - (op.style.sigF15 - op.style.sigA15);
  if (Math.abs(strike) >= 4) out.push(`Striking differential ${Math.abs(strike).toFixed(0)} significant strikes per 15 minutes ${strike >= 0 ? 'better' : 'worse'} (lands ${me.style.sigF15.toFixed(0)}, absorbs ${me.style.sigA15.toFixed(0)})`);
  const grap = (me.style.tdF15 - me.style.tdA15) - (op.style.tdF15 - op.style.tdA15);
  if (Math.abs(grap) >= 0.6) out.push(`Grappling: ${me.style.tdF15.toFixed(1)} takedowns per 15 vs ${op.style.tdF15.toFixed(1)}; ${grap >= 0 ? 'controls where it goes' : 'can be taken down'}`);
  if (me.age && op.age && Math.abs(me.age - op.age) >= 4) out.push(`Age ${me.age.toFixed(0)} vs ${op.age.toFixed(0)}`);
  if (me.reachIn && op.reachIn && Math.abs(me.reachIn - op.reachIn) >= 3) out.push(`Reach ${me.reachIn}" vs ${op.reachIn}"`);
  if (me.layoffDays && me.layoffDays > 400) out.push(`Coming off ${Math.round(me.layoffDays / 30)} months out`);
  if (me.ufcFights < 2) out.push(`Only ${me.ufcFights} tracked UFC bout${me.ufcFights === 1 ? '' : 's'}: leans on the debut prior`);
  return out;
}

function propReasons(bout, leg) {
  const side = leg.side, me = side === 'A' ? bout.a : side === 'B' ? bout.b : null, op = side === 'A' ? bout.b : side === 'B' ? bout.a : null;
  const out = [];
  if (leg.market === 'ko' || leg.market === 'itd') out.push(`${me.name}: ${me.finishProfile.rawWins.KO} KO wins; ${op.name} has been stopped by strikes ${op.finishProfile.rawLosses.KO} time${op.finishProfile.rawLosses.KO === 1 ? '' : 's'}`);
  if (leg.market === 'sub' || leg.market === 'itd') out.push(`${me.name}: ${me.finishProfile.rawWins.SUB} submission wins, ${me.style.subF15.toFixed(1)} attempts per 15; ${op.name} tapped ${op.finishProfile.rawLosses.SUB} time${op.finishProfile.rawLosses.SUB === 1 ? '' : 's'}`);
  if (leg.market === 'dec') out.push(`${me.name} has ${me.finishProfile.rawWins.DEC} decision wins; ${op.name} has been finished ${op.finishProfile.rawLosses.KO + op.finishProfile.rawLosses.SUB} times`);
  if (leg.market === 'distance' || leg.market === 'nodistance') out.push(`Simulated: goes the distance ${pct(bout.distance)}; KO ${pct(bout.methods.A.KO + bout.methods.B.KO)}, submission ${pct(bout.methods.A.SUB + bout.methods.B.SUB)}`);
  out.push(`${bout.rounds}-round ${bout.weightClass?.toLowerCase() || ''} bout`);
  return out;
}

function legTitle(bout, l) {
  if (l.market === 'distance' || l.market === 'nodistance') return `${LABEL[l.market]}: ${bout.a.name} vs ${bout.b.name}`;
  if (l.market === 'over' || l.market === 'under') return `${LABEL[l.market]} ${l.line} rounds: ${bout.a.name} vs ${bout.b.name}`;
  const me = l.side === 'A' ? bout.a.name : bout.b.name;
  return l.market === 'win' ? me : `${me} ${LABEL[l.market]}`;
}

function candidates(bouts) {
  const legs = [];
  for (const b of bouts) {
    if (b.result) continue;
    for (const side of ['A', 'B']) for (const market of ['win', 'ko', 'sub', 'dec', 'itd']) legs.push({ bout: b.id, market, side });
    legs.push({ bout: b.id, market: 'distance' }, { bout: b.id, market: 'nodistance' });
  }
  return legs;
}

function buildPlays(payload, card, bookRows = []) {
  const byId = new Map(payload.bouts.map(b => [b.id, b]));
  const priced = new Map(bookRows.map(r => [`${r.bout}|${r.market}|${r.side || ''}|${r.line ?? ''}`, r]));
  const item = l => {
    const b = byId.get(l.bout), prob = legSeries(card, l).prob, r = priced.get(`${l.bout}|${l.market}|${l.side || ''}|${l.line ?? ''}`);
    return { ...l, title: legTitle(b, l), sub: `${b.a.name} vs ${b.b.name}`, prob, fairOdds: american(prob), book: r ? { raw: r.raw, dec: r.dec, implied: 1 / r.dec, ev: prob * r.dec - 1 } : null,
      reasons: l.market === 'win' ? fighterReasons(b, l.side) : propReasons(b, l) };
  };
  const all = [...candidates(payload.bouts), ...bookRows.filter(r => r.market === 'over' || r.market === 'under' || r.market === 'round')].map(l => ({ ...l }));
  const section = (filter, label) => {
    const items = all.filter(filter).map(item);
    const hasBook = items.some(i => i.book);
    const ranked = hasBook ? items.filter(i => i.book && i.book.ev >= MIN_EV && i.prob >= 0.05).sort((a, b) => b.book.ev - a.book.ev).slice(0, 6) : items.filter(i => i.prob < 0.97).sort((a, b) => b.prob - a.prob).slice(0, 6);
    const summary = hasBook
      ? (ranked.length ? `${ranked.length} ${label} price${ranked.length > 1 ? 's' : ''} beat${ranked.length > 1 ? '' : 's'} the book by ${pct(MIN_EV)}+ per $1. Best: ${ranked[0].title} at ${ranked[0].book.raw} (model ${pct(ranked[0].prob, 1)} vs ${pct(ranked[0].book.implied, 1)} implied).` : `None of your ${label} prices clears ${pct(MIN_EV)} expected profit against the model.`)
      : `The model's strongest ${label}s. Paste prices on the Odds tab to rank by value instead.`;
    return { mode: hasBook ? 'value' : 'model', summary, items: ranked };
  };
  const sides = section(l => l.market === 'win', 'side');
  const props = section(l => l.market !== 'win', 'prop');
  // Parlays: one moneyline leg per bout, priced in the simulation.
  const mlLegs = all.filter(l => l.market === 'win').map(l => ({ ...l, dec: priced.get(`${l.bout}|win|${l.side}|`)?.dec || null }));
  const bySize = {};
  for (const size of [3, 4, 5]) {
    const res = autoParlays(card, mlLegs.some(l => l.dec) ? mlLegs.filter(l => l.dec) : mlLegs, { size, count: 3, minLeg: 0.55, minJoint: { 3: 0.15, 4: 0.1, 5: 0.06 }[size] });
    bySize[size] = { note: res.note, parlays: res.parlays.map(p => ({ joint: p.joint, independent: p.independent, fairOdds: american(p.joint), bookDecimal: p.bookDecimal, ev: p.ev, legs: p.legs.map(l => ({ ...l, title: legTitle(byId.get(l.bout), l) })) })) };
  }
  const mid = bySize[4].parlays[0] || bySize[3].parlays[0];
  const parlaySummary = !mid ? 'No moneyline ticket clears the bar.' : mlLegs.some(l => l.dec)
    ? `Built from your moneyline prices, every leg +EV on its own. The best ${mid.legs.length}-leg ticket hits in ${pct(mid.joint, 1)} of simulated cards${mid.ev !== null ? `, expected ${mid.ev >= 0 ? '+' : '−'}$${Math.abs(mid.ev).toFixed(2)} per $1` : ''}.`
    : `The likeliest sides across the card, one per bout. The best ${mid.legs.length}-leg ticket hits in ${pct(mid.joint, 1)} of simulated cards (fair ${mid.fairOdds}). Without prices this is the most likely ticket, not a value ranking.`;
  return { event: payload.event, minEv: MIN_EV, sides, props, parlays: { mode: mlLegs.some(l => l.dec) ? 'value' : 'model', summary: parlaySummary, bySize }, priced: bookRows.length, generatedAt: new Date().toISOString() };
}

module.exports = { buildPlays, fighterReasons, legTitle, MIN_EV };
