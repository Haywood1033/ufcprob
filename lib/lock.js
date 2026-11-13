// lib/lock.js — write-once locks for a card: the pre-fight projection (every bout's numbers, in
// ufc_snapshots, also what the Accuracy tab grades) and the Best plays lists (ufc_plays).
//
// The rule: what's saved when the first bout starts is what the card shows from then on, for good.
//   before the first bout   draft(): saved on every build, only while the row isn't sealed
//   at/after the first bout seal(): ONE atomic statement — an existing row is sealed with its own
//                           payload (never overwritten); with no row, the candidate is inserted
//                           already sealed (a late lock). Concurrent requests all get the same row.
//   database unreachable    nothing is written; the caller shows its own numbers marked
//                           "unconfirmed". A failed read is never mistaken for "nothing saved".
//
// "Started" is the clock (the card's scheduled start, which is the first prelim) or ESPN showing
// the card live, whichever comes first.

const db = require('./db');

const FIRST_MS = 10000, RETRY_MS = 15000;
const memo = new Map(); // last sealed result this instance saw, if the database blips after the seal

const KINDS = {
  card: {
    table: 'ufc_snapshots',
    insert: '(event_id, name, event_date, payload', values: e => [e.id, e.name, e.date],
    onDraft: 'payload = EXCLUDED.payload, saved_at = NOW(), graded = NULL, graded_at = NULL',
  },
  plays: { table: 'ufc_plays', insert: '(event_id, payload', values: e => [e.id], onDraft: 'payload = EXCLUDED.payload, saved_at = NOW()' },
};

async function run(sql, params) {
  try { return await db.withTimeout(db.query(sql, params), FIRST_MS); }
  catch { return db.withTimeout(db.query(sql, params), RETRY_MS); }
}

function hasStarted(ev, now = Date.now()) {
  if (ev.state && ev.state !== 'pre') return true;
  const t = Date.parse(ev.start || '');
  return Number.isFinite(t) && now >= t;
}

function sqlFor(K, event, payload, sealed) {
  const vals = [...K.values(event), JSON.stringify(payload)];
  const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
  return { cols: `${K.insert}${sealed ? ', locked_at' : ''})`, ph: `${ph}${sealed ? ', NOW()' : ''}`, vals };
}

// Before the first bout. → { state: 'open' } | { state: 'locked', payload } already sealed |
// { state: 'off' } no database | { state: 'error', error }
async function draft(kind, event, payload) {
  const K = KINDS[kind]; if (!K) throw new Error(`unknown lock ${kind}`);
  if (!db.hasDb || !payload) return { state: 'off' };
  try {
    await db.ensureTables();
    const q = sqlFor(K, event, payload, false);
    const r = await run(`INSERT INTO ${K.table} ${q.cols} VALUES (${q.ph}) ON CONFLICT (event_id) DO UPDATE SET ${K.onDraft} WHERE ${K.table}.locked_at IS NULL RETURNING locked_at`, q.vals);
    if (r.rows.length) return { state: 'open', at: new Date().toISOString() };
    const s = await run(`SELECT payload, saved_at, locked_at FROM ${K.table} WHERE event_id = $1`, [event.id]);
    return s.rows[0] ? { state: 'locked', payload: s.rows[0].payload, savedAt: s.rows[0].saved_at, lockedAt: s.rows[0].locked_at } : { state: 'error', error: 'row missing' };
  } catch (err) { return { state: 'error', error: err.message }; }
}

// At or after the first bout. → { state: 'locked' | 'late', payload, savedAt, lockedAt } |
// { state: 'off' } | { state: 'unconfirmed', error } (nothing written) |
// { state: 'none' } nothing was saved and `insert` is off (nothing written).
// `insert: false` is for a card that is already over: a row saved before the first bout is sealed
// and returned as usual, but with no row nothing is created. A projection built after the fights
// isn't a pre-fight projection, so it must never be stored (or graded) as one.
async function seal(kind, event, candidate, { insert = true } = {}) {
  const K = KINDS[kind]; if (!K) throw new Error(`unknown lock ${kind}`);
  if (!db.hasDb) return { state: 'off' };
  const key = `${kind}|${event.id}`;
  try {
    await db.ensureTables();
    let row;
    if (insert) {
      const q = sqlFor(K, event, candidate, true);
      row = (await run(`INSERT INTO ${K.table} ${q.cols} VALUES (${q.ph}) ON CONFLICT (event_id) DO UPDATE SET locked_at = COALESCE(${K.table}.locked_at, NOW()) RETURNING payload, saved_at, locked_at, (xmax = 0) AS inserted`, q.vals)).rows[0];
    } else {
      row = (await run(`UPDATE ${K.table} SET locked_at = COALESCE(locked_at, NOW()) WHERE event_id = $1 RETURNING payload, saved_at, locked_at, FALSE AS inserted`, [event.id])).rows[0];
      if (!row) return { state: 'none' };
    }
    const out = { state: row.inserted ? 'late' : 'locked', payload: row.payload, savedAt: row.saved_at, lockedAt: row.locked_at };
    memo.set(key, { ...out, state: 'locked' });
    return out;
  } catch (err) {
    const m = memo.get(key);
    return m ? { ...m, fromMemo: true } : { state: 'unconfirmed', error: err.message };
  }
}

module.exports = { hasStarted, draft, seal, KINDS };
