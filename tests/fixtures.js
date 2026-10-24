// Synthetic MMA world for tests and layout screenshots: fake fighters and fake cards, served in
// UFCStats' HTML templates and ESPN's scoreboard shape (lib/ufcstats.js, lib/espn.js). Nothing
// here is real data.
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
const p = (...xs) => xs.map(x => `<p class="b-fight-details__table-text">${x ?? ''}</p>`).join('');
const flink = f => `<a class="b-link b-link_style_black" href="http://ufcstats.com/fighter-details/${f.id}">${f.name}</a>`;

function eventHtml(ev) {
  const rowsHtml = ev.bouts.map(bt => {
    const done = !!bt.res;
    const [first, second] = done ? [bt.res.winner, bt.res.loser] : [bt.a, bt.b];
    const sW = done ? bt.res.stW : {}, sL = done ? bt.res.stL : {};
    return `<tr class="b-fight-details__table-row b-fight-details__table-row__hover js-fight-details-click" data-link="http://ufcstats.com/fight-details/${bt.fightId}">
      <td class="b-fight-details__table-col">${done ? '<p class="b-fight-details__table-text"><a class="b-flag b-flag_style_green"><i class="b-flag__inner"><i class="b-flag__text">win</i></i></a></p>' : ''}</td>
      <td class="b-fight-details__table-col l-page_align_left">${p(flink(first), flink(second))}</td>
      <td class="b-fight-details__table-col">${done ? p(sW.kd, sL.kd) : ''}</td>
      <td class="b-fight-details__table-col">${done ? p(sW.sig, sL.sig) : ''}</td>
      <td class="b-fight-details__table-col">${done ? p(sW.td, sL.td) : ''}</td>
      <td class="b-fight-details__table-col">${done ? p(sW.sub, sL.sub) : ''}</td>
      <td class="b-fight-details__table-col l-page_align_left">${p(bt.wc + (bt.title ? ' <img src="http://1e49bc5171d173577ecd-1323f4090557a33db01577564f60846c.r80.cf1.rackcdn.com/belt.png">' : ''))}</td>
      <td class="b-fight-details__table-col l-page_align_left">${done ? p(bt.res.method, bt.res.detail) : p('')}</td>
      <td class="b-fight-details__table-col">${done ? p(bt.res.round) : p('')}</td>
      <td class="b-fight-details__table-col">${done ? p(clockTxt(bt.res.time)) : p('')}</td></tr>`;
  }).join('\n');
  const d = new Date(`${ev.date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `<html><body><h2 class="b-content__title"><span class="b-content__title-highlight">${ev.name}</span></h2>
    <ul class="b-list__box-list"><li class="b-list__box-list-item"><i class="b-list__box-item-title">Date:</i> ${d} </li><li class="b-list__box-list-item"><i class="b-list__box-item-title">Location:</i> ${ev.location} </li></ul>
    <table class="b-fight-details__table"><thead><tr class="b-fight-details__table-row_type_head"><th>W/L</th></tr></thead><tbody>${rowsHtml}</tbody></table></body></html>`;
}

function listHtml(events) {
  return `<table class="b-statistics__table-events"><tbody>${events.map(e => `<tr class="b-statistics__table-row"><td class="b-statistics__table-col"><i class="b-statistics__table-content"><a href="http://ufcstats.com/event-details/${e.id}" class="b-link b-link_style_black">${e.name}</a><span class="b-statistics__date">${new Date(`${e.date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</span></i></td><td class="b-statistics__table-col b-statistics__table-col_style_big-top-padding">${e.location}</td></tr>`).join('')}</tbody></table>`;
}

function fighterHtml(f) {
  const ht = 66 + (f.reach - 66) * 0.6;
  const dob = new Date(`${f.dob}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC' });
  return `<span class="b-content__title-highlight">${f.name}</span><span class="b-content__title-record">Record: 15-4-0</span>
    <ul><li class="b-list__box-list-item b-list__box-list-item_type_block"><i class="b-list__box-item-title b-list__box-item-title_type_width">Height:</i> ${Math.floor(ht / 12)}' ${Math.round(ht % 12)}" </li>
    <li class="b-list__box-list-item"><i class="b-list__box-item-title">Reach:</i> ${f.reach}" </li>
    <li class="b-list__box-list-item"><i class="b-list__box-item-title">STANCE:</i> ${f.stance} </li>
    <li class="b-list__box-list-item"><i class="b-list__box-item-title">DOB:</i> ${dob} </li></ul>`;
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
  const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  global.fetch = async url => {
    const u = String(url);
    let m;
    if (u.includes('/statistics/events/completed')) return ok(listHtml(events.filter(e => e.done).reverse()));
    if (u.includes('/statistics/events/upcoming')) return ok(listHtml(upcoming));
    if ((m = u.match(/event-details\/([0-9a-f]+)/))) { const e = byId.get(m[1]); return e ? ok(eventHtml(e)) : { ok: false, status: 404, text: async () => '' }; }
    if ((m = u.match(/fighter-details\/([0-9a-f]+)/))) { const f = fById.get(m[1]); return f ? ok(fighterHtml(f)) : { ok: false, status: 404, text: async () => '' }; }
    if (u.includes('/sports/mma/ufc/scoreboard')) {
      const e = upcoming[0];
      if (!e) return ok({ events: [] });
      return ok({ events: [{ id: '600' + e.id.slice(-4), name: e.name, date: `${e.date}T23:00Z`, status: { type: { state: live ? 'in' : 'pre' } },
        competitions: e.bouts.map((bt, i) => ({ date: `${e.date}T23:00Z`, cardSegment: { description: i < 5 ? 'Main Card' : 'Prelims' }, format: { regulation: { periods: bt.rounds } },
          status: { period: live && i === 11 ? 2 : 0, displayClock: '2:14', type: { state: live && i >= 10 ? (i === 11 ? 'in' : 'post') : 'pre', detail: live && i === 11 ? 'R2 2:14' : 'Scheduled' } },
          competitors: [{ athlete: { displayName: bt.a.name }, winner: live && i === 10 }, { athlete: { displayName: bt.b.name }, winner: false }] })) }] });
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  return { restore: () => { global.fetch = real; }, fighters, events, upcoming: upcoming[0] };
}

module.exports = { installMockFetch, makeWorld, fight, CLASSES };
