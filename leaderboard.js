// Leaderboard page.
import { $, api, auth, escapeHtml, storage } from "./common.js";

let data;
let mode = storage.get("md-board-mode", null);

function boardCard(board) {
  const me = auth.user?.username.toLowerCase();
  const rows = board.rows.map((r) => `
    <tr class="${r.username.toLowerCase() === me ? "me" : ""}">
      <td class="rank rank-${r.rank}">${r.rank}</td>
      <td><a href="/profile.html?u=${encodeURIComponent(r.username)}">${escapeHtml(r.username)}</a></td>
      <td class="num">${r.value}</td>
    </tr>`).join("");
  const empty = board.metric === "current" ? "No active streaks right now." : "No one yet. This could be you!";
  return `
    <section class="card">
      <h3>${escapeHtml(board.title)}</h3>
      <div class="muted" style="text-align:left">${escapeHtml(board.modeLabel)}</div>
      ${board.rows.length ? `
        <table class="table">
          <thead><tr><th>#</th><th>Player</th><th class="num">${board.kind === "wins" ? "Wins" : "Streak"}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>` : `<p class="empty">${empty}</p>`}
    </section>`;
}

function render() {
  document.querySelectorAll("#mode-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("boards").innerHTML = data.boards.filter((b) => b.mode === mode).map(boardCard).join("");
  $("wins-board").innerHTML = data.boards.filter((b) => b.kind === "wins").map(boardCard).join("");
}

async function init() {
  try {
    data = await api("/api/leaderboard");
  } catch (err) {
    $("boards").innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!data.modes.some((m) => m.key === mode)) mode = data.modes[0]?.key;
  $("mode-tabs").replaceChildren(...data.modes.map((m) => {
    const b = document.createElement("button");
    b.textContent = m.label;
    b.dataset.mode = m.key;
    b.addEventListener("click", () => {
      mode = m.key;
      storage.set("md-board-mode", mode);
      render();
    });
    return b;
  }));
  $("join").hidden = !!auth.user;
  render();
}

init();
