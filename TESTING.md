# Accounts, leaderboards & testing

This branch adds a small server (a Cloudflare Worker in `worker/`) and a database
(Cloudflare D1) for accounts, stats and leaderboards. The server now picks each
puzzle and checks every guess, so answers can't be read out of the page.

## One-time setup in Cloudflare (before merging to `main`)

1. **Create the database.** In the Cloudflare dashboard, go to
   **Storage & databases → D1 SQL database → Create database**, name it `monsterdle`,
   and click **Create**. Copy its **Database ID**.
2. **Put the ID in `wrangler.jsonc`.** Replace `00000000-0000-0000-0000-000000000000`
   with your Database ID. The tables are created automatically on first use.
3. **Check the Worker name.** `"name"` in `wrangler.jsonc` must match your Worker's
   name in the dashboard (the name at the top of its page, also in its `workers.dev`
   address). It's set to `monsterdle`; change it if yours is different.

## Testing on your computer (recommended)

Needs [Node.js](https://nodejs.org) (the LTS version) installed once.

```sh
git fetch origin
git checkout accounts-and-leaderboards
npx wrangler dev
```

Open <http://localhost:8787>. Everything works locally, including accounts, the
leaderboard and profiles, using a private test database on your computer (stored in
`.wrangler/`, never uploaded). You don't need the Cloudflare setup above for this.
Press `Ctrl+C` in the terminal to stop it.

To start over with an empty test database, stop the server and delete the `.wrangler` folder.

## Testing on Cloudflare before going live (optional)

1. Do the one-time setup above and push it to this branch.
2. In the dashboard, open your Worker → **Settings → Build** and make sure
   **Builds for non-production branches** is turned on.
3. Every push to this branch then creates a **preview** with its own link (shown in the
   build log and under **Deployments**). Your live site doesn't change.

Previews use the **real** database, so accounts you create while testing show up on
the real leaderboard later. Use obvious test names and delete them afterwards if you like.

## Going live

When you're happy, merge the branch into `main` (on GitHub: open a pull request from
`accounts-and-leaderboards` and click **Merge**, or locally `git checkout main && git merge accounts-and-leaderboards && git push`).
Cloudflare deploys it within a minute or two.

## Where things are

| File | What it does |
|---|---|
| `worker/index.js` | The server's address list (`/api/...`) |
| `worker/auth.js` | Accounts, passwords (salted PBKDF2 hashes), logins |
| `worker/rounds.js` | Starting puzzles, checking guesses, streaks, serving audio |
| `worker/daily.js` | Daily monster, reset time zone, launch date |
| `worker/stats.js` | Profile stats and leaderboards |
| `lib/config.js` | Reads `monsters.json` (used by both the site and the server) |
| `common.js` | Shared page code: logins, navigation |
| `login.html`, `profile.html`, `leaderboard.html` | The new pages |

The reset time zone and launch date now live in `worker/daily.js`.
