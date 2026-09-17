'use strict';
// The attention rules, as a pure function of (project, now).
// Nothing in here touches the database or the filesystem, so it is testable
// and a future notify.js can consume the same output the UI does.

// Severity ranks the queue. warn comes first because uncommitted or unpushed
// work is a data-loss risk; act is something to do; info is a standing note.
const SEVERITY_RANK = { warn: 0, act: 1, info: 2 };

const RULE_IDS = [
  'unpushed',
  'dirty',
  'waiting-overdue',
  'no-next-step',
  'stale',
  'review-due',
  'no-remote',
  'untracked',
];

const ACTIVE_STAGES = ['building', 'testing', 'handoff'];
const QUIET_STAGES = ['paused', 'done'];

// review_after in the future silences these three. It is the snooze button:
// a deliberately parked project stays off the queue without being marked done.
const SNOOZABLE = ['stale', 'no-next-step', 'no-remote'];

const WAITING_GRACE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(fromIso, now) {
  if (!fromIso) return null;
  const t = Date.parse(fromIso.length <= 10 ? `${fromIso}T00:00:00Z` : fromIso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / DAY_MS);
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// Newest evidence across git, fs and claude. Null when nothing has been scanned
// yet, which is how the stale rule knows to stay quiet on a first run.
function newestActivity(project) {
  let best = null;
  for (const source of ['git', 'fs', 'claude']) {
    const at = project.activity?.[source]?.last_at;
    if (!at) continue;
    const t = Date.parse(at);
    if (Number.isNaN(t)) continue;
    if (!best || t > best.t) best = { t, at, source };
  }
  return best;
}

function evaluate(project, now = new Date()) {
  const git = project.activity?.git?.detail || {};
  const muted = new Set(Array.isArray(project.muted_rules) ? project.muted_rules : []);
  const stage = project.stage;
  const isQuietStage = QUIET_STAGES.includes(stage);
  const isActiveStage = ACTIVE_STAGES.includes(stage);

  const reviewAfterDays = daysBetween(project.review_after, now);
  const snoozed = project.review_after && reviewAfterDays !== null && reviewAfterDays < 0;

  const newest = newestActivity(project);
  const quietDays = newest ? daysBetween(newest.at, now) : null;
  const waitingDays = daysBetween(project.waiting_since, now);

  const candidates = [];

  const push = (id, severity, label, detail, ageDays) => {
    candidates.push({ id, severity, label, detail: detail || '', ageDays: ageDays ?? 0 });
  };

  if (Number(git.ahead) > 0) {
    push('unpushed', 'warn', `${plural(git.ahead, 'commit', 'commits')} unpushed`,
      git.remote ? `Not on ${shortRemote(git.remote)} yet` : 'No remote configured', 0);
  }

  if (Number(git.modified) > 0) {
    push('dirty', 'warn', `${plural(git.modified, 'uncommitted change', 'uncommitted changes')}`,
      'Modified tracked files, not committed', 0);
  }

  if (project.waiting_on && waitingDays !== null && waitingDays > WAITING_GRACE_DAYS) {
    push('waiting-overdue', 'act', `Chase ${project.waiting_on}`,
      `Waiting ${plural(waitingDays, 'day', 'days')}`, waitingDays);
  }

  if (isActiveStage && !String(project.next_step || '').trim()) {
    push('no-next-step', 'act', 'Needs a next step', `Stage is ${stage}`, 0);
  }

  if (isActiveStage && quietDays !== null && quietDays > Number(project.stale_days || 14)) {
    push('stale', 'act', `Quiet for ${plural(quietDays, 'day', 'days')}`,
      `Last sign of life: ${newest.source}`, quietDays);
  }

  if (project.review_after && reviewAfterDays !== null && reviewAfterDays >= 0) {
    push('review-due', 'act', 'Review date passed',
      reviewAfterDays === 0 ? 'Due today' : `Due ${plural(reviewAfterDays, 'day', 'days')} ago`, reviewAfterDays);
  }

  if (project.kind === 'tool' && project.path && (git.is_repo === false || (git.is_repo && !git.remote))) {
    push('no-remote', 'info', 'No backup outside this machine',
      git.is_repo ? 'Git repo with no remote' : 'Not a git repo', 0);
  }

  if (Number(git.untracked) > 0) {
    push('untracked', 'info', `${plural(git.untracked, 'untracked file', 'untracked files')}`,
      'Not in git, not ignored', 0);
  }

  // Work out, per candidate, whether it reaches the queue and why not if it does not.
  const flags = candidates.map((c) => {
    let suppressed = null;
    if (muted.has(c.id)) suppressed = 'muted';
    else if (snoozed && SNOOZABLE.includes(c.id)) suppressed = `snoozed until ${project.review_after}`;
    else if (isQuietStage && c.severity === 'act') suppressed = `stage is ${stage}`;
    return { ...c, suppressed, inQueue: suppressed === null };
  });

  flags.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    b.ageDays - a.ageDays ||
    a.id.localeCompare(b.id));

  return {
    flags,
    queue: flags.filter((f) => f.inQueue),
    newest,
    quietDays,
  };
}

function shortRemote(url) {
  const m = String(url).match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : url;
}

// Order the whole queue across projects: severity, then project priority, then
// how long the condition has been true.
function buildQueue(projects, now = new Date()) {
  const out = [];
  for (const p of projects) {
    const { queue } = evaluate(p, now);
    for (const f of queue) {
      out.push({ ...f, project_id: p.id, project_name: p.name, priority: p.priority, kind: p.kind });
    }
  }
  out.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.priority - b.priority ||
    b.ageDays - a.ageDays ||
    a.project_name.localeCompare(b.project_name));
  return out;
}

module.exports = {
  evaluate,
  buildQueue,
  newestActivity,
  daysBetween,
  RULE_IDS,
  SEVERITY_RANK,
  ACTIVE_STAGES,
  QUIET_STAGES,
  SNOOZABLE,
  WAITING_GRACE_DAYS,
};
