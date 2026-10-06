'use strict';
// Unit tests for the parts where a mistake is silent: the attention rules, the
// transcript weighting, and the checklist's sync with next_step. Run with: npm test
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// The checklist tests need a real database. Point db.js at a throwaway file
// before anything requires it, so the real dashboard.db is never touched.
const TEST_DB = path.join(os.tmpdir(), `mission-control-test-${process.pid}.db`);
process.env.DASH_DB = TEST_DB;

const attention = require('./attention');
const scan = require('./scan');
const db = require('./db');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (e) { failed += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

const NOW = new Date('2026-09-08T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

function project(over = {}) {
  return {
    id: 1, name: 'Test', kind: 'tool', stage: 'building', priority: 2,
    next_step: 'do the thing', waiting_on: '', waiting_since: null,
    review_after: null, stale_days: 14, muted_rules: [], path: 'some/path',
    activity: { git: { last_at: daysAgo(1), detail: { is_repo: true, remote: 'git@x:y/z.git', ahead: 0, modified: 0, untracked: 0 } } },
    ...over,
  };
}
const ids = (r) => r.queue.map((f) => f.id).sort();
const flagIds = (r) => r.flags.map((f) => f.id).sort();

console.log('\nattention rules');

test('clean project fires nothing', () => {
  assert.deepStrictEqual(ids(attention.evaluate(project(), NOW)), []);
});

test('unpushed commits fire a warn', () => {
  const r = attention.evaluate(project({
    activity: { git: { last_at: daysAgo(1), detail: { is_repo: true, remote: 'r', ahead: 9, modified: 0, untracked: 0 } } },
  }), NOW);
  assert.deepStrictEqual(ids(r), ['unpushed']);
  assert.strictEqual(r.queue[0].severity, 'warn');
  assert.match(r.queue[0].label, /9 commits unpushed/);
});

test('a muted rule still shows on the card but stays out of the queue', () => {
  const r = attention.evaluate(project({
    muted_rules: ['unpushed'],
    activity: { git: { last_at: daysAgo(1), detail: { is_repo: true, remote: 'r', ahead: 9, modified: 0, untracked: 0 } } },
  }), NOW);
  assert.deepStrictEqual(ids(r), [], 'queue should be empty');
  assert.deepStrictEqual(flagIds(r), ['unpushed'], 'flag should still be computed');
  assert.strictEqual(r.flags[0].suppressed, 'muted');
});

test('untracked files are info, modified files are warn, and they are separate', () => {
  const r = attention.evaluate(project({
    activity: { git: { last_at: daysAgo(1), detail: { is_repo: true, remote: 'r', ahead: 0, modified: 3, untracked: 10 } } },
  }), NOW);
  assert.deepStrictEqual(ids(r), ['dirty', 'untracked']);
  const bySeverity = Object.fromEntries(r.queue.map((f) => [f.id, f.severity]));
  assert.strictEqual(bySeverity.dirty, 'warn');
  assert.strictEqual(bySeverity.untracked, 'info');
});

test('no next step fires only on an active stage', () => {
  assert.deepStrictEqual(ids(attention.evaluate(project({ next_step: '' }), NOW)), ['no-next-step']);
  assert.deepStrictEqual(ids(attention.evaluate(project({ next_step: '', stage: 'live' }), NOW)), []);
  assert.deepStrictEqual(ids(attention.evaluate(project({ next_step: '', stage: 'idea' }), NOW)), []);
});

test('stale stays quiet until the threshold, then fires', () => {
  const quiet = (d) => project({ activity: { fs: { last_at: daysAgo(d), detail: {} } } });
  assert.deepStrictEqual(ids(attention.evaluate(quiet(10), NOW)), []);
  assert.deepStrictEqual(ids(attention.evaluate(quiet(21), NOW)), ['stale']);
});

test('stale does not fire before the first scan', () => {
  const r = attention.evaluate(project({ activity: {} }), NOW);
  assert.ok(!ids(r).includes('stale'), 'no activity means unscanned, not stale');
});

test('waiting-overdue respects the seven day grace period', () => {
  const w = (d) => project({ waiting_on: 'Drew', waiting_since: daysAgo(d) });
  assert.deepStrictEqual(ids(attention.evaluate(w(3), NOW)), []);
  const r = attention.evaluate(w(12), NOW);
  assert.deepStrictEqual(ids(r), ['waiting-overdue']);
  assert.match(r.queue[0].label, /Chase Drew/);
  assert.match(r.queue[0].detail, /12 days/);
});

test('a future snooze silences stale, no-next-step and no-remote', () => {
  const r = attention.evaluate(project({
    next_step: '',
    review_after: daysAgo(-30).slice(0, 10),
    activity: { fs: { last_at: daysAgo(60), detail: {} }, git: { last_at: null, detail: { is_repo: false } } },
  }), NOW);
  assert.deepStrictEqual(ids(r), []);
  assert.deepStrictEqual(flagIds(r), ['no-next-step', 'no-remote', 'stale']);
  assert.ok(r.flags.every((f) => /snoozed/.test(f.suppressed)));
});

test('a snooze date that has passed fires review-due', () => {
  const r = attention.evaluate(project({ review_after: daysAgo(2).slice(0, 10) }), NOW);
  assert.ok(ids(r).includes('review-due'));
});

test('paused suppresses act rules but not the data-loss warnings', () => {
  const r = attention.evaluate(project({
    stage: 'paused', next_step: '',
    activity: { git: { last_at: daysAgo(90), detail: { is_repo: true, remote: 'r', ahead: 2, modified: 1, untracked: 0 } } },
  }), NOW);
  assert.deepStrictEqual(ids(r), ['dirty', 'unpushed']);
});

test('no-remote fires for a tool folder with no repo or no remote', () => {
  const noRepo = attention.evaluate(project({
    activity: { git: { last_at: null, detail: { is_repo: false } }, fs: { last_at: daysAgo(1), detail: {} } },
  }), NOW);
  assert.ok(ids(noRepo).includes('no-remote'));

  const noRemote = attention.evaluate(project({
    activity: { git: { last_at: daysAgo(1), detail: { is_repo: true, remote: null, ahead: 0, modified: 0, untracked: 0 } } },
  }), NOW);
  assert.ok(ids(noRemote).includes('no-remote'));

  const notATool = attention.evaluate(project({
    kind: 'client',
    activity: { git: { last_at: null, detail: { is_repo: false } }, fs: { last_at: daysAgo(1), detail: {} } },
  }), NOW);
  assert.ok(!ids(notATool).includes('no-remote'), 'only tools need a remote');
});

test('every seeded kind is one the schema accepts', () => {
  const { SEED } = require('./seed');
  for (const s of SEED) {
    assert.ok(db.KINDS.includes(s.kind), `${s.slug} has unknown kind "${s.kind}"`);
  }
  // And each kind carries a definition, since the UI shows one for whichever is picked.
  for (const k of db.KIND_INFO) {
    assert.ok(k.icon && k.label && k.blurb, `kind ${k.id} is missing icon, label or blurb`);
  }
});

test('the queue puts data-loss warnings above chores, then sorts by priority', () => {
  const q = attention.buildQueue([
    project({ id: 1, name: 'Low act', priority: 3, next_step: '' }),
    project({
      id: 2, name: 'Warn', priority: 3,
      activity: { git: { last_at: daysAgo(1), detail: { is_repo: true, remote: 'r', ahead: 1, modified: 0, untracked: 0 } } },
    }),
    project({ id: 3, name: 'High act', priority: 1, next_step: '' }),
  ], NOW);
  assert.deepStrictEqual(q.map((f) => f.project_name), ['Warn', 'High act', 'Low act']);
});

console.log('\ntranscript weighting');

test('a marker inside a tool call is strong, the same marker in prose is weak', () => {
  const toolLine = JSON.stringify({
    type: 'assistant', timestamp: '2026-09-01T10:00:00Z',
    message: { content: [{ type: 'tool_use', input: { command: 'cd ar-tracking-app && npm test' } }] },
  });
  const proseLine = JSON.stringify({
    type: 'assistant', timestamp: '2026-09-01T10:00:00Z',
    message: { content: [{ type: 'text', text: 'We should look at ar-tracking-app soon.' }] },
  });
  assert.ok(scan.classify(toolLine).strongText.includes('ar-tracking-app'));
  assert.ok(!scan.classify(proseLine).strongText.includes('ar-tracking-app'));
});

test('records that are neither user nor assistant are ignored', () => {
  assert.strictEqual(scan.classify(JSON.stringify({ type: 'queue-operation', content: 'ar-tracking-app' })), null);
  assert.strictEqual(scan.classify('not json at all'), null);
});

test('volume alone attributes, whatever else the session did', () => {
  // 40 strong hits is unambiguous work, even inside a busy session.
  assert.strictEqual(scan.attributes(40, 0, 100000), true);
  assert.strictEqual(scan.attributes(10, 0, 100000), true, 'at the volume floor');
});

test('a survey session that touches everything attributes nothing', () => {
  // The real shape of this session: fifteen projects, a few hits each.
  const projects = [];
  const hits = {};
  for (let i = 1; i <= 15; i += 1) {
    projects.push({ id: i, markers: [`m${i}`] });
    hits[`m${i}`] = { strong: 3, weak: 6, last_ts: '2026-09-08T10:00:00Z' };
  }
  // One project got a bit more attention, as the dashboard's own scan did.
  hits.m1 = { strong: 6, weak: 11, last_ts: '2026-09-08T10:00:00Z' };
  const out = scan.rollUpClaude(projects, [{ hits, session_end: 'x', first_prompt: 'survey' }]);
  assert.strictEqual(out.size, 0, 'no project dominates, so none is attributed');
});

test('a focused session attributes even with modest counts', () => {
  const projects = [{ id: 1, markers: ['a'] }, { id: 2, markers: ['b'] }];
  const out = scan.rollUpClaude(projects, [{
    hits: {
      a: { strong: 5, weak: 4, last_ts: '2026-09-01T10:00:00Z' }, // score 19 of 24
      b: { strong: 0, weak: 5, last_ts: '2026-09-01T10:00:00Z' },
    },
    session_end: 'x', first_prompt: 'quick fix',
  }]);
  assert.deepStrictEqual([...out.keys()], [1]);
});

test('a discussion-only session still counts for a project with no folder', () => {
  // The two initiatives have no path, so prose is the only signal they can get.
  const projects = [{ id: 1, markers: ['Fluxguard'] }, { id: 2, markers: ['other'] }];
  const out = scan.rollUpClaude(projects, [{
    hits: {
      Fluxguard: { strong: 0, weak: 30, last_ts: '2026-06-04T10:00:00Z' },
      other: { strong: 0, weak: 3, last_ts: '2026-06-04T10:00:00Z' },
    },
    session_end: 'x', first_prompt: 'change detection strategy',
  }]);
  assert.deepStrictEqual([...out.keys()], [1]);
  assert.strictEqual(out.get(1).last_at, '2026-06-04T10:00:00Z');
});

test('hits across a project\'s several markers add up', () => {
  const p = [{ id: 1, markers: ['binder-viewer', 'Sitecap'] }];
  const out = scan.rollUpClaude(p, [
    {
      hits: {
        'binder-viewer': { strong: 6, weak: 3, last_ts: '2026-09-01T10:00:00Z' },
        Sitecap: { strong: 6, weak: 3, last_ts: '2026-09-02T10:00:00Z' },
      },
      session_end: 'x', first_prompt: 'rename it',
    },
  ]);
  assert.strictEqual(out.get(1).sessions, 1, '6 + 6 clears the volume floor that neither clears alone');
  assert.strictEqual(out.get(1).last_at, '2026-09-02T10:00:00Z', 'newest marker timestamp wins');
});

test('a project with no markers is never attributed', () => {
  const out = scan.rollUpClaude([{ id: 1, markers: [] }], [
    { hits: { anything: { strong: 99, weak: 99, last_ts: 'z' } }, session_end: 'x', first_prompt: null },
  ]);
  assert.strictEqual(out.size, 0);
});

console.log('\nchecklist (temporary database)');

test('a project created with the old next_step string gets one open step', () => {
  const p = db.createProject({ name: 'T1', stage: 'building', next_step: 'first thing' });
  assert.strictEqual(p.steps.length, 1);
  assert.strictEqual(p.steps[0].done, 0);
  assert.strictEqual(p.next_step, 'first thing', 'the cached column mirrors the top open step');
});

test('completing the top step promotes the next one and writes to history', () => {
  const p = db.createProject({ name: 'T2', stage: 'building', steps: ['one', 'two'] });
  db.updateStep(p.id, p.steps[0].id, { done: true });
  const after = db.getProject(p.id);
  assert.strictEqual(after.next_step, 'two');
  assert.deepStrictEqual(after.steps.map((s) => [s.text, s.done]), [['two', 0], ['one', 1]], 'open first, then done');
  assert.ok(after.log.some((l) => l.kind === 'done' && l.text === 'Completed: one'));
  assert.ok(!attention.evaluate(after, NOW).queue.some((f) => f.id === 'no-next-step'), 'still has a next step');
});

test('completing the last step empties next_step so the nag fires', () => {
  const p = db.createProject({ name: 'T3', stage: 'building', steps: ['only'] });
  db.updateStep(p.id, p.steps[0].id, { done: true });
  const after = db.getProject(p.id);
  assert.strictEqual(after.next_step, '');
  assert.ok(attention.evaluate(after, NOW).queue.some((f) => f.id === 'no-next-step'));
});

test('reopening a completed step puts it at the bottom of the open list', () => {
  const p = db.createProject({ name: 'T4', stage: 'building', steps: ['a', 'b', 'c'] });
  const a = p.steps[0];
  db.updateStep(p.id, a.id, { done: true });
  db.updateStep(p.id, a.id, { done: false });
  const after = db.getProject(p.id);
  assert.deepStrictEqual(after.steps.filter((s) => !s.done).map((s) => s.text), ['b', 'c', 'a']);
  assert.strictEqual(after.next_step, 'b');
  assert.ok(after.log.some((l) => l.text === 'Reopened: a'));
});

test('reordering changes which step is next', () => {
  const p = db.createProject({ name: 'T5', stage: 'building', steps: ['x', 'y'] });
  const [x, y] = p.steps;
  db.reorderSteps(p.id, [y.id, x.id]);
  assert.strictEqual(db.getProject(p.id).next_step, 'y');
});

test('deleting the top step promotes the next and is logged', () => {
  const p = db.createProject({ name: 'T6', stage: 'building', steps: ['gone', 'stays'] });
  db.deleteStep(p.id, p.steps[0].id);
  const after = db.getProject(p.id);
  assert.strictEqual(after.next_step, 'stays');
  assert.ok(after.log.some((l) => l.text === 'Removed: gone'));
});

test('patching next_step directly is ignored; the checklist is the source of truth', () => {
  const p = db.createProject({ name: 'T7', stage: 'building', steps: ['keep'] });
  db.updateProject(p.id, { next_step: 'sneaky' });
  assert.strictEqual(db.getProject(p.id).next_step, 'keep');
});

test('editing a step\'s text updates the cache when it is the top step', () => {
  const p = db.createProject({ name: 'T8', stage: 'building', steps: ['draft'] });
  db.updateStep(p.id, p.steps[0].id, { text: 'final' });
  assert.strictEqual(db.getProject(p.id).next_step, 'final');
});

test('an empty step is refused', () => {
  const p = db.createProject({ name: 'T9', stage: 'building' });
  assert.throws(() => db.addStep(p.id, '   '), /required/);
});

test('the done log lists completed steps newest first with their project, and forgets reopened ones', () => {
  const p = db.createProject({ name: 'T10', stage: 'building', steps: ['first', 'second'], icon: '🧪', color: 'mint' });
  db.updateStep(p.id, p.steps[0].id, { done: true });
  db.updateStep(p.id, p.steps[1].id, { done: true });
  const mine = db.listDone().filter((r) => r.project_id === p.id);
  assert.deepStrictEqual(mine.map((r) => r.text), ['second', 'first']);
  assert.strictEqual(mine[0].project_name, 'T10');
  assert.strictEqual(mine[0].icon, '🧪');
  assert.ok(mine[0].done_at, 'carries the completion timestamp');
  db.updateStep(p.id, p.steps[1].id, { done: false });
  assert.deepStrictEqual(db.listDone().filter((r) => r.project_id === p.id).map((r) => r.text), ['first']);
});

console.log('\nsuggestions');

const suggest = require('./suggest');
const { commitSubject, promptText } = require('./digest');

test('bad suggestions are skipped with a reason, good ones stored, and nothing is applied yet', () => {
  const p = db.createProject({ name: 'S1', stage: 'building', steps: ['write the migration plan'] });
  const r = suggest.offer([
    { project_id: 999999, type: 'add_step', payload: { text: 'x' } },
    { project_id: p.id, type: 'teleport', payload: {} },
    { project_id: p.id, type: 'set_stage', payload: { stage: 'building' } },
    { project_id: p.id, type: 'add_step', payload: { text: 'Write the migration plan' } },
    { project_id: p.id, type: 'complete_step', payload: { step_id: p.steps[0].id }, reason: 'it shipped' },
  ], 'claude');
  assert.strictEqual(r.added, 1);
  assert.deepStrictEqual(r.skipped.map((s) => s.index), [0, 1, 2, 3]);
  assert.match(r.skipped[3].error, /already an open step/);
  assert.strictEqual(db.getProject(p.id).steps[0].done, 0, 'offering must not change the project');
});

test('a suggestion offered twice, or after being dismissed, is not stored again', () => {
  const p = db.createProject({ name: 'S2', stage: 'building' });
  const s = { project_id: p.id, type: 'add_step', payload: { text: 'Ask Rutger for the Q3 invoices' } };
  assert.strictEqual(suggest.offer([s], 'claude').added, 1);
  assert.strictEqual(suggest.offer([s], 'scan').added, 0, 'same change from another source is the same suggestion');
  const id = suggest.list().find((x) => x.project_id === p.id).id;
  suggest.dismiss([id]);
  assert.strictEqual(suggest.offer([s], 'claude').added, 0);
  assert.ok(!suggest.list().some((x) => x.project_id === p.id));
});

test('applying a completion backdates it, tags the history line, and resolves the suggestion', () => {
  const p = db.createProject({ name: 'S3', stage: 'building', steps: ['ship batch 2'] });
  suggest.offer([{ project_id: p.id, type: 'complete_step', payload: { step_id: p.steps[0].id, done_at: '2026-09-28' } }], 'claude');
  const s = suggest.list().find((x) => x.project_id === p.id);
  const [res] = suggest.apply([s.id]);
  assert.ok(res.ok, res.error);
  const after = db.getProject(p.id);
  assert.strictEqual(after.steps[0].done, 1);
  assert.match(after.steps[0].done_at, /^2026-09-28/);
  assert.ok(after.log.some((l) => l.kind === 'done' && /ship batch 2 · suggested by Claude/.test(l.text)));
  assert.ok(!suggest.list().some((x) => x.id === s.id));
  assert.strictEqual(suggest.apply([s.id])[0].ok, false, 'cannot be applied twice');
});

test('reworded text is what gets added', () => {
  const p = db.createProject({ name: 'S4', stage: 'building' });
  suggest.offer([{ project_id: p.id, type: 'add_step', payload: { text: 'draft text' } }], 'claude');
  const s = suggest.list().find((x) => x.project_id === p.id);
  suggest.apply([s.id], { [s.id]: { text: 'better text' } });
  assert.strictEqual(db.getProject(p.id).next_step, 'better text');
});

test('a suggestion overtaken by a hand edit goes stale instead of showing', () => {
  const p = db.createProject({ name: 'S5', stage: 'building', steps: ['one thing'] });
  suggest.offer([{ project_id: p.id, type: 'complete_step', payload: { step_id: p.steps[0].id } },
    { project_id: p.id, type: 'set_stage', payload: { stage: 'live' } }], 'claude');
  db.updateStep(p.id, p.steps[0].id, { done: true });
  db.updateProject(p.id, { stage: 'live' });
  assert.ok(!suggest.list().some((x) => x.project_id === p.id));
  assert.strictEqual(db.row("SELECT COUNT(*) AS n FROM suggestions WHERE project_id = ? AND status = 'stale'", [p.id]).n, 2);
});

test('a failed apply rolls back and leaves the suggestion open', () => {
  const p = db.createProject({ name: 'S6', stage: 'building' });
  suggest.offer([{ project_id: p.id, type: 'add_step', payload: { text: 'real text' } }], 'claude');
  const s = suggest.list().find((x) => x.project_id === p.id);
  const [res] = suggest.apply([s.id], { [s.id]: { text: '   ' } });
  // Blank rewording falls back to the original, so this one succeeds...
  assert.ok(res.ok);
  // ...but a stage change to a stage that no longer validates must not half-apply.
  db.run("INSERT INTO suggestions(project_id, type, payload, source, fingerprint) VALUES(?, 'set_stage', '{\"stage\":\"orbit\"}', 'claude', 'bad-test')", [p.id]);
  const bad = db.row("SELECT id FROM suggestions WHERE fingerprint = 'bad-test'").id;
  const [r2] = suggest.apply([bad]);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(db.row('SELECT status FROM suggestions WHERE id = ?', [bad]).status, 'open');
  assert.strictEqual(db.getProject(p.id).stage, 'building');
});

const NOW2 = new Date('2026-10-06T12:00:00Z');
const ago2 = (d) => new Date(NOW2.getTime() - d * 86400000).toISOString();
const scanProject = (over = {}) => ({
  id: 7, name: 'P', stage: 'building', stale_days: 14, review_after: null, archived: 0, created_at: ago2(60),
  steps: [], activity: {}, ...over,
});

test('a later commit that describes an open step suggests ticking it, dated to the commit', () => {
  const p = scanProject({
    steps: [{ id: 1, text: 'Port Sitecap storage to Azure Blob', done: 0, created_at: ago2(10) }],
    activity: { git: { last_at: ago2(1), detail: { recent: [
      { hash: 'abc1234def', at: ago2(1), subject: 'Move page storage to Azure Blob for Sitecap' },
      { hash: 'zzz', at: ago2(2), subject: 'Tidy README' },
    ] } } },
  });
  const out = suggest.fromScan([p], { now: NOW2 });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].type, 'complete_step');
  assert.strictEqual(out[0].payload.done_at, ago2(1));
  assert.match(out[0].evidence, /abc1234/);
});

test('a commit sharing one word, or made before the step existed, does not match', () => {
  const p = scanProject({
    steps: [{ id: 1, text: 'Port Sitecap storage to Azure Blob', done: 0, created_at: ago2(3) }],
    activity: { git: { last_at: ago2(1), detail: { recent: [
      { hash: 'a', at: ago2(1), subject: 'Azure login page copy' },
      { hash: 'b', at: ago2(5), subject: 'Port Sitecap storage to Azure Blob' },
    ] } } },
  });
  assert.deepStrictEqual(suggest.fromScan([p], { now: NOW2 }), []);
});

test('an active project silent for a month suggests pausing, unless snoozed', () => {
  const quiet = scanProject({ activity: { fs: { last_at: ago2(40), detail: {} } } });
  const out = suggest.fromScan([quiet], { now: NOW2 });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].payload.stage, 'paused');
  const snoozed = scanProject({ review_after: '2026-10-20', activity: { fs: { last_at: ago2(40), detail: {} } } });
  assert.deepStrictEqual(suggest.fromScan([snoozed], { now: NOW2 }), []);
  const recent = scanProject({ activity: { fs: { last_at: ago2(10), detail: {} } } });
  assert.deepStrictEqual(suggest.fromScan([recent], { now: NOW2 }), []);
});

test('a paused project with fresh commits suggests building, but file times alone do not', () => {
  const back = scanProject({ stage: 'paused', activity: { git: { last_at: ago2(1), detail: { last_commit_subject: 'Resume work' } } } });
  const out = suggest.fromScan([back], { lastStageChange: new Map([[7, ago2(20)]]), now: NOW2 });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].payload.stage, 'building');
  const synced = scanProject({ stage: 'paused', activity: { fs: { last_at: ago2(0), detail: {} } } });
  assert.deepStrictEqual(suggest.fromScan([synced], { now: NOW2 }), []);
  // Work before the pause decision is why it was paused, not a reason to resume.
  const old = scanProject({ stage: 'paused', activity: { git: { last_at: ago2(2), detail: {} } } });
  assert.deepStrictEqual(suggest.fromScan([old], { lastStageChange: new Map([[7, ago2(1)]]), now: NOW2 }), []);
});

test('commit messages are read from heredocs, here-strings and -m', () => {
  assert.strictEqual(commitSubject("git commit -m \"$(cat <<'EOF'\nAdd a Done view\n\nBody\nEOF\n)\""), 'Add a Done view');
  assert.strictEqual(commitSubject("git commit -m @'\nFix the Amica double count\n'@"), 'Fix the Amica double count');
  assert.strictEqual(commitSubject('git -C "x y" commit -m "Short one"'), 'Short one');
  assert.strictEqual(commitSubject('git status'), null);
});

test('session digests keep what Matt typed and drop injected context', () => {
  assert.strictEqual(promptText({ message: { content: 'pick up the AR tracker' } }), 'pick up the AR tracker');
  assert.strictEqual(promptText({ message: { content: '<command-name>/model</command-name>' } }), null);
  assert.strictEqual(promptText({ isMeta: true, message: { content: 'Caveat: ...' } }), null);
  assert.strictEqual(promptText({ message: { content: [{ type: 'tool_result', content: 'x' }] } }), null);
  assert.strictEqual(promptText({ message: { content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }, { type: 'text', text: 'real ask' }] } }), 'real ask');
});

// Tidy up the throwaway database.
try { db.open().close(); } catch { /* already closed */ }
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  try { fs.unlinkSync(TEST_DB + suffix); } catch { /* not there */ }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
