// lib/dfs.js — fantasy projections from the fight simulation, Classic format: 6 fighters,
// $50,000 cap. Points per fighter per run come from lib/simulator's scoring (significant
// strikes, takedowns, knockdowns, control time, and the win bonus by round or decision), so a
// projection is consistent with the same fighter's win and method odds.
//
// Salaries come from the site's CSV export; names are matched to the card leniently. The route
// also sends a 2,000-run sample of each priced fighter's points so the browser can score whole
// lineups run by run (a fighter and their opponent are perfectly anti-correlated on the win bonus).

const { buildMatcher } = require('./names');
const { SCORING } = require('./simulator');

function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseSalaries(text, fighters) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { rows: [], unmatched: [], error: 'Empty file' };
  const head = parseCsvLine(lines[0]).map(h => h.toLowerCase());
  const col = names => head.findIndex(h => names.includes(h));
  const iName = col(['name']), iSal = col(['salary']), iId = col(['id']);
  if (iName < 0 || iSal < 0) return { rows: [], unmatched: [], error: 'Expected a CSV with Name and Salary columns (the site\'s salary export).' };
  const match = buildMatcher(fighters);
  const rows = [], unmatched = [];
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    const salary = Number(String(c[iSal] || '').replace(/[$,]/g, ''));
    if (!c[iName] || !salary) continue;
    const f = match(c[iName]);
    if (!f) { unmatched.push(c[iName]); continue; }
    rows.push({ id: f.id, siteId: iId >= 0 ? c[iId] : null, name: f.name, salary });
  }
  return { rows, unmatched };
}

function cardFighters(payload) {
  return payload.bouts.flatMap(b => [{ id: b.a.id, name: b.a.name, bout: b.id, side: 'A', opp: b.b.id }, { id: b.b.id, name: b.b.name, bout: b.id, side: 'B', opp: b.a.id }]);
}

function projections(payload, card, salaries) {
  const salBy = new Map((salaries || []).map(r => [r.id, r]));
  const byBout = new Map(payload.bouts.map(b => [b.id, b]));
  return cardFighters(payload).map(f => {
    const sim = card.byId.get(f.bout), S = sim.sims, want = f.side === 'A' ? 0 : 1;
    const pts = f.side === 'A' ? sim.ptsA : sim.ptsB, sig = f.side === 'A' ? sim.sigA : sim.sigB, td = f.side === 'A' ? sim.tdA : sim.tdB;
    let tot = 0, sSig = 0, sTd = 0, sBonus = 0;
    for (let k = 0; k < S; k++) {
      tot += pts[k]; sSig += sig[k]; sTd += td[k];
      if (sim.winner[k] === want) sBonus += sim.method[k] === 2 ? SCORING.decision : SCORING.win[sim.endRound[k] - 1] + (sim.endRound[k] === 1 && sim.elapsed[k] <= 60 ? SCORING.quick : 0);
    }
    const sorted = Float32Array.from(pts).sort(), q = x => +sorted[Math.min(S - 1, Math.floor(x * S))].toFixed(1);
    const mean = tot / S, strikes = (SCORING.sig * sSig) / S, takedowns = (SCORING.td * sTd) / S, bonus = sBonus / S;
    const b = byBout.get(f.bout), sal = salBy.get(f.id);
    return {
      id: f.id, name: f.name, bout: f.bout, side: f.side, opp: f.opp, oppName: f.side === 'A' ? b.b.name : b.a.name, win: f.side === 'A' ? b.pA : b.pB,
      salary: sal?.salary || null, siteId: sal?.siteId || null,
      points: +mean.toFixed(2), p10: q(0.1), p50: q(0.5), p90: q(0.9),
      split: { strikes: +strikes.toFixed(1), takedowns: +takedowns.toFixed(1), other: +Math.max(0, mean - strikes - takedowns - bonus).toFixed(1), bonus: +bonus.toFixed(1) },
      value: sal ? +((mean / sal.salary) * 1000).toFixed(2) : null,
    };
  }).sort((a, b) => b.points - a.points);
}

function simSample(payload, card, ids, n = 2000) {
  const fs = new Map(cardFighters(payload).map(f => [f.id, f]));
  const S = card.sims, step = Math.max(1, Math.floor(S / n)), m = Math.min(n, Math.floor(S / step));
  const data = new Int16Array(ids.length * m);
  ids.forEach((id, r) => {
    const f = fs.get(id), sim = card.byId.get(f.bout), pts = f.side === 'A' ? sim.ptsA : sim.ptsB;
    for (let j = 0; j < m; j++) data[r * m + j] = Math.min(32767, Math.round(pts[j * step] * 10));
  });
  return { n: m, ids, data: Buffer.from(data.buffer).toString('base64') };
}

module.exports = { parseSalaries, projections, simSample, cardFighters, parseCsvLine };
