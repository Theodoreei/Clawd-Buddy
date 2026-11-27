// A persistent bash session for the `bash` tool: state such as the working
// directory and exported variables carries over between commands.
const { spawn } = require("child_process");
const os = require("os");
const crypto = require("crypto");

const MAX_OUTPUT = 20000;
const DEFAULT_TIMEOUT_MS = 120000;

// Apps launched from Finder get a bare PATH; add the usual Homebrew and system dirs.
const EXTRA_PATH = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

class Shell {
  constructor() {
    this.proc = null;
    this.buffer = "";
    this.pending = null;
  }

  start() {
    const env = {
      ...process.env,
      PATH: [...EXTRA_PATH, process.env.PATH || ""].filter(Boolean).join(":"),
      TERM: "dumb",
      PAGER: "cat",
      GIT_PAGER: "cat",
      NO_COLOR: "1",
    };
    this.proc = spawn("/bin/bash", ["--noprofile", "--norc"], {
      cwd: os.homedir(),
      env,
      detached: true, // own process group, so a timeout can kill everything it started
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buffer = "";
    const onData = (chunk) => {
      this.buffer += chunk.toString("utf8");
      this._check();
    };
    this.proc.stdout.on("data", onData);
    this.proc.stderr.on("data", onData);
    this.proc.on("exit", () => {
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        p.resolve({ output: truncate(this.buffer) + "\n[shell exited]", exitCode: -1, timedOut: false });
      }
      this.proc = null;
    });
  }

  _check() {
    if (!this.pending) return;
    const re = new RegExp(`\\n?${this.pending.marker}(\\d+)\\n`);
    const m = this.buffer.match(re);
    if (!m) return;
    const output = this.buffer.slice(0, m.index);
    this.buffer = this.buffer.slice(m.index + m[0].length);
    const p = this.pending;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve({ output: truncate(output), exitCode: Number(m[1]), timedOut: false });
  }

  run(command, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.proc) this.start();
    if (this.pending) return Promise.resolve({ output: "Another command is still running.", exitCode: -1, timedOut: false });
    const marker = `__CLAWD_DONE_${crypto.randomBytes(6).toString("hex")}__`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const partial = this.buffer;
        this.pending = null;
        this.kill();
        resolve({ output: truncate(partial) + `\n[timed out after ${timeoutMs / 1000}s; the shell was restarted]`, exitCode: -1, timedOut: true });
      }, timeoutMs);
      this.pending = { marker, resolve, timer };
      // stdin from /dev/null so interactive prompts fail fast instead of hanging.
      this.proc.stdin.write(`{ ${command}\n} </dev/null 2>&1; printf '\\n${marker}%s\\n' "$?"\n`);
    });
  }

  kill() {
    if (this.proc) {
      try {
        process.kill(-this.proc.pid, "SIGKILL");
      } catch {
        try { this.proc.kill("SIGKILL"); } catch {}
      }
    }
    this.proc = null;
    this.buffer = "";
  }

  // Stop whatever is running (user pressed Stop) and start fresh.
  interrupt() {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve({ output: truncate(this.buffer) + "\n[interrupted by the user]", exitCode: -1, timedOut: false });
    }
    this.kill();
  }
}

function truncate(s) {
  if (s.length <= MAX_OUTPUT) return s;
  const half = MAX_OUTPUT / 2;
  return s.slice(0, half) + `\n... [${s.length - MAX_OUTPUT} characters omitted] ...\n` + s.slice(-half);
}

module.exports = { Shell };
