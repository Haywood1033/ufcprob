// lib/grading.js — grades each saved pre-fight snapshot (the last projection before the card)
// against the results once the event is synced. Nothing from after the first bout touches a
// snapshot, so the Accuracy tab is an honest out-of-sample record.
//
// Bouts are matched by the pair of fighter ids (UFCStats lists the winner first once a bout is
// over, so the order can flip between the preview and the result).

const db = require('./db');
const clip = p => Math.min(1 - 1e-4, Math.max(1e-4, p));

function gradeOne(payload, results) {
  const key = (x, y) => [x, y].sort().join('|');
  const res = new Map(results.map(r => [key(r.a_id, r.b_id), r]));
  const rows = [];
  for (const b of payload.bouts) {
    const r = res.get(key(b.a.id, b.b.id));
    if (!r || r.result !== 'a') continue;
    const aWon = r.a_id === b.a.id;
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
  const todo = await db.query(`SELECT s.event_id, s.payload FROM ufc_snapshots s JOIN ufc_events e ON e.event_id = s.event_id WHERE e.completed AND s.graded IS NULL`);
  const newly = [];
  for (const row of todo.rows) {
    if (Date.now() > deadline) break;
    const res = await db.query(`SELECT a_id, b_id, result, bucket FROM ufc_bouts WHERE event_id=$1`, [row.event_id]);
    const g = gradeOne(row.payload, res.rows);
    if (!g) continue;
    await db.query(`UPDATE ufc_snapshots SET graded=$2, graded_at=NOW() WHERE event_id=$1`, [row.event_id, JSON.stringify(g)]);
    newly.push(row.event_id);
  }
  return { newlyGraded: newly };
}

async function listGrades() {
  if (!db.hasDb) return { events: [], totals: null, note: 'No database yet: graded snapshots appear here once DATABASE_URL is set and events are synced.' };
  await gradeAll({ deadline: Date.now() + 8000 }).catch(() => {});
  const r = await db.query(`SELECT event_id, name, event_date, graded FROM ufc_snapshots WHERE graded IS NOT NULL ORDER BY event_date DESC LIMIT 60`);
  const events = r.rows.map(x => ({ eventId: x.event_id, name: x.name, date: x.event_date, ...x.graded }));
  const bouts = events.reduce((s, e) => s + e.bouts, 0), right = events.reduce((s, e) => s + e.picksRight, 0);
  return { events, totals: events.length ? { events: events.length, bouts, picksRight: right, accuracy: right / bouts, logLoss: events.reduce((s, e) => s + e.logLoss * e.bouts, 0) / bouts } : null };
}

module.exports = { gradeOne, gradeAll, listGrades };
