// lib/db.js — shared Postgres access (Supabase-compatible). Optional: with no DATABASE_URL the
// app runs fully (history comes from the public dataset); the database only keeps pre-fight
// snapshots so the Accuracy tab can grade them after the card.
// Connection string: DATABASE_URL, or the POSTGRES_URL that Vercel's Supabase (and Neon)
// integrations set. sslmode is stripped from the URL: recent pg versions read sslmode=require as
// full certificate verification, which Supabase's pooler fails; TLS stays on via `ssl` below.
const DB_VARS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING', 'SUPABASE_DB_URL'];
const dbVar = DB_VARS.find(k => process.env[k]) || null;
const hasDb = !!dbVar;
// sslmode=disable is honoured (a local database without TLS); anything else connects over TLS.
const sslOff = () => { try { return new URL(process.env[dbVar]).searchParams.get('sslmode') === 'disable'; } catch { return false; } };
function connectionString() {
  try {
    const u = new URL(process.env[dbVar]);
    ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'supa'].forEach(k => u.searchParams.delete(k));
    return u.toString();
  } catch { return process.env[dbVar]; }
}
let pool = null;

function getPool() {
  if (!hasDb) return null;
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: connectionString(), ssl: sslOff() ? false : { rejectUnauthorized: false }, max: 3, connectionTimeoutMillis: 8000 });
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

// Resolves with fn's result, or rejects after ms — so a slow database can't hang a page load.
function withTimeout(promise, ms, what = 'database') {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms); })]).finally(() => clearTimeout(t));
}

module.exports = { hasDb, dbVar, DB_VARS, query, ensureTables, withTimeout };
