// Reads the Claude Code chats saved on this Mac (~/.claude/projects/*/<session>.jsonl).
// These are the chats from the Claude app's Code tab and from the `claude` CLI.
// Chat-tab conversations live only on Anthropic's servers and aren't available here.
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const cache = new Map(); // file -> {mtimeMs, info}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === "text").map((b) => b.text).join(" ");
  return "";
}

// A user prompt that a person typed (not a tool result, command wrapper or system note).
function humanText(e) {
  if (e.type !== "user" || e.isMeta || e.isSidechain || !e.message) return null;
  const t = textOf(e.message.content).trim();
  if (!t || t.startsWith("<") || t.startsWith("[Request interrupted")) return null;
  return t;
}

function summarize(file) {
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n");
  let title = null;
  let firstPrompt = null;
  let cwd = null;
  let sessionId = path.basename(file, ".jsonl");
  let entrypoint = null;
  let messages = 0;
  for (const line of lines) {
    if (!line) continue;
    // Cheap checks first: most lines are large tool results we don't need to parse.
    const isTitle = line.includes('"custom-title"');
    const isUser = line.startsWith('{"parentUuid"') || line.includes('"type":"user"');
    if (!isTitle && !isUser && cwd) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "custom-title" && e.customTitle) title = e.customTitle;
    if (!cwd && e.cwd) cwd = e.cwd;
    if (!entrypoint && e.entrypoint) entrypoint = e.entrypoint;
    const h = humanText(e);
    if (h) {
      messages++;
      if (!firstPrompt) firstPrompt = h;
    }
  }
  if (!messages) return null; // empty or tool-only sessions
  // The last thing Claude said, for a preview.
  let lastReply = null;
  for (let i = lines.length - 1; i >= 0 && !lastReply; i--) {
    const line = lines[i];
    if (!line.includes('"type":"assistant"') || line.includes('"isSidechain":true')) continue;
    try {
      const e = JSON.parse(line);
      const t = e.message && textOf(e.message.content).trim();
      if (t) lastReply = t;
    } catch {}
  }
  const clean = (s) => s.replace(/\s+/g, " ").trim();
  return {
    sessionId,
    title: clean(title || firstPrompt).slice(0, 80),
    cwd: cwd || os.homedir(),
    project: path.basename(cwd || os.homedir()),
    source: entrypoint === "claude-desktop" ? "Claude app" : entrypoint === "sdk-cli" ? "Clawd" : entrypoint === "cli" ? "Terminal" : "Claude Code",
    lastReply: lastReply ? clean(lastReply).slice(0, 400) : null,
  };
}

/** Most recent Claude Code chats, newest first. */
function listChats(limit = 20) {
  let files = [];
  try {
    for (const dir of fs.readdirSync(PROJECTS)) {
      const full = path.join(PROJECTS, dir);
      let entries;
      try {
        entries = fs.readdirSync(full);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith(".jsonl")) continue;
        const p = path.join(full, f);
        try {
          files.push({ p, mtimeMs: fs.statSync(p).mtimeMs });
        } catch {}
      }
    }
  } catch {
    return [];
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  for (const { p, mtimeMs } of files) {
    if (out.length >= limit) break;
    let hit = cache.get(p);
    if (!hit || hit.mtimeMs !== mtimeMs) {
      let info = null;
      try {
        info = summarize(p);
      } catch {}
      hit = { mtimeMs, info };
      cache.set(p, hit);
    }
    if (hit.info) out.push({ ...hit.info, updatedAt: mtimeMs });
  }
  return out;
}

function timeAgo(ms) {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

module.exports = { listChats, timeAgo };
