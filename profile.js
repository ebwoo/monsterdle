// Profile page: anyone's stats, plus log out / change password on your own.
import { $, api, auth, escapeHtml, renderNav, toast } from "./common.js";

const params = new URLSearchParams(location.search);
const username = params.get("u") || auth.user?.username;

const pct = (n) => `${n}%`;
const orDash = (v, f = (x) => x) => (v === null || v === undefined ? "–" : f(v));

function formatTime(ms) {
  if (ms === null) return "–";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

const stat = (value, label) =>
  `<div class="stat"><div class="value">${value}</div><div class="label">${label}</div></div>`;

function distribution(dist) {
  const max = Math.max(1, ...dist);
  return `<div class="bars">${dist.map((n, i) => {
    const loss = i === dist.length - 1;
    return `<div class="bar-row">
      <span class="label">${loss ? "X" : i + 1}</span>
      <span class="bar ${n ? (loss ? "loss" : "win") : ""}" style="width:${Math.max(8, n / max * 100)}%">${n}</span>
    </div>`;
  }).join("")}</div>`;
}

function playTypeBlock(title, s) {
  return `
    <div>
      <h3>${title}</h3>
      <dl class="kv">
        <dt>Played</dt><dd>${s.played}</dd>
        <dt>Won</dt><dd>${s.wins}</dd>
        <dt>Win rate</dt><dd>${pct(s.winRate)}</dd>
        <dt>Avg guesses when solved</dt><dd>${orDash(s.avgGuesses)}</dd>
        <dt>First-try wins</dt><dd>${s.firstTry}</dd>
        <dt>Current streak</dt><dd>${s.current}</dd>
        <dt>Best streak</dt><dd>${s.best}</dd>
        <dt>Fastest solve</dt><dd>${formatTime(s.fastestMs)}</dd>
      </dl>
      ${s.played ? distribution(s.dist) : '<p class="empty">No games yet.</p>'}
    </div>`;
}

function monsterList(items, empty, format) {
  if (!items.length) return `<span class="muted">${empty}</span>`;
  return items.map(format).join("<br>");
}

function render(p) {
  document.title = `${p.username} · Monsterdle`;
  const o = p.overall;
  const joined = new Date(p.memberSince).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  $("profile").innerHTML = `
    <h2 class="page-title" style="margin-bottom:2px">${escapeHtml(p.username)}</h2>
    <p class="muted" style="text-align:left;margin-top:0">Playing since ${joined}</p>
    ${p.isOwner ? `
      <div class="actions-row">
        <button id="show-password" class="secondary">Change password</button>
        <button id="logout" class="secondary">Log out</button>
      </div>
      <form id="password-form" class="form card" style="margin-top:12px" hidden>
        <label>Current password <input id="pw-current" type="password" autocomplete="current-password"></label>
        <label>New password <input id="pw-new" type="password" autocomplete="new-password"></label>
        <p id="pw-error" class="form-error" role="alert"></p>
        <button type="submit">Save new password</button>
      </form>` : ""}

    <h3 class="section-title">Best streaks</h3>
    <div class="stat-grid">
      ${p.modes.map((m) => `
        ${stat(m.daily.best, `${escapeHtml(m.label)} · daily${m.daily.current ? ` <span class="streak-now">(${m.daily.current} now)</span>` : ""}`)}
        <div class="stat">
          <div class="value">${m.endless.best}</div>
          <div class="label">${escapeHtml(m.label)} · endless${m.endless.current ? ` <span class="streak-now">(${m.endless.current} now)</span>` : ""}</div>
          ${m.endless.best ? `<button class="link-button" data-run="${escapeHtml(m.key)}">View run ›</button>` : ""}
        </div>`).join("")}
    </div>
    <div id="best-run" hidden></div>

    <h3 class="section-title">Overview</h3>
    <div class="stat-grid">
      ${stat(o.played, "Games played")}
      ${stat(o.wins, "Monsters identified")}
      ${stat(pct(o.winRate), "Win rate")}
      ${stat(orDash(o.avgGuesses), "Avg guesses when solved")}
      ${stat(o.firstTry, "First-try wins")}
      ${stat(o.daysPlayed, "Days of dailies played")}
      ${stat(formatTime(o.fastestMs), "Fastest solve")}
      ${stat(o.skips, "Skips used")}
      ${stat(o.wrongGuesses, "Wrong guesses")}
    </div>

    ${p.modes.map((m) => `
      <h3 class="section-title">${escapeHtml(m.label)}</h3>
      <div class="card mode-split">
        ${playTypeBlock("Daily", m.daily)}
        ${playTypeBlock("Endless", m.endless)}
      </div>`).join("")}

    <h3 class="section-title">Monster facts</h3>
    <ul class="facts">
      <li><span class="fact-label">Knows best (most correct guesses)</span>
        ${monsterList(p.monsters.knownWell, "Nothing yet", (x) => `${escapeHtml(x.name)} <span class="muted">×${x.count}</span>`)}</li>
      <li><span class="fact-label">Nemesis (most missed)</span>
        ${monsterList(p.monsters.nemesis, "No misses yet!", (x) => `${escapeHtml(x.name)} <span class="muted">×${x.count}</span>`)}</li>
      <li><span class="fact-label">Most mixed up</span>
        ${monsterList(p.monsters.mixups, "No mix-ups yet", (x) =>
          `Guessed ${escapeHtml(x.guess)} when it was ${escapeHtml(x.answer)} <span class="muted">×${x.count}</span>`)}</li>
    </ul>

    <h3 class="section-title">Game history</h3>
    <nav class="tabs" id="history-tabs" aria-label="Filter games" style="margin-bottom:10px">
      <button data-mode="" class="active">All</button>
      ${p.modes.map((m) => `<button data-mode="${escapeHtml(m.key)}">${escapeHtml(m.label)}</button>`).join("")}
    </nav>
    <div class="card" style="padding:4px 8px">
      <table class="table history">
        <thead><tr><th>Puzzle</th><th>Monster</th><th class="num">Result</th></tr></thead>
        <tbody id="history-rows"></tbody>
      </table>
      <p id="history-empty" class="empty" hidden>No games yet.</p>
    </div>
    <button id="history-more" class="secondary" style="margin-top:10px;width:100%" hidden>Show older games</button>
  `;

  document.querySelectorAll("[data-run]").forEach((b) => b.addEventListener("click", () => toggleBestRun(b.dataset.run)));
  document.querySelectorAll("#history-tabs button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("#history-tabs button").forEach((x) => x.classList.toggle("active", x === b));
    loadHistory(b.dataset.mode, true);
  }));
  $("history-more").addEventListener("click", () => loadHistory(historyMode, false));
  loadHistory("", true);

  if (p.isOwner) {
    $("logout").addEventListener("click", async () => {
      await api("/api/logout", { method: "POST" }).catch(() => {});
      auth.clear();
      location.href = "/";
    });
    $("show-password").addEventListener("click", () => {
      $("password-form").hidden = !$("password-form").hidden;
    });
    $("password-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      $("pw-error").textContent = "";
      try {
        await api("/api/password", { method: "POST", body: { current: $("pw-current").value, password: $("pw-new").value } });
        $("password-form").hidden = true;
        $("password-form").reset();
        toast("Password changed");
      } catch (err) {
        $("pw-error").textContent = err.message;
      }
    });
  }
}

// ---------- best endless run ----------

let openRun = null;

function guessChips(guesses) {
  return guesses.map((g) => g.type === "right" ? "🟩"
    : g.type === "skip" ? `<span class="chip">⬛ skipped</span>`
    : `<span class="chip">🟥 ${escapeHtml(g.name)}</span>`).join(" ");
}

// Shows (or hides, if it's already open) every round of the player's best endless run in a mode.
async function toggleBestRun(mode) {
  const panel = $("best-run");
  if (openRun === mode) {
    openRun = null;
    panel.hidden = true;
    return;
  }
  openRun = mode;
  panel.hidden = false;
  panel.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const run = await api(`/api/profile/${encodeURIComponent(username)}/best-run/${encodeURIComponent(mode)}`);
    if (openRun !== mode) return;
    const day = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const first = run.rounds[0], last = run.endedBy || run.rounds[run.rounds.length - 1];
    const span = first && day(first.finishedAt) !== day(last.finishedAt)
      ? `${day(first.finishedAt)} – ${day(last.finishedAt)}` : first ? day(first.finishedAt) : "";
    panel.innerHTML = `
      <section class="card run">
        <div class="run-head">
          <h3>${escapeHtml(run.mode)} · best endless run</h3>
          <button class="link-button" id="close-run">Close</button>
        </div>
        <p class="muted" style="text-align:left;margin:2px 0 10px">
          ${run.length} in a row${span ? ` · ${span}` : ""}${run.ongoing ? ' · <span class="streak-now">still going</span>' : ""}
        </p>
        <ol class="run-list">
          ${run.rounds.map((r, i) => `
            <li>
              <span class="run-num">${i + 1}</span>
              <div class="run-main">
                <strong>${escapeHtml(r.answer)}</strong>
                <div class="run-guesses">${guessChips(r.guesses)}</div>
              </div>
              <div class="run-side">${r.guesses.length} ${r.guesses.length === 1 ? "try" : "tries"}<br>
                <span class="muted">${formatTime(r.timeMs)}</span></div>
            </li>`).join("")}
          ${run.endedBy ? `
            <li class="run-ended">
              <span class="run-num">✕</span>
              <div class="run-main">
                <span class="fact-label">Run ended by</span>
                <strong>${escapeHtml(run.endedBy.answer)}</strong>
                <div class="run-guesses">${guessChips(run.endedBy.guesses)}</div>
              </div>
              <div class="run-side"><span class="loss-text">Missed</span><br>
                <span class="muted">${formatTime(run.endedBy.timeMs)}</span></div>
            </li>` : ""}
        </ol>
      </section>`;
    $("close-run").addEventListener("click", () => toggleBestRun(mode));
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    panel.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
  }
}

// ---------- game history ----------

const SQUARES = { wrong: "🟥", skip: "⬛", right: "🟩" };
let historyMode = "";
let historyNext = null;
let historyRequest = 0;

function historyRow(g) {
  const date = new Date(g.finishedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const kind = g.playType === "daily" ? `Daily #${g.puzzleNumber}` : "Endless";
  return `
    <tr>
      <td class="puzzle">${escapeHtml(g.mode)}<div class="sub">${kind} · ${date}</div></td>
      <td>${g.answer ? escapeHtml(g.answer) : '<span class="muted">Hidden until tomorrow</span>'}
        <div class="squares" aria-label="${g.attempts} guesses">${g.squares.map((t) => SQUARES[t]).join("")}</div></td>
      <td class="num ${g.won ? "win-text" : "loss-text"}">${g.won ? `${g.attempts} ${g.attempts === 1 ? "try" : "tries"}` : "Missed"}</td>
    </tr>`;
}

// Loads a page of past games. `fresh` starts the list over (e.g. after picking a different mode).
async function loadHistory(mode, fresh) {
  const request = ++historyRequest;
  historyMode = mode;
  if (fresh) historyNext = null;
  const query = new URLSearchParams();
  if (mode) query.set("mode", mode);
  if (historyNext) query.set("before", historyNext);
  $("history-more").disabled = true;
  try {
    const page = await api(`/api/profile/${encodeURIComponent(username)}/history?${query}`);
    if (request !== historyRequest) return;
    const html = page.games.map(historyRow).join("");
    if (fresh) $("history-rows").innerHTML = html;
    else $("history-rows").insertAdjacentHTML("beforeend", html);
    historyNext = page.next;
    $("history-more").hidden = !page.next;
    $("history-empty").hidden = $("history-rows").children.length > 0;
  } catch (err) {
    toast(err.message);
  } finally {
    $("history-more").disabled = false;
  }
}

$("lookup").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("lookup-name").value.trim();
  if (name) location.href = `/profile.html?u=${encodeURIComponent(name)}`;
});

async function init() {
  if (!username) {
    location.replace("/login.html");
    return;
  }
  try {
    render(await api(`/api/profile/${encodeURIComponent(username)}`));
  } catch (err) {
    $("profile").innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
  }
  renderNav();
}

init();
