// Picks the daily monsters and works out dates. This used to run in the browser;
// it lives on the server now so players can't look up the answer ahead of time.

// Everyone gets the new daily monster at midnight in this time zone, wherever they are.
// Use any name from https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
export const RESET_TIME_ZONE = "America/New_York";

// The day the game launched (year-month-day). That day is puzzle #1.
export const LAUNCH_DATE = "2026-10-19";

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Small seeded PRNG so every player gets the same daily puzzle.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(list, seed) {
  const rng = mulberry32(seed);
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Today's date in the reset time zone, as "YYYY-MM-DD".
export function todayKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: RESET_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// When the next daily reset happens (milliseconds since 1970). Searches for the
// moment the date changes, so days made longer or shorter by daylight saving still work.
export function nextResetAt() {
  const now = Date.now();
  const today = todayKey(new Date(now));
  let lo = now, hi = now + 26 * 3600000;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (todayKey(new Date(mid)) === today) lo = mid; else hi = mid;
  }
  return hi;
}

const toUtc = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

// Whole days from one "YYYY-MM-DD" date to another.
export const daysBetween = (from, to) => Math.round((toUtc(to) - toUtc(from)) / 86400000);

export const previousDay = (day) => new Date(toUtc(day) - 86400000).toISOString().slice(0, 10);

// The number shown when sharing: #1 on launch day, #2 the day after, and so on.
export const puzzleNumber = (day) => daysBetween(LAUNCH_DATE, day) + 1;

// Every mode walks the same shuffled list, each one spread evenly behind the last,
// so different modes' daily puzzles are never the same monster.
export function dailyAnswer(config, mode, day) {
  const list = seededShuffle(config.monsters, hashString("order"));
  const keys = Object.keys(config.modes);
  const shift = Math.floor(list.length * keys.indexOf(mode) / keys.length);
  const i = daysBetween("2026-01-01", day) + shift;
  return list[((i % list.length) + list.length) % list.length];
}

// Where in the file a "random" mode starts, as a fraction. Same for everyone each day.
export const dailySeed = (mode, day) => mulberry32(hashString(`offset-${mode}-${day}`))();
