// lib/store.js — fight history, the model's backbone: one row per completed UFC bout with the
// result, method, end time and each fighter's totals (including control time), plus fighter
// physicals (reach, height, stance, date of birth). It comes from the public scrape_ufc_stats
// dataset (lib/dataset), so there's nothing to backfill; the optional database only keeps the
// pre-fight snapshots that the Accuracy tab grades.

const db = require('./db');
const { loadDataset, FIRST_YEAR, REPO } = require('./dataset');

// Every completed bout strictly before `before` (a date) — what keeps a backtest leak-free.
async function loadHistory({ before = new Date(Date.now()).toISOString().slice(0, 10) } = {}) {
  const ds = await loadDataset();
  return {
    bouts: ds.bouts.filter(b => b.date < before), fighters: ds.fighters, events: ds.events,
    resolve: ds.resolve, last: ds.last, source: 'dataset', loadedAt: ds.loadedAt,
  };
}

async function dataStatus() {
  const ds = await loadDataset();
  const latest = ds.events[0] || null;
  const ageDays = latest ? Math.round((Date.now() - Date.parse(latest.date)) / 864e5) : null;
  return {
    source: 'dataset', repo: REPO, since: `${FIRST_YEAR}-01-01`, loadedAt: ds.loadedAt,
    events: new Set(ds.bouts.map(b => b.eventId)).size, bouts: ds.bouts.length, fighters: ds.fighters.size,
    withReach: [...ds.fighters.values()].filter(f => f.reachIn).length, withDob: [...ds.fighters.values()].filter(f => f.dob).length,
    first: ds.bouts[0]?.date || null, last: ds.bouts.at(-1)?.date || null, latestEvent: latest, latestAgeDays: ageDays,
    stale: ageDays === null || ageDays > 24,
    snapshots: await snapshotStatus(),
  };
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

// Save and report: { saved, at } or { saved: false, reason } — never throws, never hangs.
async function saveSnapshotSafely(event, payload) {
  if (!db.hasDb) return { saved: false, reason: `no database connected (set ${db.DB_VARS[0]})` };
  try { await db.withTimeout(saveSnapshot(event, payload), 8000); return { saved: true, at: new Date().toISOString() }; }
  catch (err) { console.error('snapshot save failed', err); return { saved: false, reason: err.message }; }
}

// What the Accuracy tab shows about storage: connected or not, and the latest saved projection.
async function snapshotStatus() {
  if (!db.hasDb) return { connected: false, note: `No database connected, so pre-fight projections aren't being saved. Set ${db.DB_VARS[0]} (or ${db.DB_VARS[1]}) to a Postgres connection string.` };
  try {
    await db.ensureTables();
    const r = await db.withTimeout(db.query(`SELECT COUNT(*)::int AS saved, COUNT(graded)::int AS graded FROM ufc_snapshots`), 8000);
    const last = await db.query(`SELECT name, saved_at FROM ufc_snapshots ORDER BY saved_at DESC LIMIT 1`);
    return { connected: true, variable: db.dbVar, saved: r.rows[0].saved, graded: r.rows[0].graded, last: last.rows[0] ? { name: last.rows[0].name, savedAt: last.rows[0].saved_at } : null };
  } catch (err) { return { connected: false, variable: db.dbVar, error: err.message, note: `${db.dbVar} is set but the database didn't answer: ${err.message}` }; }
}

module.exports = { FIRST_YEAR, loadHistory, dataStatus, saveSnapshot, saveSnapshotSafely, snapshotStatus, loadDataset };
