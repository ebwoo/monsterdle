// The game page. The server picks the monster and checks guesses (see worker/rounds.js);
// this file handles playing the clip, typing guesses and showing results.
import { normalizeConfig, startStyle } from "./lib/config.js";
import { $, api, auth, guestRoundKey, storage, toast } from "./common.js";

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// ---------- audio ----------

let audioCtx = null;
const bufferCache = new Map();
let currentSource = null;
let playheadFrame = null;

async function loadBuffer(url) {
  if (!bufferCache.has(url)) {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const promise = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error("Couldn't load the clip. Try refreshing.");
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
  $("play").textContent = "▶";
  if (game) showPosition(seekPos);
}

// ---------- game state ----------

let config;
let mode;                // a key from config.modes, e.g. "easy"
let playType = "daily";  // "daily" | "endless"
let game = null;         // the current round from the server, plus `offset` (where the clip starts in the file)
let userStats = null;    // logged-in players' stats for this mode, from the server
let seekPos = 0;         // where in the unlocked clip playback starts, in seconds
let dragging = false;
let busy = false;
let startCounter = 0;

const steps = () => config.modes[mode].steps;
const MAX_GUESSES = () => steps().length;
const maxLen = () => steps()[steps().length - 1];

function unlockedLength() {
  if (game.done) return maxLen();
  return steps()[Math.min(game.guesses.length, steps().length - 1)];
}

// The latest point playback can start from, leaving a little to hear.
const maxStart = () => Math.max(0, unlockedLength() - 0.25);

async function startGame() {
  const request = ++startCounter;
  stopAudio();
  game = null;
  seekPos = 0;
  render();
  try {
    const roundId = auth.user ? undefined : storage.get(guestRoundKey(playType, mode), undefined);
    const data = await api("/api/round/start", { method: "POST", body: { mode, playType, roundId } });
    if (request !== startCounter) return; // the player switched modes while this was loading
    if (!auth.user) storage.set(guestRoundKey(playType, mode), data.round.id);
    applyRound(data);
    render();
    // Start fetching right away so the first play is instant.
    prepareClip().catch((e) => toast(e.message));
  } catch (e) {
    if (request !== startCounter) return;
    $("clip-len").textContent = e.message;
  }
}

function applyRound(data) {
  const same = game && game.id === data.round.id;
  game = {
    ...data.round,
    offset: same ? game.offset : null,
    // Keep the reset time from when the round began, so a daily finished after midnight still counts as yesterday's.
    nextResetAt: same ? game.nextResetAt : data.round.nextResetAt,
  };
  userStats = data.stats;
}

// Works out where in the file this round's clip starts.
async function prepareClip() {
  const round = game;
  const buffer = await loadBuffer(`/api/clip/${round.id}`);
  if (round.offset === null) {
    const room = Math.max(0, buffer.duration - maxLen());
    round.offset = startStyle(config, round.mode) === "beginning" ? 0 : round.seed * room;
  }
  return buffer;
}

async function togglePlay() {
  if (currentSource) {
    stopAudio();
    return;
  }
  await play();
}

async function play() {
  if (!game) return;
  const round = game;
  let buffer;
  try {
    buffer = await prepareClip();
  } catch (e) {
    toast(e.message);
    return;
  }
  if (game !== round) return;
  await audioCtx.resume();
  stopAudio();

  const from = Math.min(seekPos, maxStart());
  const length = Math.min(unlockedLength() - from, buffer.duration - round.offset - from);
  if (length <= 0) return;

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  source.onended = stopAudio;
  source.start(0, round.offset + from, length);
  currentSource = source;
  $("play").textContent = "■";

  const startedAt = audioCtx.currentTime;
  const tick = () => {
    const pos = from + Math.min(audioCtx.currentTime - startedAt, length);
    if (!dragging) showPosition(pos);
    if (currentSource === source) playheadFrame = requestAnimationFrame(tick);
  };
  tick();
}

// Moves the slider, the green fill and the time label to a position (seconds).
function showPosition(pos) {
  $("seek").value = pos;
  $("playhead").style.width = `${pos / maxLen() * 100}%`;
  $("pos-label").textContent = `${pos.toFixed(1)}s`;
}

// The slider can only go as far as the part of the clip that's been unlocked.
function setSeekFromSlider() {
  seekPos = Math.min(Math.max(0, Number($("seek").value)), maxStart());
  showPosition(seekPos);
}

function onSeekInput() {
  if (!game) return;
  dragging = true;
  setSeekFromSlider();
}

function onSeekChange() {
  if (!game) return;
  dragging = false;
  setSeekFromSlider();
  // Letting go while the clip plays jumps playback to the new spot.
  if (currentSource) play();
}

// ---------- guessing ----------

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

async function submitGuess(text) {
  if (!game || game.done || busy) return;
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
  if (await sendTurn({ guess: monster.name })) {
    $("guess").value = "";
    hideSuggestions();
  }
}

function skip() {
  if (!game || game.done || busy) return;
  sendTurn({ skip: true });
}

async function sendTurn(body) {
  busy = true;
  $("submit").disabled = $("skip").disabled = true;
  try {
    const data = await api(`/api/round/${game.id}/guess`, { method: "POST", body });
    stopAudio();
    const finished = data.round.done && !game.done;
    applyRound(data);
    if (finished && !auth.user) recordGuestStats();
    render();
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  } finally {
    busy = false;
    $("submit").disabled = $("skip").disabled = false;
  }
}

// ---------- stats & sharing ----------

// Guests' stats live in this browser only. Logged-in players' stats come from the server.
const guestStatsKey = () => `md-stats-${mode}-${playType}`;

function recordGuestStats() {
  const s = storage.get(guestStatsKey(), { played: 0, wins: 0, streak: 0, best: 0 });
  s.played++;
  if (game.won) {
    s.wins++;
    s.streak++;
    s.best = Math.max(s.best, s.streak);
  } else {
    s.streak = 0;
  }
  storage.set(guestStatsKey(), s);
}

function statsLine() {
  if (auth.user && userStats) {
    const s = userStats;
    const pct = s.played ? Math.round(s.wins / s.played * 100) : 0;
    return `Played ${s.played} · Win ${pct}% · Streak ${s.current} · Best ${s.best}`;
  }
  const s = storage.get(guestStatsKey(), { played: 0, wins: 0, streak: 0, best: 0 });
  const pct = s.played ? Math.round(s.wins / s.played * 100) : 0;
  return `Played ${s.played} · Win ${pct}% · Streak ${s.streak} · Best ${s.best}`;
}

function shareText() {
  const icons = { wrong: "🟥", skip: "⬛", right: "🟩" };
  const squares = game.guesses.map((g) => icons[g.type]).join("") +
    "⬜".repeat(MAX_GUESSES() - game.guesses.length);
  const score = game.won ? game.guesses.length : "X";
  const label = config.modes[mode].label;
  const header = playType === "daily"
    ? `${config.title} ${label} #${game.puzzleNumber}`
    : `${config.title} ${label} (Endless)`;
  // Each guess is wrapped in || || so Discord hides it as a spoiler until clicked.
  const guessLines = game.guesses.map((g, i) =>
    `${i + 1}. ${icons[g.type]} ${g.type === "skip" ? "Skipped" : `||${g.name}||`}`);
  // Blank lines between sections keep it readable when pasted into chats.
  return [
    header,
    `Score: ${score}/${MAX_GUESSES()}`,
    "",
    `🔊 ${squares}`,
    "",
    ...guessLines,
    "",
    location.origin + "/",
  ].join("\n");
}

async function share() {
  try {
    await navigator.clipboard.writeText(shareText());
    toast("Copied! Guesses show as spoilers on Discord.");
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
  if (!n || !game) return hideSuggestions();
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
  const total = maxLen();

  document.querySelectorAll("#mode-tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode));
  document.querySelectorAll("[data-play]").forEach((b) =>
    b.classList.toggle("active", b.dataset.play === playType));
  $("mode-desc").textContent = modeCfg.description || "";

  // Guess rows
  const rows = [];
  for (let i = 0; i < steps().length; i++) {
    const li = document.createElement("li");
    const g = game?.guesses[i];
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
  for (const s of steps().slice(0, -1)) {
    const tick = document.createElement("div");
    tick.className = "tick";
    tick.style.left = `${s / total * 100}%`;
    timeline.append(tick);
  }
  $("max-label").textContent = `${total}s`;
  $("seek").max = total;

  const loading = !game;
  $("play").disabled = $("seek").disabled = loading;
  if (loading) {
    $("unlocked").style.width = "0";
    $("playhead").style.width = "0";
    $("pos-label").textContent = "0.0s";
    $("clip-len").textContent = "Loading…";
    $("input-area").hidden = true;
    $("result").hidden = true;
    $("countdown").hidden = true;
    return;
  }

  const len = unlockedLength();
  $("unlocked").style.width = `${len / total * 100}%`;
  seekPos = Math.min(seekPos, maxStart());
  if (!currentSource) showPosition(seekPos);
  $("clip-len").textContent = (game.done ? "Full clip unlocked" : `Clip length: ${len}s`) +
    (len > steps()[0] ? " · drag the slider to replay any part" : "");

  const nextStep = steps()[game.guesses.length + 1];
  $("skip").textContent = nextStep ? `Skip (+${+(nextStep - len).toFixed(2)}s)` : "Give up";

  // Input vs. result
  $("input-area").hidden = game.done;
  $("result").hidden = !game.done;
  if (game.done) {
    $("result-title").textContent = game.won
      ? `Got it in ${game.guesses.length}!`
      : "Out of guesses";
    $("result-answer").textContent = `It was ${game.answer}.`;
    $("next").hidden = playType !== "endless";
    $("stats").textContent = statsLine();
    $("account-hint").hidden = !!auth.user;
  }
  updateCountdown();
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}

let lastTick = Date.now();

// Runs every second: updates the countdown, and moves to the new puzzle at reset.
function updateCountdown() {
  const now = Date.now();
  const previous = lastTick;
  lastTick = now;
  if (!game) return;
  const daily = playType === "daily";
  const el = $("countdown");
  const show = daily && game.done;
  const stale = daily && now >= game.nextResetAt;
  el.hidden = !show;
  el.classList.toggle("ready", stale);
  if (show) {
    el.textContent = stale
      ? "A new monster is ready! Click here to play."
      : `Next monster in ${formatDuration(game.nextResetAt - now)}`;
  }

  // At the moment of reset, switch over unless the player is partway through a puzzle.
  // (They finish that one first; afterwards the message above offers the new one.)
  const justReset = daily && previous < game.nextResetAt && now >= game.nextResetAt;
  if (justReset && (game.done || game.guesses.length === 0)) {
    startGame();
    if (show) toast("A new monster is ready!");
  }
}

// ---------- setup ----------

async function init() {
  try {
    config = normalizeConfig(await fetch("monsters.json").then((r) => r.json()));
  } catch {
    document.querySelector("main").textContent = "Could not load monsters.json.";
    return;
  }
  if (!config.monsters.length) {
    document.querySelector("main").textContent =
      "monsters.json has no monsters with an audio file. Rebuild it with tools/make-monster-list.html.";
    return;
  }

  document.title = config.title;
  $("title").textContent = config.title;

  const tabs = Object.entries(config.modes)
    .map(([key, m]) => {
      const b = document.createElement("button");
      b.textContent = m.label;
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
  $("seek").addEventListener("input", onSeekInput);
  $("seek").addEventListener("change", onSeekChange);
  $("submit").addEventListener("click", () => submitGuess($("guess").value));
  $("skip").addEventListener("click", skip);
  $("share").addEventListener("click", share);
  $("next").addEventListener("click", startGame);
  $("countdown").addEventListener("click", () => {
    if (game && Date.now() >= game.nextResetAt) startGame();
  });
  $("guess").addEventListener("input", () => { activeSuggestion = -1; showSuggestions(); });
  $("guess").addEventListener("keydown", onGuessKey);
  $("guess").addEventListener("blur", hideSuggestions);

  startGame();
  setInterval(updateCountdown, 1000);
}

init();
