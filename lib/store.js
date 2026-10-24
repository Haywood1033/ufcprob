// lib/store.js — fight history, the model's backbone: one row per completed UFC bout with the
// result, method, end time and each fighter's totals, plus fighter physicals (reach, height,
// stance, date of birth). With DATABASE_URL it persists (backfilled by /api/sync); without it the
// most recent events are fetched live so the app still works on a shorter history.

const db = require('./db');
const { fetchEvents, fetchEvent, fetchFighter } = require('./ufcstats');
const { mapLimit } = require('./http');

const FIRST_YEAR = 2014;     // modern stats era; deeper history adds little and costs requests
const MEMORY_EVENTS = Number(process.env.UFC_MEMORY_EVENTS || 70);
const HOUR = 3600 * 1000;

// Event → completed bout rows (no contests and draws kept; the model skips them for ratings).
function boutRows(ev) {
  return ev.bouts.filter(b => b.completed && b.fightId).map(b => ({
    fightId: b.fightId, eventId: ev.id, date: ev.date, order: b.order,
    a: b.a, b: b.b, weightClass: b.weightClass, title: b.title, women: b.women, rounds: b.rounds,
    result: b.result, method: b.method, methodDetail: b.methodDetail, bucket: b.bucket,
    endRound: b.round, endTime: b.time, stats: b.stats,
  }));
}

async function saveEvent(ev, rows) {
  await db.ensureTables();
  await db.query(
    `INSERT INTO ufc_events (event_id, name, event_date, location, completed, synced_at) VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (event_id) DO UPDATE SET completed=EXCLUDED.completed, synced_at=NOW()`,
    [ev.id, ev.name, ev.date, ev.location, rows.length > 0]);
  for (const r of rows) {
    const s = r.stats || { a: {}, b: {} };
    await db.query(
      `INSERT INTO ufc_bouts (fight_id, event_id, bout_order, a_id, a_name, b_id, b_name, weight_class, title, women, rounds, result, method, method_detail, bucket, end_round, end_time,
         a_kd, a_sig, a_td, a_sub, b_kd, b_sig, b_td, b_sub)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       ON CONFLICT (fight_id) DO UPDATE SET result=EXCLUDED.result, method=EXCLUDED.method, bucket=EXCLUDED.bucket, end_round=EXCLUDED.end_round, end_time=EXCLUDED.end_time`,
      [r.fightId, r.eventId, r.order, r.a.id, r.a.name, r.b.id, r.b.name, r.weightClass, r.title, r.women, r.rounds, r.result, r.method, r.methodDetail, r.bucket, r.endRound, r.endTime,
        s.a.kd, s.a.sig, s.a.td, s.a.sub, s.b.kd, s.b.sig, s.b.td, s.b.sub]);
  }
}

// Completed events the DB doesn't have yet, newest first back to FIRST_YEAR; then fighter
// pages for fighters with no physicals. Each call stops before the serverless deadline and
// reports what's left.
async function sync({ maxEvents = 25, maxFighters = 60, deadline = Date.now() + 45000 } = {}) {
  await db.ensureTables();
  const all = (await fetchEvents('completed')).filter(e => e.date >= `${FIRST_YEAR}-01-01` && Date.parse(e.date) + 30 * HOUR < Date.now());
  const have = new Set((await db.query(`SELECT event_id FROM ufc_events WHERE completed`)).rows.map(r => r.event_id));
  const todo = all.filter(e => !have.has(e.id));
  const synced = [], failed = [];
  for (const e of todo.slice(0, maxEvents)) {
    if (Date.now() > deadline - 12000) break;
    try { const ev = await fetchEvent(e.id); const rows = boutRows(ev); await saveEvent(ev, rows); synced.push({ id: e.id, name: e.name, bouts: rows.length }); }
    catch (err) { failed.push({ id: e.id, name: e.name, error: err.message }); }
  }
  // Fighter physicals, for fighters seen in bouts without a row.
  const missing = (await db.query(
    `SELECT DISTINCT id FROM (SELECT a_id AS id FROM ufc_bouts UNION SELECT b_id FROM ufc_bouts) x WHERE id IS NOT NULL AND id NOT IN (SELECT fighter_id FROM ufc_fighters) LIMIT $1`, [maxFighters])).rows.map(r => r.id);
  let fighters = 0;
  await mapLimit(missing, 4, async id => {
    if (Date.now() > deadline) return;
    try { await saveFighter(await fetchFighter(id)); fighters++; } catch { /* retried next call */ }
  });
  const fightersLeft = Number((await db.query(`SELECT COUNT(*) FROM (SELECT a_id AS id FROM ufc_bouts UNION SELECT b_id FROM ufc_bouts) x WHERE id IS NOT NULL AND id NOT IN (SELECT fighter_id FROM ufc_fighters)`)).rows[0].count);
  return { eventsListed: all.length, alreadyStored: have.size, synced, failed, remaining: Math.max(0, todo.length - synced.length - failed.length), fightersAdded: fighters, fightersRemaining: fightersLeft };
}

async function saveFighter(f) {
  await db.query(
    `INSERT INTO ufc_fighters (fighter_id, name, height_in, reach_in, stance, dob, synced_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (fighter_id) DO UPDATE SET height_in=EXCLUDED.height_in, reach_in=EXCLUDED.reach_in, stance=EXCLUDED.stance, dob=EXCLUDED.dob, synced_at=NOW()`,
    [f.id, f.name, f.heightIn, f.reachIn, f.stance, f.dob]);
}

const day = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
function rowFromDb(r) {
  return {
    fightId: r.fight_id, eventId: r.event_id, date: day(r.event_date), order: r.bout_order,
    a: { id: r.a_id, name: r.a_name }, b: { id: r.b_id, name: r.b_name }, weightClass: r.weight_class, title: r.title, women: r.women, rounds: r.rounds,
    result: r.result, method: r.method, methodDetail: r.method_detail, bucket: r.bucket, endRound: r.end_round, endTime: r.end_time,
    stats: r.a_sig === null ? null : { a: { kd: r.a_kd, sig: r.a_sig, td: r.a_td, sub: r.a_sub }, b: { kd: r.b_kd, sig: r.b_sig, td: r.b_td, sub: r.b_sub } },
  };
}

let memory = null;
async function loadFromSite() {
  const events = (await fetchEvents('completed')).filter(e => Date.parse(e.date) + 30 * HOUR < Date.now()).slice(0, MEMORY_EVENTS);
  const evs = await mapLimit(events, 6, e => fetchEvent(e.id).catch(() => null));
  return evs.filter(Boolean).flatMap(boutRows);
}

// Every completed bout strictly before `before` (a date) — what keeps a backtest leak-free.
async function loadHistory({ before = new Date().toISOString().slice(0, 10) } = {}) {
  if (db.hasDb) {
    await db.ensureTables();
    const res = await db.query(`SELECT b.*, e.event_date FROM ufc_bouts b JOIN ufc_events e ON e.event_id = b.event_id WHERE e.event_date < $1 ORDER BY e.event_date, b.bout_order DESC`, [before]);
    const fx = await db.query(`SELECT * FROM ufc_fighters`);
    return { bouts: res.rows.map(rowFromDb), fighters: new Map(fx.rows.map(f => [f.fighter_id, { heightIn: f.height_in, reachIn: f.reach_in, stance: f.stance, dob: f.dob ? day(f.dob) : null }])), source: 'database' };
  }
  if (!memory || Date.now() - memory.at > 6 * HOUR) memory = { at: Date.now(), bouts: await loadFromSite() };
  return { bouts: memory.bouts.filter(b => b.date < before).sort((x, y) => x.date.localeCompare(y.date) || y.order - x.order), fighters: new Map(), source: 'live-site' };
}

async function dataStatus() {
  if (!db.hasDb) return { source: 'live-site', note: `No DATABASE_URL set — history is the last ${MEMORY_EVENTS} events fetched live. Add a database and run /api/sync for the full history since ${FIRST_YEAR}.` };
  await db.ensureTables();
  const t = await db.query(`SELECT COUNT(*)::int AS events, MIN(event_date) AS first, MAX(event_date) AS last FROM ufc_events WHERE completed`);
  const b = await db.query(`SELECT COUNT(*)::int AS bouts FROM ufc_bouts`);
  const f = await db.query(`SELECT COUNT(*)::int AS fighters, SUM(CASE WHEN dob IS NOT NULL THEN 1 ELSE 0 END)::int AS with_dob FROM ufc_fighters`);
  return { source: 'database', ...t.rows[0], ...b.rows[0], ...f.rows[0] };
}

async function saveSnapshot(event, payload) {
  if (!db.hasDb) return false;
  await db.ensureTables();
  const res = await db.query(
    `INSERT INTO ufc_snapshots (event_id, name, event_date, payload) VALUES ($1,$2,$3,$4)
     ON CONFLICT (event_id) DO UPDATE SET payload = EXCLUDED.payload, saved_at = NOW(), graded = NULL, graded_at = NULL`,
    [event.id, event.name, event.date, JSON.stringify(payload)]);
  return res.rowCount > 0;
}

module.exports = { FIRST_YEAR, boutRows, sync, loadHistory, dataStatus, saveSnapshot, saveFighter };
