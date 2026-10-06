'use strict';
// A short readable digest of one Claude session, for the /sync-dashboard skill.
//
// A transcript is mostly tool output (file dumps, command results) and runs to
// tens of megabytes. What says what happened is much smaller: what Matt asked
// for, the last thing Claude said before handing the turn back (that is where
// the "done, pushed, next is X" summary lives), and any commit messages. This
// keeps those and drops everything else, so the sync reads kilobytes instead.
const fs = require('node:fs');
const readline = require('node:readline');

const BIG_LINE = 1_000_000;    // tool results this size are never prompts or summaries
const PROMPT_MAX = 600;
const SUMMARY_MAX = 1500;
const KEEP_PROMPTS = 12;
const KEEP_SUMMARIES = 10;

const clip = (s, n) => {
  const t = String(s || '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

// The human-typed text of a user record, or null for tool results, injected
// context and slash-command plumbing.
function promptText(obj) {
  if (obj.isMeta) return null;
  const c = obj.message && obj.message.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    const t = c.find((b) => b && b.type === 'text' && typeof b.text === 'string' && !b.text.trim().startsWith('<'));
    if (t) text = t.text;
  }
  if (!text) return null;
  text = text.trim();
  return text && !text.startsWith('<') ? text : null;
}

function commandName(obj) {
  const c = obj.message && obj.message.content;
  const s = typeof c === 'string' ? c : '';
  const m = s.match(/<command-name>\/?([^<]+)<\/command-name>/);
  return m ? m[1].trim() : null;
}

// First line of the message in a git commit command, whichever quoting the
// session used: a bash heredoc, a PowerShell here-string, or -m "...".
function commitSubject(cmd) {
  if (!/\bgit\b[^\n]*\bcommit\b/.test(cmd)) return null;
  const first = (s) => s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
  let m = cmd.match(/<<-?\s*'?EOF'?\s*\r?\n([\s\S]*?)\r?\n\s*EOF/);
  if (m) return first(m[1]);
  m = cmd.match(/@'\s*\r?\n([\s\S]*?)\r?\n'@/);
  if (m) return first(m[1]);
  m = cmd.match(/-m\s+"([^"]+)"/) || cmd.match(/-m\s+'([^']+)'/);
  return m ? first(m[1]) : null;
}

async function digestTranscript(file) {
  const prompts = [];
  const summaries = [];
  const commits = [];
  const commands = new Set();
  let pending = null;           // the latest assistant text not yet followed by a prompt
  let started = null;
  let ended = null;

  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line || line.length > BIG_LINE) continue;
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const at = obj.timestamp || null;
      if (at) { if (!started || at < started) started = at; if (!ended || at > ended) ended = at; }

      if (obj.type === 'user') {
        const cmd = commandName(obj);
        if (cmd) { commands.add(cmd); continue; }
        const text = promptText(obj);
        if (!text) continue;
        if (pending) { summaries.push(pending); pending = null; }
        prompts.push({ at, text: clip(text, PROMPT_MAX) });
      } else if (obj.type === 'assistant') {
        const content = obj.message && obj.message.content;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
          if (!b) continue;
          if (b.type === 'text' && b.text && b.text.trim()) pending = { at, text: clip(b.text, SUMMARY_MAX) };
          if (b.type === 'tool_use' && b.input && typeof b.input.command === 'string') {
            const subj = commitSubject(b.input.command);
            if (subj) commits.push({ at, subject: clip(subj, 200) });
          }
        }
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  if (pending) summaries.push(pending);

  // Keep the opening ask plus the most recent stretch: the end of a session
  // is where the state of things is.
  const trimmed = prompts.length > KEEP_PROMPTS
    ? [prompts[0], ...prompts.slice(-(KEEP_PROMPTS - 1))]
    : prompts;
  return {
    started, ended,
    commands: [...commands],
    prompts: trimmed,
    prompts_omitted: prompts.length - trimmed.length,
    turn_summaries: summaries.slice(-KEEP_SUMMARIES),
    commits,
  };
}

module.exports = { digestTranscript, commitSubject, promptText };
