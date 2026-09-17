'use strict';
// The three automatic signals: git state, newest file mtime, and Claude
// transcript activity. Everything here is async so the HTTP server stays
// responsive while the first 325 MB pass runs.
const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const db = require('./db');

const FS_IGNORE = new Set(['node_modules', '.git', 'data', 'uploads', '.next', 'dist', 'build', '.cache']);
const FS_MAX_DEPTH = 6;
const FS_MAX_FILES = 20000;

// Attribution thresholds, set from the real transcripts rather than guessed.
//
// Measured over 57 transcripts: a session that actually worked on a project
// lands 20 to 3,000 strong hits on it. A survey or planning session that merely
// touches everything lands 1 to 5 on every project at once. So a bare "one tool
// call" test attributes every project to every planning session, which is how
// the first run produced a last-touched date of today for all fifteen.
//
// Two ways in, because both kinds of work are real:
//   1. Volume. Enough tool calls aimed at the project that it cannot be a mention.
//   2. Dominance. Fewer hits, but most of what the session did was about this
//      project. This is what catches a quick fix, and a pure discussion session
//      for the two initiatives that have no folder to scan.
const STRONG_VOLUME = 10;   // strong hits that stand on their own
const MIN_SCORE = 15;       // floor for the dominance path
const MIN_SHARE = 0.25;     // and the share of the session it must represent
const STRONG_WEIGHT = 3;    // a tool call counts for three mentions in prose

const BIG_LINE = 1_000_000;

// ---------------------------------------------------------------- job state

const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  phase: 'idle',
  filesTotal: 0,
  filesDone: 0,
  bytesTotal: 0,
  bytesDone: 0,
  cached: 0,
  error: null,
  summary: null,
};

function status() {
  return {
    ...state,
    lastScanAt: db.getSetting('last_scan_at', null),
    lastSummary: db.safeJson(db.getSetting('last_scan_summary', '{}'), {}),
    everScanned: db.getSetting('last_scan_at', null) !== null,
  };
}

// ---------------------------------------------------------------- git

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

function samePath(a, b) {
  const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const x = norm(a);
  const y = norm(b);
  // Windows paths are case-insensitive; comparing raw strings would call a repo
  // root a subfolder over a drive-letter case difference.
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

async function scanGit(absPath) {
  const inTree = (await git(absPath, ['rev-parse', '--is-inside-work-tree']) || '').trim() === 'true';
  if (!inTree) return { is_repo: false };

  // git walks up, so a plain folder inside the workspace repo answers "yes" and
  // then reports the workspace's commits and dirty files as its own. Only treat
  // it as a repo when this folder is the repo root.
  const top = (await git(absPath, ['rev-parse', '--show-toplevel']) || '').trim();
  if (!top || !samePath(top, absPath)) {
    return { is_repo: false, inside_repo: top ? top.replace(/\\/g, '/') : null };
  }

  const [logOut, remote, aheadOut, modifiedOut, untrackedOut, branch] = await Promise.all([
    git(absPath, ['log', '-1', '--format=%cI%x1f%s%x1f%an']),
    git(absPath, ['remote', 'get-url', 'origin']),
    git(absPath, ['rev-list', '--count', '@{u}..HEAD']),
    git(absPath, ['status', '--porcelain', '--untracked-files=no']),
    git(absPath, ['ls-files', '--others', '--exclude-standard']),
    git(absPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);

  const [lastAt, subject, author] = (logOut || '').trim().split('\x1f');
  const countLines = (s) => (s || '').split('\n').filter((l) => l.trim()).length;

  return {
    is_repo: true,
    branch: (branch || '').trim() || null,
    remote: (remote || '').trim() || null,
    last_commit_at: lastAt || null,
    last_commit_subject: subject || null,
    last_commit_author: author || null,
    // rev-list fails with no upstream, which is not the same as being in sync.
    ahead: aheadOut === null ? 0 : Number((aheadOut || '0').trim()) || 0,
    has_upstream: aheadOut !== null,
    modified: countLines(modifiedOut),
    untracked: countLines(untrackedOut),
  };
}

// ---------------------------------------------------------------- filesystem

async function scanFs(absPath) {
  let newest = 0;
  let newestFile = null;
  let files = 0;
  let truncated = false;

  async function walk(dir, depth) {
    if (depth > FS_MAX_DEPTH || files >= FS_MAX_FILES) { truncated = files >= FS_MAX_FILES; return; }
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (files >= FS_MAX_FILES) { truncated = true; return; }
      const name = e.name;
      if (e.isDirectory()) {
        if (FS_IGNORE.has(name) || name.startsWith('.')) continue;
        await walk(path.join(dir, name), depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (/\.db(-wal|-shm|-journal)?$/i.test(name) || name.startsWith('~$')) continue;
      files += 1;
      const full = path.join(dir, name);
      try {
        const st = await fsp.stat(full);
        if (st.mtimeMs > newest) { newest = st.mtimeMs; newestFile = full; }
      } catch { /* locked or mid-sync; skip */ }
    }
  }

  try { await fsp.access(absPath); } catch { return { exists: false }; }
  await walk(absPath, 0);

  return {
    exists: true,
    files,
    truncated,
    newest_file: newestFile ? path.relative(absPath, newestFile).replace(/\\/g, '/') : null,
    last_at: newest ? new Date(newest).toISOString() : null,
  };
}

// ---------------------------------------------------------------- transcripts

function claudeProjectsDir() {
  return db.getSetting('claude_projects_dir', path.join(os.homedir(), '.claude', 'projects'));
}

async function findTranscripts(root) {
  const out = [];
  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // tool-results holds payload blobs, not conversation records.
        if (e.name === 'tool-results' || e.name === 'memory') continue;
        await walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  }
  await walk(root, 0);
  return out;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Read one transcript, counting marker hits weighted by where they occur.
async function scanTranscript(file, markers, prefilter) {
  const hits = Object.create(null);
  let sessionStart = null;
  let sessionEnd = null;
  let firstPrompt = null;

  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line) continue;

      // Cheap timestamp sweep so session bounds cover every record, not only hits.
      const tsm = line.match(/"timestamp":"([^"]+)"/);
      if (tsm) {
        if (!sessionStart || tsm[1] < sessionStart) sessionStart = tsm[1];
        if (!sessionEnd || tsm[1] > sessionEnd) sessionEnd = tsm[1];
      }

      if (firstPrompt === null && line.includes('"type":"user"') && !line.includes('system-reminder')) {
        firstPrompt = extractFirstPrompt(line);
      }

      // Injected context names every project; it is not evidence of work.
      if (line.includes('system-reminder')) continue;
      if (!prefilter.test(line)) continue;

      const cls = classify(line);
      if (!cls) continue;

      for (const m of markers) {
        if (!line.includes(m)) continue;
        const bucket = hits[m] || (hits[m] = { strong: 0, weak: 0, last_ts: null });
        if (cls.strongText && cls.strongText.includes(m)) bucket.strong += 1;
        else bucket.weak += 1;
        if (cls.ts && (!bucket.last_ts || cls.ts > bucket.last_ts)) bucket.last_ts = cls.ts;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { hits, session_start: sessionStart, session_end: sessionEnd, first_prompt: firstPrompt };
}

// Split a record into "text a tool call aimed at something" versus everything
// else. A path inside a tool_use input is evidence of work; the same string in
// prose is evidence of discussion.
function classify(line) {
  if (line.length > BIG_LINE) {
    const tsm = line.match(/"timestamp":"([^"]+)"/);
    return { ts: tsm ? tsm[1] : null, strongText: line.includes('"type":"tool_use"') ? line : '' };
  }
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (obj.type !== 'user' && obj.type !== 'assistant') return null;

  let strongText = '';
  const content = obj.message && obj.message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'tool_use') {
        try { strongText += JSON.stringify(block.input || {}); } catch { /* circular, ignore */ }
      }
    }
  }
  return { ts: obj.timestamp || null, strongText };
}

function extractFirstPrompt(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (obj.type !== 'user') return null;
  const c = obj.message && obj.message.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    const t = c.find((b) => b && b.type === 'text' && typeof b.text === 'string');
    if (t) text = t.text;
  }
  if (!text) return null;
  text = text.trim();
  if (!text || text.startsWith('<') || text.startsWith('/')) return null;
  return text.slice(0, 200);
}

// ---------------------------------------------------------------- the job

async function runScan() {
  if (state.running) return status();
  state.running = true;
  state.error = null;
  state.startedAt = db.nowIso();
  state.finishedAt = null;
  state.filesDone = 0;
  state.bytesDone = 0;
  state.cached = 0;

  const summary = { projects: 0, repos: 0, transcripts: 0, reused: 0, attributed: 0 };

  try {
    const projects = db.listProjects({ includeArchived: true });
    summary.projects = projects.length;
    const root = db.workspaceRoot();

    // ---- git and fs, per project, a few at a time
    state.phase = 'folders';
    const folderResults = [];
    const queue = [...projects];
    const workers = Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const p = queue.shift();
        if (!p.path) { folderResults.push({ p, git: null, fsr: null }); continue; }
        const abs = path.resolve(root, p.path);
        const [g, f] = await Promise.all([scanGit(abs), scanFs(abs)]);
        if (g && g.is_repo) summary.repos += 1;
        folderResults.push({ p, git: g, fsr: f });
      }
    });
    await Promise.all(workers);

    // ---- transcripts
    const claudeEnabled = db.getSetting('claude_scan_enabled', '1') === '1';
    const markers = db.allMarkers();
    const version = db.markersVersion();
    let perProjectClaude = new Map();

    if (claudeEnabled && markers.length) {
      state.phase = 'transcripts';
      const files = await findTranscripts(claudeProjectsDir());
      const stats = [];
      for (const f of files) {
        try { stats.push({ file: f, st: await fsp.stat(f) }); } catch { /* vanished */ }
      }
      state.filesTotal = stats.length;
      state.bytesTotal = stats.reduce((a, s) => a + s.st.size, 0);
      summary.transcripts = stats.length;

      const results = [];
      for (const { file, st } of stats) {
        const cached = db.getCache(file);
        const fresh = cached
          && cached.size === st.size
          && cached.mtime_ms === Math.floor(st.mtimeMs)
          // Reuse only if the cached pass already looked for every marker we
          // care about now. A newly added marker forces a re-read.
          && markers.every((m) => cached.markers_scanned.includes(m));

        if (fresh) {
          results.push(cached);
          state.cached += 1;
          summary.reused += 1;
        } else {
          const prefilter = new RegExp(markers.map(escapeRe).join('|'));
          const r = await scanTranscript(file, markers, prefilter);
          const entry = {
            file,
            size: st.size,
            mtime_ms: Math.floor(st.mtimeMs),
            markers_scanned: markers,
            session_start: r.session_start,
            session_end: r.session_end,
            first_prompt: r.first_prompt,
            hits: r.hits,
          };
          db.putCache(entry);
          results.push(entry);
        }
        state.filesDone += 1;
        state.bytesDone += st.size;
      }

      db.setSetting('markers_version', version);
      perProjectClaude = rollUpClaude(projects, results);
      for (const v of perProjectClaude.values()) summary.attributed += v.sessions;
    }

    // ---- write everything in one transaction so the UI never sees a half state
    state.phase = 'writing';
    db.tx(() => {
      for (const { p, git: g, fsr } of folderResults) {
        if (g) db.setActivity(p.id, 'git', g.is_repo ? g.last_commit_at : null, g);
        if (fsr) db.setActivity(p.id, 'fs', fsr.last_at || null, fsr);
        const c = perProjectClaude.get(p.id);
        if (c) db.setActivity(p.id, 'claude', c.last_at, c);
      }
      db.setSetting('last_scan_at', db.nowIso());
      db.setSetting('last_scan_summary', JSON.stringify(summary));
    });

    state.summary = summary;
    state.phase = 'idle';
  } catch (e) {
    state.error = e && e.message ? e.message : String(e);
    state.phase = 'error';
  } finally {
    state.running = false;
    state.finishedAt = db.nowIso();
  }
  return status();
}

const score = (strong, weak) => strong * STRONG_WEIGHT + weak;

// Does this session count as work on this project? Volume alone, or a smaller
// amount that dominates what the session was doing.
function attributes(s, w, sessionScore) {
  if (s >= STRONG_VOLUME) return true;
  const mine = score(s, w);
  if (mine < MIN_SCORE) return false;
  return sessionScore > 0 && mine / sessionScore >= MIN_SHARE;
}

// Aggregate per-marker hits into a per-project verdict.
function rollUpClaude(projects, cacheRows) {
  const out = new Map();

  // Per-project totals for each transcript, plus the whole session's total, so
  // the dominance test has a denominator.
  const perFile = cacheRows.map((r) => {
    const byProject = new Map();
    let sessionScore = 0;
    for (const p of projects) {
      let s = 0;
      let w = 0;
      let ts = null;
      for (const m of p.markers) {
        const h = r.hits[m];
        if (!h) continue;
        s += h.strong;
        w += h.weak;
        if (h.last_ts && (!ts || h.last_ts > ts)) ts = h.last_ts;
      }
      if (s || w) {
        byProject.set(p.id, { s, w, ts });
        sessionScore += score(s, w);
      }
    }
    return { row: r, byProject, sessionScore };
  });

  for (const p of projects) {
    if (!p.markers.length) continue;
    let sessions = 0;
    let strong = 0;
    let weak = 0;
    let lastAt = null;
    let lastPrompt = null;

    for (const { row: r, byProject, sessionScore } of perFile) {
      const hit = byProject.get(p.id);
      if (!hit) continue;
      if (!attributes(hit.s, hit.w, sessionScore)) continue;

      sessions += 1;
      strong += hit.s;
      weak += hit.w;
      const when = hit.ts || r.session_end;
      if (when && (!lastAt || when > lastAt)) {
        lastAt = when;
        lastPrompt = r.first_prompt || null;
      }
    }
    if (sessions) out.set(p.id, { sessions, strong, weak, last_at: lastAt, last_prompt: lastPrompt });
  }
  return out;
}

module.exports = { runScan, status, state, scanGit, scanFs, scanTranscript, rollUpClaude, attributes, classify, findTranscripts, samePath, STRONG_VOLUME, MIN_SCORE, MIN_SHARE, STRONG_WEIGHT };
