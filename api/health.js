// GET /api/health — fetches every source the model depends on and reports what came back, so a
// stale dataset or a changed ESPN feed shows up here first. A check fails on empty data, not
// only on errors: zero events is a failure, never "ok". ?event={espnId} audits one card.
const { fetchAthlete } = require('../lib/espn');
const { dataStatus, loadHistory } = require('../lib/store');
const { listEvents, pickEvent } = require('../lib/card');
const { param, send } = require('./_util');

async function check(name, fn) {
  const t = Date.now();
  try { const detail = await fn(); return { name, ok: true, ms: Date.now() - t, ...detail }; }
  catch (err) { return { name, ok: false, ms: Date.now() - t, error: err.message }; }
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
  const checks = [];
  const need = (cond, msg) => { if (!cond) throw new Error(msg); };
  checks.push(await check('History dataset (GitHub CSVs)', async () => {
    const st = await dataStatus();
    need(st.bouts > 1000, `only ${st.bouts} bouts parsed`);
    need(!st.stale, `latest event is ${st.latestAgeDays} days old (${st.latestEvent?.name || 'none'}); the upstream dataset may have stopped updating`);
    return st;
  }));
  let events = null;
  checks.push(await check('ESPN: schedule', async () => {
    events = await listEvents();
    need(events.upcoming.length + events.completed.length > 0, 'no UFC events in the schedule window');
    return { upcoming: events.upcoming.length, completed: events.completed.length, next: events.upcoming[0] || null, lastCompleted: events.completed[0] || null };
  }));
  let card = null;
  checks.push(await check('ESPN: next card', async () => {
    card = await pickEvent(param(req, 'event'));
    need(card.bouts.length > 0, `${card.name} has no bouts listed`);
    return { event: { id: card.id, name: card.name, date: card.date, state: card.state }, bouts: card.bouts.length, rounds: card.bouts.map(b => b.rounds), weightClasses: card.bouts.filter(b => b.weightClass).length, segments: [...new Set(card.bouts.map(b => b.segment))], main: card.bouts[0]?.names || null };
  }));
  if (card?.bouts.length) {
    checks.push(await check('Card fighters matched to history', async () => {
      const h = await loadHistory({ before: '9999-12-31' });
      const fs = card.bouts.flatMap(b => b.fighters);
      const missing = fs.filter(f => !h.resolve(f.name)).map(f => f.name);
      need(missing.length <= fs.length / 2, `${missing.length} of ${fs.length} fighters not found in the dataset; names may not be matching`);
      return { fighters: fs.length, matched: fs.length - missing.length, debutsOrUnmatched: missing };
    }));
    checks.push(await check('ESPN: fighter bio', async () => {
      const f = card.bouts[0].fighters[0];
      const a = await fetchAthlete(f.id);
      need(a.reachIn || a.heightIn || a.dob, `no height, reach or birth date for ${f.name}`);
      return { athlete: a };
    }));
  }
  // Snapshot storage: fails only when a database is configured but doesn't answer; with none
  // configured it passes and says projections aren't being saved.
  checks.push(await check('Snapshot storage (accuracy tracking)', async () => {
    const st = await require('../lib/store').snapshotStatus();
    if (st.variable && !st.connected) throw new Error(st.note);
    return st;
  }));
  const ok = checks.every(c => c.ok);
  send(res, ok ? 200 : 503, { ok, generatedAt: new Date().toISOString(), checks });
};
