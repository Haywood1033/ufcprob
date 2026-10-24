// lib/dataset.js — fight history from the public scrape_ufc_stats dataset on GitHub, a mirror of
// UFCStats (which now serves a JavaScript challenge to servers). Four CSVs, refreshed weekly by
// that project:
//   ufc_event_details.csv   EVENT, URL, DATE, LOCATION
//   ufc_fight_results.csv   EVENT, BOUT, OUTCOME, WEIGHTCLASS, METHOD, ROUND, TIME, TIME FORMAT, …, URL
//   ufc_fight_stats.csv     EVENT, BOUT, ROUND, FIGHTER, KD, SIG.STR., …, TD, …, SUB.ATT, REV., CTRL, …
//   ufc_fighter_tott.csv    FIGHTER, HEIGHT, WEIGHT, REACH, STANCE, DOB, URL
// Parsed into the bout rows the model reads (lib/store's shape), fighters keyed by their UFCStats
// id. Results list bouts by name only, so fighters are matched to ids through the tale-of-the-tape
// file (names are unique there in all but a handful of cases).

const { fetchText } = require('./http');
const { normName, stripSuffix } = require('./names');

const REPO = process.env.UFC_DATASET_BASE || 'https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/main';
const FILES = { events: 'ufc_event_details.csv', results: 'ufc_fight_results.csv', stats: 'ufc_fight_stats.csv', fighters: 'ufc_fighter_tott.csv' };
const FIRST_YEAR = 2010;

// RFC 4180-ish CSV: quoted fields, doubled quotes, commas inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim());
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const idFrom = (url, kind) => (String(url || '').match(new RegExp(`${kind}/([0-9a-f]+)`)) || [])[1] || null;
const parseDate = s => { const d = new Date(`${String(s || '').trim()} 00:00:00 UTC`); return isNaN(d) ? null : d.toISOString().slice(0, 10); };
const ofPair = s => { const m = String(s || '').match(/(\d+)\s+of\s+(\d+)/); return m ? Number(m[1]) : null; };
const num = s => { const n = Number(String(s ?? '').replace(/[^\d.-]/g, '')); return String(s ?? '').trim() && !/^-+$/.test(String(s).trim()) && Number.isFinite(n) ? n : null; };
const secs = s => { const m = String(s || '').match(/(\d+):(\d\d)/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const inches = s => { const ft = String(s || '').match(/(\d+)'\s*(\d+)/); if (ft) return Number(ft[1]) * 12 + Number(ft[2]); const n = num(s); return n && n > 40 ? n : null; };
const key = s => normName(s);
const ws = s => String(s || '').replace(/\s+/g, ' ').trim();
const CLASS_RE = /(women'?s\s+)?(strawweight|flyweight|bantamweight|featherweight|lightweight|welterweight|middleweight|light heavyweight|heavyweight|catch ?weight|open ?weight)/i;

function methodBucket(m) {
  const s = String(m || '').toUpperCase();
  if (/OVERTURN|DQ|COULD NOT|OTHER/.test(s)) return 'OTHER';
  if (/KO|TKO/.test(s)) return 'KO';
  if (/SUB/.test(s)) return 'SUB';
  if (/DEC/.test(s)) return 'DEC';
  return 'OTHER';
}
function weightClassOf(raw) {
  const m = String(raw || '').match(CLASS_RE);
  if (!m) return 'Open Weight';
  const cls = m[2].toLowerCase().replace(/catch ?weight/, 'catch weight').replace(/open ?weight/, 'open weight').replace(/\b\w/g, c => c.toUpperCase());
  return m[1] ? `Women's ${cls}` : cls;
}

function build({ events: evText, results: resText, stats: statText, fighters: tottText }) {
  const events = parseCsv(evText).map(e => ({ id: idFrom(e.URL, 'event-details'), name: e.EVENT, date: parseDate(e.DATE), location: e.LOCATION || null })).filter(e => e.id && e.date);
  const eventByName = new Map(events.map(e => [ws(e.name), e]));
  // Fighters: UFCStats id per name; a name used by two fighters is ambiguous and falls back to the name.
  const fighters = new Map(), byName = new Map();
  for (const f of parseCsv(tottText)) {
    const id = idFrom(f.URL, 'fighter-details');
    if (!id) continue;
    fighters.set(id, { id, name: f.FIGHTER, heightIn: inches(f.HEIGHT), reachIn: inches(f.REACH), stance: f.STANCE || null, dob: parseDate(f.DOB) });
    const k = key(f.FIGHTER);
    byName.set(k, byName.has(k) ? 'AMBIGUOUS' : id);
  }
  const fid = name => { const v = byName.get(key(name)); return v && v !== 'AMBIGUOUS' ? v : `n:${key(name)}`; };
  // Per-bout totals from the per-round stats.
  const totals = new Map();
  for (const r of parseCsv(statText)) {
    const k = `${ws(r.EVENT)}|${ws(r.BOUT)}|${key(r.FIGHTER)}`;
    const t = totals.get(k) || { kd: 0, sig: 0, sigAtt: 0, td: 0, sub: 0, ctrl: 0, n: 0 };
    t.kd += num(r.KD) || 0; t.sig += ofPair(r['SIG.STR.']) || 0; t.sigAtt += Number((String(r['SIG.STR.']).match(/of\s+(\d+)/) || [])[1] || 0);
    t.td += ofPair(r.TD) || 0; t.sub += num(r['SUB.ATT']) || 0; t.ctrl += secs(r.CTRL) || 0; t.n++;
    totals.set(k, t);
  }
  const order = new Map();
  const bouts = [];
  for (const r of parseCsv(resText)) {
    const ev = eventByName.get(ws(r.EVENT));
    if (!ev || ev.date < `${FIRST_YEAR}-01-01`) continue;
    const [an, bn] = r.BOUT.split(/\s+vs\.?\s+/i).map(s => s.trim());
    if (!an || !bn) continue;
    const out = String(r.OUTCOME || '').toUpperCase();
    // The winner is listed first on UFCStats; OUTCOME "L/W" means the second name won.
    const flip = out.startsWith('L/');
    const [wn, ln] = flip ? [bn, an] : [an, bn];
    const result = /^D\//.test(out) ? 'draw' : /^NC/.test(out) ? 'nc' : 'a';
    const rounds = Number((String(r['TIME FORMAT']).match(/(\d)\s*Rnd/i) || [])[1]) || 3;
    const o = order.get(ev.id) || 0; order.set(ev.id, o + 1);
    const st = n => totals.get(`${ws(r.EVENT)}|${ws(r.BOUT)}|${key(n)}`) || null;
    const sa = st(wn), sb = st(ln);
    bouts.push({
      fightId: idFrom(r.URL, 'fight-details') || `${ev.id}-${o}`, eventId: ev.id, date: ev.date, order: o,
      a: { id: fid(wn), name: wn }, b: { id: fid(ln), name: ln },
      weightClass: weightClassOf(r.WEIGHTCLASS), title: /title/i.test(r.WEIGHTCLASS), women: /women/i.test(r.WEIGHTCLASS), rounds: Math.min(5, rounds),
      result, method: r.METHOD || null, methodDetail: r.DETAILS || null, bucket: methodBucket(r.METHOD), endRound: num(r.ROUND), endTime: secs(r.TIME),
      stats: sa && sb ? { a: { kd: sa.kd, sig: sa.sig, td: sa.td, sub: sa.sub, ctrl: sa.ctrl }, b: { kd: sb.kd, sig: sb.sig, td: sb.td, sub: sb.sub, ctrl: sb.ctrl } } : null,
    });
  }
  bouts.sort((x, y) => x.date.localeCompare(y.date) || y.order - x.order);
  // Last date and weight class per fighter (bouts are in date order, so the last write wins).
  const last = new Map();
  for (const b of bouts) for (const s of [b.a, b.b]) last.set(s.id, { date: b.date, weightClass: b.weightClass });
  return { events: events.sort((x, y) => y.date.localeCompare(x.date)), bouts, fighters, last, resolve: resolver(fighters, last) };
}

// Name → fighter id for names from other sources (ESPN). Tries the normalized name, then without
// a generational suffix, then the tokens in any order ("Zhang Weili" / "Weili Zhang"). Two
// fighters sharing a name resolve to the one who fought most recently.
function resolver(fighters, last) {
  const forms = n => { const k = key(n); return [k, stripSuffix(k), k.split(' ').sort().join(' ')]; };
  const maps = [new Map(), new Map(), new Map()];
  const add = (name, id) => forms(name).forEach((f, i) => { if (!f) return; const l = maps[i].get(f) || []; if (!l.includes(id)) l.push(id); maps[i].set(f, l); });
  for (const [id, f] of fighters) add(f.name, id);
  // Names two fighters share were kept under one name id (results list names only); route to it.
  for (const [id, l] of last) if (id.startsWith('n:') && l) add(id.slice(2), id);
  const recency = id => last.get(id)?.date || '';
  return name => {
    const fs = forms(name);
    for (let i = 0; i < 3; i++) {
      const l = maps[i].get(fs[i]);
      if (l?.length) return [...l].sort((x, y) => recency(y).localeCompare(recency(x)))[0];
    }
    return null;
  };
}

// Kept per serverless instance for six hours; the dataset itself refreshes about weekly.
let memo = null;
async function loadDataset({ force = false } = {}) {
  if (!force && memo && Date.now() - memo.at < 6 * 3600 * 1000) return memo.data;
  const [events, results, stats, fighters] = await Promise.all(Object.values(FILES).map(f => fetchText(`${REPO}/${f}`, { timeoutMs: 30000, cache: false })));
  const data = build({ events, results, stats, fighters });
  data.loadedAt = new Date().toISOString();
  memo = { at: Date.now(), data };
  return data;
}

module.exports = { REPO, FILES, FIRST_YEAR, parseCsv, build, loadDataset, methodBucket, weightClassOf, inches, parseDate };
