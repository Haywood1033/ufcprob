// GET /api/health — fetches every source the model depends on and reports what came back, so a
// changed UFCStats template or ESPN feed shows up here first. ?event={id} audits one event.
const ufc = require('../lib/ufcstats');
const { fetchCard } = require('../lib/espn');
const { dataStatus } = require('../lib/store');
const { param, send } = require('./_util');

async function check(name, fn) {
  const t = Date.now();
  try { const detail = await fn(); return { name, ok: true, ms: Date.now() - t, ...detail }; }
  catch (err) { return { name, ok: false, ms: Date.now() - t, error: err.message }; }
}

// What the site actually sent back (status, final URL, size, title, how many event links), so a
// block page, a redirect or a template change is visible without guessing.
async function rawProbe(url) {
  const r = await fetch(url, { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; ufcprob)' }, redirect: 'follow' });
  const body = await r.text();
  return {
    url, status: r.status, finalUrl: r.url, bytes: body.length,
    title: (body.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]?.trim().slice(0, 120) || null,
    eventLinks: (body.match(/event-details\//g) || []).length,
    tableRows: (body.match(/b-statistics__table-row/g) || []).length,
    looksBlocked: /cloudflare|captcha|access denied|attention required|just a moment/i.test(body),
    start: body.replace(/\s+/g, ' ').slice(0, 300),
  };
}

// ?probe=1: what the candidate replacement sources return (shapes and samples), to build the
// ESPN / CSV parsers against real responses instead of guesses.
const clip = (v, n = 1500) => { const t = JSON.stringify(v); return t && t.length > n ? `${t.slice(0, n)}…` : v; };
const keys = o => (o && typeof o === 'object' ? Object.keys(o) : null);
async function getJson(u) { const r = await fetch(u, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; ufcprob)' } }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, bytes: t.length, json: j, text: j ? null : t.slice(0, 300) }; }
async function probe() {
  const out = [];
  const sb = await getJson('https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=20250101-20251231&limit=500');
  const ev = sb.json?.events || [];
  const done = ev.filter(e => e.status?.type?.completed || e.competitions?.[0]?.status?.type?.completed);
  const e0 = done.at(-1) || ev[0], c0 = e0?.competitions?.[0];
  out.push({ name: 'ESPN scoreboard 2025 range', status: sb.status, events: ev.length, completed: done.length, eventKeys: keys(e0), competitionKeys: keys(c0), status0: clip(c0?.status, 600), competitor0: clip(c0?.competitors?.[0], 900), details0: clip(c0?.details, 600), notes0: clip(c0?.notes, 300), format0: clip(c0?.format, 200), eventId: e0?.id, competitionId: c0?.id });
  const cal = await getJson('https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard');
  out.push({ name: 'ESPN scoreboard (current)', status: cal.status, leagueKeys: keys(cal.json?.leagues?.[0]), calendarSample: clip(cal.json?.leagues?.[0]?.calendar?.slice?.(0, 3), 600), events: cal.json?.events?.length });
  if (e0 && c0) {
    const ce = await getJson(`https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/${e0.id}/competitions/${c0.id}`);
    out.push({ name: 'ESPN core competition', status: ce.status, keys: keys(ce.json), status_: clip(ce.json?.status, 300), competitors: clip(ce.json?.competitors?.map(x => ({ id: x.id, winner: x.winner, keys: keys(x) })), 600) });
    const cid = ce.json?.competitors?.[0]?.id || c0.competitors?.[0]?.id;
    if (cid) {
      const st = await getJson(`https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/${e0.id}/competitions/${c0.id}/competitors/${cid}/statistics`);
      const cats = st.json?.splits?.categories || [];
      out.push({ name: 'ESPN core competitor statistics', status: st.status, keys: keys(st.json), categories: cats.map(c => ({ name: c.name, stats: (c.stats || []).map(x => `${x.name}=${x.displayValue ?? x.value}`) })) });
      const ath = await getJson(`https://site.web.api.espn.com/apis/common/v3/sports/mma/athletes/${cid}`);
      out.push({ name: 'ESPN athlete', status: ath.status, keys: keys(ath.json?.athlete), sample: clip(ath.json?.athlete && Object.fromEntries(Object.entries(ath.json.athlete).filter(([k, v]) => typeof v !== 'object' || ['position', 'weightClass', 'stance', 'flag'].includes(k))), 1200) });
      const hist = await getJson(`https://site.web.api.espn.com/apis/common/v3/sports/mma/athletes/${cid}/fighthistory`);
      out.push({ name: 'ESPN athlete fight history', status: hist.status, keys: keys(hist.json), sample: clip(hist.json?.events ? Object.values(hist.json.events).slice(0, 1) : hist.json, 900) });
    }
  }
  for (const f of ['ufc_event_details.csv', 'ufc_fight_results.csv', 'ufc_fight_stats.csv', 'ufc_fighter_tott.csv']) {
    const r = await fetch(`https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/main/${f}`);
    const t = await r.text();
    const lines = t.split('\n').filter(Boolean);
    out.push({ name: `GitHub CSV ${f}`, status: r.status, bytes: t.length, lines: lines.length, header: lines[0]?.slice(0, 400), first: lines[1]?.slice(0, 300), last: lines.at(-1)?.slice(0, 300) });
  }
  return out;
}

module.exports = async (req, res) => {
  if (param(req, 'probe')) {
    try { return send(res, 200, { generatedAt: new Date().toISOString(), probe: await probe() }); }
    catch (err) { return send(res, 200, { error: err.message }); }
  }
  let completed = [], upcoming = [];
  const checks = [];
  for (const u of ['http://ufcstats.com/statistics/events/completed', 'https://ufcstats.com/statistics/events/completed', 'http://www.ufcstats.com/statistics/events/completed']) {
    checks.push(await check(`Raw fetch ${u}`, () => rawProbe(u)));
  }
  checks.push(await check('UFCStats: completed events', async () => { completed = await ufc.fetchEvents('completed'); return { events: completed.length, latest: completed[0] || null }; }));
  checks.push(await check('UFCStats: upcoming events', async () => { upcoming = await ufc.fetchEvents('upcoming'); return { events: upcoming.length, next: upcoming.sort((a, b) => a.date.localeCompare(b.date))[0] || null }; }));
  if (completed[0]) checks.push(await check(`UFCStats: last event (${completed[0].name})`, async () => {
    const ev = await ufc.fetchEvent(completed[0].id);
    return { bouts: ev.bouts.length, completed: ev.bouts.filter(b => b.completed).length, withStats: ev.bouts.filter(b => b.stats?.a?.sig !== null && b.stats?.a?.sig !== undefined).length, methods: [...new Set(ev.bouts.map(b => b.bucket))], sample: ev.bouts[0] || null };
  }));
  if (upcoming[0]) {
    checks.push(await check(`UFCStats: next card (${upcoming[0].name})`, async () => { const ev = await ufc.fetchEvent(upcoming[0].id); return { bouts: ev.bouts.length, main: ev.bouts[0] ? `${ev.bouts[0].a.name} vs ${ev.bouts[0].b.name}` : null }; }));
    checks.push(await check('UFCStats: fighter page', async () => { const ev = await ufc.fetchEvent(upcoming[0].id); const f = ev.bouts[0] ? await ufc.fetchFighter(ev.bouts[0].a.id) : null; return { fighter: f }; }));
    checks.push(await check('ESPN: card for the next event', async () => { const c = await fetchCard(upcoming[0].date); return { events: c.length, bouts: c[0]?.bouts.length || 0, segments: [...new Set((c[0]?.bouts || []).map(b => b.segment))], sample: c[0]?.bouts[0] || null }; }));
  }
  checks.push(await check('History store', async () => dataStatus()));
  let audit = null;
  const id = param(req, 'event');
  if (id) audit = await check(`Audit event ${id}`, async () => { const ev = await ufc.fetchEvent(id); return { name: ev.name, date: ev.date, bouts: ev.bouts }; });
  send(res, 200, { ok: checks.every(c => c.ok), generatedAt: new Date().toISOString(), checks, audit });
};
