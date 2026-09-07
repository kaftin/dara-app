const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('[dara] FATAL: DATABASE_URL is not set. Point it at your Postgres instance.');
  process.exit(1);
}

// Render's internal database URL (service and DB in the same private network)
// doesn't need SSL. Its external URL does. Set PGSSL=true if you're using the
// external URL (e.g. connecting from outside Render, or from a different host).
const useSSL = process.env.PGSSL === 'true';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_color TEXT DEFAULT '#378ADD',
      rating INTEGER DEFAULT 1000,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      ai_games INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Postgres has no built-in case-insensitive TEXT collation the way SQLite's
  // COLLATE NOCASE does, so uniqueness is enforced on lower(username) instead,
  // and every lookup below queries the same way.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS friend_links (
      id SERIAL PRIMARY KEY,
      requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(requester_id, addressee_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

module.exports = { pool, init };
