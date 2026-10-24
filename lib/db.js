// lib/db.js — shared Postgres access (Supabase-compatible). Optional: with no DATABASE_URL the
// store fetches recent events live from UFCStats, so the app runs before a DB exists.
const hasDb = !!process.env.DATABASE_URL;
let pool = null;

function getPool() {
  if (!hasDb) return null;
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
  }
  return pool;
}

async function query(text, params) {
  const client = await getPool().connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

const ENSURE_SQL = `
  CREATE TABLE IF NOT EXISTS ufc_events (
    event_id    VARCHAR(24) PRIMARY KEY,
    name        TEXT,
    event_date  DATE,
    location    TEXT,
    completed   BOOLEAN DEFAULT FALSE,
    synced_at   TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS ufc_bouts (
    fight_id      VARCHAR(24) PRIMARY KEY,
    event_id      VARCHAR(24) NOT NULL,
    bout_order    SMALLINT,
    a_id          VARCHAR(24), a_name TEXT,
    b_id          VARCHAR(24), b_name TEXT,
    weight_class  TEXT,
    title         BOOLEAN,
    women         BOOLEAN,
    rounds        SMALLINT,
    result        VARCHAR(6),
    method        TEXT, method_detail TEXT, bucket VARCHAR(6),
    end_round     SMALLINT, end_time SMALLINT,
    a_kd SMALLINT, a_sig SMALLINT, a_td SMALLINT, a_sub SMALLINT,
    b_kd SMALLINT, b_sig SMALLINT, b_td SMALLINT, b_sub SMALLINT
  );
  CREATE INDEX IF NOT EXISTS ufc_bouts_event ON ufc_bouts (event_id);
  CREATE TABLE IF NOT EXISTS ufc_fighters (
    fighter_id  VARCHAR(24) PRIMARY KEY,
    name        TEXT,
    height_in   SMALLINT,
    reach_in    SMALLINT,
    stance      TEXT,
    dob         DATE,
    synced_at   TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS ufc_snapshots (
    event_id    VARCHAR(24) PRIMARY KEY,
    name        TEXT,
    event_date  DATE,
    saved_at    TIMESTAMP DEFAULT NOW(),
    payload     JSONB,
    graded      JSONB,
    graded_at   TIMESTAMP
  );
`;

let ensured = false;
async function ensureTables() {
  if (!hasDb || ensured) return;
  await query(ENSURE_SQL);
  ensured = true;
}

module.exports = { hasDb, query, ensureTables };
