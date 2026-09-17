# CI Project Dashboard

Every tool and project in flight, in one place: what stage it is at, what the next step is, and what needs attention. Port 4870.

## Running it

Double-click **`Start Project Dashboard.bat`**, the same as the other CI apps. It seeds the database on first run, opens your browser, and keeps the server up until you close the window. Running it a second time notices the dashboard is already up and just opens the browser.

No dependencies and no `npm install`. Node 22 or newer, for the built-in `node:sqlite`.

From a terminal, use `node server.js` rather than `npm start`. PowerShell's execution policy blocks `npm.ps1` on this machine:

```
npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running scripts is disabled
```

That is a PowerShell restriction, not an npm or app problem. `node server.js` sidesteps it, and so does `npm.cmd start`. The batch file avoids it too, because `.bat` runs under `cmd.exe`, which the policy does not touch. Note that `&&` is not a valid separator in PowerShell 5.1 either, so chain with `;` or run the commands on separate lines.

First run only, if you are not using the batch file:

```bash
node src/seed.js
```

## The idea

A tracker that needs hand-updating rots in a fortnight. This one derives most of its state from evidence already on disk, and asks you to maintain exactly two fields: **stage** and **next step**.

## What you see

The main view is a grid of **tiles**, one per project, split into three bands top to bottom:

| band | what lands here | why |
|---|---|---|
| **In motion** | active stage (idea, building, testing, handoff) with at least one open step | the work. Badges first, then priority |
| **Needs a next step** | active stage, empty checklist | tick off the last step and a project drops here on its own. Empty is the good state |
| **Live & parked** | live, paused, done, and ideas with nothing queued | compact, faded tiles. Live things sort first, and a live project with a queued step or a badge still shows it |

Stage decides whether a project is active; the checklist decides whether there is anything to do. Nothing else moves tiles between bands, so the layout is predictable.

## Kind

Kind answers one question: **what sort of thing is this, and therefore how do you treat it?** The first set mixed that up with who the work was for and how big it felt, so nothing could be filed with confidence. These six are meant to be mutually exclusive:

| kind | means | examples |
|---|---|---|
| 🛠️ **Tool** | software you built or are building; usually a folder, often a port and a repo | AR Tracker, Sitecap, Device Manager, this dashboard |
| 📦 **Client work** | output that goes to a client account | Project Amplify, Fidelity / Alight reports |
| 🔁 **Recurring** | comes back on a cadence; you run it rather than finish it | SoHo tracker, TAP invoices, the newsletter, screenshot extraction |
| 🔭 **Exploring** | still working out the shape; no agreed deliverable yet | sales intel synthesis, product matrix automation |
| 🤝 **Partner-led** | someone else is building it; you steer, review and unblock | Sebastian's change monitoring |
| 🏡 **Personal** | not CI work | Sandbagger |

**The tie-breaker**, for anything that looks like two at once: if the work right now is *building* it, it's a Tool; if the work is *running* it, it's Recurring. TAP Cost Tracker is software you wrote, but what you actually do each month is feed it invoices, so it files under Recurring.

The definitions are on screen, not just here. Hover a filter chip at the top for its one-liner, and the detail panel shows the definition of whichever kind is selected.

One honest wrinkle: **Personal** is a different axis from the other five. A personal project is also a tool. It stays a kind because there's exactly one of them, and a separate "is this CI work" flag would cost a column and a filter to serve a single row. If personal work grows, that's the time to split it out.

Each tile has its own emoji and colour, a stage pill, the next step, a five-segment progress bar (idea to live), and three "pulses" showing how recently git, Claude and the files themselves showed signs of life. A red badge in the corner counts how many rules are firing for that project, so the whole board reads at a glance. The "New project" tile sits at the end of In motion.

Click a tile for the detail panel: the checklist, stage as clickable pills, priority, waiting-on and snooze, the evidence behind each signal, per-rule mute switches, an icon and colour picker, folder and port, transcript markers, notes, and an automatic history. Click the name to rename it.

## The checklist

Each project has a list of steps. The top unchecked one is the project's **next step**, and that is what the tile shows and what the `no-next-step` rule looks at. Everything else follows from that:

- **Add** steps with the dashed input at the bottom of the list. Enter saves and keeps focus, so you can type several in a row.
- **Check one off** with the circle. It animates out, the next step moves up, and `Completed: …` goes into the history with the date. The tile picks up a green `✓ N done` chip.
- **Reorder** by dragging the grip on the left. Whatever is on top is next.
- **Edit** by clicking the text. Enter saves, Escape cancels.
- **Completed steps** collapse under a `✓ N completed` line. Each has an undo, which reopens it at the bottom of the list, not the top.
- **Remove** with the × that appears on hover. That is for steps that turned out to be wrong, not for finished ones; finished ones get checked off so the record survives.

When the last open step is checked off, the tile goes back to "Needs a next step" and the badge returns. That is deliberate: finishing something is exactly the moment to decide what comes next.

Under the hood, steps live in their own table and `projects.next_step` is a cached mirror of the top open one, kept in sync on every change. The attention rules never needed to learn about checklists. The old single-string `next_step` values were migrated into one step each on first start.

Three other views sit behind the toggle. **Needs you** is the full attention queue as a list. **Board** is a kanban by stage with drag-and-drop. **Done** is the running record of everything you have ticked off, across every project, so progress is visible rather than just the backlog. The view you leave it on is remembered.

## The Done view

Four numbers at the top: today, this week (Monday start), the last 30 days, and the current streak of days with at least one tick. A blank today does not break the streak, since today is still in progress. Under that, a 14-day strip shaded by how many steps landed each day, then the list itself grouped by week and by day, newest first. Each row shows the step, the project it belonged to, and the time. Click a row to open that project.

The search box and kind chips apply here too, so "what did I finish on Sitecap" is one keystroke. The count on the Done tab and the "N done this week" in the header both count the current week. Days are grouped in your local time zone, so an 11pm tick counts for today. Completed steps on archived projects still appear, because finished work is finished work. Reopening a step removes it from the log.

The look is deliberately not on-brand. This is a personal tool, so it borrows Apple's rather than CI's: white shading to Apple's off-white grey down the page, SF Pro where it exists and Inter as the Windows stand-in, and the ten project hues taken from Apple's system colours. Colour is an accent on each tile, at the icon and the edge, not a wash over the card. It follows your system light or dark setting, and dark mode is a true near-black.

The heading sets the rule for everything else: **black for structure, one orange for the thing to look at.** Anything that needs you is orange (the "need you" count, the badges, the Needs a next step band, the banner). Selected states and the In motion band are black. A black badge means a data-loss risk such as unpushed commits; an orange one means something to decide; grey is a standing note. Red appears only on Delete, the remove-step ×, and scan errors, so it keeps its meaning by staying rare. Green is kept for "good": the scan dot, completed steps, and the empty Needs a next step band.

Three signals feed each project:

| source | what it reads | covers |
|---|---|---|
| `git` | last commit, ahead-of-origin, modified and untracked counts, remote | projects whose folder is a repo root |
| `fs` | newest file mtime, ignoring `node_modules`, `.git`, `data`, `uploads` | anything with a folder, including reports and decks |
| `claude` | your session transcripts in `~/.claude/projects` | anything named by a marker, including work with no folder |

The board shows the newest of the three. The detail drawer shows all of them with their evidence.

## The attention queue

The top of the page is a queue, not a board. A project appears when a rule fires:

| rule | severity | fires when |
|---|---|---|
| `unpushed` | warn | commits ahead of origin |
| `dirty` | warn | modified tracked files |
| `waiting-overdue` | act | waiting on someone for more than 7 days |
| `no-next-step` | act | active stage with an empty next step |
| `stale` | act | active stage, no activity for `stale_days` (default 14) |
| `review-due` | act | the snooze date has passed |
| `no-remote` | info | an app with no git remote, so no backup off this machine |
| `untracked` | info | untracked files in a repo |

Warnings sort above chores because uncommitted work is a data-loss risk. `paused` and `done` silence the `act` rules but not the warnings.

**Snooze** (`review_after`) silences `stale`, `no-next-step` and `no-remote` until a date. Use it for deliberately parked work: Lab Broadcast is snoozed to 2026-10-08 pending the Zoom Webinar decision.

**Mute** turns off one rule for one project permanently, via the checkboxes in the detail drawer. Two are muted at seed time, both on purpose:

- Sandbagger's `unpushed`, because the 9-commit hold is deliberate until Netlify credits refresh.
- Vendor Contracts' `no-remote`, because you declined a repo for it.

Muting matters more than it looks. A queue carrying a permanent false alarm is a queue you learn to ignore.

## Transcript markers

Markers are distinctive substrings searched for in session transcripts, such as `ar-tracking-app` or `Fluxguard`. Edit them per project in the drawer.

Hits are weighted by where they land. A marker inside a tool call is **strong** (evidence of work). The same string in prose is **weak** (evidence of discussion). Injected context is ignored, because the memory index names every project and would otherwise attribute all of them to every session.

A session counts for a project two ways:

1. **Volume**: 10 or more strong hits.
2. **Dominance**: a score of 15 or more that is at least a quarter of everything the session did.

Those numbers come from measuring the real transcripts, not from taste. Sessions that genuinely worked on something land 20 to 3,000 strong hits on it; a planning session that touches everything lands 1 to 5 on each. The dominance path exists so a quick fix still registers, and so the two initiatives with no folder (sales intel, change monitoring) can register from discussion alone.

**Do not use a marker that appears in the workspace path.** `AI Training Tool` would match every session ever recorded, because the workspace folder is `AI Training Tool for CI`.

Adding a marker forces a full re-read of the transcripts, since older ones were never searched for it. Removing one does not. A first pass over 325 MB takes about 8 seconds; after that the cache keys on file size and mtime, so a rescan is near instant.

## Privacy

Transcripts contain client material and occasionally PII. This app stores only per-project counts, timestamps, and one truncated first prompt per session. `data/dashboard.db` is gitignored and must stay on this machine.

If this is ever deployed for the team, disable the transcript scanner rather than removing it:

```sql
UPDATE settings SET value = '0' WHERE key = 'claude_scan_enabled';
```

The git and filesystem signals still work.

## Layout

```
Start Project Dashboard.bat   double-click to run
server.js          http server, API, scan job guard
src/db.js          schema, migrations, data access
src/scan.js        the three scanners, all async
src/attention.js   the rules, as a pure function of (project, now)
src/seed.js        initial projects from the current workspace
src/test.js        30 unit tests (rules, transcript weighting, checklist against a temp database)
public/            the single-page front end
data/dashboard.db  gitignored
```

```bash
npm test
```

Runs a syntax check on every file plus the rule and weighting tests. The rules are where a mistake is silent, so they are the part that is covered.

## Notes

- Binds to `127.0.0.1`. No auth, local only.
- The scan runs once at startup in the background and on demand from the header.
- The workspace root is deliberately not a project. Its untracked files are expected noise and would sit in the queue forever.
- Cowork sessions (Project Amplify) do not write to `~/.claude/projects`, so Amplify's only activity signal is file mtimes.
