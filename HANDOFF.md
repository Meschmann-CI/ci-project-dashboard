# Mission Control (CI Project Dashboard): handoff

Read this first, then `ARCHITECTURE.md` (the design, with review notes) and `README.md`.

## Current state, 2026-10-08

- Live on port 4870, launched by `Start Project Dashboard.bat`, launch.json `project-dashboard`.
  Repo `Meschmann-CI/ci-project-dashboard` on Matt's personal account (his choice; it is a
  personal tool). Everything is pushed through 334ce98.
- The 2026-10-06 "Mission Control" design review is fully built: line-glyph icons, Home with
  Up next, Needs you grouped per project with actions, read-first drawer, Wins, moments.
- Matt maintains only **stage** and the **checklist of steps**. Everything else is derived by
  three scanners: git state, newest file mtime, Claude transcripts.
- Suggested tab (added 2026-10-06): scan rules in `src/suggest.js` plus the `/sync-dashboard`
  skill. The skill's source is `claude-skill/sync-dashboard/SKILL.md`; the installed copy is at
  `~/.claude/skills/sync-dashboard/`. Keep the two in step.
- 22 project rows in the live DB as of 2026-10-08. One has a dead path: "Video screenshot
  extraction" points at `Video Test`, which no longer exists.

## Next actions

1. Fix or archive the "Video screenshot extraction" row (path `Video Test` is gone).
2. Consider rows for the tools with none: Sitecap Bridge, the toolkit, Panel Management
   Platform, Soho ticket tracker, the Web Monitor guide (it is a marker on "Website change
   monitoring" today).
3. Restart the live server after any `server.js` or `src/` change (see the recipe below).

## Traps

- **Transcript attribution thresholds are measured, not guessed.** A session counts for a project
  on volume (10+ strong hits) or dominance (score 15+ and a quarter of the session). With a naive
  "one tool call is enough" rule every project showed today as last-touched, because a planning
  session mentions all of them. Any change to attribution must pass the same check: does a survey
  session attribute nothing?
- `git rev-parse --is-inside-work-tree` is true for any folder inside the workspace repo. The
  scanner requires `--show-toplevel` to equal the folder (case-insensitive). Any tool that walks
  these folders hits the same thing.
- Folder moves break project paths silently. When a tile shows no signals, check
  `activity.fs.detail.exists`. Paths were fixed via the live API on 2026-10-06 (Product Matrix,
  TAP, SharePoint tracker, the dashboard's own tile).
- Adding a marker forces a full re-read of all transcripts (about 8 s); the cache keys on file
  size, mtime and marker set.
- `npm start` fails in PowerShell (execution policy blocks `npm.ps1`); `node server.js` or the
  .bat work.
- The API refuses requests without a JSON content type and checks the Host header; curl needs
  `-H "Content-Type: application/json"`.
- `data/dashboard.db` holds session prompts. It stays on this machine. If the app is ever shared,
  set `claude_scan_enabled` to 0 rather than removing the scanner.
- Restart recipe: take a `VACUUM INTO` snapshot into `data/` first, stop the node process and
  the cmd window that started it, then `Start-Process` the .bat. The .bat's first-run check lost
  its backslashes once (`datadashboard.db`); fixed in 334ce98.
- The browser pane is about 520 px wide; screenshots for review pages come from headless Edge
  over CDP, and leftover Edge processes must be killed by their private profile path.
- The three Sep 8-9 completions were re-dated to 2026-09-14 at Matt's request so launch week
  counted. Deliberate; do not restore. Snapshot `data/dashboard-before-redate-20260917-2111.db`.

## Decisions not to reopen

- **Palette rule:** black for structure, orange (#ff9500, #c05600 text) for anything needing
  attention, red only for destructive or error. The black heading with the orange period is
  locked. No CI navy/teal here; it is a personal tool and brand rules do not apply.
- Type: Apple system stack with Inter as the Windows stand-in. White background shading to
  #f5f5f7.
- Kinds answer "what sort of thing is this": tool, client, recurring, exploring, partner,
  personal. Building it = tool, running it = recurring.
- Bands on Home: In motion (active stage, open steps), Needs a next step (active, no steps),
  parked dock (live/paused/done). `bandOf()` in `public/app.js`.
- Per-rule mutes exist so permanent false alarms (Sandbagger unpushed on purpose, Vendor app
  with no remote) do not train Matt to ignore the queue.
- Suggestions come from both scan rules and the skill, on demand, never scheduled. Nothing
  changes until he applies it; dismissed fingerprints never return.
- Done is called Wins. Night-shift dark mode was declined.

## Where things live

```
server.js                http server, API routes, scan job guard
src/db.js                schema, migrations, KIND_INFO, GLYPHS, steps, syncNextStep
src/attention.js         pure rules engine for the Needs you queue
src/scan-*.js            git, fs mtime and Claude transcript scanners
src/suggest.js           Suggested tab rules
src/seed.js              first-run project list (paths drift; the live DB is the truth)
public/app.js, glyphs.js, styles.css
claude-skill/sync-dashboard/SKILL.md   source of the /sync-dashboard skill
data/dashboard.db        live DB, gitignored; manual snapshots beside it
```
