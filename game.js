"use strict";

// ---------- helpers ----------

const $ = (id) => document.getElementById(id);

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

// "audio/Pale_Crawler.mp3" -> "Pale Crawler"
const nameFromFile = (path) =>
  path.split("/").pop().replace(/\.[^.]+$/, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Puzzle number: days since launch, in the player's local time.
function dayNumber() {
  const [y, m, d] = todayKey().split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(2026, 0, 1)) / 86400000);
}

const storage = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 1800);
}

// ---------- audio ----------

let audioCtx = null;
const bufferCache = new Map();
let currentSource = null;
let playheadFrame = null;

async function loadBuffer(url) {
  if (!bufferCache.has(url)) {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    // Encode each path segment so names with spaces, apostrophes or # still load.
    const safeUrl = url.split("/").map(encodeURIComponent).join("/");
    const promise = fetch(safeUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`Could not load ${url}`);
        return r.arrayBuffer();
      })
      .then((data) => audioCtx.decodeAudioData(data));
    bufferCache.set(url, promise);
    promise.catch(() => bufferCache.delete(url));
  }
  return bufferCache.get(url);
}

function stopAudio() {
  if (currentSource) {
    currentSource.onended = null;
    try { currentSource.stop(); } catch {}
    currentSource = null;
  }
  cancelAnimationFrame(playheadFrame);
  $("playhead").style.width = "0";
  $("play").textContent = "▶";
}

// ---------- game state ----------

let config;
let mode;                // a key from config.modes, e.g. "easy"
let playType = "daily";  // "daily" | "endless"
let game;                // { answer, guesses: [{type, name}], done, won, offset }

const MAX_GUESSES = () => config.modes[mode].steps.length;

function pool() {
  return config.monsters.filter((m) => m.audio);
}

function stateKey() {
  return `md-daily-${mode}-${todayKey()}`;
}

// "beginning" plays from 0:00; "random" plays from anywhere in the file.
// Modes without a "start" setting: the first one plays from the beginning, the rest are random.
function startStyle(key) {
  const start = config.modes[key].start;
  if (start === "beginning" || start === "random") return start;
  return Object.keys(config.modes)[0] === key ? "beginning" : "random";
}

// Every mode walks the same shuffled list, each one spread evenly behind the last,
// so different modes' daily puzzles are never the same monster.
function pickDailyAnswer() {
  const list = seededShuffle(pool(), hashString("order"));
  const keys = Object.keys(config.modes);
  const shift = Math.floor(list.length * keys.indexOf(mode) / keys.length);
  const i = dayNumber() + shift;
  return list[((i % list.length) + list.length) % list.length];
}

function pickRandomAnswer(exclude) {
  const list = pool();
  const choices = list.length > 1 ? list.filter((m) => m.name !== exclude) : list;
  return choices[Math.floor(Math.random() * choices.length)];
}

function startGame() {
  stopAudio();
  if (playType === "daily") {
    const answer = pickDailyAnswer();
    const saved = storage.get(stateKey(), null);
    game = saved && saved.answer === answer.name
      ? { ...saved, answer }
      : { answer, guesses: [], done: false, won: false };
  } else {
    game = { answer: pickRandomAnswer(game?.answer?.name), guesses: [], done: false, won: false };
  }
  game.offset = null;
  render();
  // Start fetching right away so the first play is instant.
  prepareClip().catch((e) => toast(e.message));
}

function saveGame() {
  if (playType !== "daily") return;
  const { answer, guesses, done, won } = game;
  storage.set(stateKey(), { answer: answer.name, guesses, done, won });
}

// Works out where in the file this round's clip starts.
async function prepareClip() {
  const buffer = await loadBuffer(game.answer.audio);
  if (game.offset === null) {
    if (startStyle(mode) === "beginning") {
      game.offset = 0;
    } else {
      const steps = config.modes[mode].steps;
      const maxLen = steps[steps.length - 1];
      const room = Math.max(0, buffer.duration - maxLen);
      const rng = playType === "daily"
        ? mulberry32(hashString(`offset-${mode}-${todayKey()}`))
        : Math.random;
      game.offset = rng() * room;
    }
  }
  return buffer;
}

function unlockedLength() {
  const steps = config.modes[mode].steps;
  if (game.done) return steps[steps.length - 1];
  return steps[Math.min(game.guesses.length, steps.length - 1)];
}

async function togglePlay() {
  if (currentSource) {
    stopAudio();
    return;
  }
  const answerAtStart = game.answer;
  let buffer;
  try {
    buffer = await prepareClip();
  } catch (e) {
    toast(e.message);
    return;
  }
  if (game.answer !== answerAtStart) return;
  await audioCtx.resume();

  const steps = config.modes[mode].steps;
  const maxLen = steps[steps.length - 1];
  const length = Math.min(unlockedLength(), buffer.duration - game.offset);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  source.onended = stopAudio;
  source.start(0, game.offset, length);
  currentSource = source;
  $("play").textContent = "■";

  const startedAt = audioCtx.currentTime;
  const tick = () => {
    const elapsed = audioCtx.currentTime - startedAt;
    $("playhead").style.width = `${Math.min(elapsed, length) / maxLen * 100}%`;
    if (currentSource === source) playheadFrame = requestAnimationFrame(tick);
  };
  tick();
}

// Number of typos between two strings (insert, delete, change, or swap two neighbouring letters).
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

// Typos allowed for a name of this length: none for short names, 1 for 5+ letters, 2 for 9+.
const typoAllowance = (len) => (len >= 9 ? 2 : len >= 5 ? 1 : 0);

// Matches free-typed text to a monster by name or alias, forgiving small typos.
function findMonster(text) {
  const n = normalize(text);
  if (!n) return null;
  let best = null;
  let bestDist = Infinity;
  for (const m of config.monsters) {
    for (const name of [m.name, ...(m.aliases || [])]) {
      const target = normalize(name);
      const dist = editDistance(n, target);
      if (dist <= typoAllowance(target.length) && dist < bestDist) {
        best = m;
        bestDist = dist;
      }
    }
  }
  return best;
}

function submitGuess(text) {
  if (game.done) return;
  const typed = text.trim();
  if (!typed) {
    toast("Type a guess first");
    return;
  }
  // Names that aren't in the monster list are rejected and don't use up a guess.
  const monster = findMonster(typed);
  if (!monster) {
    toast("That's not a monster in the list");
    return;
  }
  if (game.guesses.some((g) => g.name === monster.name)) {
    toast("Already guessed");
    return;
  }
  const correct = monster.name === game.answer.name;
  game.guesses.push({ type: correct ? "right" : "wrong", name: monster.name });
  $("guess").value = "";
  hideSuggestions();
  afterTurn(correct);
}

function skip() {
  if (game.done) return;
  game.guesses.push({ type: "skip", name: "Skipped" });
  afterTurn(false);
}

function afterTurn(correct) {
  stopAudio();
  if (correct || game.guesses.length >= MAX_GUESSES()) {
    game.done = true;
    game.won = correct;
    recordStats();
  }
  saveGame();
  render();
}

// ---------- stats & sharing ----------

function statsKey() {
  return `md-stats-${mode}-${playType}`;
}

function recordStats() {
  const s = storage.get(statsKey(), { played: 0, wins: 0, streak: 0, best: 0, dist: {} });
  s.played++;
  if (game.won) {
    s.wins++;
    s.streak++;
    s.best = Math.max(s.best, s.streak);
    s.dist[game.guesses.length] = (s.dist[game.guesses.length] || 0) + 1;
  } else {
    s.streak = 0;
  }
  storage.set(statsKey(), s);
}

function shareText() {
  const icons = { wrong: "🟥", skip: "⬛", right: "🟩" };
  const squares = game.guesses.map((g) => icons[g.type]).join("") +
    "⬜".repeat(MAX_GUESSES() - game.guesses.length);
  const score = game.won ? game.guesses.length : "X";
  const label = config.modes[mode].label;
  const header = playType === "daily"
    ? `${config.title} ${label} #${dayNumber() + 1}`
    : `${config.title} ${label} (Endless)`;
  return `${header} ${score}/${MAX_GUESSES()}\n🔊${squares}\n${location.href}`;
}

async function share() {
  try {
    await navigator.clipboard.writeText(shareText());
    toast("Copied to clipboard");
  } catch {
    prompt("Copy your result:", shareText());
  }
}

// ---------- autocomplete ----------

let activeSuggestion = -1;

function hideSuggestions() {
  $("suggestions").hidden = true;
  activeSuggestion = -1;
}

function chooseSuggestion(name) {
  $("guess").value = name;
  hideSuggestions();
  $("guess").focus();
}

function showSuggestions() {
  const n = normalize($("guess").value);
  const list = $("suggestions");
  if (!n) return hideSuggestions();
  const guessed = new Set(game.guesses.map((g) => g.name));
  const matches = config.monsters
    .filter((m) => !guessed.has(m.name))
    .filter((m) => [m.name, ...(m.aliases || [])].some((s) => normalize(s).includes(n)))
    .slice(0, 8);
  list.replaceChildren(...matches.map((m, i) => {
    const li = document.createElement("li");
    li.textContent = m.name;
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      chooseSuggestion(m.name);
    });
    if (i === activeSuggestion) li.classList.add("active");
    return li;
  }));
  list.hidden = matches.length === 0;
}

function onGuessKey(e) {
  const items = [...$("suggestions").children];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!items.length) return;
    e.preventDefault();
    const dir = e.key === "ArrowDown" ? 1 : -1;
    activeSuggestion = (activeSuggestion + dir + items.length) % items.length;
    items.forEach((li, i) => li.classList.toggle("active", i === activeSuggestion));
  } else if (e.key === "Enter" || (e.key === "Tab" && items[activeSuggestion])) {
    e.preventDefault();
    // Enter on a highlighted suggestion fills it in; otherwise submit exactly what was typed.
    if (items[activeSuggestion]) chooseSuggestion(items[activeSuggestion].textContent);
    else if (e.key === "Enter") submitGuess($("guess").value);
  } else if (e.key === "Escape") {
    hideSuggestions();
  }
}

// ---------- rendering ----------

function render() {
  const modeCfg = config.modes[mode];
  const steps = modeCfg.steps;
  const maxLen = steps[steps.length - 1];

  document.querySelectorAll("#mode-tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode));
  document.querySelectorAll("[data-play]").forEach((b) =>
    b.classList.toggle("active", b.dataset.play === playType));
  $("mode-desc").textContent = modeCfg.description || "";

  // Guess rows
  const rows = [];
  for (let i = 0; i < steps.length; i++) {
    const li = document.createElement("li");
    const g = game.guesses[i];
    if (g) {
      li.className = g.type;
      li.append(g.name);
    }
    rows.push(li);
  }
  $("guesses").replaceChildren(...rows);

  // Timeline
  const timeline = $("timeline");
  timeline.querySelectorAll(".tick").forEach((t) => t.remove());
  for (const s of steps.slice(0, -1)) {
    const tick = document.createElement("div");
    tick.className = "tick";
    tick.style.left = `${s / maxLen * 100}%`;
    timeline.append(tick);
  }
  $("unlocked").style.width = `${unlockedLength() / maxLen * 100}%`;
  $("max-label").textContent = `${maxLen}s`;

  const len = unlockedLength();
  $("clip-len").textContent = game.done
    ? "Full clip unlocked"
    : `Clip length: ${len}s`;

  const nextStep = steps[game.guesses.length + 1];
  $("skip").textContent = nextStep ? `Skip (+${+(nextStep - len).toFixed(2)}s)` : "Give up";

  // Input vs. result
  $("input-area").hidden = game.done;
  $("result").hidden = !game.done;
  if (game.done) {
    $("result-title").textContent = game.won
      ? `Got it in ${game.guesses.length}!`
      : "Out of guesses";
    $("result-answer").textContent = `It was ${game.answer.name}.`;
    $("next").hidden = playType !== "endless";
    const s = storage.get(statsKey(), { played: 0, wins: 0, streak: 0, best: 0 });
    const pct = s.played ? Math.round(s.wins / s.played * 100) : 0;
    $("stats").textContent = `Played ${s.played} · Win ${pct}% · Streak ${s.streak} · Best ${s.best}`;
  }
}

// ---------- setup ----------

async function init() {
  try {
    config = await fetch("monsters.json").then((r) => r.json());
  } catch {
    document.querySelector("main").textContent =
      "Could not load monsters.json. Run the site from a web server (see README).";
    return;
  }

  // Entries can be a bare file path or an object; a missing name comes from the file name.
  // Older lists used "spawn"/"theme" instead of "audio", so those still work.
  config.monsters = (config.monsters || []).flatMap((m) => {
    const entry = typeof m === "string" ? { audio: m } : { ...m };
    entry.audio ||= entry.spawn || entry.theme;
    if (!entry.audio) {
      console.warn("Skipping monster with no audio file:", m);
      return [];
    }
    return [{ ...entry, name: entry.name || nameFromFile(entry.audio), aliases: entry.aliases || [] }];
  });
  if (!config.monsters.length) {
    document.querySelector("main").textContent =
      "monsters.json has no monsters with an audio file. Rebuild it with tools/make-monster-list.html.";
    return;
  }
  config.title ||= "Monsterdle";
  // Drop any mode that's missing its clip lengths, and fall back to defaults if none are left.
  config.modes = Object.fromEntries(Object.entries(config.modes || {}).filter(([key, m]) => {
    const ok = m && Array.isArray(m.steps) && m.steps.length > 0;
    if (!ok) console.warn(`Mode "${key}" has no "steps" list, so it was skipped.`);
    return ok;
  }));
  if (!Object.keys(config.modes).length) {
    config.modes = {
      spawn: { label: "Spawn Sound", description: "", start: "beginning", steps: [0.5, 1, 2, 3, 5, 8] },
      theme: { label: "Theme", description: "", start: "random", steps: [1, 2, 4, 7, 11, 16] },
    };
  }

  document.title = config.title;
  $("title").textContent = config.title;

  const tabs = Object.entries(config.modes)
    .map(([key, m]) => {
      const b = document.createElement("button");
      b.textContent = m.label || key;
      b.dataset.mode = key;
      b.addEventListener("click", () => {
        mode = key;
        storage.set("md-prefs", { mode, playType });
        startGame();
      });
      return b;
    });
  $("mode-tabs").replaceChildren(...tabs);

  const prefs = storage.get("md-prefs", {});
  if (tabs.some((t) => t.dataset.mode === prefs.mode)) mode = prefs.mode;
  else mode = tabs[0].dataset.mode;
  if (prefs.playType === "endless") playType = "endless";

  document.querySelectorAll("[data-play]").forEach((b) =>
    b.addEventListener("click", () => {
      playType = b.dataset.play;
      storage.set("md-prefs", { mode, playType });
      startGame();
    }));

  $("play").addEventListener("click", togglePlay);
  $("submit").addEventListener("click", () => submitGuess($("guess").value));
  $("skip").addEventListener("click", skip);
  $("share").addEventListener("click", share);
  $("next").addEventListener("click", startGame);
  $("guess").addEventListener("input", () => { activeSuggestion = -1; showSuggestions(); });
  $("guess").addEventListener("keydown", onGuessKey);
  $("guess").addEventListener("blur", hideSuggestions);

  startGame();
}

init();
