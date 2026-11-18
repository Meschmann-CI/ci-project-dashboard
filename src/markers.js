'use strict';
// Markers a project gets from where it lives, on top of the ones typed in.
//
// A project added through the New project form used to start with no markers,
// so no Claude session could ever be matched to it and the sync had nothing to
// read (Next-Gen Benchmark went five weeks that way). Now the folder name, the
// app folder that holds the repo, and the GitHub repo name count as markers
// automatically, and they follow the project when its path or remote changes.
//
// Pure functions, no database, so scan.js, sync.js and db.js can all use them.

// Grouping folders at the workspace top level. Every project under them shares
// these names, so they say nothing about which project a session worked on.
const GROUP_FOLDERS = new Set(['ci web apps', 'tools', 'claude projects', 'archive', 'for fun', 'cis ai resources']);
const MIN_LEN = 6;

const segments = (p) => String(p || '').split(/[\\/]+/).map((s) => s.trim()).filter(Boolean);
const repoName = (remote) => {
  const m = String(remote || '').trim().match(/([^/:\\]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
};

// gitDetail is the git scanner's result for this project (activity.git.detail),
// or null before the first scan. otherPaths are the other projects' paths, so a
// parent folder two projects share (Tools/Soho) is never used for either.
function autoMarkers(relPath, gitDetail, otherPaths = [], workspaceRoot = '') {
  const segs = segments(relPath);
  const out = [];
  if (segs.length) {
    out.push(segs[segs.length - 1]);
    if (segs.length >= 2) {
      const parent = segs[segs.length - 2];
      const shared = otherPaths.some((o) => segments(o).slice(0, -1).includes(parent) || segments(o).slice(-1)[0] === parent);
      if (!shared) out.push(parent);
    }
  }
  if (gitDetail && gitDetail.is_repo) {
    if (gitDetail.repo_dir) out.push(...segments(gitDetail.repo_dir).slice(-1));
    const r = repoName(gitDetail.remote);
    if (r) out.push(r);
  }
  const root = String(workspaceRoot || '').toLowerCase();
  const seen = new Set();
  return out.filter((m) => {
    if (m.length < MIN_LEN || GROUP_FOLDERS.has(m.toLowerCase())) return false;
    // A marker inside the workspace path would match every file path in every session.
    if (root && root.includes(m.toLowerCase())) return false;
    if (seen.has(m)) return false;
    seen.add(m);
    return true;
  });
}

// Attach auto_markers and match_markers (typed plus automatic) to each project.
// gitOf(p) returns that project's git detail; by default the stored activity.
function withAutoMarkers(projects, workspaceRoot, gitOf = (p) => p.activity && p.activity.git && p.activity.git.detail) {
  for (const p of projects) {
    const others = projects.filter((o) => o.id !== p.id && o.path).map((o) => o.path);
    const typed = p.markers || [];
    // A line with "binder-viewer-app" also holds "binder-viewer"; keeping both
    // would count each hit twice and skew the attribution thresholds.
    const kept = [...typed];
    const overlaps = (m) => kept.some((k) => k.includes(m) || m.includes(k));
    p.auto_markers = [];
    for (const m of p.path ? autoMarkers(p.path, gitOf(p), others, workspaceRoot) : []) {
      if (overlaps(m)) continue;
      kept.push(m);
      p.auto_markers.push(m);
    }
    p.match_markers = [...typed, ...p.auto_markers];
  }
  return projects;
}

module.exports = { autoMarkers, withAutoMarkers, repoName, GROUP_FOLDERS };
