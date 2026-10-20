// Accounts: username + password. Passwords are never stored, only a salted
// PBKDF2 hash of them. Logins are random tokens; only their SHA-256 is stored.
import { HttpError, first, run } from "./db.js";

const USERNAME_RULE = /^[A-Za-z0-9_]{3,20}$/;
const PBKDF2_ITERATIONS = 100000; // the most Cloudflare Workers allow
const SESSION_DAYS = 90;
const MAX_FAILURES = 10; // per username, per 15 minutes

const encoder = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
const randomHex = (bytes) => toHex(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256 = async (text) => toHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS }, key, 256);
  return toHex(bits);
}

function sameHash(a, b) {
  const x = fromHex(a), y = fromHex(b);
  if (x.length !== y.length) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

async function createSession(env, user) {
  const token = randomHex(32);
  const now = Date.now();
  await run(env, "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    await sha256(token), user.id, now, now + SESSION_DAYS * 86400000);
  return { token, user: { username: user.username } };
}

function checkPassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw new HttpError(400, "Password must be at least 8 characters.");
  }
  if (password.length > 200) throw new HttpError(400, "That password is too long.");
}

export async function register(env, body) {
  const username = String(body.username || "").trim();
  if (!USERNAME_RULE.test(username)) {
    throw new HttpError(400, "Usernames are 3–20 characters: letters, numbers and _ only.");
  }
  checkPassword(body.password);
  const lower = username.toLowerCase();
  if (await first(env, "SELECT 1 FROM users WHERE username_lower = ?", lower)) {
    throw new HttpError(409, "That username is taken.");
  }
  const salt = randomHex(16);
  const hash = await hashPassword(body.password, salt);
  let result;
  try {
    result = await run(env,
      "INSERT INTO users (username, username_lower, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)",
      username, lower, hash, salt, Date.now());
  } catch (err) {
    // Two people grabbed the same name at the same moment.
    if (String(err).includes("UNIQUE")) throw new HttpError(409, "That username is taken.");
    throw err;
  }
  return createSession(env, { id: result.meta.last_row_id, username });
}

export async function login(env, body) {
  const lower = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");
  const since = Date.now() - 15 * 60000;
  const { n } = await first(env, "SELECT COUNT(*) AS n FROM login_failures WHERE username_lower = ? AND at > ?", lower, since);
  if (n >= MAX_FAILURES) throw new HttpError(429, "Too many wrong passwords. Try again in 15 minutes.");

  const user = await first(env, "SELECT * FROM users WHERE username_lower = ?", lower);
  if (!user || !sameHash(await hashPassword(password, user.password_salt), user.password_hash)) {
    await run(env, "INSERT INTO login_failures (username_lower, at) VALUES (?, ?)", lower, Date.now());
    throw new HttpError(401, "Wrong username or password.");
  }
  await run(env, "DELETE FROM login_failures WHERE username_lower = ?", lower);
  return createSession(env, user);
}

export const tokenFrom = (request) => (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || null;

export async function logout(env, request) {
  const token = tokenFrom(request);
  if (token) await run(env, "DELETE FROM sessions WHERE token_hash = ?", await sha256(token));
}

// The logged-in player for this request, or null for a guest.
export async function currentUser(env, request) {
  const token = tokenFrom(request);
  if (!token) return null;
  return first(env,
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    await sha256(token), Date.now());
}

export async function changePassword(env, user, body) {
  const row = await first(env, "SELECT * FROM users WHERE id = ?", user.id);
  if (!sameHash(await hashPassword(String(body.current || ""), row.password_salt), row.password_hash)) {
    throw new HttpError(401, "Your current password is wrong.");
  }
  checkPassword(body.password);
  const salt = randomHex(16);
  await run(env, "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?",
    await hashPassword(body.password, salt), salt, user.id);
}
