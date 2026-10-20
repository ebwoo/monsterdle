// Profile pages and leaderboards.
import { HttpError, all, first } from "./db.js";
import { previousDay, puzzleNumber, todayKey } from "./daily.js";
import { liveStreak } from "./rounds.js";

const blank = (steps) => ({
  played: 0, wins: 0, guessTotal: 0, firstTry: 0, fastestMs: null,
  dist: Array(steps + 1).fill(0), // wins in 1, 2, … guesses, then losses
});

const top = (counts, n = 3) => [...counts.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, n)
  .map(([name, count]) => ({ name, count }));

const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

function finish(s) {
  return {
    played: s.played,
    wins: s.wins,
    winRate: s.played ? Math.round(s.wins / s.played * 100) : 0,
    avgGuesses: s.wins ? Math.round(s.guessTotal / s.wins * 100) / 100 : null,
    firstTry: s.firstTry,
    fastestMs: s.fastestMs,
    dist: s.dist,
  };
}

export async function profile(env, config, viewer, username) {
  const user = await first(env, "SELECT id, username, created_at FROM users WHERE username_lower = ?",
    String(username).toLowerCase());
  if (!user) throw new HttpError(404, "No player with that name.");
  const isOwner = viewer?.id === user.id;
  const today = todayKey();

  const rounds = await all(env,
    "SELECT mode, play_type, day, answer, guesses, won, created_at, finished_at FROM rounds WHERE user_id = ? AND done = 1 ORDER BY finished_at",
    user.id);
  const streakRows = await all(env, "SELECT * FROM streaks WHERE user_id = ?", user.id);

  const modes = {};
  for (const [key, m] of Object.entries(config.modes)) {
    modes[key] = { key, label: m.label, steps: m.steps.length, daily: blank(m.steps.length), endless: blank(m.steps.length) };
  }
  const overall = blank(0);
  const days = new Set();
  let skips = 0, wrongGuesses = 0;
  const knownWell = new Map(), nemesis = new Map(), mixups = new Map();

  for (const r of rounds) {
    const mode = modes[r.mode];
    if (!mode) continue; // a mode that's since been removed from monsters.json
    const guesses = JSON.parse(r.guesses);
    const timeMs = r.finished_at - r.created_at;
    for (const s of [mode[r.play_type], overall]) {
      s.played++;
      if (r.won) {
        s.wins++;
        s.guessTotal += guesses.length;
        if (guesses.length === 1) s.firstTry++;
        if (s.fastestMs === null || timeMs < s.fastestMs) s.fastestMs = timeMs;
      }
    }
    const dist = mode[r.play_type].dist;
    dist[r.won ? Math.min(guesses.length, dist.length - 1) - 1 : dist.length - 1]++;
    if (r.play_type === "daily") days.add(r.day);
    skips += guesses.filter((g) => g.type === "skip").length;
    wrongGuesses += guesses.filter((g) => g.type === "wrong").length;

    // Today's daily answer is left out of monster stats so profiles can't spoil it.
    if (r.play_type === "daily" && r.day === today) continue;
    bump(r.won ? knownWell : nemesis, r.answer);
    for (const g of guesses) if (g.type === "wrong") bump(mixups, `${r.answer}\u0000${g.name}`);
  }

  const streakFor = (mode, kind) => {
    const row = streakRows.find((s) => s.mode === mode && s.kind === kind);
    return { current: liveStreak(kind, row), best: row?.best || 0 };
  };

  return {
    username: user.username,
    memberSince: user.created_at,
    isOwner,
    overall: { ...finish(overall), daysPlayed: days.size, skips, wrongGuesses },
    modes: Object.values(modes).map((m) => ({
      key: m.key,
      label: m.label,
      daily: { ...finish(m.daily), ...streakFor(m.key, "daily") },
      endless: { ...finish(m.endless), ...streakFor(m.key, "endless") },
    })),
    monsters: {
      knownWell: top(knownWell),
      nemesis: top(nemesis),
      mixups: top(mixups).map(({ name, count }) => {
        const [answer, guess] = name.split("\u0000");
        return { answer, guess, count };
      }),
    },
  };
}

// A player's past games, newest first, a page at a time. `before` is the cursor
// from the previous page ("finishedAt:id"), so pages never skip or repeat a game.
export async function history(env, config, viewer, username, params) {
  const user = await first(env, "SELECT id FROM users WHERE username_lower = ?", String(username).toLowerCase());
  if (!user) throw new HttpError(404, "No player with that name.");
  const isOwner = viewer?.id === user.id;
  const today = todayKey();
  const limit = 25;

  const where = ["user_id = ?", "done = 1"];
  const args = [user.id];
  const mode = params.get("mode");
  if (mode && config.modes[mode]) {
    where.push("mode = ?");
    args.push(mode);
  }
  const before = (params.get("before") || "").match(/^(\d+):([\w-]+)$/);
  if (before) {
    where.push("(finished_at < ? OR (finished_at = ? AND id < ?))");
    args.push(Number(before[1]), Number(before[1]), before[2]);
  }
  const rows = await all(env,
    `SELECT id, mode, play_type, day, answer, guesses, won, finished_at FROM rounds
     WHERE ${where.join(" AND ")} ORDER BY finished_at DESC, id DESC LIMIT ?`,
    ...args, limit + 1);

  const games = rows.slice(0, limit).map((r) => {
    const guesses = JSON.parse(r.guesses);
    return {
      mode: config.modes[r.mode]?.label || r.mode,
      playType: r.play_type,
      puzzleNumber: r.day ? puzzleNumber(r.day) : null,
      won: !!r.won,
      attempts: guesses.length,
      squares: guesses.map((g) => g.type),
      // Today's daily answer stays hidden from other players until tomorrow.
      answer: r.play_type === "daily" && r.day === today && !isOwner ? null : r.answer,
      finishedAt: r.finished_at,
    };
  });
  const last = rows[limit - 1];
  return { games, next: rows.length > limit ? `${last.finished_at}:${last.id}` : null };
}

// Players with the same score share a rank.
function ranked(rows) {
  return rows.map((row) => ({ ...row, rank: rows.findIndex((r) => r.value === row.value) + 1 }));
}

export async function leaderboard(env, config) {
  const today = todayKey();
  const boards = [];
  for (const [key, m] of Object.entries(config.modes)) {
    for (const kind of ["daily", "endless"]) {
      const label = kind === "daily" ? "Daily" : "Endless";
      // Current streaks: a daily streak only counts if its last win was today or yesterday.
      const current = await all(env,
        `SELECT u.username, s.current AS value FROM streaks s JOIN users u ON u.id = s.user_id
         WHERE s.mode = ? AND s.kind = ? AND s.current > 0
           ${kind === "daily" ? "AND s.last_day IN (?, ?)" : ""}
         ORDER BY s.current DESC, s.best DESC, u.username_lower LIMIT 25`,
        ...(kind === "daily" ? [key, kind, today, previousDay(today)] : [key, kind]));
      const best = await all(env,
        `SELECT u.username, s.best AS value FROM streaks s JOIN users u ON u.id = s.user_id
         WHERE s.mode = ? AND s.kind = ? AND s.best > 0
         ORDER BY s.best DESC, u.username_lower LIMIT 25`,
        key, kind);
      boards.push(
        { id: `${key}-${kind}-current`, mode: key, modeLabel: m.label, kind, metric: "current",
          title: `${label}: current streak`, rows: ranked(current) },
        { id: `${key}-${kind}-best`, mode: key, modeLabel: m.label, kind, metric: "best",
          title: `${label}: best streak ever`, rows: ranked(best) },
      );
    }
  }
  const wins = await all(env,
    `SELECT u.username, COUNT(*) AS value FROM rounds r JOIN users u ON u.id = r.user_id
     WHERE r.won = 1 GROUP BY r.user_id ORDER BY value DESC, u.username_lower LIMIT 25`);
  boards.push({ id: "wins", mode: null, modeLabel: "All modes", kind: "wins", metric: "wins", title: "Most monsters identified", rows: ranked(wins) });
  return { modes: Object.entries(config.modes).map(([key, m]) => ({ key, label: m.label })), boards };
}

// The run of endless rounds behind a player's best streak in one mode: the longest
// unbroken string of wins, in the order they were played. On a tie, the run that set
// the record first wins (the same rule as the best-streak number). Daily isn't included.
export async function bestRun(env, config, username, mode) {
  if (!config.modes[mode]) throw new HttpError(400, "Unknown mode.");
  const user = await first(env, "SELECT id FROM users WHERE username_lower = ?", String(username).toLowerCase());
  if (!user) throw new HttpError(404, "No player with that name.");
  const rounds = await all(env,
    `SELECT answer, guesses, won, created_at, finished_at FROM rounds
     WHERE user_id = ? AND mode = ? AND play_type = 'endless' AND done = 1
     ORDER BY finished_at, id`,
    user.id, mode);

  let bestStart = 0, bestLength = 0, start = 0;
  rounds.forEach((r, i) => {
    if (!r.won) {
      start = i + 1;
      return;
    }
    if (i - start + 1 > bestLength) {
      bestStart = start;
      bestLength = i - start + 1;
    }
  });
  const run = rounds.slice(bestStart, bestStart + bestLength);
  // Still going if nothing has been finished in this mode since the run's last win.
  const ongoing = bestLength > 0 && bestStart + bestLength === rounds.length;
  return {
    mode: config.modes[mode].label,
    length: bestLength,
    ongoing,
    rounds: run.map((r) => ({
      answer: r.answer,
      guesses: JSON.parse(r.guesses),
      timeMs: r.finished_at - r.created_at,
      finishedAt: r.finished_at,
    })),
  };
}
