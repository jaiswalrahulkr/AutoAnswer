import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

let pool = null;

export function getDb() {
  const url = process.env.DATABASE_URL || '';
  if (!url) return null;
  if (!pool) {
    pool = new Pool({ connectionString: url, max: 10 });
  }
  return pool;
}

export async function ensureTables() {
  const db = getDb();
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      google_sub TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      picture TEXT,
      credits_balance INT NOT NULL DEFAULT 10,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS usage_logs (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      timestamp_ms BIGINT NOT NULL,
      timestamp_iso TEXT NOT NULL,
      timestamp_ist TEXT NOT NULL,
      page_url TEXT,
      action_type TEXT NOT NULL,
      delta INT NOT NULL,
      request_id TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS payments (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT,
      amount INT,
      currency TEXT,
      pack_id TEXT,
      status TEXT,
      provider_ref TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS credit_adjustments (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      delta INT NOT NULL,
      reason TEXT,
      admin_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_ref_idx
      ON payments (provider_ref)
      WHERE provider_ref IS NOT NULL;
  `);
}

export async function withTransaction(fn) {
  const db = getDb();
  if (!db) return await fn(null);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}


