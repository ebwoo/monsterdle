// Runs the puzzles. The server picks each answer and checks every guess, so the
// browser never knows the answer until the round is over.
import { normalizeConfig } from "../lib/config.js";
import { HttpError, first, run } from "./db.js";
import { dailyAnswer, dailySeed, nextResetAt, previousDay, puzzleNumber, todayKey } from "./daily.js";

let cached = null;

// monsters.json, read from the site's own files. Kept for a minute between requests.
export async function loadConfig(env, request) {
  if (cached && Date.now() - cached.at < 60000) return cached.config;
  const res = await env.ASSETS.fetch(new Request(new URL("/monsters.json", request.url)));
  if (!res.ok) throw new Error("Could not load monsters.json");
  const config = normalizeConfig(await res.json());
  config.byName = new Map(config.monsters.map((m) => [m.name, m]));
  cached = { config, at: Date.now() };
  return config;
}

// What the browser is allowed to see about a round.
export function roundView(round) {
  return {
    id: round.id,
    mode: round.mode,
    playType: round.play_type,
    day: round.day,
    puzzleNumber: round.day ? puzzleNumber(round.day) : null,
    seed: round.seed,
    guesses: JSON.parse(round.guesses),
    done: !!round.done,
    won: !!round.won,
    answer: round.done ? round.answer : null,
    nextResetAt: nextResetAt(),
  };
}

async function createRound(env, fields) {
  const round = {
    id: crypto.randomUUID(),
    user_id: fields.userId ?? null,
    mode: fields.mode,
    play_type: fields.playType,
    day: fields.day ?? null,
    answer: fields.answer,
    seed: fields.seed,
    guesses: "[]",
    done: 0,
    won: 0,
    created_at: Date.now(),
    finished_at: null,
  };
  try {
    await run(env,
      `INSERT INTO rounds (id, user_id, mode, play_type, day, answer, seed, guesses, done, won, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 0, 0, ?)`,
      round.id, round.user_id, round.mode, round.play_type, round.day, round.answer, round.seed, round.created_at);
  } catch (err) {
    // The same player started today's daily twice at once: use the one that won the race.
    if (fields.playType === "daily" && fields.userId && String(err).includes("UNIQUE")) {
      return first(env, "SELECT * FROM rounds WHERE user_id = ? AND mode = ? AND play_type = 'daily' AND day = ?",
        fields.userId, fields.mode, fields.day);
    }
    throw err;
  }
  return round;
}

function randomAnswer(config, exclude) {
  const list = config.monsters.length > 1 ? config.monsters.filter((m) => m.name !== exclude) : config.monsters;
  return list[Math.floor(Math.random() * list.length)].name;
}

// Resumes the player's current round for this mode, or starts a new one.
// Guests pass back the round id they were given, since they have no account to look it up by.
export async function startRound(env, config, user, body) {
  const mode = String(body.mode || "");
  if (!config.modes[mode]) throw new HttpError(400, "Unknown mode.");
  const playType = body.playType === "endless" ? "endless" : "daily";
  const guestRoundId = !user && typeof body.roundId === "string" ? body.roundId : null;

  if (playType === "daily") {
    const day = todayKey();
    const existing = user
      ? await first(env, "SELECT * FROM rounds WHERE user_id = ? AND mode = ? AND play_type = 'daily' AND day = ?",
        user.id, mode, day)
      : guestRoundId && await first(env,
        "SELECT * FROM rounds WHERE id = ? AND user_id IS NULL AND mode = ? AND play_type = 'daily' AND day = ?",
        guestRoundId, mode, day);
    return existing || createRound(env, {
      userId: user?.id, mode, playType, day, answer: dailyAnswer(config, mode, day).name, seed: dailySeed(mode, day),
    });
  }

  // Endless: an unfinished round always comes back, so refreshing or switching modes
  // can't be used to dodge a monster you don't know (and protect your streak).
  const latest = user
    ? await first(env, "SELECT * FROM rounds WHERE user_id = ? AND mode = ? AND play_type = 'endless' ORDER BY created_at DESC LIMIT 1",
      user.id, mode)
    : guestRoundId && await first(env,
      "SELECT * FROM rounds WHERE id = ? AND user_id IS NULL AND mode = ? AND play_type = 'endless'", guestRoundId, mode);
  if (latest && !latest.done) return latest;
  return createRound(env, {
    userId: user?.id, mode, playType, answer: randomAnswer(config, latest?.answer), seed: Math.random(),
  });
}

async function loadRound(env, user, id) {
  const round = await first(env, "SELECT * FROM rounds WHERE id = ?", id);
  if (!round) throw new HttpError(404, "That round doesn't exist anymore. Refresh the page.");
  if (round.user_id !== null && round.user_id !== user?.id) {
    throw new HttpError(403, "That round belongs to another player.");
  }
  return round;
}

export async function makeGuess(env, config, user, id, body) {
  const round = await loadRound(env, user, id);
  if (round.done) throw new HttpError(409, "This round is already over.");
  const steps = config.modes[round.mode]?.steps;
  if (!steps) throw new HttpError(400, "Unknown mode.");

  const guesses = JSON.parse(round.guesses);
  let entry;
  if (body.skip) {
    entry = { type: "skip", name: "Skipped" };
  } else {
    const monster = config.byName.get(String(body.guess || ""));
    if (!monster) throw new HttpError(400, "That's not a monster in the list.");
    if (guesses.some((g) => g.name === monster.name)) throw new HttpError(400, "Already guessed.");
    entry = { type: monster.name === round.answer ? "right" : "wrong", name: monster.name };
  }
  guesses.push(entry);
  const won = entry.type === "right";
  const done = won || guesses.length >= steps.length;
  const now = Date.now();

  // Only saves if nothing changed since we read the round, so double-clicks can't sneak in extra guesses.
  const result = await run(env,
    "UPDATE rounds SET guesses = ?, done = ?, won = ?, finished_at = ? WHERE id = ? AND guesses = ? AND done = 0",
    JSON.stringify(guesses), done ? 1 : 0, won ? 1 : 0, done ? now : null, round.id, round.guesses);
  if (!result.meta.changes) throw new HttpError(409, "That guess crossed with another one. Refresh and try again.");

  const updated = { ...round, guesses: JSON.stringify(guesses), done: done ? 1 : 0, won: won ? 1 : 0, finished_at: done ? now : null };
  if (done && updated.user_id) await recordStreak(env, updated);
  return updated;
}

// Sends the round's audio. The address only contains the round's random id,
// so the file name (which is the monster's name) never reaches the browser.
export async function clip(env, config, request, id) {
  const round = await first(env, "SELECT answer FROM rounds WHERE id = ?", id);
  const monster = round && config.byName.get(round.answer);
  if (!monster) throw new HttpError(404, "Clip not found.");
  const path = "/" + monster.audio.split("/").map(encodeURIComponent).join("/");
  const res = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
  if (!res.ok) throw new HttpError(404, "Audio file missing.");
  return new Response(res.body, {
    headers: {
      "content-type": res.headers.get("content-type") || "audio/mpeg",
      "cache-control": "private, max-age=86400",
    },
  });
}

// ---------- streaks ----------

export async function recordStreak(env, round) {
  const kind = round.play_type;
  const row = await first(env, "SELECT * FROM streaks WHERE user_id = ? AND mode = ? AND kind = ?",
    round.user_id, round.mode, kind) || { current: 0, best: 0, last_day: null };
  let current;
  let lastDay = row.last_day;
  if (kind === "daily") {
    if (row.last_day && row.last_day >= round.day) return; // already counted
    current = round.won ? (row.last_day === previousDay(round.day) ? row.current + 1 : 1) : 0;
    lastDay = round.day;
  } else {
    current = round.won ? row.current + 1 : 0;
  }
  await run(env,
    `INSERT INTO streaks (user_id, mode, kind, current, best, last_day) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, mode, kind) DO UPDATE SET current = excluded.current, best = excluded.best, last_day = excluded.last_day`,
    round.user_id, round.mode, kind, current, Math.max(row.best, current), lastDay);
}

// A daily streak only counts as current if the last win was today or yesterday.
export function liveStreak(kind, row) {
  if (!row) return 0;
  if (kind !== "daily") return row.current;
  const today = todayKey();
  return row.last_day === today || row.last_day === previousDay(today) ? row.current : 0;
}

// The numbers shown under a finished puzzle.
export async function summary(env, userId, mode, playType) {
  const counts = await first(env,
    "SELECT COUNT(*) AS played, COALESCE(SUM(won), 0) AS wins FROM rounds WHERE user_id = ? AND mode = ? AND play_type = ? AND done = 1",
    userId, mode, playType);
  const row = await first(env, "SELECT * FROM streaks WHERE user_id = ? AND mode = ? AND kind = ?", userId, mode, playType);
  return { played: counts.played, wins: counts.wins, current: liveStreak(playType, row), best: row?.best || 0 };
}

// After logging in, rounds played as a guest in this browser move to the account
// (so playing today's daily as a guest first doesn't give you a second try).
export async function claimRounds(env, user, ids) {
  if (!Array.isArray(ids)) return;
  const rounds = [];
  for (const id of ids.slice(0, 10)) {
    if (typeof id !== "string") continue;
    const round = await first(env, "SELECT * FROM rounds WHERE id = ? AND user_id IS NULL", id);
    if (round) rounds.push(round);
  }
  rounds.sort((a, b) => a.created_at - b.created_at);
  for (const round of rounds) {
    const clash = round.play_type === "daily"
      ? await first(env, "SELECT 1 FROM rounds WHERE user_id = ? AND mode = ? AND play_type = 'daily' AND day = ?",
        user.id, round.mode, round.day)
      : !round.done && await first(env, "SELECT 1 FROM rounds WHERE user_id = ? AND mode = ? AND play_type = 'endless' AND done = 0",
        user.id, round.mode);
    if (clash) continue;
    const result = await run(env, "UPDATE rounds SET user_id = ? WHERE id = ? AND user_id IS NULL", user.id, round.id);
    if (result.meta.changes && round.done) await recordStreak(env, { ...round, user_id: user.id });
  }
}
