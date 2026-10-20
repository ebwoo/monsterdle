// Small helpers for responses and the D1 database.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Bad request.");
  }
}

export const first = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
export const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
export const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();

// Tables are created automatically the first time the server runs, so there's
// nothing to set up by hand in the database.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    username_lower TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  // One row per puzzle someone plays. Guests' rounds have no user_id and are cleaned up after a few days.
  `CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    mode TEXT NOT NULL,
    play_type TEXT NOT NULL,
    day TEXT,
    answer TEXT NOT NULL,
    seed REAL NOT NULL,
    guesses TEXT NOT NULL DEFAULT '[]',
    done INTEGER NOT NULL DEFAULT 0,
    won INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS rounds_one_daily ON rounds(user_id, mode, day)
    WHERE user_id IS NOT NULL AND play_type = 'daily'`,
  `CREATE INDEX IF NOT EXISTS rounds_by_user ON rounds(user_id, done, finished_at)`,
  `CREATE TABLE IF NOT EXISTS streaks (
    user_id INTEGER NOT NULL,
    mode TEXT NOT NULL,
    kind TEXT NOT NULL,
    current INTEGER NOT NULL DEFAULT 0,
    best INTEGER NOT NULL DEFAULT 0,
    last_day TEXT,
    PRIMARY KEY (user_id, mode, kind)
  )`,
  `CREATE INDEX IF NOT EXISTS streaks_board ON streaks(mode, kind, best)`,
  `CREATE TABLE IF NOT EXISTS login_failures (username_lower TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS login_failures_by_name ON login_failures(username_lower, at)`,
];

let schemaReady = null;

export function ensureSchema(env) {
  schemaReady ??= env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

// Clears out old guest rounds, expired logins and old failed-login records.
export async function prune(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rounds WHERE user_id IS NULL AND created_at < ?").bind(now - 3 * 86400000),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM login_failures WHERE at < ?").bind(now - 86400000),
  ]);
}
