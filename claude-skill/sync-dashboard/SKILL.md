---
name: sync-dashboard
description: Read Matt's recent Claude sessions, commits and memory notes, work out what progress happened outside the Mission Control project dashboard, and post suggested updates (tick off steps, add next steps, change stage, add history entries, set waiting-on) for him to review and apply in the app. Use when Matt types /sync-dashboard or asks to sync, update or catch up the project dashboard. Optional argument: how far back to look, like "30d" or "2026-09-20".
---

# Sync the project dashboard

The dashboard (Mission Control, Node app on http://localhost:4870) tracks each
project's stage and checklist. Work mostly happens in Claude sessions outside
it, so the board falls behind. Your job is to read the evidence since the last
sync and **propose** updates. You never apply them. Matt ticks the ones that are
right in the app's **Suggested** tab.

Precision matters more than coverage. A suggestion list that is mostly wrong
gets ignored. Propose only what the evidence plainly shows, and skip a project
when nothing is clear.

## 1. Fetch the context

Use the Bash tool. Save to the session scratchpad (or any temp folder). Pass the
argument through as `since` if Matt gave one:

```bash
curl -s -m 120 -o "<scratchpad>/dash-context.json" -w "%{http_code}" "http://localhost:4870/api/suggestions/context?since=<arg or empty>"
```

- **Connection refused or 000:** the dashboard is not running. Tell Matt to
  double-click `Start Project Dashboard.bat` in
  `CI Web Apps/My Project Dashboard/project-dashboard-app`, then run
  /sync-dashboard again. Stop here.
- **404 "no such route":** an older build is running. Tell Matt the dashboard
  needs a restart to pick up the sync feature. Stop here.

The call runs a quick rescan first, so it can take a few seconds.

## 2. Read it

Read the file with the Read tool, paging through with offset and limit if it is
long. What it holds:

- `as_of`: keep this; you send it back in step 4.
- `since`: the start of the window.
- `projects[]`: `id`, `name`, `stage`, `waiting_on`, `open_steps[]` (each with
  an `id`), `recently_done[]`, and the evidence: `commits[]` and `sessions[]`.
  Each session has `prompts` (what Matt typed) and `turn_summaries` (Claude's
  last message before handing back, which is where "done, pushed, next is X"
  lives). Projects with `has_evidence: false` have no new commits or sessions.
- `memory_notes[]`: memory files changed in the window. These are curated
  status notes ("all 5 batches pushed 2026-09-28") and are strong evidence.
- `open_suggestions[]`: already waiting for Matt. Do not repeat them.

The digests can contain client names or personal details from research work.
Do not copy those into suggestion text beyond what the update needs.

## 3. Decide what to suggest

For each project with evidence, consider these five types:

| type | payload | when |
|---|---|---|
| `complete_step` | `{ "step_id": 21, "done_at": "2026-09-30" }` | An open step's outcome clearly happened: a commit, a wrap-up saying done or pushed, or a memory note. `done_at` is the day it happened. |
| `add_step` | `{ "text": "..." }` | Someone stated a concrete next action or remaining work ("next is", "still to do", "waiting to push", "phase 6 remains"). Not ideas, not maybes. |
| `set_stage` | `{ "stage": "live" }` | A clear transition. idea to building when the build started. building or testing to live when people are using it. To paused when Matt said to park it. To done when it is finished for good. Stages: idea, building, testing, handoff, live, paused, done. |
| `add_log` | `{ "text": "...", "at": "2026-09-30" }` | A milestone worth keeping in the project's history: shipped, pushed, decided, handed off, a meaningful finding. At most one per project per day. Never for routine commits. |
| `set_waiting` | `{ "waiting_on": "Drew" }` | Progress is blocked on a named person or outside event. Use `""` to clear it when that wait is over. |

Rules:

- Match `complete_step` to the step's **id** from `open_steps`. If no open step
  matches, the work may still merit an `add_log`.
- Do not suggest what `recently_done` or `open_steps` already says.
- Two to four suggestions per project is plenty. Zero is fine.
- Every suggestion needs a `reason` (one sentence, why this is right) and
  `evidence` (where you saw it: `Session 4dab2491, Sep 30: "everything is
  pushed"`, `Commit Sep 30: "Rename the app to Hangar"`, or
  `Memory note project_golf-app.md`).
- Text Matt will keep (step text, history entries) is short and plain. Write
  "is" rather than "serves as", no em dashes, no promotional words. A step reads
  as an action ("Send the Hangar launch email to all of CI"). A history entry
  reads as a fact ("Shipped design batches 1 to 5 and renamed the app Hangar").

## 4. Post the suggestions

Write the body to a JSON file with the Write tool, then:

```bash
curl -s -m 30 -X POST -H "Content-Type: application/json" --data-binary "@<scratchpad>/dash-suggestions.json" http://localhost:4870/api/suggestions
```

Body shape:

```json
{
  "as_of": "<as_of from the context>",
  "suggestions": [
    { "project_id": 9, "type": "complete_step", "payload": { "step_id": 21, "done_at": "2026-09-30" },
      "reason": "...", "evidence": "..." }
  ]
}
```

Post even when you found nothing (`"suggestions": []`). That records the sync,
so the next one starts from here. The response says how many were `added` and
lists any `skipped`, with the index and the reason. A skip for "suggested
before" is normal (Matt already applied or dismissed it). For any other skip,
fix and repost only those items if the fix is obvious.

## 5. Report back

Keep it short:

- How many suggestions you posted, grouped by project, one line each.
- Anything you noticed but chose not to suggest because the evidence was thin.
- The link: http://localhost:4870/#suggested

Do not apply suggestions, edit the database, or change memory files as part of
this skill.
