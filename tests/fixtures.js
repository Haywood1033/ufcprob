// Synthetic MMA world for tests and layout screenshots: fake fighters and fake cards, served as
// the scrape_ufc_stats CSVs (lib/dataset.js) and ESPN's scoreboard, core and athlete shapes
// (lib/espn.js). Nothing here is real data.
const { makeRng } = require('../lib/rng');

const FIRST = ['Alex', 'Bruno', 'Caio', 'Dario', 'Eryk', 'Felipe', 'Goran', 'Hugo', 'Ilir', 'Jonas', 'Kiko', 'Luka', 'Mateo', 'Niko', 'Omar', 'Pavel', 'Rafa', 'Sergei', 'Tariq', 'Uriah', 'Vito', 'Wes', 'Yuri', 'Zane'];
const LAST = ['Almeida', 'Borges', 'Castro', 'Duarte', 'Esposito', 'Faria', 'Gomes', 'Halvorsen', 'Ivanov', 'Jensen', 'Kovac', 'Lopes', 'Moraes', 'Novak', 'Okafor', 'Petrov', 'Quintero', 'Rocha', 'Silva', 'Teixeira'];
const CLASSES = ['Flyweight', 'Bantamweight', 'Featherweight', 'Lightweight', 'Welterweight', 'Middleweight', 'Light Heavyweight', 'Heavyweight', "Women's Strawweight", "Women's Flyweight", "Women's Bantamweight"];
const HEAVY = { Heavyweight: 1.6, 'Light Heavyweight': 1.35, Middleweight: 1.15 };
const sig = z => 1 / (1 + Math.exp(-z));
const hex = n => n.toString(16).padStart(16, '0');

function makeWorld(seed = 11) {
  const rng = makeRng(seed);
  const fighters = [];
  CLASSES.forEach((wc, ci) => {
    for (let i = 0; i < 34; i++) {
      const n = fighters.length;
      fighters.push({
        id: hex(0xf000 + n), name: `${FIRST[n % 24]} ${LAST[Math.floor(n / 24) % 20]}${n >= 480 ? ' Jr.' : ''}`, wc, women: /Women/.test(wc),
        skill: rng.normal(), power: Math.exp(rng.normal() * 0.5) * (HEAVY[wc] || 1), chin: Math.exp(rng.normal() * 0.45), grap: rng.normal(), subs: Math.exp(rng.normal() * 0.5),
        vol: 3.5 + rng.uniform() * 3, dob: `${1986 + Math.floor(rng.uniform() * 14)}-0${1 + Math.floor(rng.uniform() * 9)}-1${Math.floor(rng.uniform() * 9)}`, reach: 66 + Math.round(rng.uniform() * 12) + (HEAVY[wc] ? 4 : 0),
        stance: rng.uniform() < 0.7 ? 'Orthodox' : 'Southpaw',
      });
    }
  });
  return { fighters, rng };
}

// One fight from the latent traits: winner, method, round, time and box-score totals.
function fight(a, b, rounds, rng) {
  const pA = sig(1.15 * (a.skill - b.skill) + 0.25 * (a.grap - b.grap));
  const aWins = rng.uniform() < pA;
  const W = aWins ? a : b, L = aWins ? b : a;
  const dom = Math.max(0.3, (aWins ? pA : 1 - pA) / 0.5);
  const ko = 0.022 * W.power * L.chin * Math.sqrt(dom), sub = 0.012 * W.subs * Math.max(0.3, 1 + 0.5 * (W.grap - L.grap)) * Math.sqrt(dom);
  let bucket = 'DEC', round = rounds, time = 300;
  for (let r = 1; r <= rounds; r++) {
    const fin = 1 - Math.exp(-5 * (ko + sub));
    if (rng.uniform() < fin) { bucket = rng.uniform() < ko / (ko + sub) ? 'KO' : 'SUB'; round = r; time = Math.max(10, Math.round(rng.uniform() * 290)); break; }
  }
  const mins = (round - 1) * 5 + time / 60;
  const st = (X, Y, won) => ({ kd: bucket === 'KO' && won ? 1 : rng.uniform() < 0.04 * mins / 5 ? 1 : 0, sig: Math.round(X.vol * mins * (won ? 1.1 : 0.9) * Math.exp(rng.normal() * 0.3)), td: Math.max(0, Math.round((0.35 + 0.3 * X.grap - 0.15 * Y.grap) * mins / 5 * 2 + rng.normal() * 0.6)), sub: bucket === 'SUB' && won ? 1 : rng.uniform() < 0.15 * Math.max(0.2, X.subs) ? 1 : 0 });
  const method = bucket === 'KO' ? 'KO/TKO' : bucket === 'SUB' ? 'SUB' : rng.uniform() < 0.15 ? 'S-DEC' : 'U-DEC';
  return { winner: W, loser: L, method, detail: bucket === 'KO' ? 'Punches' : bucket === 'SUB' ? 'Rear Naked Choke' : '', round, time, stW: st(W, L, true), stL: st(L, W, false) };
}

const clockTxt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const csvCell = v => (/[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
const csv = (head, rows) => [head.join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\n') + '\n';
const longDate = d => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const shortDate = d => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC' });
const heightOf = f => 66 + Math.round((f.reach - 66) * 0.6);
// Fighters missing from the tale-of-the-tape file, so their physicals come from ESPN's bio.
const NO_TOTT = new Set([5, 77]);

// The four scrape_ufc_stats CSVs (lib/dataset.js) for every completed event.
function datasetCsvs(events, fighters) {
  const done = events.filter(e => e.done).reverse();
  const evCsv = csv(['EVENT', 'URL', 'DATE', 'LOCATION'], done.map(e => [`${e.name} `, `http://ufcstats.com/event-details/${e.id}`, longDate(e.date), e.location]));
  const res = [], st = [];
  for (const e of done) for (const bt of e.bouts) {
    const r = bt.res, aWon = r.winner === bt.a;
    const outcome = bt.draw ? 'D/D' : aWon ? 'W/L' : 'L/W';
    const bout = `${bt.a.name} vs. ${bt.b.name}`;
    const method = { 'KO/TKO': 'KO/TKO ', SUB: 'Submission ', 'S-DEC': 'Decision - Split ', 'U-DEC': 'Decision - Unanimous ' }[r.method];
    res.push([`${e.name} `, bout, outcome, `${bt.title ? 'UFC ' : ''}${bt.wc}${bt.title ? ' Title' : ''} Bout`, method, r.round, clockTxt(r.time), bt.rounds === 5 ? '5 Rnd (5-5-5-5-5)' : '3 Rnd (5-5-5)', 'Herb Dean', r.detail, `http://ufcstats.com/fight-details/${bt.fightId}`]);
    for (const [f, s] of [[r.winner, r.stW], [r.loser, r.stL]]) {
      // Totals in round 1, empty later rounds — the parser sums rounds either way.
      for (let k = 1; k <= r.round; k++) {
        const one = k === 1;
        st.push([e.name, bout, `Round ${k}`, f.name, one ? `${s.kd}.0` : '0', one ? `${s.sig} of ${s.sig + 9}` : '0 of 0', '---', '0 of 0', one ? `${s.td} of ${s.td + 2}` : '0 of 0', '---', one ? s.sub : 0, 0, one ? clockTxt(s.td * 45) : '--', '', '', '', '', '', '']);
      }
    }
  }
  const tott = csv(['FIGHTER', 'HEIGHT', 'WEIGHT', 'REACH', 'STANCE', 'DOB', 'URL'], fighters.filter((f, i) => !NO_TOTT.has(i)).map(f => [f.name, `${Math.floor(heightOf(f) / 12)}' ${heightOf(f) % 12}"`, '155 lbs.', `${f.reach}.0"`, f.stance, shortDate(f.dob), `http://ufcstats.com/fighter-details/${f.id}`]));
  return {
    'ufc_event_details.csv': evCsv,
    'ufc_fight_results.csv': csv(['EVENT', 'BOUT', 'OUTCOME', 'WEIGHTCLASS', 'METHOD', 'ROUND', 'TIME', 'TIME FORMAT', 'REFEREE', 'DETAILS', 'URL'], res),
    'ufc_fight_stats.csv': csv(['EVENT', 'BOUT', 'ROUND', 'FIGHTER', 'KD', 'SIG.STR.', 'SIG.STR. %', 'TOTAL STR.', 'TD', 'TD %', 'SUB.ATT', 'REV.', 'CTRL', 'HEAD', 'BODY', 'LEG', 'DISTANCE', 'CLINCH', 'GROUND'], st),
    'ufc_fighter_tott.csv': tott,
  };
}

const espnId = f => String(3000000 + parseInt(f.id, 16));
const espnEventId = e => String(600000 + parseInt(e.id, 16));
const compId = (e, i) => `${parseInt(e.id, 16)}${String(i).padStart(2, '0')}`;
// ESPN's scoreboard for one event: bouts in start order (prelims first), no card segment (the
// core API supplies it), weight class on every other bout.
function espnEvent(e, { live }) {
  const competitions = e.bouts.map((bt, i) => {
    const post = e.done || (live && i >= 10 && i !== 11), inProg = !e.done && live && i === 11;
    const winA = post && bt.res ? bt.res.winner === bt.a : live && i === 10;
    return {
      id: compId(e, i), date: new Date(Date.parse(`${e.date}T23:00:00Z`) - i * 1200e3).toISOString().replace(/:00\.000Z$/, 'Z'),
      format: { regulation: { periods: bt.rounds } }, ...(i % 2 ? {} : { type: { abbreviation: bt.wc } }),
      status: { period: inProg ? 2 : post ? bt.res?.round || 3 : 0, displayClock: '2:14', type: { state: post ? 'post' : inProg ? 'in' : 'pre', completed: post, detail: inProg ? 'R2 2:14' : post ? 'Final' : 'Scheduled' } },
      competitors: [bt.a, bt.b].map((f, k) => ({ id: espnId(f), athlete: { id: espnId(f), displayName: f.name }, winner: post ? (k === 0 ? winA : !winA) : false, records: [{ summary: '15-4-0' }] })),
    };
  }).reverse();
  return { id: espnEventId(e), name: e.name, date: `${e.date}T23:00Z`, status: { type: { state: e.done ? 'post' : live ? 'in' : 'pre' } }, competitions };
}

function installMockFetch({ now, live = false } = {}) {
  const { fighters, rng } = makeWorld();
  const byClass = new Map(CLASSES.map(c => [c, fighters.filter(f => f.wc === c)]));
  const nowMs = Date.parse(now);
  const events = [];
  // Weekly events from Jan 2023, plus the next Saturday's card.
  let t = Date.UTC(2023, 0, 7);
  let fid = 0x100000, eid = 0;
  while (t < nowMs + 8 * 864e5) {
    const date = new Date(t).toISOString().slice(0, 10);
    const done = t + 30 * 3600e3 < nowMs;
    const used = new Set();
    const bouts = [];
    for (let k = 0; k < 12; k++) {
      const wc = CLASSES[Math.floor(rng.uniform() * CLASSES.length)];
      const pool = byClass.get(wc).filter(f => !used.has(f.id));
      // Matchmaking: neighbours on skill, like real cards.
      const sorted = [...pool].sort((x, y) => x.skill - y.skill);
      const i = Math.floor(rng.uniform() * (sorted.length - 1));
      const j = Math.min(sorted.length - 1, i + 1 + Math.floor(rng.uniform() * 8));
      const a = sorted[i], b = sorted[j];
      used.add(a.id); used.add(b.id);
      const title = k === 0 && eid % 4 === 0;
      const rounds = k === 0 ? 5 : 3;
      bouts.push({ fightId: hex(fid++), a, b, wc, title, rounds, res: done ? fight(a, b, rounds, rng) : null });
    }
    events.push({ id: hex(0xe000 + eid), name: `UFC Fight Night ${eid + 1}: ${bouts[0].a.name.split(' ')[1]} vs. ${bouts[0].b.name.split(' ')[1]} (synthetic)`, date, location: 'Las Vegas, Nevada, USA', bouts, done });
    eid++; t += 7 * 864e5;
  }
  const upcoming = events.filter(e => !e.done);
  const byId = new Map(events.map(e => [e.id, e]));
  const fById = new Map(fighters.map(f => [f.id, f]));
  const real = global.fetch;
  const files = datasetCsvs(events, fighters);
  const byEspn = new Map(fighters.map(f => [espnId(f), f]));
  const bySeg = new Map();
  for (const e of events) e.bouts.forEach((bt, i) => bySeg.set(compId(e, i), i < 5 ? 'Main Card' : 'Prelims'));
  const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const notFound = { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  global.fetch = async url => {
    const u = String(url);
    let m;
    if ((m = u.match(/scrape_ufc_stats\/main\/(\w+\.csv)/))) return files[m[1]] ? ok(files[m[1]]) : notFound;
    if ((m = u.match(/\/sports\/mma\/ufc\/scoreboard\?dates=(\d{8})(?:-(\d{8}))?/))) {
      const d = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
      const from = d(m[1]), to = d(m[2] || m[1]);
      return ok({ events: events.filter(e => e.date >= from && e.date <= to).map(e => espnEvent(e, { live })) });
    }
    if ((m = u.match(/leagues\/ufc\/events\/\d+\/competitions\/(\d+)$/))) return bySeg.has(m[1]) ? ok({ id: m[1], cardSegment: { description: bySeg.get(m[1]) } }) : notFound;
    if ((m = u.match(/mma\/athletes\/(\d+)$/))) {
      const f = byEspn.get(m[1]);
      if (!f) return notFound;
      const [y, mo, da] = f.dob.split('-').map(Number);
      return ok({ athlete: { id: m[1], displayName: f.name, displayHeight: `${Math.floor(heightOf(f) / 12)}' ${heightOf(f) % 12}"`, displayReach: `${f.reach}"`, displayDOB: `${da}/${mo}/${y}`, stance: { text: f.stance }, weightClass: { text: f.wc }, gender: f.women ? 'FEMALE' : 'MALE' } });
    }
    return notFound;
  };
  return { restore: () => { global.fetch = real; }, fighters, events, upcoming: upcoming[0], espnId, espnEventId, NO_TOTT };
}

module.exports = { installMockFetch, makeWorld, fight, CLASSES };
