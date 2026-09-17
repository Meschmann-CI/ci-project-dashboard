# CI Project Dashboard: architecture

Status: proposed 2026-09-08 (Opus), reviewed and revised 2026-09-08 (Fable). Approved to build. Port 4870.

Build from this version. The "Review notes" section at the end lists what changed from the first draft and why, so the builder does not re-introduce the original problems.

## The problem it solves

Matt runs roughly a dozen tools and projects at once, most of them built and maintained through Claude sessions. Nothing today answers, in one place: what stage is each thing at, what is the next step, who is it waiting on, and which ones have gone quiet. The Claude memory files hold fragments of this but they are per-topic and not built for scanning.

The failure mode to design against: a tracker that needs hand-updating rots within two weeks. So the dashboard derives as much as it can from evidence already on disk, and asks a person to maintain only two fields a machine cannot infer: **stage** and **next step**.

## What counts as a project

Anything Matt would want to see on the board. Not only code. Kinds:

| kind | examples |
|---|---|
| app | AR Tracker, Device Manager, Sitecap, Vendor Contracts, Lab Broadcast, Web Tools, Training Tool |
| deliverable | Project Amplify reports, The CI Prompt newsletter, Alight/Fidelity firm profiles |
| initiative | Sales intel synthesis (ZoomInfo + Gong + Salesforce), website change monitoring (Sebastian) |
| ops | SharePoint upgrade tracker, git repo hygiene |
| research | video screenshot extraction workflow |
| personal | Sandbagger golf app |

A project may or may not have a folder, and may or may not be a git repo. The schema treats both as optional. The workspace root itself is **not** a project: its 10 dirty files are deliberate untracked noise, and listing it would keep a permanent false alarm in the queue.

## Three automatic signals

Each project gets a "last activity" per source. The card shows the newest of the three, and the detail view shows all of them with their evidence.

**1. git** (for projects whose folder is a repo)
Last commit date and message, remote URL, ahead-of-origin count, and two separate dirty counts: modified tracked files, and untracked files. Run via `execFile('git', ['-C', path, ...])` with an args array (the workspace path contains spaces and a comma, so never build a shell string). Asynchronous, never `execFileSync`, so the HTTP server stays responsive during a scan.

**2. fs** (any project with a folder)
Newest mtime of any file under the folder, ignoring `node_modules`, `.git`, `data/`, `uploads/`, and `*.db*`. This covers work with no repo (Amplify, newsletter, Alight). Async walk with `fs.promises.readdir(..., {withFileTypes: true})`, depth cap 6, and a per-project file cap of 20,000 so a screenshot dump cannot stall the scan. Node handles paths past 260 chars, so MAX_PATH is not a concern here. OneDrive on-demand placeholders stat without hydrating.

**3. claude** (session transcripts)
Every `*.jsonl` under every directory in `~/.claude/projects/` (use `os.homedir()`; today there is one workspace dir with 37 files totalling 325 MB, but a session opened from a subfolder would create a second dir). Subagent transcripts in per-session subdirectories are included; `tool-results/` folders are skipped.

Full JSON parsing on every scan is too slow. Instead:

- Each project has a list of **markers**: short substrings such as `ar-tracking-app`, `binder-viewer`, `golf-app`, `Project Amplify`. Seeded from folder names; editable in the UI.
- The scanner streams each transcript line by line (`readline` over a read stream) and does plain substring matching against all markers. Only lines that hit a marker get `JSON.parse`d, to read `type` and `timestamp`.
- **Hits are weighted by where they occur**, because the memory index is injected into about a third of sessions and names every project a few times, and any planning session (like the one that produced this document) mentions everything:
  - **strong**: the hit is inside a `tool_use` record (a file path or command aimed at the project). This is evidence of work.
  - **weak**: the hit is in a `user` or `assistant` record. Evidence of discussion.
  - **ignored**: the line contains `system-reminder` (injected context), or the record type is anything else.
  - A session is attributed to a project when `strong >= 1` or `weak >= 5`. Both counts are stored so the threshold can be tuned without rescanning.
- Per-file results are cached in `scan_cache` keyed by `(size, mtime_ms, markers_version)`. `markers_version` is a settings counter bumped whenever any marker is added, removed, or edited; a mismatch forces that file to be re-read. Without this, a new marker would never be found in old transcripts. After the first pass a rescan touches only files that grew, so it is sub-second.
- Output per project: attributed session count, last attributed session timestamp, and the first human prompt of the most recent attributed session, truncated to 200 characters (so the card can say: last session, "fix the Amica double count").

Measured on the current transcripts: real work sessions hit their project's marker 500 to 3,000 times, nearly all in `tool_use` records; cross-mention noise is 1 to 25 hits per session, nearly all in `user`/`assistant` records. The weighting separates them cleanly.

A marker hit means a session worked on or discussed the project. It does not prove progress. Good enough for "when did I last touch this," which is the question being asked.

## Attention rules

The top of the page is a queue, not a board. A project appears in the queue when any rule fires, and each entry says what to do about it. Rules, in severity order:

| rule | severity | fires when | shown as |
|---|---|---|---|
| unpushed | warn | git ahead of origin > 0 | "9 commits unpushed" |
| dirty | warn | modified tracked files > 0 | "3 uncommitted changes" |
| waiting-overdue | act | `waiting_on` set and `waiting_since` > 7 days ago | "Chase Drew (12 days)" |
| no-next-step | act | stage is `building`/`testing`/`handoff` and `next_step` empty | "Needs a next step" |
| stale | act | stage is `building`/`testing`/`handoff` and newest activity across all sources > `stale_days` ago (default 14) | "Quiet for 21 days" |
| review-due | act | `review_after` date has passed | "Review date passed" |
| no-remote | info | kind is `app`, folder exists, and either not a git repo or no remote | "No backup outside this machine" |
| untracked | info | untracked files > 0 in a repo | "4 untracked files" |

Queue ordering: severity, then project priority, then age of the condition.

**Snoozing.** `review_after` suppresses `stale`, `no-next-step`, and `no-remote` until that date. That is how a deliberately parked project (Lab Broadcast, pending the Zoom Webinar trial) stays off the queue without being marked done.

**Muting.** Each project has a `muted_rules` list. A muted rule still computes and still shows on the card as a grey chip, but does not enter the queue. Needed today: the golf app is 9 commits ahead of origin by design (pushes are on hold until Netlify credits refresh). Without muting, `unpushed` would nag forever and Matt would learn to ignore the queue, which defeats it. Mutes are per rule so muting `unpushed` on the golf app does not hide a future `dirty`.

`paused` and `done` stages suppress the `act` rules. They do not suppress `unpushed` or `dirty`, because uncommitted work is a data-loss risk regardless of intent; use a mute if that is wanted.

## Data model

SQLite via `node:sqlite` (built in on Node 22+, no native compile, same as the other CI apps). `DatabaseSync` is synchronous, which is fine for one user; keep scan writes batched in a transaction per scan so the UI does not read a half-written state.

```
projects    id, slug, name, kind, summary, path, repo_url, port,
            stage, priority, next_step, waiting_on, waiting_since,
            review_after, stale_days, muted_rules (JSON array),
            notes, archived, sort, icon, color, created_at, updated_at
steps       id, project_id, text, done, done_at, sort, created_at
            -- added 2026-09-08. A project's checklist. projects.next_step is a
            -- cached mirror of the first open row, resynced on every step change,
            -- so attention.js and the tiles still read one string. Completing a
            -- step writes a 'done' row to log. Old next_step values were migrated
            -- into one step each, guarded by settings.steps_migrated.
markers     project_id, marker
activity    (project_id, source) -> last_at, detail JSON, scanned_at
scan_cache  file -> size, mtime_ms, markers_version, session_start,
            session_end, first_prompt, hits JSON { marker: {strong, weak, last_ts} }
log         project_id, at, kind, text        -- human-readable changelog
settings    key, value                         -- workspace_root, claude_projects_dir,
                                               -- markers_version, last_scan_at, last_scan_summary
```

Stages: `idea → building → testing → handoff → live`, plus `paused` and `done` as off-ramps. Deliverables and initiatives use the same list; `done` is the terminal state for a shipped report.

The `log` table records stage changes, next-step changes, and waiting-on changes automatically, so a project's detail view shows its own history without anyone writing it. Field edits in the UI save on blur or Enter, not per keystroke, so the log does not fill with partial edits.

`waiting_since` is stamped automatically when `waiting_on` goes from empty to set, and cleared when it goes back to empty.

## Server

Node built-in `http`, zero npm dependencies (no `npm install` to run through the Fortinet TLS interception). Static files from `public/` with the resolved path checked to stay inside `public/`. JSON API under `/api/`:

```
POST   /api/projects/:id/steps            add a step (returns the full project)
PATCH  /api/projects/:id/steps/:sid       {text?, done?}  completing logs 'Completed: …'
DELETE /api/projects/:id/steps/:sid
POST   /api/projects/:id/steps/reorder    {ids: [...]}  open steps in the wanted order
GET    /api/projects              list with activity and computed attention flags
POST   /api/projects              create
GET    /api/projects/:id          full record with log
PATCH  /api/projects/:id          partial update (fields and/or markers and/or muted_rules)
DELETE /api/projects/:id
POST   /api/projects/:id/log      add a note
POST   /api/scan                  start a scan if none is running; returns 202 immediately
GET    /api/scan/status           running flag, progress (files done / total), last scan time and summary
```

Attention flags are computed server-side in one place (`src/attention.js`) so the UI and any future notifier agree. `attention.js` is a pure function of a project record plus a "now" timestamp, which is what makes it unit-testable.

Scanning is a single async job guarded by a module-level "running" flag; a second `POST /api/scan` while one runs returns the existing status rather than starting another. The scan runs once at startup and on demand. No timer: the page is opened when Matt wants to look, and after the first run a scan takes a few seconds.

Binds to `127.0.0.1` only.

## UI

**Revised 2026-09-08 after first use.** Matt wanted a project-first layout he could scan in a glance, with far more colour and personality, and said the CI brand guidelines do not apply because this is a personal tool. The queue-first layout below was replaced by a tile grid; the queue and the board survive as secondary views. Each project gained an `icon` (emoji) and `color` (one of ten named hues) column, added by an `ALTER TABLE` migration in `db.js` and backfilled by the seed. The rest of this section is the original v1 layout, kept for the record.

**Kinds rewritten 2026-09-17.** The original six (app, research, deliverable, ops, initiative, personal) answered three different questions at once, so Matt could not tell which to pick. Replaced with tool / client / recurring / exploring / partner / personal, which all answer "what sort of thing is this". Each carries an icon, label and one-line definition in `KIND_INFO` in `db.js`, served through `/api/meta` and shown in the UI: as a `title` on the filter chips, and as a six-button picker with the selected definition underneath in the detail panel. Migrated by a blanket map plus three slug-specific corrections, guarded by `settings.kinds_v2`; anything unrecognised falls back to `tool`. The `no-remote` rule now keys on `tool` rather than `app`. `personal` remains a kind although it is strictly a different axis, on the grounds that one row does not justify a column.

**Palette settled 2026-09-17, later the same day.** Matt liked the black heading with the orange full stop and asked for that to drive the rest; the red "4 need you" under it clashed. Rule adopted: black for structure and selected states, one orange (`--accent` #ff9500, `--accent-text` #c05600 for text on white) for everything that needs attention, red (`--alarm`) reserved for destructive controls and errors only. Severity now maps to fill rather than hue family: `warn` (data loss) is a black badge, `act` an orange one with a black numeral, `info` grey. Band tones follow: In motion black, Needs a next step orange, parked grey. Green stays for "good" states only. `--amber` is now an alias of `--accent`.

**Restyled 2026-09-17.** The first pass used Fraunces and Manrope on a beige paper background with a grain overlay. Matt did not like the beige or the type, and asked for white (or a white gradient) and "an Apple type font". Now: a white to `#f5f5f7` vertical gradient, the grain removed (on white it reads as dirt), and the system stack `-apple-system, BlinkMacSystemFont, "SF Pro Display"/"SF Pro Text", Inter, "Segoe UI"`. macOS and iOS get real SF Pro and never fetch a webfont; Windows falls to Inter from Google Fonts, which is the closest available match. Display weights dropped from 800/900 to 700 with tighter tracking, which is what a grotesque wants. The ten project hues became Apple's system colours, and the tile tint dropped from 22% to 11% so colour reads as an accent against white. Red split into two tokens: `--alarm` for fills and `--alarm-text` (`#d70015`) for text on white, because Apple red at `#ff3b30` is under 4.5:1 as body text.

Vanilla JS single page. Originally CI palette (#172851 navy, #007E8F teal, Heebo), matching the other internal apps.

1. **Scan status bar**: last scan time, or a progress indicator while the first pass streams 325 MB. Until the first scan completes, cards show "not yet scanned" rather than firing `stale` on everything.
2. **Attention queue** at the top. One line per firing rule, grouped by project, severity-ordered. Each line has the action verb. Muted rules do not appear here. Empty state: "Nothing needs you."
3. **Board** below, columns by stage. Cards show name, kind chip, priority dot, next step, last activity per source ("git 3d · claude 1d · files 2h"), and flag chips (muted ones grey). Drag between columns changes stage.
4. **Detail drawer** on click. Every field editable inline. Shows all three activity sources with their evidence (last commit message, last session prompt, newest file path). Per-rule mute toggles. Markers editable as chips; editing a marker bumps `markers_version`. Shows the log and a note box.
5. **Filters**: kind, priority, show archived. Search by name.

## Seeding

`src/seed.js` creates the initial rows from what is on disk today, with stage and next step filled in from the current memory files. Idempotent (skips slugs that exist), so it can be rerun when a new app folder appears. It also writes the initial `settings` rows (workspace root, Claude projects dir).

Known seed values as of 2026-09-08:

| project | stage | next step / waiting on | mutes |
|---|---|---|---|
| AR Tracker (port 4850) | building | Await Matt's re-export of Drew's Feed 1 with Opportunity ID and Owner Email, then build the Opportunity-ID importer; waiting on Matt | |
| Device Manager (4830) | live | none | |
| Sitecap (4840) | handoff | Azure port via Soho/Tom; waiting on Soho/Tom | |
| Vendor Contracts (4820) | testing | SMTP credentials; Matt declined a GitHub repo for now | no-remote |
| Lab Broadcast (4860) | paused | review_after: set when Matt decides on the Zoom Webinar trial | |
| Web Tools (Process Mapper, Prompt Library) | live | none | |
| AI Training Tool | live | accessibility work deliberately deferred; set review_after | |
| Sandbagger (5173) | live | push when Netlify credits refresh; waiting on Netlify | unpushed |
| Project Amplify | building | confirm with Matt | |
| The CI Prompt newsletter | building | confirm with Matt | |
| Sales intel synthesis | idea | Gong connector status unknown; Salesforce prod via mcp-remote | |
| Website change monitoring | building | Sebastian owns build; waiting on Sebastian | |
| SharePoint upgrade tracker | building | confirm with Matt | |

Rows marked "confirm with Matt" get seeded with an empty next step so `no-next-step` fires and he fills them in from the UI on first use.

## Privacy

Transcripts contain client material and occasionally PII. The dashboard stores only per-project counts, timestamps, and one truncated first prompt per session in `data/dashboard.db`. That database is gitignored and must stay on this machine. If the app is ever deployed for the team, the `claude` scanner is disabled by config, not removed, because the other two signals are still useful.

## Out of scope for v1

- Notifications (email, Teams). The attention rules are structured so a later `notify.js` can consume `attention.js` output unchanged.
- Reading the memory `.md` files automatically. They are prose; the seed reads them once by hand.
- Multi-user or auth. Local only, same as Vendor Contracts before deployment.
- Tracking Claude Cowork sessions (Amplify). Those do not write to `~/.claude/projects`; Amplify's activity comes from the fs signal only.

## Layout

```
CI Web Apps/Project Dashboard/project-dashboard-app/
  server.js           http server + API routes + scan job guard
  src/db.js           schema, migrations, data access
  src/scan.js         git, fs, and transcript scanners (all async)
  src/attention.js    the rules table above, as a pure function
  src/seed.js         initial projects from the current workspace
  src/test.js         syntax check + attention rule unit tests + marker weighting test
  public/index.html
  public/app.js
  public/styles.css
  data/dashboard.db   gitignored
```

Add a `project-dashboard` entry to the workspace `.claude/launch.json` on port 4870.

Own repo later (`Corporate-Insight/ci-project-dashboard`) following the repo-per-app convention; app-rooted `.gitignore` with `**/` patterns, not path-anchored ones.

## Review notes (Fable, 2026-09-08)

The first draft was sound in shape. These are the changes, each tied to something observed on this machine.

1. **Marker weighting and thresholds.** Tested against all 37 transcripts. The memory index is injected into 10 of them and mentions every project 1 to 11 times; planning sessions mention everything. Unweighted counting would have attributed every project to the most recent session. Fixed by weighting `tool_use` hits over `user`/`assistant` hits, ignoring `system-reminder` lines, and requiring `strong >= 1` or `weak >= 5`.
2. **Cache invalidation on marker change.** The draft cached per file by size and mtime only. Adding a marker would never find it in already-scanned transcripts. Added `markers_version` to the cache key.
3. **Per-rule mutes.** The draft said `unpushed` and `dirty` are never suppressed. The golf app is 9 commits ahead on purpose (Netlify hold), so the queue would have carried a permanent false alarm from day one. Added `muted_rules`.
4. **Async scanning.** The draft said the startup scan runs "in the background" but used `execFileSync`, which blocks the event loop. Changed to async `execFile` and async fs walks, with a running-flag guard and a progress endpoint so the UI can show first-scan state instead of firing `stale` on every card.
5. **Dirty split.** `git status --porcelain` counts untracked files as dirty. The workspace root has 10 such files that are deliberate. Split into `dirty` (modified tracked, warn) and `untracked` (info), and excluded the workspace root as a project.
6. **No-remote rule.** The memory notes that the AR, vendor, and device databases have no backup outside this machine. That is exactly the kind of quiet risk the queue exists to surface, so it is now a rule rather than a note.
7. **Scan all Claude project dirs.** The draft assumed one `~/.claude/projects/<workspace>` dir. Opening Claude from a subfolder creates another. Now globs the parent.
8. **Privacy section.** Transcripts carry client material; the doc now states what is stored and that the `claude` scanner is disabled if the app is ever deployed.
9. **Smaller items:** save-on-blur so the log does not fill with keystrokes; `attention.js` as a pure function of (project, now) so it is testable; bind to 127.0.0.1; static path traversal check; per-project fs file cap; launch.json entry.

Not changed, considered and kept: SQLite over a JSON file (the log and cache tables want indexes); zero dependencies over Express (avoids npm through the Fortinet proxy, and the API is eight routes); stage list shared across kinds (a per-kind list adds UI complexity for little gain at this size).
