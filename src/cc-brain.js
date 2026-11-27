// Clawd's second brain: the user's own Claude Code, signed in with their Claude account.
// Each message runs `claude -p` with streaming JSON in and out, resuming one Claude Code session
// so the conversation carries on. Permission prompts come back to Clawd's Allow/Deny bubble.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { animationForClaudeCodeTool, describeClaudeCodeTool } = require("./integrations");

const EXTRA_PATH = [path.join(os.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

function personaPrompt(sets) {
  const list = Object.entries(sets).map(([n, s]) => `${n}: ${s.desc}`).join("\n");
  return `You are Clawd, a small, warm, very expressive pixel-art buddy who lives in a see-through window on the user's Mac desktop. You're running inside Claude Code on their Mac, and you chat with them and do real tasks for them.

Your words appear in a small speech bubble above your head, so keep replies short and friendly: usually 1-3 sentences, no headers or tables. Be playful but useful.

You are animated. Put an animation tag anywhere in your text to act it out at that moment (the tag is never shown): [[animation]] or [[animation:effect]]. Use about one per reply, more for big moments: [[hello:sparkles]], [[thinking-aloud]], [[celebrate:confetti]], [[sorry:sweat]], [[great-question]], [[idle-heart:hearts]], [[proceed]]. Effects: hearts, sparkles, confetti, question, exclaim, zzz, sweat, music, bounce, shake. Your tools animate automatically.

Animations you can use:
${list}

For Mac tasks use Bash with macOS tools: open (apps, files, URLs), osascript (AppleScript), mdfind, pbcopy/pbpaste, say, screencapture. To see the screen, run \`screencapture -x /tmp/clawd-screen.png\` and Read that file. The user approves anything risky in your bubble. Never do destructive or hard-to-undo things (deleting files, sending messages, purchases) unless they clearly asked for exactly that. Interactive programs and sudo won't work; tell the user to run those themselves.

If the user wants to change your model, API key, size or connections, tell them to right-click you and open the companion (⌘,).`;
}

class ClaudeCodeBrain {
  constructor(agent) {
    this.agent = agent; // emits the same events as the API brain
    this.sessionId = null; // Claude Code session this chat continues
    this.fork = false; // fork an existing chat on the next message instead of writing into it
    this.cwd = null;
    this.title = null;
    this.proc = null;
  }

  reset() {
    this.stop();
    this.sessionId = null;
    this.fork = false;
    this.cwd = null;
    this.title = null;
  }

  // Continue a chat from the Claude app (Code tab) or the terminal. It's forked, so the
  // original chat is never changed; Clawd's replies go into a copy.
  connect({ sessionId, cwd, title }) {
    this.stop();
    this.sessionId = sessionId;
    this.fork = true;
    this.cwd = cwd && fs.existsSync(cwd) ? cwd : null;
    this.title = title;
  }

  // A one-off answer with no tools and no saved session (used for notification summaries).
  summarizeOnce(prompt, { claudePath, model }) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, PATH: [...EXTRA_PATH, process.env.PATH || ""].join(":") };
      delete env.ANTHROPIC_API_KEY;
      const p = spawn(
        claudePath,
        ["-p", prompt, "--output-format", "json", "--model", model, "--permission-prompts", "none", "--no-session-persistence"],
        { cwd: os.tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] }
      );
      let out = "";
      let err = "";
      const timer = setTimeout(() => p.kill("SIGTERM"), 120000);
      p.stdout.on("data", (c) => (out += c));
      p.stderr.on("data", (c) => (err = (err + c).slice(-2000)));
      p.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      p.on("close", () => {
        clearTimeout(timer);
        try {
          const r = JSON.parse(out);
          if (r.is_error || !r.result) return reject(new Error(r.result || "Claude Code error"));
          resolve(String(r.result).trim());
        } catch {
          reject(new Error(err.trim() || "Claude Code returned nothing"));
        }
      });
    });
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {}
      this.proc = null;
    }
  }

  /**
   * One turn: send `text`, stream events to the agent, resolve when Claude Code finishes.
   * @returns {Promise<{ok: boolean, usedTools: boolean, error?: {anim: string, message: string}}>}
   */
  run(text, { claudePath, model, folder, mcpServers, signal, parser, onApproval }) {
    const a = this.agent;
    const cwd = this.cwd || folder || os.homedir();
    try {
      fs.mkdirSync(cwd, { recursive: true });
    } catch {}

    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", "manual",
      "--permission-prompt-tool", "stdio",
      "--model", model,
      "--append-system-prompt", personaPrompt(a.sets),
    ];
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
      if (this.fork) args.push("--fork-session");
    }
    if (mcpServers && mcpServers.length) {
      const cfg = { mcpServers: {} };
      for (const s of mcpServers) {
        cfg.mcpServers[s.name] = { type: "http", url: s.url, ...(s.token ? { headers: { Authorization: `Bearer ${s.token}` } } : {}) };
      }
      args.push("--mcp-config", JSON.stringify(cfg));
    }

    return new Promise((resolve) => {
      const env = { ...process.env, PATH: [...EXTRA_PATH, process.env.PATH || ""].join(":") };
      delete env.ANTHROPIC_API_KEY; // use the Claude account Claude Code is signed in with
      const proc = spawn(claudePath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      this.proc = proc;
      const send = (o) => {
        try {
          proc.stdin.write(JSON.stringify(o) + "\n");
        } catch {}
      };
      let buf = "";
      let stderr = "";
      let result = null;
      let usedTools = false;
      let limited = null;
      const thinkTimers = [];
      const clearThink = () => thinkTimers.splice(0).forEach(clearTimeout);
      const onAbort = () => proc.kill("SIGTERM");
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      send({ type: "control_request", request_id: "clawd_init", request: { subtype: "initialize" } });
      send({ type: "user", message: { role: "user", content: text } });

      const handle = async (e) => {
        if (e.type === "system" && e.subtype === "init" && e.session_id) {
          this.sessionId = e.session_id; // the fork's new id, or the same id when continuing
          this.fork = false;
          return;
        }
        if (e.type === "stream_event" && !e.parent_tool_use_id) {
          const ev = e.event;
          if (ev.type === "content_block_start") {
            const b = ev.content_block;
            if (b.type === "thinking") {
              a.activity("thinking");
              clearThink();
              thinkTimers.push(setTimeout(() => a.activity("thinking-aloud"), 9000));
              thinkTimers.push(setTimeout(() => a.activity("effort-xhigh"), 25000));
            } else if (b.type === "tool_use") {
              a.activity(animationForClaudeCodeTool(b.name, {}, () => "bash"));
            }
          } else if (ev.type === "content_block_stop") clearThink();
          else if (ev.type === "content_block_delta") {
            if (ev.delta.type === "text_delta") parser.push(ev.delta.text);
            else if (ev.delta.type === "thinking_delta") a.emit("thinking", ev.delta.thinking);
          }
          return;
        }
        if (e.type === "assistant" && e.message && Array.isArray(e.message.content)) {
          for (const b of e.message.content) {
            if (b.type !== "tool_use") continue;
            usedTools = true;
            const anim = animationForClaudeCodeTool(b.name, b.input || {}, require("./agent").animationForCommand);
            a.activity(e.parent_tool_use_id ? "agents" : anim);
            if (!e.parent_tool_use_id) {
              const app = /^mcp__(github|linear)__/.exec(b.name);
              const chip = b.name === "Bash" ? "bash" : app ? app[1] : b.name.startsWith("mcp__") ? "app" : "claude-code";
              a.emit("tool", { name: chip, detail: b.name === "Bash" ? (b.input && b.input.command) || "Bash" : describeClaudeCodeTool(b.name, b.input || {}) });
            }
          }
          return;
        }
        if (e.type === "control_request" && e.request && e.request.subtype === "can_use_tool") {
          const r = e.request;
          const input = r.input || {};
          const kind = r.tool_name === "Bash" ? "bash" : "claude-code-tool";
          let detail;
          if (r.tool_name === "Bash") detail = input.command || "";
          else if (r.tool_name.startsWith("mcp__")) {
            // e.g. "GitHub: create issue" plus what it would send (repo, title, body…)
            const args = Object.entries(input)
              .filter(([, v]) => v !== undefined && v !== null && v !== "")
              .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
              .join("\n");
            detail = describeClaudeCodeTool(r.tool_name, input) + (args ? `\n${args.slice(0, 600)}` : "");
          } else detail = `${r.display_name || r.tool_name}: ${r.description || describeClaudeCodeTool(r.tool_name, input)}`;
          const ok = await onApproval(kind, detail);
          send({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: e.request_id,
              response: ok ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "The user declined this. Ask what they'd like instead." },
            },
          });
          a.activity(ok ? animationForClaudeCodeTool(r.tool_name, input, require("./agent").animationForCommand) : "thinking");
          if (!ok) a.emit("emote", { anim: null, effect: "shake" });
          return;
        }
        if (e.type === "rate_limit_event" && e.rate_limit_info && e.rate_limit_info.status && e.rate_limit_info.status !== "allowed") {
          limited = e.rate_limit_info;
          return;
        }
        if (e.type === "result") {
          result = e;
          const u = e.usage || {};
          const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          if (used) a.emit("context", { used, window: 1000000 });
          try {
            proc.stdin.end();
          } catch {}
        }
      };

      proc.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let e;
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          handle(e);
        }
      });
      proc.stderr.on("data", (c) => (stderr = (stderr + c.toString("utf8")).slice(-3000)));
      proc.on("error", (err) => {
        clearThink();
        resolve({ ok: false, usedTools, error: { anim: "crash", message: `Couldn't start Claude Code: ${err.message}` } });
      });
      proc.on("close", (code) => {
        clearThink();
        if (signal) signal.removeEventListener("abort", onAbort);
        if (this.proc === proc) this.proc = null;
        parser.flush();
        if (signal && signal.aborted) return resolve({ ok: false, usedTools, error: { anim: "interrupt", message: "Okay, stopped!" } });
        if (result && result.subtype === "success" && !result.is_error) return resolve({ ok: true, usedTools });
        if (limited) {
          const when = limited.resetsAt ? new Date(limited.resetsAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "later";
          const anim = limited.rateLimitType === "seven_day" ? "limit-7d" : "limit-5h";
          return resolve({ ok: false, usedTools, error: { anim, message: `I've hit your Claude usage limit. It resets around ${when}.` } });
        }
        const detail = (result && (result.result || (result.errors || []).join(" "))) || stderr.trim().split("\n").slice(-3).join(" ") || `exit code ${code}`;
        const notLoggedIn = /log ?in|auth|credential|\/login/i.test(detail);
        resolve({
          ok: false,
          usedTools,
          error: notLoggedIn
            ? { anim: "login", message: "Claude Code isn't signed in. Run `claude` in Terminal and sign in with your Claude account, then try again." }
            : { anim: "stop-failure", message: `Claude Code had a problem: ${detail.slice(0, 300)}` },
        });
      });
    });
  }
}

module.exports = { ClaudeCodeBrain };
