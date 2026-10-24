// lib/db.js — shared Postgres access (Supabase-compatible). Optional: with no DATABASE_URL the
// app runs fully (history comes from the public dataset); the database only keeps pre-fight
// snapshots so the Accuracy tab can grade them after the card.
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
