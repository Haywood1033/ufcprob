// lib/grading.js — grades each saved pre-fight snapshot (the last projection before the card)
// against the results once they reach the history dataset. Nothing from after the first bout
// touches a snapshot, so the Accuracy tab is an honest out-of-sample record.
//
// Bouts are matched by the pair of fighter ids, or by the pair of names for a fighter who was a
// debutant at snapshot time (the dataset lists the winner first, so order can flip).

const db = require('./db');
const { loadDataset } = require('./dataset');
const { normName } = require('./names');
const clip = p => Math.min(1 - 1e-4, Math.max(1e-4, p));
const pairKey = (x, y) => [x, y].sort().join('|');
const day = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const shift = (d, days) => new Date(Date.parse(`${d}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

function gradeOne(payload, results) {
  const byId = new Map(results.map(r => [pairKey(r.a.id, r.b.id), r]));
  const byName = new Map(results.map(r => [pairKey(normName(r.a.name), normName(r.b.name)), r]));
  const rows = [];
  for (const b of payload.bouts) {
    const r = byId.get(pairKey(b.a.id, b.b.id)) || byName.get(pairKey(normName(b.a.name), normName(b.b.name)));
    if (!r || r.result !== 'a') continue;
    const aWon = r.a.id === b.a.id || normName(r.a.name) === normName(b.a.name);
    const p = aWon ? b.pA : b.pB;
    const m = r.bucket in (b.methods.A || {}) ? (aWon ? b.methods.A : b.methods.B)[r.bucket] : null;
    rows.push({ p, picked: p >= 0.5, method: m, went: r.bucket === 'DEC' ? 1 : 0, dist: b.distance });
  }
  if (rows.length < 3) return null;
  const mean = f => rows.reduce((s, x) => s + f(x), 0) / rows.length;
  return {
    bouts: rows.length, picksRight: rows.filter(x => x.picked).length,
    logLoss: +(-mean(x => Math.log(clip(x.p)))).toFixed(4), brier: +mean(x => (1 - x.p) ** 2).toFixed(4),
    methodLogLoss: +(-rows.filter(x => x.method !== null).reduce((s, x) => s + Math.log(clip(x.method)), 0) / Math.max(1, rows.filter(x => x.method !== null).length)).toFixed(4),
    distanceBrier: +mean(x => (x.dist - x.went) ** 2).toFixed(4),
  };
}

async function gradeAll({ deadline = Date.now() + 20000 } = {}) {
  if (!db.hasDb) return { newlyGraded: [] };
  await db.ensureTables();
  const todo = await db.query(`SELECT event_id, event_date, payload FROM ufc_snapshots WHERE graded IS NULL AND event_date < NOW() - INTERVAL '1 day'`);
  if (!todo.rows.length) return { newlyGraded: [] };
  const ds = await loadDataset();
  const newly = [];
  for (const row of todo.rows) {
    if (Date.now() > deadline) break;
    const d = day(row.event_date), lo = shift(d, -1), hi = shift(d, 2);
    const g = gradeOne(row.payload, ds.bouts.filter(x => x.date >= lo && x.date <= hi));
    if (!g) continue; // results not in the dataset yet; tried again next time
    await db.query(`UPDATE ufc_snapshots SET graded=$2, graded_at=NOW() WHERE event_id=$1`, [row.event_id, JSON.stringify(g)]);
    newly.push(row.event_id);
  }
  return { newlyGraded: newly };
}

async function listGrades() {
  if (!db.hasDb) return { events: [], totals: null, note: 'No database yet: set DATABASE_URL and each card\'s pre-fight projection is saved, then graded once results reach the dataset.' };
  await gradeAll({ deadline: Date.now() + 8000 }).catch(() => {});
  const r = await db.query(`SELECT event_id, name, event_date, graded FROM ufc_snapshots WHERE graded IS NOT NULL ORDER BY event_date DESC LIMIT 60`);
  const events = r.rows.map(x => ({ eventId: x.event_id, name: x.name, date: x.event_date, ...x.graded }));
  const bouts = events.reduce((s, e) => s + e.bouts, 0), right = events.reduce((s, e) => s + e.picksRight, 0);
  return { events, totals: events.length ? { events: events.length, bouts, picksRight: right, accuracy: right / bouts, logLoss: events.reduce((s, e) => s + e.logLoss * e.bouts, 0) / bouts } : null };
}

module.exports = { gradeOne, gradeAll, listGrades };
