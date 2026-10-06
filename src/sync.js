'use strict';
// What the /sync-dashboard skill reads: every project's current state, plus
// the evidence since the last sync. That means digests of the Claude sessions
// attributed to it, its recent commits, and any memory notes that changed. The
// skill decides what that evidence means and POSTs suggestions back.
//
// Everything stays on this machine. The server listens on 127.0.0.1 only, and
// the Claude session reading this already had these transcripts.
const fsp = require('node:fs/promises');
const path = require('node:path');
const db = require('./db');
const scan = require('./scan');
const suggest = require('./suggest');
const { digestTranscript } = require('./digest');

const DEFAULT_LOOKBACK_DAYS = 14;
const MAX_SESSIONS = 40;
const MAX_NOTES = 25;
const NOTE_MAX = 4000;
const RESCAN_IF_OLDER_MS = 2 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Attribution is only as fresh as the last scan, so bring it up to date first.
// Once the cache is warm a rescan takes a second or two.
async function freshScan() {
  const last = Date.parse(db.getSetting('last_scan_at', '') || '');
  if (!scan.state.running && (Number.isNaN(last) || Date.now() - last > RESCAN_IF_OLDER_MS)) {
    await scan.runScan();
  }
  while (scan.state.running) await sleep(300);
}

// since: '2026-09-20', '30d', or nothing for "since the last sync".
function resolveSince(since, now = new Date()) {
  const s = String(since || '').trim();
  const days = s.match(/^(\d{1,3})d$/);
  if (days) return new Date(now.getTime() - Number(days[1]) * 86400000).toISOString();
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s))) return new Date(Date.parse(s)).toISOString();
  const last = db.getSetting('last_claude_sync_at', null);
  if (last && !Number.isNaN(Date.parse(last))) return last;
  return new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 86400000).toISOString();
}

// Only main-session transcripts. Subagent transcripts sit a folder deeper and
// their "user" turns are prompts Claude wrote, not things Matt asked for.
function isMainSession(file, root) {
  return scan.samePath(path.dirname(path.dirname(file)), root);
}

async function memoryNotes(root, sinceT) {
  const out = [];
  let dirs = [];
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const memDir = path.join(root, d.name, 'memory');
    let files = [];
    try { files = await fsp.readdir(memDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      const full = path.join(memDir, f);
      try {
        const st = await fsp.stat(full);
        if (st.mtimeMs <= sinceT) continue;
        const text = await fsp.readFile(full, 'utf8');
        out.push({ file: f, modified: new Date(st.mtimeMs).toISOString(), text: text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX)}…` : text });
      } catch { /* mid-sync or locked; skip */ }
    }
  }
  out.sort((a, b) => b.modified.localeCompare(a.modified));
  return out.slice(0, MAX_NOTES);
}

async function buildContext({ since } = {}) {
  await freshScan();
  const asOf = db.nowIso();
  const sinceIso = resolveSince(since);
  const sinceT = Date.parse(sinceIso);
  const root = scan.claudeProjectsDir();

  const projects = db.listProjects();
  const recentRows = db.allCache().filter((r) =>
    r.session_end && Date.parse(r.session_end) > sinceT && isMainSession(r.file, root));
  const byProject = scan.sessionsByProject(projects, recentRows);

  // Digest each session once, newest first, even if it worked on two projects.
  const files = [...new Set([...byProject.values()].flat().map((r) => r.file))];
  const endOf = new Map(recentRows.map((r) => [r.file, r.session_end]));
  files.sort((a, b) => String(endOf.get(b)).localeCompare(String(endOf.get(a))));
  const digests = new Map();
  for (const f of files.slice(0, MAX_SESSIONS)) {
    try {
      const d = await digestTranscript(f);
      // The sync's own session would otherwise report on itself.
      if (d.commands.includes('sync-dashboard') && !d.prompts.length) continue;
      digests.set(f, { session: path.basename(f, '.jsonl').slice(0, 8), ...d });
    } catch { /* vanished or locked; skip */ }
  }

  const doneRecently = (p) => (p.steps || []).filter((s) => s.done).slice(0, 5)
    .map((s) => ({ text: s.text, done_at: s.done_at }));

  const out = projects.map((p) => {
    const commits = ((p.activity.git && p.activity.git.detail && p.activity.git.detail.recent) || [])
      .filter((c) => Date.parse(c.at) > sinceT)
      .map((c) => ({ at: c.at, subject: c.subject }));
    const sessions = (byProject.get(p.id) || []).map((r) => digests.get(r.file)).filter(Boolean);
    return {
      id: p.id,
      name: p.name,
      stage: p.stage,
      kind: p.kind,
      summary: p.summary,
      path: p.path,
      waiting_on: p.waiting_on || '',
      open_steps: (p.steps || []).filter((s) => !s.done).map((s) => ({ id: s.id, text: s.text })),
      recently_done: doneRecently(p),
      has_evidence: commits.length > 0 || sessions.length > 0,
      commits,
      sessions,
    };
  });

  return {
    as_of: asOf,
    since: sinceIso,
    stages: db.STAGES,
    types: suggest.TYPES,
    projects: out,
    memory_notes: await memoryNotes(root, sinceT),
    open_suggestions: suggest.list().map((s) => ({ project_id: s.project_id, type: s.type, payload: s.payload })),
  };
}

// Store what the skill sent and move the "since" mark up to the moment its
// context was built, so a session that ran during the sync is read next time.
function receive(body) {
  const result = suggest.offer(body.suggestions || [], 'claude');
  const asOf = body.as_of && !Number.isNaN(Date.parse(body.as_of)) ? new Date(Date.parse(body.as_of)).toISOString() : db.nowIso();
  db.setSetting('last_claude_sync_at', asOf);
  return { ...result, last_claude_sync_at: asOf };
}

module.exports = { buildContext, receive, resolveSince, isMainSession };
