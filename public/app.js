'use strict';
/* Mission Control front end. No framework, no build step. */

const state = {
  projects: [],
  queue: [],
  done: [],          // every completed step, newest first, from /api/done
  suggestions: [],   // open suggested updates, from /api/suggestions
  lastSync: null,    // when /sync-dashboard last posted
  sugSel: new Set(), // suggestion ids ticked for applying
  sugEdits: {},      // { id: { text } } rewording typed before applying
  meta: { stages: [], kinds: [], kind_info: [], colors: [], rules: [], owner_name: '' },
  scan: {},
  view: 'tiles',
  openId: null,
  detail: null,
  filters: { q: '', kind: '', archived: false, sort: 'attention' },
  pollTimer: null,
};

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const STAGE_LABEL = { idea: 'Idea', building: 'Building', testing: 'Testing', handoff: 'Handoff', live: 'Live', paused: 'Paused', done: 'Done' };
const STAGE_STEP = { idea: 1, building: 2, testing: 3, handoff: 4, live: 5, paused: 2, done: 5 };
// Kinds come from the server so the labels and the one-line definitions live in
// one place. Falls back gracefully if a project carries a kind we do not know.
const kindInfo = (id) =>
  (state.meta.kind_info || []).find((k) => k.id === id) || { id, icon: '•', label: id || 'unfiled', blurb: '' };
const SOURCE_ICON = { git: '🌱', claude: '✨', fs: '📁' };
const SOURCE_LABEL = { git: 'git', claude: 'claude', fs: 'files' };

// A project's icon: its line glyph in white on a squircle of its colour, or its
// emoji when Matt chose that instead. Sizes: xs 26, sm 34, md 44, lg 56, xl 64.
// glyphFor / glyphSvg come from glyphs.js.
function appIcon(p, size = 'lg') {
  const n = el('span', `ico ${size}`);
  n.dataset.color = p.color || 'cocoa';
  const g = glyphFor(p);
  if (g) n.innerHTML = glyphSvg(g);
  else { n.classList.add('emo'); n.textContent = p.icon || '•'; }
  return n;
}
// The small monochrome mark for a kind, used on chips and the kind picker.
function kindIcon(kind) {
  const n = el('span', 'kglyph');
  n.innerHTML = glyphSvg(KIND_GLYPH[kind] || 'sparkles');
  return n;
}

// ------------------------------------------------------------------ helpers

function ago(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.round(h)}h ago`;
  const d = h / 24; if (d < 31) return `${Math.round(d)}d ago`;
  const mo = d / 30.44; if (mo < 12) return `${Math.round(mo)}mo ago`;
  return `${(d / 365).toFixed(1)}y ago`;
}
const shortAgo = (iso) => { const a = ago(iso); return a ? a.replace(' ago', '').replace('just now', 'now') : null; };
function daysSince(iso) { const t = Date.parse(iso || ''); return Number.isNaN(t) ? Infinity : (Date.now() - t) / 86400000; }
function freshness(iso) { const d = daysSince(iso); return d < 2 ? 'fresh' : d < 8 ? 'warm' : 'cold'; }
function newestOf(p) {
  let best = null;
  for (const s of ['git', 'claude', 'fs']) {
    const a = p.activity?.[s]?.last_at;
    if (a && (!best || a > best)) best = a;
  }
  return best;
}
function queueCount(p) { return (p.flags || []).filter((f) => f.inQueue).length; }
function worstSeverity(p) {
  const q = (p.flags || []).filter((f) => f.inQueue);
  if (q.some((f) => f.severity === 'warn')) return 'warn';
  if (q.some((f) => f.severity === 'act')) return 'act';
  return q.length ? 'info' : null;
}

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, isErr ? 5000 : 2200);
}

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

// ------------------------------------------------------------------ loading

const SORTS = [['attention', 'Needs attention first'], ['recent', 'Recently active'], ['priority', 'Priority'], ['name', 'Name']];

async function loadMeta() {
  state.meta = await api('/api/meta');
  renderFilterMenu();
}

// Kind, sort and archived live in one menu, so the toolbar is one row.
function renderFilterMenu() {
  const kinds = $('#kindChips'); kinds.innerHTML = '';
  const opt = (label, on, onPick, mark, title) => {
    const b = el('button', 'menu-item' + (on ? ' on' : ''));
    b.type = 'button';
    if (mark) b.appendChild(mark); else b.appendChild(el('span', 'kglyph'));
    b.appendChild(el('span', 'mi-label', label));
    b.appendChild(el('span', 'mi-check', on ? '✓' : ''));
    if (title) b.title = title;
    b.addEventListener('click', () => { onPick(); renderFilterMenu(); render(); });
    return b;
  };
  kinds.appendChild(opt('All kinds', !state.filters.kind, () => { state.filters.kind = ''; }));
  for (const k of state.meta.kind_info) {
    kinds.appendChild(opt(k.label, state.filters.kind === k.id, () => { state.filters.kind = k.id; }, kindIcon(k.id), k.blurb));
  }
  const sorts = $('#sortList'); sorts.innerHTML = '';
  for (const [id, label] of SORTS) sorts.appendChild(opt(label, state.filters.sort === id, () => { state.filters.sort = id; }));

  const kind = state.meta.kind_info.find((k) => k.id === state.filters.kind);
  const lbl = $('#filterLabel'); lbl.innerHTML = '';
  if (kind) lbl.appendChild(kindIcon(kind.id));
  lbl.appendChild(document.createTextNode(kind ? kind.label : 'All kinds'));
  $('#filterBtn').classList.toggle('on', !!kind || state.filters.archived);
}

function toggleFilterMenu(open) {
  const m = $('#filterMenu'); const b = $('#filterBtn');
  const show = open ?? m.hidden;
  m.hidden = !show; b.setAttribute('aria-expanded', String(show));
}

// ---- search: filters the board as you type, and offers projects to jump to.
function renderJump() {
  const box = $('#jump'); const q = $('#search').value.trim().toLowerCase();
  if (!q) { box.hidden = true; return; }
  const hits = state.projects
    .map((p) => ({ p, at: p.name.toLowerCase().indexOf(q), other: `${p.next_step} ${p.summary}`.toLowerCase().includes(q) }))
    .filter((h) => h.at >= 0 || h.other)
    .sort((a, b) => (a.at < 0) - (b.at < 0) || a.at - b.at || a.p.name.localeCompare(b.p.name))
    .slice(0, 6);
  box.innerHTML = '';
  state.jumpIndex = Math.min(state.jumpIndex || 0, Math.max(0, hits.length - 1));
  if (!hits.length) { box.appendChild(el('div', 'jump-empty', 'No project matches. The board below is filtered too.')); box.hidden = false; return; }
  hits.forEach(({ p }, k) => {
    const r = el('button', 'jump-row' + (k === state.jumpIndex ? ' on' : ''));
    r.type = 'button'; r.setAttribute('role', 'option');
    r.appendChild(appIcon(p, 'xs'));
    r.appendChild(el('span', 'jr-name', p.name));
    r.appendChild(el('span', 'jr-sub', STAGE_LABEL[p.stage] || p.stage));
    r.addEventListener('mousedown', (e) => { e.preventDefault(); jumpTo(p.id); });
    box.appendChild(r);
  });
  box.hidden = false;
  state.jumpHits = hits.map((h) => h.p.id);
}
function jumpTo(id) {
  $('#jump').hidden = true;
  $('#search').blur();
  openDrawer(id);
}

async function load() {
  const [data, done, sug] = await Promise.all([
    api('/api/projects' + (state.filters.archived ? '?archived=1' : '')),
    // The done log and suggestions are niceties. If the server is an older
    // build without these routes, the board must still load rather than fail.
    api('/api/done').catch(() => ({ items: [] })),
    api('/api/suggestions').catch(() => ({ items: [], last_claude_sync_at: null })),
  ]);
  state.projects = data.projects; state.queue = data.queue; state.scan = data.scan;
  state.done = done.items || [];
  state.suggestions = sug.items || []; state.lastSync = sug.last_claude_sync_at || null;
  render();
}

async function pollScan() {
  state.scan = await api('/api/scan/status');
  renderScan();
  if (state.scan.running) state.pollTimer = setTimeout(pollScan, 700);
  else {
    clearTimeout(state.pollTimer); state.pollTimer = null; await load();
    const n = state.scan.summary?.suggested || 0;
    if (n) toast(`Scan found ${n} new suggested update${n === 1 ? '' : 's'}`);
  }
}

// ------------------------------------------------------------------ render

function render() {
  renderHero();
  renderScan();
  const visible = sorted(filtered());
  renderTiles(visible);
  renderQueue(visible);
  renderBoard(visible);
  const n = state.queue.length;
  const qc = $('#queueCount'); qc.textContent = n; qc.className = 'count' + (n ? '' : ' zero');
  renderDone();
  $('#doneCount').textContent = doneStats(state.done).thisWeek;
  renderSuggested();
  const sc = $('#sugCount'); sc.textContent = state.suggestions.length; sc.hidden = !state.suggestions.length;
  if (state.openId && state.detail && state.detail.id === state.openId) renderDrawer(state.detail);
}

function renderHero() {
  const now = new Date();
  $('#today').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const h = now.getHours();
  const word = h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const name = String(state.meta.owner_name || '').trim();
  const g = $('#greeting');
  // Built as nodes rather than innerHTML: the name is data, not markup.
  g.textContent = name ? `${word}, ${name}` : word;
  g.appendChild(el('span', 'period', '.'));

  const active = state.projects.filter((p) => !p.archived);
  const need = new Set(state.queue.map((q) => q.project_id)).size;
  const motion = active.filter((p) => bandOf(p) === 'motion').length;
  const stalled = active.filter((p) => bandOf(p) === 'stalled').length;
  const parked = active.filter((p) => bandOf(p) === 'parked').length;
  const ds = doneStats(state.done);
  // Each figure that asks for something is a link to where you deal with it.
  const go = (where, text) => `<a class="need" href="#" data-go="${where}">${text}</a>`;
  $('#summary').innerHTML =
    `<b>${motion}</b> in motion · ` +
    (stalled ? go('stalled', `${stalled} need${stalled === 1 ? 's' : ''} a next step`) : `<b>0</b> stalled`) +
    ` · <b>${parked}</b> live &amp; parked · ` +
    (need ? go('queue', `${need} need${need === 1 ? 's' : ''} you`) : `<b style="color:var(--ok)">nothing needs you</b>`) +
    (ds.thisWeek ? ` · <b class="good">${ds.thisWeek}</b> done this week` : '') +
    (state.suggestions.length ? ` · ${go('suggested', `${state.suggestions.length} suggested update${state.suggestions.length === 1 ? '' : 's'}`)}` : '');
}

function renderScan() {
  const s = state.scan || {};
  const box = $('#scanStatus'); const txt = box.querySelector('.scan-text');
  box.classList.toggle('running', !!s.running); box.classList.toggle('error', !!s.error);
  if (s.running) {
    const pct = s.bytesTotal ? Math.round((s.bytesDone / s.bytesTotal) * 100) : 0;
    txt.textContent = s.phase === 'transcripts' ? `reading transcripts ${pct}%` : `scanning ${s.phase}…`;
  } else if (s.error) txt.textContent = `scan failed`;
  else if (s.lastScanAt) {
    // Say what the last scan produced, so a scan that found something does not
    // look the same as one that found nothing.
    const found = s.lastSummary?.suggested || 0;
    txt.textContent = `scanned ${ago(s.lastScanAt)}` + (found && state.suggestions.length ? ` · ${found} new suggested` : '');
  }
  else txt.textContent = 'not scanned yet';
}

function filtered() {
  const { q, kind } = state.filters;
  const needle = q.trim().toLowerCase();
  return state.projects.filter((p) => {
    if (kind && p.kind !== kind) return false;
    if (needle && !`${p.name} ${p.summary} ${p.next_step} ${p.waiting_on} ${p.path || ''}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

function sorted(list) {
  const sev = { warn: 0, act: 1, info: 2 };
  const by = {
    attention: (a, b) => (queueCount(b) > 0) - (queueCount(a) > 0) || (sev[worstSeverity(a)] ?? 9) - (sev[worstSeverity(b)] ?? 9) || a.priority - b.priority || a.name.localeCompare(b.name),
    recent: (a, b) => (newestOf(b) || '').localeCompare(newestOf(a) || '') || a.name.localeCompare(b.name),
    priority: (a, b) => a.priority - b.priority || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  return [...list].sort(by[state.filters.sort] || by.attention);
}

// ------------------------------------------------------------------ bands + tiles

// Which band a project sits in. Stage decides whether it is active; the
// checklist decides whether there is anything to do. Ticking off the last
// step moves a project from "motion" to "stalled" with no other change.
const PARKED_STAGES = ['live', 'paused', 'done'];
function openSteps(p) { return (p.steps || []).filter((s) => !s.done).length; }
function bandOf(p) {
  if (PARKED_STAGES.includes(p.stage)) return 'parked';
  if (openSteps(p) > 0) return 'motion';
  if (p.stage === 'idea') return 'parked';
  return 'stalled';
}
const BANDS = [
  { id: 'motion', tone: 'go', title: 'In motion', desc: 'Active, with a next step queued. This is the work.',
    empty: 'Nothing in motion. Add a step to something below, or start a project.' },
  { id: 'stalled', tone: 'stop', title: 'Needs a next step', desc: 'Active, but the checklist is empty. Decide what comes next, or park it.',
    empty: 'Empty, which is the good kind of empty. Everything active knows what comes next.' },
  { id: 'parked', tone: 'rest', title: 'Live & parked', desc: 'Running on their own, paused, done, or ideas not yet started.', compact: true },
];
// Inside the parked band: live things first (with queued steps ahead of the
// rest), then unstarted ideas, then paused, then done.
const PARKED_RANK = { live: 0, idea: 2, paused: 3, done: 4 };
function parkedOrder(a, b) {
  const ra = PARKED_RANK[a.stage] ?? 9, rb = PARKED_RANK[b.stage] ?? 9;
  if (ra !== rb) return ra - rb;
  const sa = openSteps(a) > 0 ? 0 : 1, sb = openSteps(b) > 0 ? 0 : 1;
  if (sa !== sb) return sa - sb;
  return a.name.localeCompare(b.name);
}

function renderTiles(visible) {
  renderUpNext(visible);
  const box = $('#tiles'); box.innerHTML = '';
  let i = 0;

  for (const band of BANDS) {
    let list = visible.filter((p) => bandOf(p) === band.id);
    if (band.id === 'parked') list = [...list].sort(parkedOrder);
    if (band.id === 'parked' && !list.length) continue;

    const sec = el('section', `band band-${band.tone}`);
    sec.id = `band-${band.id}`;
    const head = el('div', 'band-head');
    head.appendChild(el('span', 'band-dot'));
    head.appendChild(el('h2', 'band-title', band.title));
    head.appendChild(el('span', 'band-count', String(list.length)));
    head.appendChild(el('span', 'band-desc', band.desc));
    sec.appendChild(head);

    // Live and parked mostly run themselves, so they get a compact dock of rows
    // instead of ten more cards competing with the work above.
    if (band.compact) {
      sec.appendChild(dock(list));
      box.appendChild(sec);
      continue;
    }

    const grid = el('div', 'tiles');
    if (!list.length && band.empty) grid.appendChild(el('div', 'band-empty', band.empty));
    for (const p of list) grid.appendChild(tile(p, i++));

    if (band.id === 'motion') {
      const add = el('div', 'tile new');
      add.style.setProperty('--i', i++);
      add.appendChild(el('div', 'plus', '＋'));
      add.appendChild(el('div', null, 'New project'));
      add.addEventListener('click', newProject);
      grid.appendChild(add);
    }
    sec.appendChild(grid);
    box.appendChild(sec);
  }
}

// ---- pieces shared by tiles, Up next and the dock

// The attention count sits on the icon, like a notification on an app. Black
// for a data-loss risk, orange for something to decide, grey for a note.
function badgedIcon(p, size) {
  const ico = appIcon(p, size);
  const n = queueCount(p);
  if (n) ico.appendChild(el('span', `bdg ${worstSeverity(p)}`, String(n)));
  return ico;
}

function stageLabel(p) {
  const s = el('span', 'stg');
  s.dataset.stage = p.stage;
  s.appendChild(el('i'));
  s.appendChild(document.createTextNode(STAGE_LABEL[p.stage] || p.stage));
  return s;
}

// Thirty days of activity, oldest first, one number per local calendar day.
// A commit counts 1 and a Claude session that worked on the project counts 2,
// so a day of real work stands taller than a stray commit.
const ACTIVITY_DAYS = 30;
function activityDays(p) {
  const out = new Array(ACTIVITY_DAYS).fill(0);
  const today = startOfDay(new Date()).getTime();
  const add = (iso, w) => {
    const t = Date.parse(iso || '');
    if (Number.isNaN(t)) return;
    const back = Math.round((today - startOfDay(new Date(t)).getTime()) / DAY);
    if (back >= 0 && back < ACTIVITY_DAYS) out[ACTIVITY_DAYS - 1 - back] += w;
  };
  for (const c of p.activity?.git?.detail?.recent || []) add(c.at, 1);
  for (const s of p.activity?.claude?.detail?.recent_sessions || []) add(s, 2);
  return out;
}

function spark(p) {
  const days = activityDays(p);
  const max = Math.max(4, ...days);
  const total = days.reduce((a, b) => a + b, 0);
  const s = el('div', 'spark');
  s.setAttribute('role', 'img');
  s.setAttribute('aria-label', total ? 'Activity over the last 30 days' : 'No commits or sessions in the last 30 days');
  days.forEach((v, k) => {
    const bar = el('i', v ? '' : 'z');
    if (v) bar.style.height = `${Math.max(14, Math.round((v / max) * 100))}%`;
    const d = new Date(Date.now() - (ACTIVITY_DAYS - 1 - k) * DAY);
    bar.title = `${fmtDay(d)}: ${v ? `${v} activity` : 'quiet'}`;
    s.appendChild(bar);
  });
  return s;
}

// Open versus done steps as a ring that fills green as the checklist empties.
function stepRing(p) {
  const done = (p.steps || []).filter((s) => s.done).length;
  const total = done + openSteps(p);
  const r = 10, C = 2 * Math.PI * r, f = total ? done / total : 0;
  const w = el('span', 'ring');
  w.title = `${done} of ${total} steps done`;
  w.innerHTML = `<svg viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="${r}" class="track"/>`
    + `<circle cx="13" cy="13" r="${r}" class="fill" stroke-dasharray="${(C * f).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 13 13)"/></svg>`;
  return w;
}

function lastActive(p) {
  const at = newestOf(p);
  if (!at) return state.scan?.everScanned ? 'no activity yet' : 'not scanned yet';
  const a = ago(at);
  return a === 'just now' ? 'active just now' : `active ${a}`;
}

function nextLine(p) {
  const next = el('p', 'tile-next' + (p.next_step ? '' : ' none'));
  if (p.next_step) {
    next.textContent = p.next_step;
    if (p.waiting_on) { next.appendChild(document.createTextNode(' ')); next.appendChild(el('span', 'wait', `(waiting on ${p.waiting_on})`)); }
  } else if (['paused', 'done', 'live', 'idea'].includes(p.stage)) {
    next.textContent = p.summary || 'No next step needed right now.';
    next.classList.remove('none');
  } else next.textContent = 'Needs a next step';
  return next;
}

function tile(p, i) {
  const t = el('article', 'tile');
  t.dataset.color = p.color || 'cocoa';
  t.style.setProperty('--i', i);
  t.addEventListener('click', () => openDrawer(p.id));

  const top = el('div', 'tile-top');
  top.appendChild(badgedIcon(p, 'lg'));
  top.appendChild(stageLabel(p));
  t.appendChild(top);

  const name = el('h3', 'tile-name', p.name);
  if (p.priority === 1) { const st = el('span', 'star', '★'); st.title = 'High priority'; name.appendChild(st); }
  t.appendChild(name);
  t.appendChild(nextLine(p));

  // The activity strip gets the full width; the step count and freshness sit
  // on one line underneath it.
  const foot = el('div', 'tile-foot');
  foot.appendChild(spark(p));
  const meta = el('div', 'tile-meta');
  const open = openSteps(p);
  const done = (p.steps || []).filter((s) => s.done).length;
  const count = el('span', 'tile-count');
  count.appendChild(stepRing(p));
  count.appendChild(el('b', null, open ? `${open} open` : done ? `${done} done` : 'no steps'));
  meta.appendChild(count);
  meta.appendChild(el('span', 'tile-fresh', lastActive(p)));
  foot.appendChild(meta);
  t.appendChild(foot);
  return t;
}

function dock(list) {
  const d = el('div', 'dock');
  list.forEach((p, k) => {
    const r = el('button', 'dk' + (['paused', 'done'].includes(p.stage) ? ' is-quiet' : ''));
    r.type = 'button';
    r.dataset.color = p.color || 'cocoa';
    r.style.setProperty('--i', k);
    r.appendChild(badgedIcon(p, 'sm'));
    const body = el('span', 'dk-body');
    body.appendChild(el('span', 'dk-name', p.name));
    const what = p.next_step || p.waiting_on && `Waiting on ${p.waiting_on}` || p.summary || '';
    body.appendChild(el('span', 'dk-sub', `${STAGE_LABEL[p.stage] || p.stage}${what ? ` · ${what}` : ''}`));
    r.appendChild(body);
    r.appendChild(spark(p));
    r.addEventListener('click', () => openDrawer(p.id));
    d.appendChild(r);
  });
  return d;
}

// ---- Up next: the top step of every project in motion, tickable in place.

const UPNEXT_CAP = 5;
function renderUpNext(visible) {
  const box = $('#upnext'); box.innerHTML = '';
  const rows = visible
    .filter((p) => bandOf(p) === 'motion' && p.next_step)
    .sort((a, b) => a.priority - b.priority || (newestOf(b) || '').localeCompare(newestOf(a) || '') || a.name.localeCompare(b.name));
  box.hidden = !rows.length;
  if (!rows.length) return;

  const lead = el('div', 'un-lead');
  const words = el('div');
  words.appendChild(el('h2', 'un-title', 'Up next'));
  words.appendChild(el('p', 'un-desc', 'The top step on each project in motion. Tick it here.'));
  lead.appendChild(words);
  const big = el('div', 'un-big', String(rows.length));
  big.appendChild(el('small', null, rows.length === 1 ? 'project moving' : 'projects moving'));
  lead.appendChild(big);
  box.appendChild(lead);

  const list = el('div', 'un-list');
  const shown = state.upAll ? rows : rows.slice(0, UPNEXT_CAP);
  shown.forEach((p, k) => list.appendChild(upRow(p, k)));
  if (rows.length > UPNEXT_CAP) {
    const rest = rows.slice(UPNEXT_CAP);
    const more = el('button', 'un-more', state.upAll ? 'Show fewer' : `${rest.length} more: ${rest.map((p) => p.name).join(', ')}`);
    more.type = 'button';
    more.addEventListener('click', () => { state.upAll = !state.upAll; renderUpNext(sorted(filtered())); });
    list.appendChild(more);
  }
  box.appendChild(list);
}

function upRow(p, k) {
  const step = (p.steps || []).find((s) => !s.done);
  const r = el('div', 'un-row');
  r.style.setProperty('--i', k);
  const tick = el('button', 'un-tick');
  tick.type = 'button';
  tick.setAttribute('aria-label', `Mark "${p.next_step}" done`);
  tick.innerHTML = glyphSvg('check');
  tick.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!step || r.classList.contains('ticking')) return;
    r.classList.add('ticking');
    // Let the check land before the list redraws with the project's next step.
    setTimeout(() => steps(p.id, 'PATCH', `/${step.id}`, { done: true }), 480);
  });
  r.appendChild(tick);
  r.appendChild(badgedIcon(p, 'xs'));
  const text = el('span', 'un-text');
  if (p.priority === 1) text.appendChild(el('span', 'star', '★'));
  text.appendChild(document.createTextNode(p.next_step));
  if (p.waiting_on) text.appendChild(el('span', 'wait', ` (waiting on ${p.waiting_on})`));
  r.appendChild(text);
  r.appendChild(el('span', 'un-proj', p.name));
  r.addEventListener('click', () => openDrawer(p.id));
  return r;
}

// ------------------------------------------------------------------ queue + board

function renderQueue(visible) {
  const ids = new Set(visible.map((p) => p.id));
  const byId = new Map(state.projects.map((p) => [p.id, p]));
  const items = state.queue.filter((q) => ids.has(q.project_id));
  const box = $('#queue'); box.innerHTML = '';
  if (!items.length) {
    const e = el('div', 'empty', 'Nothing needs you.');
    e.appendChild(el('small', null, 'Every active project has a next step and recent activity. Go make something.'));
    box.appendChild(e); return;
  }
  items.forEach((it, i) => {
    const p = byId.get(it.project_id) || {};
    const r = el('div', `qrow ${it.severity}`); r.dataset.color = p.color || 'cocoa'; r.style.setProperty('--i', i);
    r.appendChild(appIcon(p, 'md'));
    const body = el('div'); body.appendChild(el('div', 'label', it.label)); body.appendChild(el('div', 'sub', it.detail)); r.appendChild(body);
    r.appendChild(el('div', 'who', it.project_name));
    r.addEventListener('click', () => openDrawer(it.project_id));
    box.appendChild(r);
  });
}

function renderBoard(visible) {
  const board = $('#board'); board.innerHTML = '';
  for (const stage of state.meta.stages) {
    const inStage = visible.filter((p) => p.stage === stage);
    const col = el('div', 'col');
    const head = el('div', 'col-head'); head.appendChild(el('span', null, STAGE_LABEL[stage] || stage)); head.appendChild(el('span', 'n', String(inStage.length))); col.appendChild(head);
    const body = el('div', 'col-body'); body.dataset.stage = stage;
    body.addEventListener('dragover', (e) => { e.preventDefault(); body.classList.add('over'); });
    body.addEventListener('dragleave', () => body.classList.remove('over'));
    body.addEventListener('drop', async (e) => {
      e.preventDefault(); body.classList.remove('over');
      const id = Number(e.dataTransfer.getData('text/plain'));
      const p = state.projects.find((x) => x.id === id);
      if (!p || p.stage === stage) return;
      await patch(id, { stage }); toast(`${p.name} → ${STAGE_LABEL[stage]}`);
    });
    for (const p of inStage) {
      const m = el('div', 'mini'); m.dataset.color = p.color || 'cocoa'; m.draggable = true;
      m.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(p.id)); m.classList.add('dragging'); });
      m.addEventListener('dragend', () => m.classList.remove('dragging'));
      m.addEventListener('click', () => openDrawer(p.id));
      const n = queueCount(p); if (n) m.appendChild(el('span', `badge ${worstSeverity(p)}`, String(n)));
      m.appendChild(appIcon(p, 'sm'));
      m.appendChild(el('div', 'nm', p.name));
      body.appendChild(m);
    }
    col.appendChild(body); board.appendChild(col);
  }
}

function setView(v) {
  state.view = v;
  document.querySelectorAll('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  $('#viewTiles').hidden = v !== 'tiles'; $('#viewQueue').hidden = v !== 'queue'; $('#viewBoard').hidden = v !== 'board';
  $('#viewDone').hidden = v !== 'done';
  $('#viewSuggested').hidden = v !== 'suggested';
  try { localStorage.setItem('mc.view', v); } catch { /* fine */ }
}

// ------------------------------------------------------------------ drawer

async function openDrawer(id) {
  state.openId = id;
  $('#scrim').hidden = false; $('#drawer').hidden = false;
  const stub = state.projects.find((x) => x.id === id);
  if (stub) { state.detail = { ...stub, log: [] }; renderDrawer(state.detail); }
  await refreshDetail();
}
async function refreshDetail() {
  if (!state.openId) return;
  try { const full = await api(`/api/projects/${state.openId}`); if (full.id === state.openId) { state.detail = full; renderDrawer(full); } }
  catch (e) { toast(e.message, true); }
}
function closeDrawer() { state.openId = null; state.detail = null; $('#scrim').hidden = true; $('#drawer').hidden = true; }

async function patch(id, body) {
  try { await api(`/api/projects/${id}`, { method: 'PATCH', body }); await load(); if (state.openId === id) await refreshDetail(); }
  catch (e) { toast(e.message, true); }
}

function renderDrawer(p) {
  const d = $('#drawer'); const scrollTop = d.scrollTop; d.innerHTML = '';
  d.dataset.color = p.color || 'cocoa';

  // ---- header
  const head = el('div', 'dhead');
  const blob = appIcon(p, 'xl'); blob.classList.add('pick'); blob.title = 'Change icon';
  blob.addEventListener('click', () => d.querySelector('#looks')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  head.appendChild(blob);
  const titles = el('div', 'titles');
  const h2 = el('h2', null, p.name); h2.contentEditable = 'true'; h2.spellcheck = false; h2.title = 'Click to rename';
  h2.addEventListener('blur', () => { const v = h2.textContent.trim(); if (v && v !== p.name) patch(p.id, { name: v }); else h2.textContent = p.name; });
  h2.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); h2.blur(); } });
  titles.appendChild(h2);
  const bits = [kindInfo(p.kind).label]; if (p.port) bits.push(`port ${p.port}`); if (p.newest?.at) bits.push(`last touched ${ago(p.newest.at)}`);
  titles.appendChild(el('div', 'sub', bits.join(' · ')));
  head.appendChild(titles);
  const close = el('button', 'close', '×'); close.setAttribute('aria-label', 'Close'); close.addEventListener('click', closeDrawer); head.appendChild(close);
  d.appendChild(head);

  const body = el('div', 'dbody'); d.appendChild(body);

  // ---- now
  const openN = (p.steps || []).filter((s) => !s.done).length;
  const gNow = group(body, 'Up next', openN ? `${openN} step${openN === 1 ? '' : 's'} queued · top one is the next step` : 'nothing queued');
  gNow.appendChild(checklist(p));

  const mine = state.suggestions.filter((s) => s.project_id === p.id).length;
  if (mine) {
    const link = el('button', 'sug-link', `✨ ${mine} suggested update${mine === 1 ? '' : 's'} for this project · Review`);
    link.addEventListener('click', () => { closeDrawer(); setView('suggested'); });
    gNow.appendChild(link);
  }

  const stageF = el('div', 'field'); stageF.appendChild(el('label', null, 'Stage'));
  const steps = el('div', 'steps');
  for (const s of state.meta.stages) {
    const b = el('button', 'step' + (s === p.stage ? ' on' : ''), STAGE_LABEL[s] || s); b.dataset.stage = s;
    b.addEventListener('click', () => { if (s !== p.stage) patch(p.id, { stage: s }); });
    steps.appendChild(b);
  }
  stageF.appendChild(steps); gNow.appendChild(stageF);

  const prioF = el('div', 'field'); prioF.appendChild(el('label', null, 'Priority'));
  const prio = el('div', 'prio');
  for (const [v, lbl] of [['1', '★ High'], ['2', 'Normal'], ['3', 'Low']]) {
    const b = el('button', String(p.priority) === v ? 'on' : '', lbl); b.dataset.p = v;
    b.addEventListener('click', () => patch(p.id, { priority: v })); prio.appendChild(b);
  }
  prioF.appendChild(prio); gNow.appendChild(prioF);

  // Kind as six labelled buttons with the definition of whichever is selected
  // shown underneath, so the meaning is on screen instead of in your head.
  const kindF = el('div', 'field');
  kindF.appendChild(el('label', null, 'Kind'));
  const pick = el('div', 'kindpick');
  for (const k of state.meta.kind_info) {
    const b = el('button', 'kindbtn' + (k.id === p.kind ? ' on' : ''));
    const ki = kindIcon(k.id); ki.classList.add('ki'); b.appendChild(ki);
    b.appendChild(el('span', 'kl', k.label));
    b.title = k.blurb;
    b.addEventListener('click', () => { if (k.id !== p.kind) patch(p.id, { kind: k.id }); });
    pick.appendChild(b);
  }
  kindF.appendChild(pick);
  kindF.appendChild(el('div', 'hint kindblurb', kindInfo(p.kind).blurb));
  gNow.appendChild(kindF);

  const r3 = el('div', 'row2');
  r3.appendChild(field('Waiting on', input(p.waiting_on, (v) => patch(p.id, { waiting_on: v })), p.waiting_since ? `Since ${p.waiting_since}. After 7 days you get a nudge.` : 'A person or an outside event.'));
  r3.appendChild(field('Snooze until', input(p.review_after || '', (v) => patch(p.id, { review_after: v }), 'date'), 'Quiets stale, no-next-step and no-backup nags.'));
  gNow.appendChild(r3);

  // ---- signals
  const gSig = group(body, 'Signals', 'what the scanners found', 'radar');
  const sig = el('div', 'signals');
  sig.appendChild(signalRow('git', p.activity.git, gitEvidence));
  sig.appendChild(signalRow('claude', p.activity.claude, claudeEvidence));
  sig.appendChild(signalRow('fs', p.activity.fs, fsEvidence));
  gSig.appendChild(sig);

  // ---- rules
  const gRules = group(body, 'Nags', 'flip one off to mute it for this project', 'bell');
  const rules = el('div', 'rules');
  if (!(p.flags || []).length) rules.appendChild(el('div', 'rule', 'Nothing firing. Lovely.'));
  for (const f of p.flags || []) {
    const r = el('div', 'rule' + (f.suppressed ? ' is-muted' : ''));
    const sw = document.createElement('input'); sw.type = 'checkbox'; sw.className = 'switch';
    sw.checked = !(p.muted_rules || []).includes(f.id); sw.title = sw.checked ? 'On. Click to mute.' : 'Muted. Click to turn back on.';
    sw.addEventListener('change', () => { const set = new Set(p.muted_rules || []); if (sw.checked) set.delete(f.id); else set.add(f.id); patch(p.id, { muted_rules: [...set] }); });
    r.appendChild(sw);
    const lbl = el('div'); lbl.appendChild(el('div', 'rlabel', f.label)); lbl.appendChild(el('div', 'rdetail', f.suppressed ? `${f.detail} · ${f.suppressed}` : f.detail)); r.appendChild(lbl);
    r.appendChild(el('span', `sev ${f.severity}`, f.severity));
    rules.appendChild(r);
  }
  gRules.appendChild(rules);

  // ---- looks
  const gLooks = group(body, 'Looks', 'icon and colour', 'palette'); gLooks.id = 'looks';
  const sw = el('div', 'swatches');
  for (const c of state.meta.colors) {
    const s = el('button', 'swatch' + (c === p.color ? ' on' : '')); s.style.background = `var(--${c})`; s.title = c;
    s.addEventListener('click', () => patch(p.id, { color: c })); sw.appendChild(s);
  }
  gLooks.appendChild(sw);
  const current = glyphFor(p);
  const gl = el('div', 'glyphs');
  for (const g of PICKABLE) {
    const b = el('button', 'glyphbtn' + (g === current ? ' on' : ''));
    b.innerHTML = glyphSvg(g); b.title = g; b.setAttribute('aria-label', `Use the ${g} icon`);
    b.addEventListener('click', () => patch(p.id, { glyph: g }));
    gl.appendChild(b);
  }
  gLooks.appendChild(gl);
  // An emoji still works for anything the glyphs do not cover. Typing one
  // switches the tile to it; clicking any glyph above switches back.
  const custom = input(p.glyph === 'emoji' ? p.icon : '', (v) => patch(p.id, v.trim() ? { icon: v, glyph: 'emoji' } : { glyph: '' }));
  custom.placeholder = 'Or use an emoji instead'; custom.className = 'emoji-input';
  gLooks.appendChild(custom);

  // ---- where
  const gWhere = group(body, 'Where it lives', null, 'pin');
  gWhere.appendChild(field('Folder, relative to the workspace', input(p.path || '', (v) => patch(p.id, { path: v }))));
  const r4 = el('div', 'row3');
  r4.appendChild(field('Port', input(p.port || '', (v) => patch(p.id, { port: v }))));
  r4.appendChild(field('Stale after', input(p.stale_days, (v) => patch(p.id, { stale_days: v })), 'days'));
  r4.appendChild(field('Repo URL', input(p.repo_url || '', (v) => patch(p.id, { repo_url: v }))));
  gWhere.appendChild(r4);

  // ---- markers
  const gM = group(body, 'Transcript markers', 'how Claude sessions get matched to this', 'search');
  const chips = el('div', 'chipsrow');
  for (const m of p.markers) { const c = el('span', 'mchip'); c.appendChild(el('span', null, m)); const x = el('button', null, '×'); x.addEventListener('click', () => patch(p.id, { markers: p.markers.filter((y) => y !== m) })); c.appendChild(x); chips.appendChild(c); }
  if (!p.markers.length) chips.appendChild(el('span', 'hint', 'No markers, so Claude sessions cannot be matched.'));
  gM.appendChild(chips);
  const addM = input('', null); addM.placeholder = 'Add a marker, press Enter';
  addM.addEventListener('keydown', (e) => { if (e.key === 'Enter' && addM.value.trim()) { e.preventDefault(); patch(p.id, { markers: [...p.markers, addM.value.trim()] }); } });
  gM.appendChild(addM);
  gM.appendChild(el('div', 'hint', 'Distinctive substrings only. Adding one re-reads every transcript. Never use anything in the workspace path.'));

  // ---- notes + history
  const gN = group(body, 'Notes', null, 'pen'); gN.appendChild(textarea(p.notes, (v) => patch(p.id, { notes: v })));
  const gL = group(body, 'History', null, 'clock');
  const note = input('', null); note.placeholder = 'Jot a note, press Enter';
  note.addEventListener('keydown', async (e) => { if (e.key !== 'Enter' || !note.value.trim()) return; e.preventDefault(); try { await api(`/api/projects/${p.id}/log`, { method: 'POST', body: { text: note.value.trim() } }); note.value = ''; await refreshDetail(); } catch (err) { toast(err.message, true); } });
  gL.appendChild(note);
  const logs = el('div', 'logs'); logs.style.marginTop = '10px';
  for (const l of p.log || []) { const r = el('div', `logrow ${l.kind}`); r.appendChild(el('div', 'lat', (l.at || '').slice(0, 10))); r.appendChild(el('div', 'ltext', l.text)); logs.appendChild(r); }
  gL.appendChild(logs);

  // ---- actions
  const acts = el('div', 'dactions');
  const arch = el('button', 'pill pill-ghost', p.archived ? 'Unarchive' : 'Archive'); arch.addEventListener('click', () => patch(p.id, { archived: p.archived ? 0 : 1 })); acts.appendChild(arch);
  const del = el('button', 'pill pill-danger', 'Delete'); del.addEventListener('click', async () => { if (!confirm(`Delete "${p.name}" and its history? This cannot be undone.`)) return; await api(`/api/projects/${p.id}`, { method: 'DELETE' }); closeDrawer(); await load(); toast('Deleted'); }); acts.appendChild(del);
  body.appendChild(acts);

  d.scrollTop = scrollTop;
}

// ------------------------------------------------------------------ checklist

function checklist(p) {
  const wrap = el('div', 'checklist');
  const open = (p.steps || []).filter((s) => !s.done);
  const done = (p.steps || []).filter((s) => s.done);

  const list = el('div', 'steplist');
  if (!open.length) {
    const quiet = ['paused', 'done', 'live', 'idea'].includes(p.stage);
    list.appendChild(el('div', 'stepempty', quiet ? 'Nothing queued, and that is fine at this stage.' : 'Nothing queued, so the tile wears a badge. What is the next thing to do?'));
  }
  open.forEach((s, i) => list.appendChild(stepItem(p, s, i === 0)));
  wrap.appendChild(list);

  const add = input('', null);
  add.className = 'addstep';
  add.placeholder = open.length ? 'Add another step, press Enter' : 'Add the next step, press Enter';
  add.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !add.value.trim()) return;
    e.preventDefault();
    const text = add.value.trim(); add.value = '';
    await steps(p.id, 'POST', '', { text });
    // Keep the cursor here so a burst of steps can be typed in one go.
    const again = $('#drawer .addstep'); if (again) again.focus();
  });
  wrap.appendChild(add);

  if (done.length) {
    const det = el('details', 'donelist');
    state.doneOpen = state.doneOpen || {};
    det.open = !!state.doneOpen[p.id];
    det.addEventListener('toggle', () => { state.doneOpen[p.id] = det.open; });
    det.appendChild(el('summary', null, `✓ ${done.length} completed`));
    for (const s of done) {
      const r = el('div', 'doneitem');
      r.appendChild(el('span', 'dcheck', '✓'));
      r.appendChild(el('span', 'dtext', s.text));
      r.appendChild(el('span', 'ddate', (s.done_at || '').slice(0, 10)));
      const undo = el('button', 'undo', 'undo');
      undo.addEventListener('click', () => steps(p.id, 'PATCH', `/${s.id}`, { done: false }));
      r.appendChild(undo);
      det.appendChild(r);
    }
    wrap.appendChild(det);
  }
  return wrap;
}

function stepItem(p, s, isNext) {
  const r = el('div', 'stepitem' + (isNext ? ' is-next' : ''));
  r.dataset.id = s.id;

  // Only the grip starts a drag, so selecting text inside the row still works.
  const grip = el('span', 'grip', '⋮⋮'); grip.draggable = true; grip.title = 'Drag to reorder';
  grip.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/step', String(s.id)); e.dataTransfer.effectAllowed = 'move'; r.classList.add('dragging'); });
  grip.addEventListener('dragend', () => r.classList.remove('dragging'));
  r.appendChild(grip);

  const tick = el('button', 'tick'); tick.title = 'Done'; tick.setAttribute('aria-label', 'Mark complete');
  tick.addEventListener('click', (e) => {
    e.stopPropagation();
    if (r.classList.contains('ticking')) return;
    r.classList.add('ticking');
    // Let the check animation land before the row leaves the list.
    setTimeout(() => steps(p.id, 'PATCH', `/${s.id}`, { done: true }), 420);
  });
  r.appendChild(tick);

  const txt = el('div', 'steptext', s.text); txt.contentEditable = 'true'; txt.spellcheck = false;
  txt.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); txt.blur(); } if (e.key === 'Escape') { txt.textContent = s.text; txt.blur(); } });
  txt.addEventListener('blur', () => { const v = txt.textContent.trim(); if (v && v !== s.text) steps(p.id, 'PATCH', `/${s.id}`, { text: v }); else txt.textContent = s.text; });
  r.appendChild(txt);

  const x = el('button', 'x', '×'); x.title = 'Remove';
  x.addEventListener('click', () => steps(p.id, 'DELETE', `/${s.id}`));
  r.appendChild(x);

  r.addEventListener('dragover', (e) => { if (Array.from(e.dataTransfer.types).includes('text/step')) { e.preventDefault(); r.classList.add('over'); } });
  r.addEventListener('dragleave', () => r.classList.remove('over'));
  r.addEventListener('drop', (e) => {
    e.preventDefault(); r.classList.remove('over');
    const from = Number(e.dataTransfer.getData('text/step'));
    if (!from || from === s.id) return;
    const ids = (p.steps || []).filter((z) => !z.done).map((z) => z.id).filter((id) => id !== from);
    ids.splice(ids.indexOf(s.id), 0, from);
    steps(p.id, 'POST', '/reorder', { ids });
  });
  return r;
}

async function steps(pid, method, suffix, body) {
  try {
    const full = await api(`/api/projects/${pid}/steps${suffix}`, { method, body });
    if (state.openId === pid) state.detail = full;
    await load();
  } catch (e) { toast(e.message, true); }
}

function group(parent, title, sub, glyph = 'target') {
  const g = el('div', 'dgroup'); const h = el('h3');
  const mark = el('span', 'hglyph'); mark.innerHTML = glyphSvg(glyph); h.appendChild(mark);
  h.appendChild(document.createTextNode(title));
  if (sub) h.appendChild(el('small', null, sub));
  g.appendChild(h); parent.appendChild(g); return g;
}
function field(label, control, hint) { const f = el('div', 'field'); f.appendChild(el('label', null, label)); f.appendChild(control); if (hint) f.appendChild(el('div', 'hint', hint)); return f; }
// Save on blur or Enter, never per keystroke, so the log stays readable.
function input(value, onSave, type) {
  const i = document.createElement('input'); i.type = type || 'text'; i.value = value == null ? '' : value;
  if (onSave) { const commit = () => { if (String(i.value) !== String(value ?? '')) onSave(i.value); }; i.addEventListener('blur', commit); i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); i.blur(); } }); }
  return i;
}
function textarea(value, onSave, cls) { const t = document.createElement('textarea'); if (cls) t.className = cls; t.value = value || ''; t.addEventListener('blur', () => { if (t.value !== (value || '')) onSave(t.value); }); return t; }
function select(options, value, onSave, labels) {
  const s = document.createElement('select');
  for (const o of options) { const opt = el('option', null, (labels && labels[o]) || o); opt.value = o; if (String(o) === String(value)) opt.selected = true; s.appendChild(opt); }
  s.addEventListener('change', () => onSave(s.value)); return s;
}

function signalRow(source, act, describe) {
  const has = act && act.last_at;
  const r = el('div', 'signal' + (has ? ` ${freshness(act.last_at)}` : ' none'));
  r.appendChild(el('div', 'ico', SOURCE_ICON[source]));
  const what = el('div', 'what'); what.innerHTML = act ? describe(act.detail || {}) : '<i>not scanned yet</i>'; r.appendChild(what);
  r.appendChild(el('div', 'when', has ? ago(act.last_at) : '—'));
  return r;
}
const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function gitEvidence(g) {
  if (g.is_repo === false) return g.inside_repo ? 'Not its own repo <i>(sits inside the workspace repo)</i>' : 'Not a git repository';
  const bits = [];
  if (g.last_commit_subject) bits.push(`<b>“${escapeHtml(g.last_commit_subject)}”</b>`);
  const c = []; if (g.ahead) c.push(`${g.ahead} ahead`); if (g.modified) c.push(`${g.modified} modified`); if (g.untracked) c.push(`${g.untracked} untracked`); if (!g.has_upstream) c.push('no upstream');
  if (c.length) bits.push(c.join(', '));
  if (g.remote) bits.push(escapeHtml(g.remote.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')));
  return bits.join(' · ') || 'clean';
}
function claudeEvidence(c) {
  if (!c.sessions) return 'no sessions matched';
  const s = `<b>${c.sessions} session${c.sessions === 1 ? '' : 's'}</b>`;
  return c.last_prompt ? `${s} · last one opened with “${escapeHtml(c.last_prompt)}”` : s;
}
function fsEvidence(f) {
  if (f.exists === false) return 'folder not found';
  const bits = []; if (f.newest_file) bits.push(`<b>${escapeHtml(f.newest_file)}</b>`); if (f.files != null) bits.push(`${f.files} files${f.truncated ? '+' : ''}`);
  return bits.join(' · ') || 'empty folder';
}

// ------------------------------------------------------------------ done log

const DAY = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');
// Local calendar day. A step ticked at 11pm belongs to today, not tomorrow UTC.
function dayKey(d) { d = d instanceof Date ? d : new Date(d); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function startOfWeek(d) { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; } // Monday
const fmtDay = (d) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

// The search box and kind chips apply here too, so "what did I finish on
// Sitecap" is one keystroke away.
function doneVisible() {
  const { q, kind } = state.filters; const needle = q.trim().toLowerCase();
  return (state.done || []).filter((r) => {
    if (kind && r.kind !== kind) return false;
    if (needle && !`${r.text} ${r.project_name}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

function doneStats(items) {
  const now = new Date(); const today = startOfDay(now); const week = startOfWeek(now);
  const byDay = new Map();
  for (const r of items) { const k = dayKey(r.done_at); byDay.set(k, (byDay.get(k) || 0) + 1); }
  const strip = [];
  for (let i = 13; i >= 0; i -= 1) { const d = new Date(today.getTime() - i * DAY); strip.push({ date: d, n: byDay.get(dayKey(d)) || 0 }); }
  // Consecutive days with at least one tick, counting back from today. A blank
  // today does not end the run, since today is still in progress.
  let streak = 0;
  for (let i = 0; i < 3650; i += 1) {
    const n = byDay.get(dayKey(new Date(today.getTime() - i * DAY))) || 0;
    if (n) streak += 1; else if (i > 0) break;
  }
  const since = (d) => items.filter((r) => new Date(r.done_at) >= d).length;
  return { today: byDay.get(dayKey(today)) || 0, thisWeek: since(week), last30: since(new Date(today.getTime() - 29 * DAY)), total: items.length, streak, strip, byDay };
}

function renderDone() {
  const box = $('#done'); box.innerHTML = '';
  const items = doneVisible();
  const s = doneStats(items);

  const side = el('aside', 'done-side');
  const stats = el('div', 'done-stats');
  for (const [n, lbl] of [[s.today, 'today'], [s.thisWeek, 'this week'], [s.last30, 'last 30 days'], [s.streak, s.streak === 1 ? 'day streak' : 'day streak']]) {
    const t = el('div', 'stat'); t.appendChild(el('div', 'n', String(n))); t.appendChild(el('div', 'l', lbl)); stats.appendChild(t);
  }
  side.appendChild(stats);

  const max = Math.max(1, ...s.strip.map((d) => d.n));
  const strip = el('div', 'strip');
  for (const d of s.strip) {
    const cell = el('div', 'cell' + (d.n ? ' has' : ''));
    cell.style.setProperty('--f', (d.n / max).toFixed(2));
    cell.title = `${fmtDay(d.date)}: ${d.n} done`;
    cell.appendChild(el('span', 'wd', d.date.toLocaleDateString(undefined, { weekday: 'narrow' })));
    if (d.n) cell.appendChild(el('span', 'nn', String(d.n)));
    strip.appendChild(cell);
  }
  side.appendChild(strip);
  box.appendChild(side);

  if (!items.length) {
    const e = el('div', 'empty', 'Nothing ticked off yet.');
    e.appendChild(el('small', null, state.done.length ? 'Nothing matches the current filter.' : 'Check a step on any project and it lands here, dated.'));
    box.appendChild(e); return;
  }

  const list = el('div', 'donelog');
  const todayKey = dayKey(new Date()); const yKey = dayKey(new Date(Date.now() - DAY));
  let lastDay = null; let lastWeek = null;
  for (const r of items) {
    const d = new Date(r.done_at); const k = dayKey(d); const wkStart = startOfWeek(d); const wk = dayKey(wkStart);
    if (wk !== lastWeek) {
      lastWeek = wk;
      const wn = items.filter((x) => dayKey(startOfWeek(new Date(x.done_at))) === wk).length;
      const h = el('div', 'doneweek');
      h.appendChild(el('span', null, wk === dayKey(startOfWeek(new Date())) ? 'This week' : `Week of ${wkStart.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`));
      h.appendChild(el('span', 'wn', `${wn} done`));
      list.appendChild(h);
    }
    if (k !== lastDay) {
      lastDay = k;
      const h = el('div', 'doneday');
      h.appendChild(el('span', null, k === todayKey ? 'Today' : k === yKey ? 'Yesterday' : fmtDay(d)));
      h.appendChild(el('span', 'dn', String(s.byDay.get(k))));
      list.appendChild(h);
    }
    const row = el('div', 'donerow'); row.dataset.color = r.color || 'cocoa';
    row.appendChild(el('span', 'dcheck', '✓'));
    row.appendChild(appIcon(r, 'sm'));
    const body = el('div', 'body'); body.appendChild(el('div', 'txt', r.text)); body.appendChild(el('div', 'proj', r.project_name)); row.appendChild(body);
    row.appendChild(el('span', 'time', fmtTime(r.done_at)));
    row.addEventListener('click', () => openDrawer(r.project_id));
    list.appendChild(row);
  }
  box.appendChild(list);
}

// ------------------------------------------------------------------ suggested

const SUG_VERB = { complete_step: 'Tick off', add_step: 'New step', set_stage: 'Stage', add_log: 'History', set_waiting: 'Waiting on' };
const SUG_SOURCE = { claude: '✨ Claude sync', scan: '📡 Scan' };
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function suggestionsVisible() {
  const { q, kind } = state.filters; const needle = q.trim().toLowerCase();
  const kindOf = new Map(state.projects.map((p) => [p.id, p.kind]));
  return state.suggestions.filter((s) => {
    if (kind && kindOf.get(s.project_id) !== kind) return false;
    if (needle && !`${s.project_name} ${JSON.stringify(s.payload)} ${s.reason}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

function renderSuggested() {
  const box = $('#suggested'); box.innerHTML = '';
  // Forget ticks and rewording for suggestions that are gone.
  const live = new Set(state.suggestions.map((s) => s.id));
  for (const id of [...state.sugSel]) if (!live.has(id)) state.sugSel.delete(id);
  for (const id of Object.keys(state.sugEdits)) if (!live.has(Number(id))) delete state.sugEdits[id];

  const items = suggestionsVisible();

  const head = el('div', 'sug-head');
  const intro = el('div', 'sug-intro');
  intro.appendChild(el('h2', null, 'Suggested updates'));
  intro.appendChild(el('p', null, 'Changes your commits, Claude sessions and memory notes say have already happened. Tick the ones that are right and apply them. Nothing changes until you do.'));
  const meta = el('p', 'sug-meta');
  meta.appendChild(document.createTextNode(state.lastSync ? `Claude last read your sessions ${ago(state.lastSync)}. ` : 'Claude has not read your sessions yet. '));
  meta.appendChild(document.createTextNode('For a fresh read, type '));
  meta.appendChild(el('code', null, '/sync-dashboard'));
  meta.appendChild(document.createTextNode(' in any Claude session.'));
  intro.appendChild(meta);
  head.appendChild(intro);

  const bar = el('div', 'sug-bar');
  const all = el('button', 'pill pill-ghost sug-all');
  all.disabled = !items.length;
  all.addEventListener('click', () => {
    const allOn = items.every((s) => state.sugSel.has(s.id));
    for (const s of items) { if (allOn) state.sugSel.delete(s.id); else state.sugSel.add(s.id); }
    syncSugTicks();
  });
  const dis = el('button', 'pill sug-dismiss');
  dis.title = 'Dismissed suggestions never come back';
  dis.addEventListener('click', () => dismissSuggestions([...state.sugSel]));
  const app = el('button', 'pill pill-solid sug-apply');
  app.addEventListener('click', applySuggestions);
  bar.append(all, dis, app);
  head.appendChild(bar);
  box.appendChild(head);
  syncSugTicks();

  if (!items.length) {
    const e = el('div', 'empty', state.suggestions.length ? 'Nothing matches the current filter.' : 'Nothing to review.');
    if (!state.suggestions.length) e.appendChild(el('small', null, 'Each scan adds the obvious ones by itself. For the rest, type /sync-dashboard in a Claude session.'));
    box.appendChild(e); return;
  }

  // One card per project, in the order the server sent (priority, then name).
  const groups = new Map();
  for (const s of items) { if (!groups.has(s.project_id)) groups.set(s.project_id, []); groups.get(s.project_id).push(s); }
  let i = 0;
  for (const [pid, list] of groups) {
    const first = list[0];
    const g = el('section', 'sug-group'); g.dataset.color = first.color || 'cocoa'; g.style.setProperty('--i', i++);
    const gh = el('div', 'sug-ghead');
    gh.appendChild(appIcon(first, 'sm'));
    const nm = el('button', 'sug-pname', first.project_name); nm.title = 'Open project';
    nm.addEventListener('click', () => openDrawer(pid));
    gh.appendChild(nm);
    const st = el('span', 'tag stage', STAGE_LABEL[first.project_stage] || first.project_stage); st.dataset.stage = first.project_stage;
    gh.appendChild(st);
    g.appendChild(gh);
    for (const s of list) g.appendChild(sugRow(s));
    box.appendChild(g);
  }
  syncSugTicks();
}

// Ticking updates the rows and buttons in place. Re-rendering the list on
// every tick replays its entrance animation and jumps the scroll position, so
// the next click lands on the wrong row.
function syncSugTicks() {
  const box = $('#suggested'); if (!box) return;
  const visible = suggestionsVisible();
  const n = state.sugSel.size;
  for (const r of box.querySelectorAll('.sug')) {
    const on = state.sugSel.has(Number(r.dataset.id));
    r.classList.toggle('on', on);
    const cb = r.querySelector('.sug-cb'); if (cb) cb.checked = on;
  }
  const all = box.querySelector('.sug-all');
  if (all) all.textContent = visible.length && visible.every((s) => state.sugSel.has(s.id)) ? 'Clear ticks' : 'Tick all';
  const dis = box.querySelector('.sug-dismiss');
  if (dis) { dis.textContent = n ? `Dismiss ${n}` : 'Dismiss'; dis.disabled = !n; }
  const app = box.querySelector('.sug-apply');
  if (app) { app.textContent = n ? `Apply ${n} selected` : 'Apply selected'; app.disabled = !n; }
}

function sugRow(s) {
  const on = state.sugSel.has(s.id);
  const pl = s.payload || {};
  const r = el('div', 'sug' + (on ? ' on' : ''));
  r.dataset.id = s.id;
  const toggle = () => { if (state.sugSel.has(s.id)) state.sugSel.delete(s.id); else state.sugSel.add(s.id); syncSugTicks(); };

  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'sug-cb'; cb.checked = on;
  cb.setAttribute('aria-label', 'Select this suggestion');
  cb.addEventListener('change', toggle);
  r.appendChild(cb);

  const main = el('div', 'sug-main');
  const line = el('div', 'sug-line');
  line.appendChild(el('span', `sverb ${s.type}`, SUG_VERB[s.type] || s.type));

  if (s.type === 'add_step' || s.type === 'add_log') {
    // Wording is editable before applying; the edit rides along with the apply.
    const t = el('span', 'stext editable', state.sugEdits[s.id]?.text ?? pl.text);
    t.contentEditable = 'true'; t.spellcheck = true; t.title = 'Click to reword before applying';
    t.addEventListener('input', () => { state.sugEdits[s.id] = { text: t.textContent.trim() }; });
    t.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); t.blur(); } });
    line.appendChild(t);
    if (pl.at) line.appendChild(el('span', 'sdate', fmtDate(pl.at)));
  } else if (s.type === 'complete_step') {
    line.appendChild(el('span', 'stext', pl.step_text));
    if (pl.done_at) line.appendChild(el('span', 'sdate', `done ${fmtDate(pl.done_at)}`));
  } else if (s.type === 'set_stage') {
    line.appendChild(el('span', 'stext', `${STAGE_LABEL[pl.from] || pl.from} → ${STAGE_LABEL[pl.stage] || pl.stage}`));
  } else if (s.type === 'set_waiting') {
    line.appendChild(el('span', 'stext', pl.waiting_on || 'Nobody (clear it)'));
  }
  main.appendChild(line);
  if (s.reason) main.appendChild(el('div', 'sreason', s.reason));
  const ev = el('div', 'sevid');
  ev.appendChild(el('span', 'ssrc', SUG_SOURCE[s.source] || s.source));
  if (s.evidence) ev.appendChild(el('span', null, s.evidence));
  main.appendChild(ev);
  r.appendChild(main);

  const x = el('button', 'sx', '×'); x.title = 'Dismiss. It will not be suggested again.'; x.setAttribute('aria-label', 'Dismiss');
  x.addEventListener('click', () => dismissSuggestions([s.id]));
  r.appendChild(x);

  // Clicking anywhere on the row ticks it, except where the click means something else.
  r.addEventListener('click', (e) => {
    if (e.target.closest('input, button, [contenteditable=true]')) return;
    toggle();
  });
  return r;
}

async function applySuggestions() {
  const ids = [...state.sugSel]; if (!ids.length) return;
  const edits = {};
  for (const id of ids) if (state.sugEdits[id]?.text) edits[id] = state.sugEdits[id];
  try {
    const { results } = await api('/api/suggestions/apply', { method: 'POST', body: { ids, edits } });
    const ok = results.filter((r) => r.ok).length;
    const bad = results.filter((r) => !r.ok);
    state.sugSel.clear();
    await load();
    toast(bad.length
      ? `Applied ${ok}. ${bad.length} skipped: ${bad[0].error}`
      : `Applied ${ok} update${ok === 1 ? '' : 's'}`, bad.length && !ok);
  } catch (e) { toast(e.message, true); }
}

async function dismissSuggestions(ids) {
  if (!ids.length) return;
  try {
    await api('/api/suggestions/dismiss', { method: 'POST', body: { ids } });
    for (const id of ids) state.sugSel.delete(id);
    await load();
    toast(`Dismissed ${ids.length}`);
  } catch (e) { toast(e.message, true); }
}

// ------------------------------------------------------------------ misc

async function newProject() {
  const name = prompt('What are you starting?');
  if (!name || !name.trim()) return;
  try {
    const colors = state.meta.colors; const color = colors[Math.floor(Math.random() * colors.length)];
    const p = await api('/api/projects', { method: 'POST', body: { name: name.trim(), stage: 'idea', color, icon: '💡' } });
    await load(); openDrawer(p.id);
  } catch (e) { toast(e.message, true); }
}

async function startScan() {
  if (state.scan?.running) return;
  try { state.scan = await api('/api/scan', { method: 'POST' }); renderScan(); if (!state.pollTimer) pollScan(); }
  catch (e) { toast(e.message, true); }
}

function wire() {
  $('#scanStatus').addEventListener('click', startScan);
  $('#newBtn').addEventListener('click', newProject);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#viewSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.view); });
  $('#showArchived').addEventListener('change', (e) => { state.filters.archived = e.target.checked; renderFilterMenu(); load(); });
  $('#filterBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleFilterMenu(); });
  $('#filterMenu').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => toggleFilterMenu(false));
  $('#summary').addEventListener('click', (e) => {
    const a = e.target.closest('[data-go]'); if (!a) return;
    e.preventDefault();
    if (a.dataset.go === 'stalled') { setView('tiles'); $('#band-stalled')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    else setView(a.dataset.go);
  });

  const search = $('#search');
  let t;
  search.addEventListener('input', () => {
    state.jumpIndex = 0; renderJump();
    clearTimeout(t); t = setTimeout(() => { state.filters.q = search.value; render(); }, 120);
  });
  search.addEventListener('focus', renderJump);
  search.addEventListener('blur', () => setTimeout(() => { $('#jump').hidden = true; }, 120));
  search.addEventListener('keydown', (e) => {
    const n = (state.jumpHits || []).length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); state.jumpIndex = (state.jumpIndex + 1) % n; renderJump(); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); state.jumpIndex = (state.jumpIndex - 1 + n) % n; renderJump(); }
    else if (e.key === 'Enter' && n && !$('#jump').hidden) { e.preventDefault(); jumpTo(state.jumpHits[state.jumpIndex || 0]); }
    else if (e.key === 'Escape') { e.stopPropagation(); search.value = ''; state.filters.q = ''; $('#jump').hidden = true; search.blur(); render(); }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); search.focus(); search.select(); return; }
    if (e.key === 'Escape') { toggleFilterMenu(false); if (state.openId) closeDrawer(); }
    const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if (e.key === '/' && !typing) { e.preventDefault(); search.focus(); }
  });
  try { const v = localStorage.getItem('mc.view'); if (v) setView(v); } catch { /* fine */ }
  // The /sync-dashboard skill links straight here.
  if (location.hash === '#suggested') setView('suggested');
}

(async function main() {
  wire();
  try { await loadMeta(); await load(); if (state.scan?.running && !state.pollTimer) pollScan(); }
  catch (e) { toast(`Could not load: ${e.message}`, true); }
})();
