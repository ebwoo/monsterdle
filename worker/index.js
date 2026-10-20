// The server side of Monsterdle: everything under /api/. All other addresses are
// the normal website files, served straight from the repository.
import { changePassword, currentUser, login, logout, register, tokenFrom } from "./auth.js";
import { HttpError, ensureSchema, json, prune, readJson } from "./db.js";
import { claimRounds, clip, loadConfig, makeGuess, roundView, startRound, summary } from "./rounds.js";
import { bestRun, history, leaderboard, profile } from "./stats.js";

async function route(request, env, ctx, url) {
  const method = request.method;
  const path = url.pathname;
  const config = await loadConfig(env, request);
  const user = await currentUser(env, request);
  // A login the server doesn't recognise (expired, or the account is gone): say so,
  // so the page can log out instead of silently playing as a guest while showing a name.
  const accountRoutes = ["/api/login", "/api/register", "/api/logout"];
  if (!user && tokenFrom(request) && !accountRoutes.includes(path)) {
    throw new HttpError(401, "Your login has expired. Please log in again.");
  }
  let m;

  // Each finished round reply also carries the player's stats for that mode.
  const withStats = async (round) => ({
    round: roundView(round),
    stats: user && round.user_id === user.id ? await summary(env, user.id, round.mode, round.play_type) : null,
  });

  if (method === "POST" && path === "/api/register") return json(await register(env, await readJson(request)));
  if (method === "POST" && path === "/api/login") return json(await login(env, await readJson(request)));
  if (method === "POST" && path === "/api/logout") {
    await logout(env, request);
    return json({ ok: true });
  }
  if (method === "GET" && path === "/api/me") {
    if (!user) throw new HttpError(401, "Not logged in.");
    return json({ user: { username: user.username } });
  }
  if (method === "POST" && path === "/api/password") {
    if (!user) throw new HttpError(401, "Not logged in.");
    await changePassword(env, user, await readJson(request));
    return json({ ok: true });
  }
  if (method === "POST" && path === "/api/claim") {
    if (!user) throw new HttpError(401, "Not logged in.");
    await claimRounds(env, user, (await readJson(request)).roundIds);
    return json({ ok: true });
  }
  if (method === "POST" && path === "/api/round/start") {
    if (Math.random() < 0.02) ctx.waitUntil(prune(env));
    return json(await withStats(await startRound(env, config, user, await readJson(request))));
  }
  if (method === "POST" && (m = path.match(/^\/api\/round\/([\w-]+)\/guess$/))) {
    return json(await withStats(await makeGuess(env, config, user, m[1], await readJson(request))));
  }
  if (method === "GET" && (m = path.match(/^\/api\/clip\/([\w-]+)$/))) return clip(env, config, request, m[1]);
  if (method === "GET" && (m = path.match(/^\/api\/profile\/([\w]+)$/))) return json(await profile(env, config, user, m[1]));
  if (method === "GET" && (m = path.match(/^\/api\/profile\/([\w]+)\/best-run\/([\w-]+)$/))) {
    return json(await bestRun(env, config, m[1], m[2]));
  }
  if (method === "GET" && (m = path.match(/^\/api\/profile\/([\w]+)\/history$/))) {
    return json(await history(env, config, user, m[1], url.searchParams));
  }
  if (method === "GET" && path === "/api/leaderboard") return json(await leaderboard(env, config));
  throw new HttpError(404, "Not found.");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Audio is only handed out through /api/clip/, so file names can't give answers away.
    if (url.pathname.startsWith("/audio/")) return new Response("Not found", { status: 404 });
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      await ensureSchema(env);
      return await route(request, env, ctx, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Something went wrong on the server. Try again in a moment." }, 500);
    }
  },
};
