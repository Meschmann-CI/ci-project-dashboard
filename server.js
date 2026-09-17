'use strict';
// CI Project Dashboard. Node built-in http, no dependencies. Local only.
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const db = require('./src/db');
const attention = require('./src/attention');
const scan = require('./src/scan');

const PORT = Number(process.env.PORT || 4870);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function send(res, code, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('body must be JSON')); }
    });
    req.on('error', reject);
  });
}

// Attach computed attention flags so the UI and any future notifier agree.
function decorate(projects, now = new Date()) {
  return projects.map((p) => {
    const { flags, newest, quietDays } = attention.evaluate(p, now);
    return { ...p, flags, newest, quietDays };
  });
}

async function api(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const rest = seg.slice(1);
  const method = req.method;

  if (rest[0] === 'meta' && method === 'GET') {
    return send(res, 200, {
      stages: db.STAGES,
      kinds: db.KINDS,
      kind_info: db.KIND_INFO,
      colors: db.COLORS,
      rules: attention.RULE_IDS,
      owner_name: db.getSetting('owner_name', ''),
      workspace_root: db.workspaceRoot(),
      claude_scan_enabled: db.getSetting('claude_scan_enabled', '1') === '1',
    });
  }

  if (rest[0] === 'scan') {
    if (rest[1] === 'status' && method === 'GET') return send(res, 200, scan.status());
    if (!rest[1] && method === 'POST') {
      if (scan.state.running) return send(res, 202, scan.status());
      scan.runScan().catch(() => { /* recorded in state.error */ });
      return send(res, 202, scan.status());
    }
  }

  if (rest[0] === 'projects') {
    if (!rest[1] && method === 'GET') {
      const includeArchived = url.searchParams.get('archived') === '1';
      const list = decorate(db.listProjects({ includeArchived }));
      return send(res, 200, {
        projects: list,
        queue: attention.buildQueue(list),
        scan: scan.status(),
      });
    }

    if (!rest[1] && method === 'POST') {
      const body = await readBody(req);
      return send(res, 201, db.createProject(body));
    }

    const id = Number(rest[1]);
    if (Number.isInteger(id) && id > 0) {
      // ---- checklist
      if (rest[2] === 'steps') {
        if (!rest[3] && method === 'POST') {
          const body = await readBody(req);
          db.addStep(id, body.text);
          return send(res, 201, decorate([db.getProject(id)])[0]);
        }
        if (rest[3] === 'reorder' && method === 'POST') {
          const body = await readBody(req);
          if (!Array.isArray(body.ids)) return send(res, 400, { error: 'ids must be an array' });
          db.reorderSteps(id, body.ids);
          return send(res, 200, decorate([db.getProject(id)])[0]);
        }
        const sid = Number(rest[3]);
        if (Number.isInteger(sid) && sid > 0) {
          if (method === 'PATCH') {
            const body = await readBody(req);
            if (!db.updateStep(id, sid, body)) return send(res, 404, { error: 'no such step' });
            return send(res, 200, decorate([db.getProject(id)])[0]);
          }
          if (method === 'DELETE') {
            if (!db.deleteStep(id, sid)) return send(res, 404, { error: 'no such step' });
            return send(res, 200, decorate([db.getProject(id)])[0]);
          }
        }
      }

      if (rest[2] === 'log' && method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        if (!text) return send(res, 400, { error: 'text is required' });
        db.addLog(id, 'note', text);
        return send(res, 201, db.getProject(id));
      }
      if (!rest[2]) {
        if (method === 'GET') {
          const p = db.getProject(id);
          if (!p) return send(res, 404, { error: 'not found' });
          return send(res, 200, decorate([p])[0]);
        }
        if (method === 'PATCH') {
          const body = await readBody(req);
          const p = db.updateProject(id, body);
          if (!p) return send(res, 404, { error: 'not found' });
          return send(res, 200, decorate([p])[0]);
        }
        if (method === 'DELETE') {
          return send(res, 200, { deleted: db.deleteProject(id) });
        }
      }
    }
  }

  return send(res, 404, { error: 'no such route' });
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.resolve(PUBLIC_DIR, '.' + rel);
  // Never serve outside public/, whatever the path contains.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, { error: 'forbidden' });
  }
  try {
    const st = await fsp.stat(target);
    if (!st.isFile()) throw new Error('not a file');
    const type = TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    fs.createReadStream(target).pipe(res);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const handler = url.pathname.startsWith('/api/')
    ? api(req, res, url)
    : serveStatic(req, res, url);

  Promise.resolve(handler).catch((e) => {
    const msg = e && e.message ? e.message : 'server error';
    const code = /required|must be|unknown|too large/i.test(msg) ? 400 : 500;
    if (!res.headersSent) send(res, code, { error: msg });
    else res.end();
  });
});

if (require.main === module) {
  db.open();
  server.listen(PORT, HOST, () => {
    console.log(`CI Project Dashboard  http://localhost:${PORT}`);
    console.log(`  db         ${db.DB_PATH}`);
    console.log(`  workspace  ${db.workspaceRoot()}`);
    const n = db.listProjects({ includeArchived: true }).length;
    if (!n) {
      console.log('  no projects yet: run  npm run seed');
    } else {
      console.log(`  ${n} projects; starting background scan`);
      scan.runScan().then((s) => {
        if (s.error) console.error('  scan failed:', s.error);
        else console.log('  scan done:', JSON.stringify(s.summary));
      });
    }
  });
}

module.exports = { server };
