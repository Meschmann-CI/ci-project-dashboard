'use strict';
/* Mission Control front end. No framework, no build step. */

const state = {
  projects: [],
  queue: [],
  done: [],          // every completed step, newest first, from /api/done
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
const EMOJIS = ['🧭','💵','💻','📸','📝','📡','🧰','🎓','⛳','📣','📰','🔭','👁️','🗂️','🎬','📊','🚀','🧪','🎯','🔧','🧠','📈','🗺️','🔐','💡','🎨','🧩','⚡','🌱','🏗️','📬','🛰️','🎛️','🧮','📎','🗃️','🪄','🧵','🔬','🛒','🏦','💬','📅','🎁','🕹️','🐙','🦉','🌊'];

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

async function loadMeta() {
  state.meta = await api('/api/meta');
  const chips = $('#kindChips');
  chips.innerHTML = '';
  const all = el('button', 'chip on', 'All');
  all.dataset.kind = '';
  all.title = 'Every kind';
  chips.appendChild(all);
  for (const k of state.meta.kind_info) {
    const b = el('button', 'chip', `${k.icon} ${k.label}`);
    b.dataset.kind = k.id;
    b.title = k.blurb;   // hover here for the definition
    chips.appendChild(b);
  }
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    state.filters.kind = b.dataset.kind;
    chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
    render();
  });
}

async function load() {
  const [data, done] = await Promise.all([
    api('/api/projects' + (state.filters.archived ? '?archived=1' : '')),
    // The done log is a nicety. If the server is an older build without this
    // route, the board must still load rather than fail with it.
    api('/api/done').catch(() => ({ items: [] })),
  ]);
  state.projects = data.projects; state.queue = data.queue; state.scan = data.scan;
  state.done = done.items || [];
  render();
}

async function pollScan() {
  state.scan = await api('/api/scan/status');
  renderScan();
  if (state.scan.running) state.pollTimer = setTimeout(pollScan, 700);
  else { clearTimeout(state.pollTimer); state.pollTimer = null; await load(); }
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
  $('#summary').innerHTML =
    `<b>${motion}</b> in motion · ` +
    (stalled ? `<span class="need">${stalled} need${stalled === 1 ? 's' : ''} a next step</span>` : `<b>0</b> stalled`) +
    ` · <b>${parked}</b> live &amp; parked · ` +
    (need ? `<span class="need">${need} need${need === 1 ? 's' : ''} you</span>` : `<b style="color:var(--ok)">nothing needs you</b>`) +
    (ds.thisWeek ? ` · <b class="good">${ds.thisWeek}</b> done this week` : '');
}

function renderScan() {
  const s = state.scan || {};
  const box = $('#scanStatus'); const txt = box.querySelector('.scan-text');
  box.classList.toggle('running', !!s.running); box.classList.toggle('error', !!s.error);
  if (s.running) {
    const pct = s.bytesTotal ? Math.round((s.bytesDone / s.bytesTotal) * 100) : 0;
    txt.textContent = s.phase === 'transcripts' ? `reading transcripts ${pct}%` : `scanning ${s.phase}…`;
  } else if (s.error) txt.textContent = `scan failed`;
  else if (s.lastScanAt) txt.textContent = `scanned ${ago(s.lastScanAt)}`;
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
  const box = $('#tiles'); box.innerHTML = '';
  let i = 0;

  for (const band of BANDS) {
    let list = visible.filter((p) => bandOf(p) === band.id);
    if (band.id === 'parked') list = [...list].sort(parkedOrder);
    if (band.id === 'parked' && !list.length) continue;

    const sec = el('section', `band band-${band.tone}`);
    const head = el('div', 'band-head');
    head.appendChild(el('span', 'band-dot'));
    head.appendChild(el('h2', 'band-title', band.title));
    head.appendChild(el('span', 'band-count', String(list.length)));
    head.appendChild(el('span', 'band-desc', band.desc));
    sec.appendChild(head);

    const grid = el('div', 'tiles' + (band.compact ? ' compact' : ''));
    if (!list.length && band.empty) grid.appendChild(el('div', 'band-empty', band.empty));
    for (const p of list) grid.appendChild(tile(p, i++, band.compact));

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

  const banner = $('#banner');
  const needy = state.projects.filter((p) => queueCount(p) > 0);
  if (needy.length) {
    banner.hidden = false; banner.innerHTML = '';
    banner.appendChild(el('span', 'lead', `${needy.length} project${needy.length === 1 ? '' : 's'} need${needy.length === 1 ? 's' : ''} you`));
    const faces = el('span', 'faces');
    for (const p of needy.slice(0, 8)) { const f = el('span', 'face', p.icon || '•'); f.dataset.color = p.color; faces.appendChild(f); }
    banner.appendChild(faces);
    banner.appendChild(el('span', null, state.queue.slice(0, 2).map((q) => `${q.project_name}: ${q.label.toLowerCase()}`).join(' · ') + (state.queue.length > 2 ? ' · …' : '')));
    banner.appendChild(el('span', 'go', 'See all →'));
    banner.onclick = () => setView('queue');
  } else banner.hidden = true;
}

function tile(p, i, compact = false) {
  const t = el('article', 'tile' + (compact ? ' compact' : ''));
  t.dataset.color = p.color || 'cocoa';
  t.style.setProperty('--i', i);
  if (['paused', 'done'].includes(p.stage)) t.classList.add('is-quiet');
  const hasOpen = openSteps(p) > 0;
  t.addEventListener('click', () => openDrawer(p.id));

  const n = queueCount(p);
  // Badge colour carries the worst severity: black for data-loss risk, orange for
  // something to decide, grey for a standing note.
  if (n) t.appendChild(el('span', `badge ${worstSeverity(p)}`, String(n)));

  const top = el('div', 'tile-top');
  top.appendChild(el('div', 'blob', p.icon || kindInfo(p.kind).icon));
  const tags = el('div', 'tile-tags');
  const st = el('span', 'tag stage', STAGE_LABEL[p.stage] || p.stage); st.dataset.stage = p.stage; tags.appendChild(st);
  const kindTag = el('span', 'tag', p.port ? `:${p.port}` : kindInfo(p.kind).label);
  kindTag.title = p.port ? `Runs on port ${p.port}` : kindInfo(p.kind).blurb;
  tags.appendChild(kindTag);
  if (p.priority === 1) tags.appendChild(el('span', 'tag hot', '★ high'));
  top.appendChild(tags);
  t.appendChild(top);

  t.appendChild(el('h3', 'tile-name', p.name));

  // Compact tiles (the parked band) only spend a line on the next step when
  // there genuinely is one queued; otherwise the name and pulses are enough.
  if (!compact || hasOpen) {
    const next = el('p', 'tile-next' + (p.next_step ? '' : ' none'));
    if (p.next_step) {
      next.textContent = p.next_step;
      if (p.waiting_on) { next.appendChild(document.createTextNode(' ')); next.appendChild(el('span', 'wait', `(waiting on ${p.waiting_on})`)); }
    } else next.textContent = ['paused', 'done', 'live', 'idea'].includes(p.stage) ? (p.summary || 'No next step needed right now.') : 'Needs a next step';
    if (!p.next_step && ['paused', 'done', 'live', 'idea'].includes(p.stage)) next.classList.remove('none');
    t.appendChild(next);
  }

  const openN = openSteps(p);
  const doneN = (p.steps || []).filter((s) => s.done).length;
  if (openN > 1 || doneN) {
    const m = el('div', 'tile-steps');
    if (openN > 1) m.appendChild(el('span', 'tchip', `+${openN - 1} more`));
    if (doneN) m.appendChild(el('span', 'tchip done', `✓ ${doneN} done`));
    t.appendChild(m);
  }

  if (!compact) {
    const prog = el('div', 'progress ' + (p.stage === 'paused' ? 'paused' : p.stage === 'done' ? 'done' : ''));
    const step = STAGE_STEP[p.stage] || 0;
    for (let k = 1; k <= 5; k += 1) prog.appendChild(el('i', k <= step ? 'fill' : ''));
    t.appendChild(prog);
  }

  const pulses = el('div', 'pulses');
  let any = false;
  for (const s of ['git', 'claude', 'fs']) {
    const a = p.activity?.[s]; if (!a || !a.last_at) continue;
    any = true;
    const pu = el('span', `pulse ${freshness(a.last_at)}`);
    pu.appendChild(el('i'));
    pu.appendChild(el('span', 'lbl', SOURCE_LABEL[s]));
    pu.appendChild(document.createTextNode(' ' + shortAgo(a.last_at)));
    pulses.appendChild(pu);
  }
  if (!any) { const pu = el('span', 'pulse'); pu.appendChild(el('i')); pu.appendChild(el('span', 'lbl', state.scan?.everScanned ? 'no signals yet' : 'not scanned yet')); pulses.appendChild(pu); }
  t.appendChild(pulses);
  return t;
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
    r.appendChild(el('div', 'face', p.icon || '•'));
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
      await patch(id, { stage }); toast(`${p.icon || ''} ${p.name} → ${STAGE_LABEL[stage]}`);
    });
    for (const p of inStage) {
      const m = el('div', 'mini'); m.dataset.color = p.color || 'cocoa'; m.draggable = true;
      m.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(p.id)); m.classList.add('dragging'); });
      m.addEventListener('dragend', () => m.classList.remove('dragging'));
      m.addEventListener('click', () => openDrawer(p.id));
      const n = queueCount(p); if (n) m.appendChild(el('span', `badge ${worstSeverity(p)}`, String(n)));
      m.appendChild(el('div', 'face', p.icon || '•'));
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
  const blob = el('div', 'blob', p.icon || kindInfo(p.kind).icon); blob.title = 'Change icon below';
  blob.addEventListener('click', () => d.querySelector('#looks')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  head.appendChild(blob);
  const titles = el('div', 'titles');
  const h2 = el('h2', null, p.name); h2.contentEditable = 'true'; h2.spellcheck = false; h2.title = 'Click to rename';
  h2.addEventListener('blur', () => { const v = h2.textContent.trim(); if (v && v !== p.name) patch(p.id, { name: v }); else h2.textContent = p.name; });
  h2.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); h2.blur(); } });
  titles.appendChild(h2);
  const bits = [`${kindInfo(p.kind).icon} ${kindInfo(p.kind).label}`]; if (p.port) bits.push(`port ${p.port}`); if (p.newest?.at) bits.push(`last touched ${ago(p.newest.at)}`);
  titles.appendChild(el('div', 'sub', bits.join(' · ')));
  head.appendChild(titles);
  const close = el('button', 'close', '×'); close.setAttribute('aria-label', 'Close'); close.addEventListener('click', closeDrawer); head.appendChild(close);
  d.appendChild(head);

  const body = el('div', 'dbody'); d.appendChild(body);

  // ---- now
  const openN = (p.steps || []).filter((s) => !s.done).length;
  const gNow = group(body, '🎯 Up next', openN ? `${openN} step${openN === 1 ? '' : 's'} queued · top one is the next step` : 'nothing queued');
  gNow.appendChild(checklist(p));

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
  for (const [v, lbl] of [['1', '🔥 High'], ['2', 'Normal'], ['3', 'Low']]) {
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
    b.appendChild(el('span', 'ki', k.icon));
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
  const gSig = group(body, '📡 Signals', 'what the scanners found');
  const sig = el('div', 'signals');
  sig.appendChild(signalRow('git', p.activity.git, gitEvidence));
  sig.appendChild(signalRow('claude', p.activity.claude, claudeEvidence));
  sig.appendChild(signalRow('fs', p.activity.fs, fsEvidence));
  gSig.appendChild(sig);

  // ---- rules
  const gRules = group(body, '🔔 Nags', 'flip one off to mute it for this project');
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
  const gLooks = group(body, '🎨 Looks'); gLooks.id = 'looks';
  const sw = el('div', 'swatches');
  for (const c of state.meta.colors) {
    const s = el('button', 'swatch' + (c === p.color ? ' on' : '')); s.style.background = `var(--${c})`; s.title = c;
    s.addEventListener('click', () => patch(p.id, { color: c })); sw.appendChild(s);
  }
  gLooks.appendChild(sw);
  const em = el('div', 'emojis');
  for (const e of EMOJIS) { const b = el('button', 'emoji' + (e === p.icon ? ' on' : ''), e); b.addEventListener('click', () => patch(p.id, { icon: e })); em.appendChild(b); }
  gLooks.appendChild(em);
  const custom = input(p.icon, (v) => patch(p.id, { icon: v })); custom.placeholder = 'Or paste any emoji'; custom.style.marginTop = '8px'; custom.style.width = '200px';
  gLooks.appendChild(custom);

  // ---- where
  const gWhere = group(body, '📍 Where it lives');
  gWhere.appendChild(field('Folder, relative to the workspace', input(p.path || '', (v) => patch(p.id, { path: v }))));
  const r4 = el('div', 'row3');
  r4.appendChild(field('Port', input(p.port || '', (v) => patch(p.id, { port: v }))));
  r4.appendChild(field('Stale after', input(p.stale_days, (v) => patch(p.id, { stale_days: v })), 'days'));
  r4.appendChild(field('Repo URL', input(p.repo_url || '', (v) => patch(p.id, { repo_url: v }))));
  gWhere.appendChild(r4);

  // ---- markers
  const gM = group(body, '🔎 Transcript markers', 'how Claude sessions get matched to this');
  const chips = el('div', 'chipsrow');
  for (const m of p.markers) { const c = el('span', 'mchip'); c.appendChild(el('span', null, m)); const x = el('button', null, '×'); x.addEventListener('click', () => patch(p.id, { markers: p.markers.filter((y) => y !== m) })); c.appendChild(x); chips.appendChild(c); }
  if (!p.markers.length) chips.appendChild(el('span', 'hint', 'No markers, so Claude sessions cannot be matched.'));
  gM.appendChild(chips);
  const addM = input('', null); addM.placeholder = 'Add a marker, press Enter';
  addM.addEventListener('keydown', (e) => { if (e.key === 'Enter' && addM.value.trim()) { e.preventDefault(); patch(p.id, { markers: [...p.markers, addM.value.trim()] }); } });
  gM.appendChild(addM);
  gM.appendChild(el('div', 'hint', 'Distinctive substrings only. Adding one re-reads every transcript. Never use anything in the workspace path.'));

  // ---- notes + history
  const gN = group(body, '📓 Notes'); gN.appendChild(textarea(p.notes, (v) => patch(p.id, { notes: v })));
  const gL = group(body, '🕰️ History');
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

function group(parent, title, sub) {
  const g = el('div', 'dgroup'); const h = el('h3', null, title); if (sub) h.appendChild(el('small', null, sub)); g.appendChild(h); parent.appendChild(g); return g;
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

  const stats = el('div', 'done-stats');
  for (const [n, lbl] of [[s.today, 'today'], [s.thisWeek, 'this week'], [s.last30, 'last 30 days'], [s.streak, s.streak === 1 ? 'day streak' : 'day streak']]) {
    const t = el('div', 'stat'); t.appendChild(el('div', 'n', String(n))); t.appendChild(el('div', 'l', lbl)); stats.appendChild(t);
  }
  box.appendChild(stats);

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
  box.appendChild(strip);

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
    row.appendChild(el('span', 'face', r.icon || '•'));
    const body = el('div', 'body'); body.appendChild(el('div', 'txt', r.text)); body.appendChild(el('div', 'proj', r.project_name)); row.appendChild(body);
    row.appendChild(el('span', 'time', fmtTime(r.done_at)));
    row.addEventListener('click', () => openDrawer(r.project_id));
    list.appendChild(row);
  }
  box.appendChild(list);
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
  $('#sort').addEventListener('change', (e) => { state.filters.sort = e.target.value; render(); });
  $('#showArchived').addEventListener('change', (e) => { state.filters.archived = e.target.checked; load(); });
  let t; $('#search').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.filters.q = e.target.value; render(); }, 120); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.openId) closeDrawer();
    const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if (e.key === '/' && !typing) { e.preventDefault(); $('#search').focus(); }
  });
  try { const v = localStorage.getItem('mc.view'); if (v) setView(v); } catch { /* fine */ }
}

(async function main() {
  wire();
  try { await loadMeta(); await load(); if (state.scan?.running && !state.pollTimer) pollScan(); }
  catch (e) { toast(`Could not load: ${e.message}`, true); }
})();
