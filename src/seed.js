'use strict';
// Initial projects, from what is on disk and from the Claude memory files as of
// 2026-09-08. Idempotent: existing slugs are left alone, so this can be rerun
// when a new app folder appears.
const path = require('node:path');
const os = require('node:os');
const db = require('./db');

// Markers must not appear in the workspace path itself. The workspace folder is
// "AI Training Tool for CI", which is in the cwd line of every transcript, so
// "AI Training Tool" would match every session ever recorded.
const SEED = [
  {
    slug: 'ar-tracker',
    name: 'AR Tracker',
    kind: 'tool',
    summary: 'Money-in pipeline for Cynthia: renewal to contract to PO to invoice to paid.',
    path: 'CI Web Apps/AR Tracking App/ar-tracking-app',
    port: 4850,
    stage: 'building',
    priority: 1,
    next_step: "Re-export Drew's Feed 1 with Opportunity ID and Owner Email, then build the importer keyed on Opportunity ID that reads Billing Notes.",
    waiting_on: 'Matt (Feed 1 re-export)',
    notes: 'Read HANDOFF.md first. Grain conflicts between tracker, QuickBooks and Salesforce are the recurring trap; QuickBooks wins. Never auto-email AEs, Drew handles that in his one-on-ones.',
    markers: ['ar-tracking-app', 'AR Tracking App'],
  },
  {
    slug: 'device-manager',
    name: 'CI Device Manager',
    kind: 'tool',
    summary: 'Loaner checkout and laptop registry.',
    path: 'CI Web Apps/Devive Management Tool/device-management-app',
    repo_url: 'https://github.com/Corporate-Insight/ci-device-manager.git',
    port: 4830,
    stage: 'live',
    priority: 3,
    notes: 'A kiosk copy lives in device-management-app-CHECKOUT-LAPTOP: a second source of truth, left alone for now.',
    markers: ['device-management-app', 'CI Device Manager', 'Devive Management Tool'],
  },
  {
    slug: 'sitecap',
    name: 'CI Sitecap',
    kind: 'tool',
    summary: 'Flip-book viewer for site captures. Was "Binder Viewer".',
    path: 'CI Web Apps/Binder Viewer/binder-viewer-app',
    repo_url: 'https://github.com/Corporate-Insight/ci-binder-viewer.git',
    port: 4840,
    stage: 'handoff',
    priority: 2,
    next_step: 'Azure port: Blob storage plus Postgres or Azure SQL. Local data deliberately abandoned.',
    waiting_on: 'Soho and Tom',
    notes: 'UI says sitecap/journey/capture, code still says binder/page. Audited and hardened 2026-09-02.',
    markers: ['binder-viewer', 'Binder Viewer', 'Sitecap', 'sitecap'],
  },
  {
    slug: 'vendor-contracts',
    name: 'Vendor Contract Manager',
    kind: 'tool',
    summary: 'Replaces the SharePoint contract list. Renewal reminders at 60 days.',
    path: 'CI Web Apps/Vendor Management App/vendor-contract-app',
    port: 4820,
    stage: 'testing',
    priority: 2,
    next_step: 'Enter M365 SMTP credentials in Settings. The tenant needs Authenticated SMTP enabled first.',
    muted_rules: ['no-remote'],
    notes: 'Matt declined a GitHub repo for now, so the no-remote nag is muted deliberately. No auth yet, which is fine locally but required before any team deployment.',
    markers: ['vendor-contract-app', 'Vendor Management App'],
  },
  {
    slug: 'lab-broadcast',
    name: 'UX Lab Broadcast',
    kind: 'tool',
    summary: 'Zoom RTMP to MediaMTX to a Node viewer with chat.',
    path: 'CI Web Apps/UX Lab Broadcast/lab-broadcast-app',
    port: 4860,
    stage: 'paused',
    priority: 3,
    next_step: 'Decide whether to keep the MediaMTX pipeline or trial Zoom Webinar instead.',
    review_after: '2026-10-08',
    notes: 'Paused 2026-09-03. Working locally. Snoozed a month so it resurfaces rather than being forgotten.',
    markers: ['lab-broadcast', 'UX Lab Broadcast', 'MediaMTX'],
  },
  {
    slug: 'web-tools',
    name: 'CI Web Tools',
    kind: 'tool',
    summary: 'Process Mapper and Prompt Library, one repo.',
    path: 'CI Web Apps/CI Web Tools',
    repo_url: 'https://github.com/Corporate-Insight/ci-web-tools.git',
    stage: 'live',
    priority: 3,
    markers: ['CI Web Tools', 'Process Mapper', 'Prompt Library'],
  },
  {
    slug: 'training-tool',
    name: 'Interactive AI Training Tool',
    kind: 'tool',
    summary: 'Single-file HTML course, five modules.',
    path: 'CI Web Apps/Interactive CI AI Training Tool',
    repo_url: 'https://github.com/Corporate-Insight/Ai-training-tool.git',
    stage: 'live',
    priority: 3,
    review_after: '2026-12-01',
    notes: 'Audited and fixed 2026-09-03. Accessibility work deliberately deferred; the review date brings it back.',
    markers: ['Interactive CI AI Training Tool', 'Ai-training-tool'],
  },
  {
    slug: 'sandbagger',
    name: 'Sandbagger (golf)',
    kind: 'personal',
    summary: 'Golf trip tracker. Live on Netlify with Supabase.',
    path: 'For Fun/Golf App/golf-app',
    repo_url: 'https://github.com/Meschmann-CI/sandbagger.git',
    port: 5173,
    stage: 'live',
    priority: 3,
    next_step: 'Push the local commits once Netlify credits refresh.',
    waiting_on: 'Netlify credits',
    muted_rules: ['unpushed'],
    notes: 'Not a CI project. The unpushed nag is muted on purpose: the hold is deliberate, and a permanent false alarm would train the queue to be ignored.',
    markers: ['golf-app', 'Sandbagger', 'sandbagger'],
  },
  {
    slug: 'project-amplify',
    name: 'Project Amplify',
    kind: 'client',
    summary: 'Cowork project preloaded with source docs and CI PPT templates so deliverables are built directly in the templates.',
    path: 'Project Amplify',
    stage: 'building',
    priority: 2,
    notes: 'Cowork sessions do not write to ~/.claude/projects, so the Claude signal will stay empty here. File mtimes are the only activity source.',
    markers: ['Project Amplify'],
  },
  {
    slug: 'ci-prompt-newsletter',
    name: 'The CI Prompt (newsletter)',
    kind: 'recurring',
    summary: 'Internal AI newsletter.',
    path: 'The CI Prompt - AI Newsletter',
    stage: 'building',
    priority: 2,
    markers: ['The CI Prompt', 'CI Prompt - AI Newsletter'],
  },
  {
    slug: 'sales-intel',
    name: 'Sales intel synthesis',
    kind: 'exploring',
    summary: 'Claude pulling ZoomInfo, Gong and Salesforce together for account context.',
    stage: 'idea',
    priority: 1,
    next_step: 'Confirm the Gong connector status, then finish Salesforce production via the mcp-remote bridge.',
    notes: 'ZoomInfo works. Salesforce sandbox connector expired; production via mcp-remote is the active path. Gong status unknown. The value is the combination, not any one source.',
    markers: ['ZoomInfo', 'Gong connector', 'mcp-remote'],
  },
  {
    slug: 'change-monitoring',
    name: 'Website change monitoring',
    kind: 'partner',
    summary: 'Detects meaningful changes on tracked firms’ pages. Replaces Fluxguard.',
    stage: 'building',
    priority: 1,
    next_step: 'Settle the meaningful-change strategy: cheap high-recall detector, then a Claude vision classifier for meaningful-versus-noise.',
    waiting_on: 'Sebastian',
    notes: 'Fluxguard auto-renewed to 2027-06-28; cancelling needs written notice to legal@legitscript.com by about 2027-05-29. An observed 100% text-diff figure suggests the text comparison is mis-calibrated.',
    markers: ['Fluxguard', 'change-monitoring', 'change detection'],
  },
  {
    slug: 'sharepoint-upgrade',
    name: 'SharePoint upgrade tracker',
    kind: 'recurring',
    path: 'Sharepoint Upgrade Tracker',
    stage: 'building',
    priority: 3,
    markers: ['Sharepoint Upgrade Tracker'],
  },
  {
    slug: 'video-screenshots',
    name: 'Video screenshot extraction',
    kind: 'recurring',
    summary: 'ffmpeg scene detection, montage review, labelled per-page screenshots for researcher decks.',
    path: 'Video Test',
    stage: 'live',
    priority: 3,
    notes: 'Working crop and threshold values are recorded in the memory file.',
    markers: ['Extracted Screenshots', 'scene-detect'],
  },
  {
    slug: 'project-dashboard',
    name: 'Project Dashboard',
    kind: 'tool',
    summary: 'This board. Stage and next step by hand, everything else from git, file mtimes and Claude transcripts.',
    path: 'CI Web Apps/Project Dashboard/project-dashboard-app',
    port: 4870,
    stage: 'testing',
    priority: 2,
    next_step: 'Fill in the stage and next step for the projects seeded blank, then create the GitHub repo so it has a backup.',
    notes: 'Built 2026-09-08. See ARCHITECTURE.md for the design and the review notes; README.md for how the rules and markers work.',
    markers: ['project-dashboard-app', 'Project Dashboard'],
  },
  {
    slug: 'fidelity-alight',
    name: 'Fidelity / Alight reports',
    kind: 'client',
    summary: 'Consolidated firm profiles and RPM/WFM reports.',
    path: 'Fidelity Project - Alight Reports (1)',
    stage: 'building',
    priority: 2,
    markers: ['Alight Reports', 'Consolidated Firm Profiles'],
  },
];

// Tile face for each project. Kept apart from SEED so it can be backfilled onto
// rows that already exist, and so the two lists are easy to scan side by side.
const LOOKS = {
  'ar-tracker':           { icon: '💵', color: 'lime' },
  'device-manager':       { icon: '💻', color: 'sky' },
  'sitecap':              { icon: '📸', color: 'periwinkle' },
  'vendor-contracts':     { icon: '📝', color: 'marigold' },
  'lab-broadcast':        { icon: '📡', color: 'grape' },
  'web-tools':            { icon: '🧰', color: 'tangerine' },
  'training-tool':        { icon: '🎓', color: 'mint' },
  'sandbagger':           { icon: '⛳', color: 'lime' },
  'project-amplify':      { icon: '📣', color: 'coral' },
  'ci-prompt-newsletter': { icon: '📰', color: 'cocoa' },
  'sales-intel':          { icon: '🔭', color: 'sky' },
  'change-monitoring':    { icon: '👁️', color: 'rose' },
  'sharepoint-upgrade':   { icon: '🗂️', color: 'marigold' },
  'video-screenshots':    { icon: '🎬', color: 'grape' },
  'project-dashboard':    { icon: '🧭', color: 'tangerine' },
  'fidelity-alight':      { icon: '📊', color: 'periwinkle' },
};

function seed({ verbose = true } = {}) {
  db.open();

  if (!db.getSetting('workspace_root')) db.setSetting('workspace_root', db.DEFAULT_WORKSPACE_ROOT);
  if (!db.getSetting('claude_projects_dir')) {
    db.setSetting('claude_projects_dir', path.join(os.homedir(), '.claude', 'projects'));
  }
  if (!db.getSetting('claude_scan_enabled')) db.setSetting('claude_scan_enabled', '1');

  let created = 0;
  let skipped = 0;
  for (const [i, s] of SEED.entries()) {
    const existing = db.row('SELECT id FROM projects WHERE slug = ?', [s.slug]);
    if (existing) { skipped += 1; continue; }
    db.createProject({ ...s, ...(LOOKS[s.slug] || {}), sort: i });
    created += 1;
    if (verbose) console.log(`  + ${s.name}`);
  }

  // Give a face to any row that has none yet. Only fills blanks, so a look
  // Matt has changed in the UI is never overwritten.
  let dressed = 0;
  for (const [slug, look] of Object.entries(LOOKS)) {
    const r = db.run(
      "UPDATE projects SET icon = CASE WHEN icon = '' THEN ? ELSE icon END, color = CASE WHEN color = '' THEN ? ELSE color END WHERE slug = ? AND (icon = '' OR color = '')",
      [look.icon, look.color, slug]);
    dressed += r.changes;
  }

  if (verbose) {
    console.log(`\nSeeded ${created} projects, skipped ${skipped} already present, gave ${dressed} an icon and colour.`);
    console.log(`Workspace root: ${db.workspaceRoot()}`);
    console.log('Projects with no next step will show up in the attention queue for you to fill in.');
  }
  return { created, skipped };
}

if (require.main === module) seed();

module.exports = { seed, SEED, LOOKS };
