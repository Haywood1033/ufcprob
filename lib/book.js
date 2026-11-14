// lib/book.js — pasted sportsbook prices → priced legs. One line per price, comma or tab
// separated, American or decimal odds:
//   Fighter Name, ml, -150                      moneyline
//   Fighter Name, ko, +200                      by KO/TKO (also: sub, dec, itd / inside distance)
//   Fighter A vs Fighter B, distance, -120      fight goes the distance (or: no distance)
//   Fighter A vs Fighter B, over 2.5, -110      total rounds (or: under 1.5)
// Names are matched to the card's fighters (lib/names); unmatched lines come back with a reason.

const { buildMatcher } = require('./names');

function toDecimal(raw) {
  const s = String(raw || '').trim().replace('−', '-');
  if (/^[+-]\d+$/.test(s)) { const a = Number(s); return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); }
  const d = Number(s);
  return Number.isFinite(d) && d > 1 && d < 1000 ? d : null;
}

const SIDE_MARKETS = [
  [/^(ml|moneyline|win|to win)$/, 'win'], [/^(ko|tko|ko\/tko|by ko)$/, 'ko'], [/^(sub|submission|by sub)$/, 'sub'],
  [/^(dec|decision|by dec)$/, 'dec'], [/^(itd|inside( the)? distance|finish)$/, 'itd'],
];

function parseBook(text, bouts) {
  const fighters = bouts.flatMap(b => [{ id: b.a.id, name: b.a.name, bout: b.id, side: 'A' }, { id: b.b.id, name: b.b.name, bout: b.id, side: 'B' }]);
  const match = buildMatcher(fighters);
  const rows = [], skipped = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) continue;
    const parts = raw.split(/\t|,/).map(s => s.trim());
    if (parts.length < 3) { skipped.push({ line: raw, why: 'Needs at least: name, market, odds' }); continue; }
    const mk = parts[1].toLowerCase(), dec = toDecimal(parts[2]);
    if (!dec) { skipped.push({ line: raw, why: `Couldn't read the odds "${parts[2]}"` }); continue; }
    const tot = mk.match(/^(over|under|o|u)\s*([\d.]+)$/);
    if (tot || /^(distance|goes the distance|no distance|doesn.?t go the distance)$/.test(mk)) {
      const [x, y] = parts[0].split(/\s+(?:vs\.?|v\.?)\s+/i);
      const f = (x && match(x)) || (y && match(y));
      if (!f) { skipped.push({ line: raw, why: `Couldn't match "${parts[0]}" to a bout on this card` }); continue; }
      if (tot) rows.push({ bout: f.bout, market: /^o/.test(tot[1]) ? 'over' : 'under', line: Number(tot[2]), dec, raw: parts[2] });
      else rows.push({ bout: f.bout, market: /no|n.?t/.test(mk) ? 'nodistance' : 'distance', dec, raw: parts[2] });
      continue;
    }
    const market = SIDE_MARKETS.find(([re]) => re.test(mk))?.[1];
    if (!market) { skipped.push({ line: raw, why: `Unknown market "${parts[1]}"` }); continue; }
    const f = match(parts[0]);
    if (!f) { skipped.push({ line: raw, why: `Couldn't match "${parts[0]}" to a fighter on this card` }); continue; }
    rows.push({ bout: f.bout, market, side: f.side, dec, raw: parts[2] });
  }
  return { rows, skipped };
}

// The card's own sportsbook lines (lib/card's `market`, from ESPN) as priced rows, the same shape
// pasted prices parse to: moneyline and method per fighter, and the round total.
function marketRows(bouts) {
  const rows = [], fmt = a => (a > 0 ? `+${a}` : `${a}`);
  const add = (row, a) => { if (a !== null && a !== undefined) rows.push({ ...row, dec: toDecimal(fmt(a)), raw: fmt(a) }); };
  for (const bt of bouts) {
    const m = bt.market; if (!m) continue;
    for (const [side, s] of [['A', m.a], ['B', m.b]]) for (const [market, key] of [['win', 'ml'], ['ko', 'ko'], ['sub', 'sub'], ['dec', 'dec']]) add({ bout: bt.id, market, side }, s[key]);
    if (m.total) { add({ bout: bt.id, market: 'over', line: m.total.line }, m.total.over); add({ bout: bt.id, market: 'under', line: m.total.line }, m.total.under); }
  }
  return rows;
}
const marketName = bouts => bouts.find(b => b.market)?.market.provider || null;

module.exports = { parseBook, toDecimal, marketRows, marketName };
