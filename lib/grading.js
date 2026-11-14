// lib/grading.js — grades each saved pre-fight snapshot (the last projection before the card)
// against the results once they reach the history dataset. Nothing from after the first bout
// touches a snapshot, so the Accuracy tab is an honest out-of-sample record. A snapshot that was
// only locked late (first saved after the card began, marked `lockedLate`) is left out: it is
// never graded and never listed.
//
// Bouts are matched by the pair of fighter ids, or by the pair of names for a fighter who was a
// debutant at snapshot time (the dataset lists the winner first, so order can flip).

const db = require('./db');
const { loadDataset } = require('./dataset');
const { normName } = require('./names');
const lean = require('./lean');
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
    rows.push({ p, picked: p >= 0.5, method: m, went: r.bucket === 'DEC' ? 1 : 0, dist: b.distance, finished: ['KO', 'SUB', 'DEC'].includes(r.bucket), book: b.market?.pA ? (aWon ? b.market.pA : 1 - b.market.pA) : null });
  }
  if (rows.length < 3) return null;
  const mean = f => rows.reduce((s, x) => s + f(x), 0) / rows.length;
  return {
    bouts: rows.length, picksRight: rows.filter(x => x.picked).length,
    logLoss: +(-mean(x => Math.log(clip(x.p)))).toFixed(4), brier: +mean(x => (1 - x.p) ** 2).toFixed(4),
    methodLogLoss: +(-rows.filter(x => x.method !== null).reduce((s, x) => s + Math.log(clip(x.method)), 0) / Math.max(1, rows.filter(x => x.method !== null).length)).toFixed(4),
    distanceBrier: +mean(x => (x.dist - x.went) ** 2).toFixed(4),
    // The sportsbook's own score on the bouts it priced, and the model's on those same bouts.
    ...(bk => (bk.length ? { bookBouts: bk.length, bookLogLoss: +(-bk.reduce((s, x) => s + Math.log(clip(x.book)), 0) / bk.length).toFixed(4), modelLogLossVsBook: +(-bk.reduce((s, x) => s + Math.log(clip(x.p)), 0) / bk.length).toFixed(4), bookPicksRight: bk.filter(x => x.book >= 0.5).length } : {}))(rows.filter(x => x.book !== null)),
    // How each lean tier did on this card: { win: [{ tier, n, hit }], pace: [...] }.
    leans: (s => ({ win: s.win.map(({ tier, n, hit }) => ({ tier, n, hit })), pace: s.pace.map(({ tier, n, hit }) => ({ tier, n, hit })) }))(lean.summarize(rows.filter(x => x.finished).map(x => ({ fav: Math.max(x.p, 1 - x.p), favWon: x.picked, dist: x.dist, went: !!x.went })))),
  };
}

async function gradeAll({ deadline = Date.now() + 20000 } = {}) {
  if (!db.hasDb) return { newlyGraded: [] };
  await db.ensureTables();
  const todo = await db.query(`SELECT event_id, event_date, payload FROM ufc_snapshots WHERE graded IS NULL AND payload->>'lockedLate' IS NULL AND event_date < NOW() - INTERVAL '1 day'`);
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

// The graded record is read straight from the database (with a retry for a cold connection) and is
// never hidden by the storage status line: a slow status check can only add a warning, not blank the
// record. New results are graded first only within a short budget, so the page isn't held up.
async function listGrades() {
  const store = require('./store');
  if (!db.hasDb) { const storage = await store.snapshotStatus(); return { events: [], totals: null, storage, note: storage.note }; }
  await gradeAll({ deadline: Date.now() + 4000 }).catch(() => {});
  const q = ms => db.withTimeout(db.query(`SELECT event_id, name, event_date, graded FROM ufc_snapshots WHERE graded IS NOT NULL AND payload->>'lockedLate' IS NULL ORDER BY event_date DESC LIMIT 60`), ms);
  const [r, storage] = await Promise.all([q(10000).catch(() => q(15000)).catch(err => ({ error: err.message })), store.snapshotStatus()]);
  if (r.error) return { events: [], totals: null, storage: { ...storage, connected: false, variable: db.dbVar, error: r.error }, note: r.error };
  const events = r.rows.map(x => ({ eventId: x.event_id, name: x.name, date: x.event_date, ...x.graded }));
  const bouts = events.reduce((s, e) => s + e.bouts, 0), right = events.reduce((s, e) => s + e.picksRight, 0);
  // Lean tiers across every graded card that has them (cards graded before leans existed don't).
  const leans = { win: lean.WIN.map(([tier, label]) => ({ tier, label, n: 0, hit: 0 })), pace: lean.PACE.map(([tier, label]) => ({ tier, label, n: 0, hit: 0 })) };
  for (const e of events) for (const k of ['win', 'pace']) for (const t of e.leans?.[k] || []) { const row = leans[k].find(x => x.tier === t.tier); if (row) { row.n += t.n; row.hit += t.hit; } }
  return { storage, events, leans, totals: events.length ? { events: events.length, bouts, picksRight: right, accuracy: right / bouts, logLoss: events.reduce((s, e) => s + e.logLoss * e.bouts, 0) / bouts } : null };
}

module.exports = { gradeOne, gradeAll, listGrades };
