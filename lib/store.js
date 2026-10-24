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
    snapshots: db.hasDb ? 'database' : 'off (set DATABASE_URL to keep and grade pre-fight snapshots)',
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

module.exports = { FIRST_YEAR, loadHistory, dataStatus, saveSnapshot, loadDataset };
