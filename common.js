// Shared by every page: talking to the server, who's logged in, and the top navigation.

export const $ = (id) => document.getElementById(id);

export const storage = {
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
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

export function toast(msg) {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2200);
}

export const auth = {
  get token() { return storage.get("md-token", null); },
  get user() { return storage.get("md-user", null); },
  save({ token, user }) {
    storage.set("md-token", token);
    storage.set("md-user", user);
  },
  clear() {
    storage.remove("md-token");
    storage.remove("md-user");
  },
};

export async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && auth.token && path !== "/api/login") {
    // The saved login expired or was signed out elsewhere.
    auth.clear();
    renderNav();
  }
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

// Guests' rounds are remembered by id in this browser, one per mode and play type.
export const guestRoundKey = (playType, mode) => `md-round-${playType}-${mode}`;

export function guestRoundIds() {
  const ids = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith("md-round-")) ids.push(storage.get(key, null));
    }
  } catch {}
  return ids.filter(Boolean);
}

export function forgetGuestRounds() {
  try {
    Object.keys(localStorage).filter((k) => k.startsWith("md-round-")).forEach((k) => localStorage.removeItem(k));
  } catch {}
}

export function renderNav() {
  const nav = $("site-nav");
  if (!nav) return;
  const here = location.pathname;
  const link = (href, text, match) => {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    if (match.includes(here)) a.className = "active";
    return a;
  };
  const user = auth.user;
  nav.replaceChildren(
    link("/", "Play", ["/", "/index.html"]),
    link("/leaderboard.html", "Leaderboard", ["/leaderboard.html", "/leaderboard"]),
    user
      ? link(`/profile.html?u=${encodeURIComponent(user.username)}`, user.username, ["/profile.html", "/profile"])
      : link("/login.html", "Log in", ["/login.html", "/login"]),
  );
}

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

renderNav();
