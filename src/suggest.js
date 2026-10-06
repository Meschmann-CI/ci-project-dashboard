'use strict';
// Suggested updates: changes the evidence outside the app says have happened,
// held for Matt to approve. Two sources feed it:
//
//   scan    cheap, local rules run at the end of every scan (fromScan below)
//   claude  a /sync-dashboard session that reads recent transcripts, commits
//           and memory notes, then POSTs what it thinks changed
//
// Nothing here edits a project until apply() is called with the ids he ticked.
// The unique fingerprint is what keeps a dismissed suggestion from coming back.
const db = require('./db');

const TYPES = ['complete_step', 'add_step', 'set_stage', 'add_log', 'set_waiting'];
const SOURCES = ['scan', 'claude'];
const VIA = { scan: 'suggested by scan', claude: 'suggested by Claude' };

const ACTIVE_STAGES = ['building', 'testing', 'handoff'];
const PAUSE_AFTER_DAYS = 30;     // floor; a project's own stale_days x2 can raise it
const RESUME_WITHIN_DAYS = 3;
const DAY_MS = 86400000;

const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ts = (iso) => { const t = Date.parse(iso || ''); return Number.isNaN(t) ? null : t; };

// YYYY-MM-DD (read as local noon, so it lands on that calendar day) or a full
// ISO stamp. Clamped to now: a completion cannot be dated in the future.
function pastIso(v, now = new Date()) {
  if (!v) return null;
  const s = String(v).trim();
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00` : s);
  if (Number.isNaN(t)) return null;
  return new Date(Math.min(t, now.getTime())).toISOString();
}

function openStepWithText(projectId, text) {
  const want = norm(text);
  return db.rows('SELECT text FROM steps WHERE project_id = ? AND done = 0', [projectId])
    .some((s) => norm(s.text) === want);
}

// Validate one incoming suggestion against the project as it stands now, and
// work out its fingerprint. Throws with a reason the caller can report back.
function prepare(input, source) {
  const pid = Number(input && input.project_id);
  const p = db.row('SELECT id, stage, waiting_on FROM projects WHERE id = ?', [pid]);
  if (!p) throw new Error(`no such project: ${input && input.project_id}`);
  const type = String(input.type || '');
  if (!TYPES.includes(type)) throw new Error(`unknown type: ${type}`);
  const pl = input.payload || {};
  const payload = {};
  let key;

  if (type === 'complete_step') {
    const s = db.row('SELECT id, text, done FROM steps WHERE id = ? AND project_id = ?', [Number(pl.step_id), pid]);
    if (!s) throw new Error(`step ${pl.step_id} is not on project ${pid}`);
    if (s.done) throw new Error('step is already done');
    payload.step_id = s.id;
    payload.step_text = s.text;
    const at = pastIso(pl.done_at);
    if (at) payload.done_at = at;
    key = String(s.id);
  } else if (type === 'add_step') {
    const text = clip(pl.text, 500);
    if (!text) throw new Error('text is required');
    if (openStepWithText(pid, text)) throw new Error('already an open step');
    payload.text = text;
    key = norm(text);
  } else if (type === 'set_stage') {
    const stage = String(pl.stage || '');
    if (!db.STAGES.includes(stage)) throw new Error(`unknown stage: ${stage}`);
    if (stage === p.stage) throw new Error(`already ${stage}`);
    payload.stage = stage;
    payload.from = p.stage;
    key = `${p.stage}>${stage}`;
  } else if (type === 'add_log') {
    const text = clip(pl.text, 1000);
    if (!text) throw new Error('text is required');
    payload.text = text;
    const at = pastIso(pl.at);
    if (at) payload.at = at;
    key = norm(text);
  } else if (type === 'set_waiting') {
    const w = clip(pl.waiting_on, 200);
    if (w === (p.waiting_on || '')) throw new Error(w ? `already waiting on ${w}` : 'not waiting on anyone');
    payload.waiting_on = w;
    key = `${norm(p.waiting_on)}>${norm(w)}`;
  }

  // A scan rule passes `key` when the same change can be right again later on
  // new evidence (paused, picked back up, paused again).
  if (input.key) key += `|${input.key}`;

  return {
    project_id: pid, type, payload,
    reason: clip(input.reason, 300),
    evidence: clip(input.evidence, 600),
    source,
    fingerprint: `${type}|${pid}|${key}`,
  };
}

// Store new suggestions. Anything invalid, or seen before in any state, is
// skipped and reported, never an error for the batch.
function offer(list, source) {
  if (!SOURCES.includes(source)) throw new Error(`unknown source: ${source}`);
  if (!Array.isArray(list)) throw new Error('suggestions must be an array');
  const out = { added: 0, skipped: [] };
  db.tx(() => {
    list.forEach((input, index) => {
      let r;
      try { r = prepare(input, source); }
      catch (e) { out.skipped.push({ index, error: e.message }); return; }
      const info = db.run(
        `INSERT OR IGNORE INTO suggestions(project_id, type, payload, reason, evidence, source, fingerprint)
         VALUES(?,?,?,?,?,?,?)`,
        [r.project_id, r.type, JSON.stringify(r.payload), r.reason, r.evidence, r.source, r.fingerprint]);
      if (info.changes) out.added += 1;
      else out.skipped.push({ index, error: 'suggested before (open, applied or dismissed)' });
    });
  });
  return out;
}

function hydrate(s) {
  if (s) s.payload = db.safeJson(s.payload, {});
  return s;
}

// Does the change still make sense? Matt may have done it by hand since.
function stillApplies(s) {
  const p = db.row('SELECT stage, waiting_on FROM projects WHERE id = ?', [s.project_id]);
  if (!p) return false;
  const pl = s.payload;
  switch (s.type) {
    case 'complete_step': {
      const st = db.row('SELECT done FROM steps WHERE id = ? AND project_id = ?', [pl.step_id, s.project_id]);
      return !!st && !st.done;
    }
    case 'add_step': return !openStepWithText(s.project_id, pl.text);
    case 'set_stage': return p.stage !== pl.stage;
    case 'set_waiting': return (p.waiting_on || '') !== pl.waiting_on;
    default: return true;
  }
}

function resolve(ids, status) {
  const at = db.nowIso();
  for (const id of ids) {
    db.run("UPDATE suggestions SET status = ?, resolved_at = ? WHERE id = ? AND status = 'open'", [status, at, id]);
  }
}

// Open suggestions for unarchived projects. Ones overtaken by a hand edit are
// retired as 'stale' on the way out rather than shown.
function list() {
  const open = db.rows(
    `SELECT s.*, p.name AS project_name, p.icon, p.color, p.stage AS project_stage, p.priority
     FROM suggestions s JOIN projects p ON p.id = s.project_id
     WHERE s.status = 'open' AND p.archived = 0
     ORDER BY p.priority, p.name, s.created_at, s.id`).map(hydrate);
  const live = open.filter(stillApplies);
  const gone = open.filter((s) => !live.includes(s)).map((s) => s.id);
  if (gone.length) db.tx(() => resolve(gone, 'stale'));
  return live;
}

function applyOne(s, edit) {
  const via = VIA[s.source] || '';
  const pl = s.payload;
  // A rewording cleared to nothing means "keep the original", not "blank it".
  const text = (v) => clip(clip(edit && edit.text, 1000) || v, s.type === 'add_step' ? 500 : 1000);
  switch (s.type) {
    case 'complete_step':
      db.updateStep(s.project_id, pl.step_id, { done: true }, { via, doneAt: pl.done_at || null });
      break;
    case 'add_step':
      db.addStep(s.project_id, text(pl.text), { via });
      break;
    case 'set_stage':
      db.updateProject(s.project_id, { stage: pl.stage }, { via });
      break;
    case 'add_log':
      db.addLog(s.project_id, 'note', `${text(pl.text)} · ${via}`, pl.at || null);
      break;
    case 'set_waiting':
      db.updateProject(s.project_id, { waiting_on: pl.waiting_on }, { via });
      break;
    default:
      throw new Error(`unknown type: ${s.type}`);
  }
}

// Apply the ticked ones, each in its own transaction so one that no longer
// fits does not block the rest. edits: { [id]: { text } } for wording Matt
// changed before applying.
function apply(ids, edits = {}) {
  const results = [];
  for (const raw of ids) {
    const id = Number(raw);
    const s = hydrate(db.row('SELECT * FROM suggestions WHERE id = ?', [id]));
    if (!s || s.status !== 'open') { results.push({ id, ok: false, error: 'not an open suggestion' }); continue; }
    if (!stillApplies(s)) {
      resolve([id], 'stale');
      results.push({ id, ok: false, error: 'already done or changed by hand' });
      continue;
    }
    try {
      db.tx(() => { applyOne(s, edits[id]); resolve([id], 'applied'); });
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }
  return results;
}

function dismiss(ids) {
  db.tx(() => resolve(ids.map(Number), 'dismissed'));
  return { dismissed: ids.length };
}

// ---------------------------------------------------------------- scan rules
//
// Kept deliberately narrow. A suggestion list that is mostly wrong gets
// ignored, the same way a nag queue with a permanent false alarm does, so
// these only fire on evidence that rarely misleads. Judgement calls (what a
// session achieved, what comes next) are left to the Claude sync.

const STOP = new Set(('the and for with from into onto that this then than are was were will have has had '
  + 'not but you your our out off all any can its get got via per new one two use using make made '
  + 'add added fix fixed update updated build built run set up first next more less into also just '
  + 'app tool page file files step steps work').split(' '));

function stem(w) {
  for (const suf of ['ing', 'ed', 'es', 's']) {
    if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length);
  }
  return w;
}

function tokens(s) {
  const out = new Set();
  for (const w of String(s || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(stem(w));
  }
  return out;
}

// The commit that best describes an open step, if one clearly does: at least
// two distinctive words shared, covering at least half of the step's words,
// and made after the step was written down.
function bestCommitFor(step, commits) {
  const want = tokens(step.text);
  if (want.size < 2) return null;
  const after = ts(step.created_at) || 0;
  let best = null;
  for (const c of commits) {
    const at = ts(c.at);
    if (at === null || at < after) continue;
    const have = tokens(c.subject);
    let shared = 0;
    for (const w of want) if (have.has(w)) shared += 1;
    const score = shared / want.size;
    if (shared >= 2 && score >= 0.5 && (!best || score > best.score)) best = { ...c, score };
  }
  return best;
}

function newestOf(p, sources) {
  let best = null;
  for (const source of sources) {
    const a = p.activity && p.activity[source];
    const t = a && ts(a.last_at);
    if (t !== null && t !== undefined && (!best || t > best.t)) best = { t, at: a.last_at, source, detail: a.detail || {} };
  }
  return best;
}

const dayOf = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// Pure: projects (as listProjects returns them) in, candidate suggestions out.
// lastStageChange maps project id to the ISO time its stage last changed.
function fromScan(projects, { lastStageChange = new Map(), now = new Date() } = {}) {
  const out = [];
  const nowT = now.getTime();

  for (const p of projects) {
    if (p.archived) continue;

    // 1. An open step that a later commit plainly describes.
    const commits = (p.activity && p.activity.git && p.activity.git.detail && p.activity.git.detail.recent) || [];
    for (const s of (p.steps || []).filter((x) => !x.done)) {
      const c = bestCommitFor(s, commits);
      if (!c) continue;
      out.push({
        project_id: p.id, type: 'complete_step',
        payload: { step_id: s.id, done_at: c.at },
        reason: 'A commit made after this step was added describes the same work.',
        evidence: `Commit ${String(c.hash || '').slice(0, 7)} on ${dayOf(c.at)}: "${c.subject}"`,
      });
    }

    // 2. Active on paper, silent in fact.
    const snoozed = p.review_after && ts(`${p.review_after}T23:59:59`) > nowT;
    const newest = newestOf(p, ['git', 'fs', 'claude']);
    if (ACTIVE_STAGES.includes(p.stage) && newest && !snoozed) {
      const quiet = Math.floor((nowT - newest.t) / DAY_MS);
      const limit = Math.max(PAUSE_AFTER_DAYS, 2 * (p.stale_days || 14));
      if (quiet >= limit) {
        out.push({
          project_id: p.id, type: 'set_stage', payload: { stage: 'paused' },
          key: new Date(newest.t).toISOString().slice(0, 10),
          reason: `No commits, file changes or Claude sessions for ${quiet} days.`,
          evidence: `Last activity: ${newest.source === 'fs' ? 'a file change' : newest.source} on ${dayOf(newest.at)}`,
        });
      }
    }

    // 3. Parked on paper, being worked on in fact. File times are left out
    //    here because OneDrive sync touches them without anyone working.
    if (p.stage === 'paused' || p.stage === 'idea') {
      const work = newestOf(p, ['git', 'claude']);
      const since = ts(lastStageChange.get(p.id)) || ts(p.created_at) || 0;
      if (work && nowT - work.t <= RESUME_WITHIN_DAYS * DAY_MS && work.t > since) {
        const what = work.source === 'git'
          ? `Commit on ${dayOf(work.at)}: "${work.detail.last_commit_subject || ''}"`
          : `Claude session on ${dayOf(work.at)}${work.detail.last_prompt ? `: "${work.detail.last_prompt}"` : ''}`;
        out.push({
          project_id: p.id, type: 'set_stage', payload: { stage: 'building' },
          key: new Date(work.t).toISOString().slice(0, 10),
          reason: `Work picked up again after it was marked ${p.stage}.`,
          evidence: what,
        });
      }
    }
  }
  return out;
}

function lastStageChanges() {
  return new Map(db.rows("SELECT project_id, MAX(at) AS at FROM log WHERE kind = 'stage' GROUP BY project_id")
    .map((r) => [r.project_id, r.at]));
}

// Run the scan rules and store whatever is new. Returns how many were added.
function offerFromScan(now = new Date()) {
  const projects = db.listProjects();
  return offer(fromScan(projects, { lastStageChange: lastStageChanges(), now }), 'scan').added;
}

module.exports = {
  TYPES, SOURCES, prepare, offer, list, apply, dismiss, stillApplies,
  fromScan, offerFromScan, lastStageChanges, tokens, bestCommitFor, pastIso,
};
