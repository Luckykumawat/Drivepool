import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export async function openDatabase(url) {
  if (url) {
    const { Pool } = await import('pg');
    let connectionString;
    try {
      connectionString = new URL(url);
    } catch {
      throw new Error('DATABASE_URL must be a valid Postgres connection URL.');
    }
    // Set TLS in the driver so URL parameters cannot override certificate verification.
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'ssl']) {
      connectionString.searchParams.delete(key);
    }
    const pool = new Pool({
      connectionString: connectionString.toString(),
      ssl: {
        rejectUnauthorized: true,
        ...(process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT } : {})
      },
      max: 4,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 10000
    });
    pool.on('error', () => console.error('An idle Postgres connection closed unexpectedly.'));
    try {
      await pool.query(readFileSync(new URL('./postgres.sql', import.meta.url), 'utf8'));
    } catch {
      await pool.end();
      throw new Error('Postgres initialization failed. Check DATABASE_URL, TLS and schema permissions.');
    }

    return async (sql, ...parameters) => {
      let index = 0;
      const query = sql.replaceAll('@', 'drivepool.').replaceAll('rowid', 'position')
        .replaceAll('?', () => '$' + ++index);
      return (await pool.query(query, parameters)).rows;
    };
  }

  const { DatabaseSync } = await import('node:sqlite');
  const data = resolve(process.env.DATA_DIR || './data');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const sqlite = new DatabaseSync(resolve(data, 'drivepool.sqlite'));
  sqlite.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT, expiry INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth (state TEXT PRIMARY KEY, session_id TEXT NOT NULL, verifier TEXT NOT NULL, expiry INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS drives (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL,
      token TEXT NOT NULL, UNIQUE(user_id, subject)
    );
  `);
  return (sql, ...parameters) => sqlite.prepare(sql.replaceAll('@', '')).all(...parameters);
}
