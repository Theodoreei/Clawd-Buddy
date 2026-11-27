// Connections Clawd can use beyond the shell: Slack (Web API with your token) and
// Claude Code (the `claude` CLI, run headless to write code for you).
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ---------------------------------------------------------------- Slack

async function slackCall(token, method, params = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, String(v));
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Slack HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) {
    const hint =
      data.error === "missing_scope" ? ` (your Slack token needs the "${data.needed}" scope)` :
      data.error === "not_in_channel" ? " (invite your Slack app to that channel first)" :
      data.error === "invalid_auth" ? " (the Slack token is invalid; reconnect Slack in the companion app)" : "";
    throw new Error(`Slack: ${data.error}${hint}`);
  }
  return data;
}

async function slackTest(token) {
  const d = await slackCall(token, "auth.test");
  return { team: d.team, user: d.user, url: d.url };
}

const SLACK_TOOLS = [
  {
    name: "slack_list_channels",
    description: "List Slack channels the connected account can see (name and id). Optionally filter by a word in the name.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "slack_read_messages",
    description: "Read the most recent messages in a Slack channel or DM. `channel` is a channel id (C…/D…/G…) or a #name.",
    input_schema: {
      type: "object",
      properties: { channel: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } },
      required: ["channel"],
      additionalProperties: false,
    },
  },
  {
    name: "slack_search",
    description: "Search Slack messages (needs a user token with search:read).",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "slack_send_message",
    description: "Send a Slack message to a channel or DM (the user approves it first). Only send what the user asked you to send.",
    input_schema: {
      type: "object",
      properties: { channel: { type: "string" }, text: { type: "string" }, thread_ts: { type: "string" } },
      required: ["channel", "text"],
      additionalProperties: false,
    },
  },
].map((t) => ({ ...t, eager_input_streaming: true }));

class Slack {
  constructor(token) {
    this.token = token;
    this.users = new Map();
    this.channels = null;
  }

  async listChannels() {
    if (this.channels) return this.channels;
    const out = [];
    let cursor;
    do {
      const d = await slackCall(this.token, "conversations.list", {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      out.push(...d.channels.map((c) => ({ id: c.id, name: c.name, member: c.is_member })));
      cursor = d.response_metadata && d.response_metadata.next_cursor;
    } while (cursor && out.length < 1000);
    this.channels = out;
    return out;
  }

  async resolveChannel(ch) {
    if (/^[CDG][A-Z0-9]{6,}$/.test(ch)) return ch;
    const name = ch.replace(/^#/, "").toLowerCase();
    const found = (await this.listChannels()).find((c) => c.name.toLowerCase() === name);
    if (!found) throw new Error(`No Slack channel named #${name}`);
    return found.id;
  }

  async userName(id) {
    if (!id) return "someone";
    if (!this.users.has(id)) {
      try {
        const d = await slackCall(this.token, "users.info", { user: id });
        this.users.set(id, d.user.profile.display_name || d.user.real_name || d.user.name);
      } catch {
        this.users.set(id, id);
      }
    }
    return this.users.get(id);
  }

  async run(name, input) {
    if (name === "slack_list_channels") {
      const q = (input.query || "").toLowerCase();
      const list = (await this.listChannels()).filter((c) => !q || c.name.toLowerCase().includes(q)).slice(0, 100);
      return list.map((c) => `#${c.name} (${c.id})${c.member ? "" : " [not a member]"}`).join("\n") || "No channels found.";
    }
    if (name === "slack_read_messages") {
      const channel = await this.resolveChannel(input.channel);
      const d = await slackCall(this.token, "conversations.history", { channel, limit: input.limit || 15 });
      const lines = [];
      for (const m of d.messages.reverse()) {
        const when = new Date(Number(m.ts) * 1000).toLocaleString();
        lines.push(`[${when}] ${await this.userName(m.user)}: ${m.text} (ts ${m.ts})`);
      }
      return lines.join("\n") || "No messages.";
    }
    if (name === "slack_search") {
      const d = await slackCall(this.token, "search.messages", { query: input.query, count: 15 });
      const matches = (d.messages && d.messages.matches) || [];
      return matches.map((m) => `#${m.channel && m.channel.name} ${m.username}: ${m.text} (${m.permalink})`).join("\n") || "No matches.";
    }
    if (name === "slack_send_message") {
      const channel = await this.resolveChannel(input.channel);
      const d = await slackCall(this.token, "chat.postMessage", { channel, text: input.text, thread_ts: input.thread_ts });
      return `Sent (ts ${d.ts}).`;
    }
    throw new Error(`Unknown Slack tool ${name}`);
  }
}

// ---------------------------------------------------------------- Claude Code

const EXTRA_PATH = [path.join(os.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const shellEnv = () => ({ ...process.env, PATH: [...EXTRA_PATH, process.env.PATH || ""].join(":") });

// Finds the `claude` CLI and its version, or null when it isn't installed.
function findClaudeCode() {
  return new Promise((resolve) => {
    const candidates = [path.join(os.homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", path.join(os.homedir(), ".claude/local/claude")];
    const found = candidates.find((p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    const withPath = (p) =>
      execFile(p, ["--version"], { env: shellEnv(), timeout: 15000 }, (err, stdout) => resolve(err ? null : { path: p, version: stdout.trim() }));
    if (found) return withPath(found);
    // Fall back to the user's login shell PATH.
    execFile("/bin/zsh", ["-lc", "command -v claude"], { timeout: 15000 }, (err, stdout) => {
      const p = stdout && stdout.trim();
      if (err || !p) resolve(null);
      else withPath(p);
    });
  });
}

const CLAUDE_CODE_TOOL = {
  name: "claude_code",
  description:
    "Hand a coding task to Claude Code, which works inside a project folder: writing and editing code, building apps and scripts, fixing bugs, running tests, explaining a codebase. " +
    "Give it a complete, self-contained task description (what to build or change, and what done looks like). " +
    "`directory` is the project folder (absolute path or ~/…); leave it out to use the user's default projects folder. " +
    "It can take several minutes. You get back Claude Code's final summary.",
  input_schema: {
    type: "object",
    properties: { task: { type: "string" }, directory: { type: "string" } },
    required: ["task"],
    additionalProperties: false,
  },
  eager_input_streaming: true,
};

// What Clawd acts out for a tool on a connected app server (GitHub, Linear, others).
function animationForAppTool(server, tool) {
  const t = String(tool || "").toLowerCase();
  const s = String(server || "").toLowerCase();
  const rules = [
    [/merge/, "git-pr"],
    [/review|diff/, "code-review"],
    [/pull_request|_pr\b|^pr_/, "git-pr"],
    [/push|create_or_update_file|update_file|create_file/, "git-push"],
    [/commit/, s === "github" ? "git" : "git-commit"],
    [/workflow|job|run|action/, "ci-pipeline"],
    [/search|find|list/, "search"],
    [/comment/, "new-mail"],
    [/document|doc/, "docs-read"],
    [/(create|update|save|write).*issue|issue.*(create|update|write)|project|cycle|milestone/, "todo-list"],
    [/get|read|file|content|issue/, "reading"],
    [/branch|tag|release|repo/, "git"],
  ];
  for (const [re, anim] of rules) if (re.test(t)) return anim;
  return s === "github" ? "git" : s === "linear" ? "todo-list" : "tools";
}

// "create_pull_request" on "github" -> "GitHub: create pull request"
function describeAppTool(server, tool) {
  const names = { github: "GitHub", linear: "Linear" };
  return `${names[server] || server}: ${String(tool).replace(/_/g, " ")}`;
}

// What Clawd should act out for each Claude Code tool.
function animationForClaudeCodeTool(name, input, animationForCommand) {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (mcp) return animationForAppTool(mcp[1], mcp[2]);
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(name)) return "writing";
  if (name === "Read") return /\.pdf$/i.test((input && input.file_path) || "") ? "pdf" : "reading";
  if (name === "Bash") return animationForCommand((input && input.command) || "");
  if (["Grep", "Glob", "LS", "WebSearch", "ToolSearch"].includes(name)) return "search";
  if (name === "WebFetch") return "web-fetch";
  if (name === "Task" || name === "Agent") return "agent-spawn";
  if (name === "TodoWrite" || name === "TaskCreate" || name === "TaskUpdate") return "todo-list";
  return "tools";
}

function describeClaudeCodeTool(name, input = {}) {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (mcp) return describeAppTool(mcp[1], mcp[2]);
  const short = (s) => (s && s.length > 80 ? s.slice(0, 77) + "…" : s || "");
  const file = input.file_path || input.notebook_path || input.path;
  if (file) return `${name} ${file.replace(os.homedir(), "~")}`;
  if (input.command) return `${name}: ${short(input.command)}`;
  if (input.pattern) return `${name} ${short(input.pattern)}`;
  if (input.description) return `${name}: ${short(input.description)}`;
  if (input.url) return `${name} ${short(input.url)}`;
  return name;
}

/**
 * Runs `claude -p` in `cwd` and streams what it does.
 * @returns {Promise<{text: string, isError: boolean, cost: number|null, turns: number|null}>}
 */
function runClaudeCode({ claudePath, task, cwd, permissionMode, signal, onTool, onText }) {
  return new Promise((resolve) => {
    const args = ["-p", task, "--output-format", "stream-json", "--verbose", "--permission-mode", permissionMode];
    const proc = spawn(claudePath, args, { cwd, env: shellEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    let lastText = "";
    let result = null;
    const timer = setTimeout(() => proc.kill("SIGTERM"), 30 * 60 * 1000);
    const onAbort = () => proc.kill("SIGTERM");
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
          for (const b of ev.message.content) {
            if (b.type === "tool_use") onTool && onTool(b.name, b.input || {});
            else if (b.type === "text" && b.text.trim()) {
              lastText = b.text.trim();
              onText && onText(lastText);
            }
          }
        } else if (ev.type === "result") {
          result = ev;
        }
      }
    });
    proc.stderr.on("data", (c) => (stderr = (stderr + c.toString("utf8")).slice(-4000)));
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ text: `Couldn't start Claude Code: ${err.message}`, isError: true, cost: null, turns: null });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (signal && signal.aborted) return resolve({ text: "Stopped by the user.", isError: true, cost: null, turns: null });
      if (result) {
        return resolve({
          text: result.result || lastText || "(Claude Code finished without a summary)",
          isError: !!result.is_error || result.subtype !== "success",
          cost: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
          turns: result.num_turns ?? null,
        });
      }
      resolve({ text: `Claude Code exited (code ${code}). ${stderr.trim().slice(-1500)}`, isError: true, cost: null, turns: null });
    });
  });
}

function expandHome(p) {
  if (!p) return p;
  return p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

module.exports = {
  SLACK_TOOLS,
  Slack,
  slackTest,
  CLAUDE_CODE_TOOL,
  findClaudeCode,
  runClaudeCode,
  animationForClaudeCodeTool,
  describeClaudeCodeTool,
  animationForAppTool,
  describeAppTool,
  expandHome,
};
