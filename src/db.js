'use strict';
// SQLite via node:sqlite, built in on Node 22+. No native modules to compile
// and no npm install to push through the Fortinet proxy.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { RULE_IDS } = require('./attention');

const APP_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(APP_DIR, 'data');
const DB_PATH = process.env.DASH_DB || path.join(DATA_DIR, 'dashboard.db');

// app dir -> Project Dashboard -> CI Web Apps -> workspace root
const DEFAULT_WORKSPACE_ROOT = path.resolve(APP_DIR, '..', '..', '..');

const STAGES = ['idea', 'building', 'testing', 'handoff', 'live', 'paused', 'done'];

// Kind answers exactly one question: what sort of thing is this, and therefore
// how do you treat it? The first set mixed that up with who the work was for
// (deliverable), which domain it touched (ops) and how big it felt (initiative),
// so nothing could be filed with confidence. These six are mutually exclusive.
//
// The tie-breaker, for anything that looks like two of them at once: if the work
// right now is BUILDING it, it is a tool; if the work is RUNNING it, recurring.
const KIND_INFO = [
  { id: 'tool', icon: '🛠️', label: 'Tool',
    blurb: 'Software you built or are building. Usually a folder, often a port and a repo.' },
  { id: 'client', icon: '📦', label: 'Client work',
    blurb: 'Output that goes to a client account: reports, firm profiles, decks.' },
  { id: 'recurring', icon: '🔁', label: 'Recurring',
    blurb: 'Comes back on a cadence. You run it rather than finish it.' },
  { id: 'exploring', icon: '🔭', label: 'Exploring',
    blurb: 'Still working out the shape. No agreed deliverable yet.' },
  { id: 'partner', icon: '🤝', label: 'Partner-led',
    blurb: 'Someone else is building it. You steer, review and unblock.' },
  { id: 'personal', icon: '🏡', label: 'Personal',
    blurb: 'Not CI work.' },
];
const KINDS = KIND_INFO.map((k) => k.id);
const KIND_LABEL = Object.fromEntries(KIND_INFO.map((k) => [k.id, k.label]));
// Tile hues. Names, not hex: the front end owns the actual values so the
// palette can change without a migration.
const COLORS = ['coral', 'tangerine', 'marigold', 'lime', 'mint', 'sky', 'periwinkle', 'grape', 'rose', 'cocoa'];

let db = null;

function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id            INTEGER PRIMARY KEY,
      slug          TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      kind          TEXT NOT NULL DEFAULT 'app',
      summary       TEXT NOT NULL DEFAULT '',
      path          TEXT,
      repo_url      TEXT,
      port          INTEGER,
      stage         TEXT NOT NULL DEFAULT 'building',
      priority      INTEGER NOT NULL DEFAULT 2,
      next_step     TEXT NOT NULL DEFAULT '',
      waiting_on    TEXT NOT NULL DEFAULT '',
      waiting_since TEXT,
      review_after  TEXT,
      stale_days    INTEGER NOT NULL DEFAULT 14,
      muted_rules   TEXT NOT NULL DEFAULT '[]',
      notes         TEXT NOT NULL DEFAULT '',
      archived      INTEGER NOT NULL DEFAULT 0,
      sort          INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS markers (
      id         INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      marker     TEXT NOT NULL,
      UNIQUE(project_id, marker)
    );

    CREATE TABLE IF NOT EXISTS activity (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source     TEXT NOT NULL,
      last_at    TEXT,
      detail     TEXT NOT NULL DEFAULT '{}',
      scanned_at TEXT NOT NULL,
      PRIMARY KEY (project_id, source)
    );

    CREATE TABLE IF NOT EXISTS scan_cache (
      file             TEXT PRIMARY KEY,
      size             INTEGER NOT NULL,
      mtime_ms         INTEGER NOT NULL,
      markers_scanned  TEXT NOT NULL DEFAULT '[]',
      session_start    TEXT,
      session_end      TEXT,
      first_prompt     TEXT,
      hits             TEXT NOT NULL DEFAULT '{}',
      scanned_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS log (
      id         INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      kind       TEXT NOT NULL,
      text       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS log_project_at ON log(project_id, at DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- A project's checklist. The "next step" everywhere else is simply the
    -- first open row here; projects.next_step is kept in sync as a cache so
    -- attention.js and the tiles never need to know steps exist.
    CREATE TABLE IF NOT EXISTS steps (
      id         INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      text       TEXT NOT NULL,
      done       INTEGER NOT NULL DEFAULT 0,
      done_at    TEXT,
      sort       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS steps_project ON steps(project_id, done, sort);
  `);

  // One-time: turn the old single next_step text into the first checklist row.
  const migrated = d.prepare("SELECT value FROM settings WHERE key = 'steps_migrated'").get();
  if (!migrated) {
    d.exec(`INSERT INTO steps(project_id, text, sort)
            SELECT id, next_step, 0 FROM projects
            WHERE next_step <> '' AND id NOT IN (SELECT DISTINCT project_id FROM steps)`);
    d.exec("INSERT INTO settings(key, value) VALUES ('steps_migrated', '1')");
  }

  // Columns added after the first release. ALTER TABLE ADD COLUMN is the one
  // schema change SQLite does cheaply, so this is the whole migration system.
  const have = new Set(d.prepare('PRAGMA table_info(projects)').all().map((c) => c.name));
  const add = (name, ddl) => { if (!have.has(name)) d.exec(`ALTER TABLE projects ADD COLUMN ${name} ${ddl}`); };
  add('icon', "TEXT NOT NULL DEFAULT ''");
  add('color', "TEXT NOT NULL DEFAULT ''");

  // One-time: the second, coherent set of kinds.
  if (!d.prepare("SELECT 1 FROM settings WHERE key = 'kinds_v2'").get()) {
    const blanket = { app: 'tool', deliverable: 'client', ops: 'recurring', initiative: 'exploring', research: 'exploring' };
    for (const [from, to] of Object.entries(blanket)) {
      d.prepare('UPDATE projects SET kind = ? WHERE kind = ?').run(to, from);
    }
    // Three the blanket map gets wrong, because the old label hid what they are:
    // the newsletter ships on a cadence, the screenshot workflow gets re-run, and
    // change monitoring is Sebastian's build, not ours.
    d.prepare("UPDATE projects SET kind = 'recurring' WHERE slug IN ('ci-prompt-newsletter', 'video-screenshots')").run();
    d.prepare("UPDATE projects SET kind = 'partner' WHERE slug = 'change-monitoring'").run();
    // Anything unrecognised (hand-typed, or from a future version) lands somewhere valid.
    d.prepare(`UPDATE projects SET kind = 'tool' WHERE kind NOT IN (${KINDS.map(() => '?').join(',')})`).run(...KINDS);
    d.prepare("INSERT INTO settings(key, value) VALUES ('kinds_v2', '1')").run();
  }

  // The name the dashboard greets you by. A setting, not a constant, so it is
  // one UPDATE to change rather than an edit to the source.
  if (!d.prepare("SELECT 1 FROM settings WHERE key = 'owner_name'").get()) {
    d.prepare("INSERT INTO settings(key, value) VALUES ('owner_name', 'Matt')").run();
  }
}

const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

function rows(sql, params = []) { return open().prepare(sql).all(...params); }
function row(sql, params = []) { return open().prepare(sql).get(...params); }
function run(sql, params = []) { return open().prepare(sql).run(...params); }
function tx(fn) {
  const d = open();
  d.exec('BEGIN');
  try { const r = fn(); d.exec('COMMIT'); return r; }
  catch (e) { try { d.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
}

function getSetting(key, fallback = null) {
  const r = row('SELECT value FROM settings WHERE key = ?', [key]);
  return r ? r.value : fallback;
}
function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)]);
}

function workspaceRoot() { return getSetting('workspace_root', DEFAULT_WORKSPACE_ROOT); }

// A stable fingerprint of the full marker set. Stored per cached transcript so a
// newly added marker forces the files that predate it to be re-read.
function markersVersion() {
  const all = rows('SELECT marker FROM markers ORDER BY marker').map((r) => r.marker);
  return crypto.createHash('sha1').update(all.join('\u0000')).digest('hex').slice(0, 12);
}
function allMarkers() {
  return rows('SELECT DISTINCT marker FROM markers ORDER BY marker').map((r) => r.marker);
}

// next_step is deliberately absent: it is written only by syncNextStep from the
// steps table. Use addStep / updateStep to change what a project does next.
const EDITABLE = ['name', 'kind', 'summary', 'path', 'repo_url', 'port', 'stage', 'priority',
  'waiting_on', 'waiting_since', 'review_after', 'stale_days', 'muted_rules',
  'notes', 'archived', 'sort', 'icon', 'color'];

const NUMERIC = { port: null, priority: 2, stale_days: 14, archived: 0, sort: 0 };
const DATE_FIELDS = ['waiting_since', 'review_after'];

function normalise(key, value) {
  if (key === 'muted_rules') {
    const list = Array.isArray(value)
      ? value
      : String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((r) => !RULE_IDS.includes(r));
    if (bad.length) throw new Error(`unknown rule id: ${bad.join(', ')}`);
    return JSON.stringify([...new Set(list)]);
  }
  if (key in NUMERIC) {
    if (value === '' || value === null || value === undefined) return NUMERIC[key];
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
    return key === 'archived' ? (n ? 1 : 0) : Math.trunc(n);
  }
  if (DATE_FIELDS.includes(key)) {
    if (!value) return null;
    const s = String(value).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${key} must be YYYY-MM-DD`);
    return s;
  }
  if (key === 'path' || key === 'repo_url') {
    const s = value == null ? '' : String(value).trim();
    return s === '' ? null : s.replace(/\\/g, '/');
  }
  if (key === 'color') {
    const s = String(value || '').trim().toLowerCase();
    if (s && !COLORS.includes(s)) throw new Error(`unknown color: ${s}`);
    return s;
  }
  if (key === 'icon') {
    // One emoji, give or take a variation selector or skin tone. Cap the length
    // so a pasted sentence cannot become a tile icon.
    return String(value || '').trim().slice(0, 8);
  }
  return value == null ? '' : String(value).trim();
}

function hydrate(p) {
  if (!p) return p;
  p.muted_rules = safeJson(p.muted_rules, []);
  p.archived = Number(p.archived);
  return p;
}
function safeJson(s, fallback = {}) {
  if (s == null) return fallback;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return fallback; }
}

// Open steps first in their order, then completed ones newest first.
const STEP_ORDER = 'ORDER BY done, CASE WHEN done THEN done_at END DESC, sort, id';

function listProjects({ includeArchived = false } = {}) {
  const where = includeArchived ? '' : 'WHERE archived = 0';
  const ps = rows(`SELECT * FROM projects ${where} ORDER BY priority, sort, name`).map(hydrate);
  const byId = new Map(ps.map((p) => [p.id, Object.assign(p, { activity: {}, markers: [], steps: [] })]));
  for (const a of rows('SELECT * FROM activity')) {
    const p = byId.get(a.project_id);
    if (p) p.activity[a.source] = { last_at: a.last_at, detail: safeJson(a.detail), scanned_at: a.scanned_at };
  }
  for (const m of rows('SELECT project_id, marker FROM markers ORDER BY marker')) {
    const p = byId.get(m.project_id);
    if (p) p.markers.push(m.marker);
  }
  for (const s of rows(`SELECT * FROM steps ${STEP_ORDER}`)) {
    const p = byId.get(s.project_id);
    if (p) p.steps.push(s);
  }
  return [...byId.values()];
}

function getProject(id) {
  const p = hydrate(row('SELECT * FROM projects WHERE id = ?', [id]));
  if (!p) return null;
  p.activity = {};
  for (const a of rows('SELECT * FROM activity WHERE project_id = ?', [id])) {
    p.activity[a.source] = { last_at: a.last_at, detail: safeJson(a.detail), scanned_at: a.scanned_at };
  }
  p.markers = rows('SELECT marker FROM markers WHERE project_id = ? ORDER BY marker', [id]).map((r) => r.marker);
  p.steps = rows(`SELECT * FROM steps WHERE project_id = ? ${STEP_ORDER}`, [id]);
  p.log = rows('SELECT * FROM log WHERE project_id = ? ORDER BY at DESC, id DESC LIMIT 100', [id]);
  return p;
}

// ---------- steps ----------

// projects.next_step mirrors the first open step so everything downstream
// (attention rules, tiles, the API) keeps a single string to read.
function syncNextStep(projectId) {
  const first = row('SELECT text FROM steps WHERE project_id = ? AND done = 0 ORDER BY sort, id LIMIT 1', [projectId]);
  run("UPDATE projects SET next_step = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    [first ? first.text : '', projectId]);
}

function addStep(projectId, text, { log = true } = {}) {
  const t = String(text || '').trim().slice(0, 500);
  if (!t) throw new Error('step text is required');
  if (!row('SELECT 1 FROM projects WHERE id = ?', [projectId])) throw new Error('no such project');
  const next = row('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM steps WHERE project_id = ? AND done = 0', [projectId]).n;
  const info = run('INSERT INTO steps(project_id, text, sort) VALUES(?,?,?)', [projectId, t, next]);
  if (log) addLog(projectId, 'step', `Added: ${t}`);
  syncNextStep(projectId);
  return row('SELECT * FROM steps WHERE id = ?', [Number(info.lastInsertRowid)]);
}

function updateStep(projectId, stepId, patch) {
  const s = row('SELECT * FROM steps WHERE id = ? AND project_id = ?', [stepId, projectId]);
  if (!s) return null;
  return tx(() => {
    if ('text' in patch) {
      const t = String(patch.text || '').trim().slice(0, 500);
      if (!t) throw new Error('step text is required');
      if (t !== s.text) run('UPDATE steps SET text = ? WHERE id = ?', [t, stepId]);
    }
    if ('done' in patch) {
      const done = patch.done ? 1 : 0;
      if (done !== s.done) {
        run('UPDATE steps SET done = ?, done_at = ? WHERE id = ?', [done, done ? nowIso() : null, stepId]);
        // Completing a step is the one event this whole tool exists to record.
        addLog(projectId, done ? 'done' : 'step', `${done ? 'Completed' : 'Reopened'}: ${'text' in patch ? patch.text : s.text}`);
        if (!done) {
          // Reopened steps go to the bottom of the open list, not the top.
          const n = row('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM steps WHERE project_id = ? AND done = 0', [projectId]).n;
          run('UPDATE steps SET sort = ? WHERE id = ?', [n, stepId]);
        }
      }
    }
    if ('sort' in patch && Number.isFinite(Number(patch.sort))) {
      run('UPDATE steps SET sort = ? WHERE id = ?', [Math.trunc(Number(patch.sort)), stepId]);
    }
    syncNextStep(projectId);
    return row('SELECT * FROM steps WHERE id = ?', [stepId]);
  });
}

function deleteStep(projectId, stepId) {
  const s = row('SELECT * FROM steps WHERE id = ? AND project_id = ?', [stepId, projectId]);
  if (!s) return false;
  run('DELETE FROM steps WHERE id = ?', [stepId]);
  addLog(projectId, 'step', `Removed: ${s.text}`);
  syncNextStep(projectId);
  return true;
}

// Every completed step across every project, newest first, with enough of the
// project attached to draw a row. Archived projects are included on purpose:
// finished work is finished work. Grouping by day happens in the browser, in
// the viewer's own time zone, so an 11pm tick counts for today rather than
// tomorrow UTC.
function listDone({ limit = 500 } = {}) {
  return rows(`SELECT s.id, s.text, s.done_at, s.project_id,
                      p.name AS project_name, p.icon, p.color, p.kind, p.archived
               FROM steps s JOIN projects p ON p.id = s.project_id
               WHERE s.done = 1 AND s.done_at IS NOT NULL
               ORDER BY s.done_at DESC, s.id DESC
               LIMIT ?`, [limit]);
}

// Reorder the open steps. ids is the full open list in the wanted order; any
// open step not mentioned keeps its place after the mentioned ones.
function reorderSteps(projectId, ids) {
  const open = rows('SELECT id FROM steps WHERE project_id = ? AND done = 0 ORDER BY sort, id', [projectId]).map((r) => r.id);
  const wanted = ids.map(Number).filter((id) => open.includes(id));
  const rest = open.filter((id) => !wanted.includes(id));
  tx(() => {
    [...wanted, ...rest].forEach((id, i) => run('UPDATE steps SET sort = ? WHERE id = ?', [i, id]));
    syncNextStep(projectId);
  });
  return rows(`SELECT * FROM steps WHERE project_id = ? ${STEP_ORDER}`, [projectId]);
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
}

function createProject(input) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('name is required');
  let slug = slugify(input.slug || name);
  const base = slug;
  let n = 1;
  while (row('SELECT 1 FROM projects WHERE slug = ?', [slug])) slug = `${base}-${++n}`;

  const fields = { slug, name };
  for (const k of EDITABLE) {
    if (k === 'name' || !(k in input)) continue;
    fields[k] = normalise(k, input[k]);
  }
  if (fields.stage && !STAGES.includes(fields.stage)) throw new Error(`unknown stage: ${fields.stage}`);
  if (fields.kind && !KINDS.includes(fields.kind)) throw new Error(`unknown kind: ${fields.kind}`);
  // The column default still says 'app' on databases created before kinds_v2.
  if (!fields.kind) fields.kind = 'tool';
  if (fields.waiting_on && !fields.waiting_since) fields.waiting_since = today();

  const cols = Object.keys(fields);
  const info = run(
    `INSERT INTO projects(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`,
    cols.map((c) => fields[c]));
  const id = Number(info.lastInsertRowid);
  for (const m of input.markers || []) addMarker(id, m);
  addLog(id, 'system', 'Project created');
  // Accept the old single-string form and a list, so the seed and any caller
  // that predates checklists still work.
  const initial = Array.isArray(input.steps) ? input.steps : (input.next_step ? [input.next_step] : []);
  for (const s of initial) if (String(s || '').trim()) addStep(id, s, { log: false });
  return getProject(id);
}

function updateProject(id, patch) {
  const before = getProject(id);
  if (!before) return null;

  const sets = [];
  const vals = [];
  const logs = [];

  for (const k of EDITABLE) {
    if (!(k in patch)) continue;
    const v = normalise(k, patch[k]);
    if (k === 'stage' && !STAGES.includes(v)) throw new Error(`unknown stage: ${v}`);
    if (k === 'kind' && !KINDS.includes(v)) throw new Error(`unknown kind: ${v}`);

    const prev = k === 'muted_rules' ? JSON.stringify(before.muted_rules) : before[k];
    if (String(prev ?? '') === String(v ?? '')) continue;

    sets.push(`${k} = ?`);
    vals.push(v);

    if (k === 'stage') logs.push(['stage', `Stage: ${before.stage} to ${v}`]);
    else if (k === 'next_step') logs.push(['next_step', v ? `Next step: ${v}` : 'Next step cleared']);
    else if (k === 'waiting_on') logs.push(['field', v ? `Waiting on ${v}` : 'No longer waiting on anyone']);
    else if (k === 'archived') logs.push(['system', v ? 'Archived' : 'Unarchived']);
    else if (k === 'muted_rules') logs.push(['field', `Muted rules: ${safeJson(v, []).join(', ') || 'none'}`]);
    else if (k === 'review_after') logs.push(['field', v ? `Snoozed until ${v}` : 'Snooze cleared']);
  }

  // Starting to wait on someone stamps the clock; stopping clears it.
  if ('waiting_on' in patch && !('waiting_since' in patch)) {
    const w = normalise('waiting_on', patch.waiting_on);
    const wantsStamp = w ? (before.waiting_on ? before.waiting_since : today()) : null;
    if (String(before.waiting_since ?? '') !== String(wantsStamp ?? '')) {
      sets.push('waiting_since = ?');
      vals.push(wantsStamp);
    }
  }

  return tx(() => {
    if (Array.isArray(patch.markers)) {
      run('DELETE FROM markers WHERE project_id = ?', [id]);
      for (const m of patch.markers) addMarker(id, m);
    }
    if (sets.length) {
      sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
    }
    for (const [kind, text] of logs) addLog(id, kind, text);
    return getProject(id);
  });
}

function deleteProject(id) {
  return run('DELETE FROM projects WHERE id = ?', [id]).changes > 0;
}

function addMarker(projectId, marker) {
  const m = String(marker || '').trim();
  if (!m) return;
  run('INSERT OR IGNORE INTO markers(project_id, marker) VALUES(?,?)', [projectId, m]);
}

function addLog(projectId, kind, text) {
  run('INSERT INTO log(project_id, kind, text) VALUES(?,?,?)', [projectId, kind, String(text).slice(0, 2000)]);
}

function setActivity(projectId, source, lastAt, detail) {
  run(`INSERT INTO activity(project_id, source, last_at, detail, scanned_at) VALUES(?,?,?,?,?)
       ON CONFLICT(project_id, source) DO UPDATE SET
         last_at = excluded.last_at, detail = excluded.detail, scanned_at = excluded.scanned_at`,
    [projectId, source, lastAt, JSON.stringify(detail || {}), nowIso()]);
}

function getCache(file) {
  const r = row('SELECT * FROM scan_cache WHERE file = ?', [file]);
  if (!r) return null;
  r.hits = safeJson(r.hits, {});
  r.markers_scanned = safeJson(r.markers_scanned, []);
  return r;
}

function putCache(entry) {
  run(`INSERT INTO scan_cache(file, size, mtime_ms, markers_scanned, session_start, session_end, first_prompt, hits, scanned_at)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(file) DO UPDATE SET
         size = excluded.size, mtime_ms = excluded.mtime_ms, markers_scanned = excluded.markers_scanned,
         session_start = excluded.session_start, session_end = excluded.session_end,
         first_prompt = excluded.first_prompt, hits = excluded.hits, scanned_at = excluded.scanned_at`,
    [entry.file, entry.size, entry.mtime_ms, JSON.stringify(entry.markers_scanned || []),
      entry.session_start, entry.session_end, entry.first_prompt,
      JSON.stringify(entry.hits || {}), nowIso()]);
}

function allCache() {
  return rows('SELECT * FROM scan_cache').map((r) => {
    r.hits = safeJson(r.hits, {});
    r.markers_scanned = safeJson(r.markers_scanned, []);
    return r;
  });
}

module.exports = {
  open, rows, row, run, tx, nowIso, today, safeJson,
  DB_PATH, DATA_DIR, APP_DIR, DEFAULT_WORKSPACE_ROOT, STAGES, KINDS, KIND_INFO, KIND_LABEL, COLORS,
  getSetting, setSetting, workspaceRoot, markersVersion, allMarkers,
  listProjects, getProject, createProject, updateProject, deleteProject,
  addMarker, addLog, setActivity, slugify,
  addStep, updateStep, deleteStep, reorderSteps, syncNextStep, listDone,
  getCache, putCache, allCache,
};
