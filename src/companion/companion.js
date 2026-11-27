"use strict";

const $ = (id) => document.getElementById(id);
const api = window.companion;
let state = null;
let player = null;
let mcpRows = []; // editable copy of the app-server list

// ---------------------------------------------------------------- mini Clawd
const TAB_ANIMS = { general: "tools", "api-key": "login", connections: "ide-connected", chats: "resume", "claude-code": "writing", about: "hello" };

(async function start() {
  try {
    const sets = await (await fetch("../../assets/sets.json")).json();
    player = new ClawdPlayer($("clawd"), sets);
    player.react("hello");
  } catch (e) {
    console.warn("no animations", e);
  }
  state = await api.state();
  render();
  showTab(location.hash.slice(1) || "general", false);
})();

function react(anim) {
  if (player) player.react(anim, { front: true });
}

api.on((msg) => {
  if (msg.type === "state") {
    state = msg.state;
    render();
  } else if (msg.type === "section") showTab(msg.section);
});

// ---------------------------------------------------------------- tabs
function showTab(name, animate = true) {
  if (!$(name)) name = "general";
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === name));
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  if (animate && TAB_ANIMS[name]) react(TAB_ANIMS[name]);
}
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-ext]");
  if (a) {
    e.preventDefault();
    api.open(a.dataset.ext);
  }
});

function msg(id, text, ok) {
  const el = $(id);
  el.textContent = text || "";
  el.className = "msg" + (text ? (ok ? " ok" : " bad") : "");
}

// ---------------------------------------------------------------- render
function render() {
  if (!state) return;
  const model = state.models.find((m) => m.id === state.model);
  $("modelLine").textContent = model ? `thinking with ${model.label}` : "";
  $("shortcut").textContent = state.shortcut;
  $("version").textContent = `Version ${state.version}`;

  // brain
  document.querySelectorAll('input[name="brain"]').forEach((r) => (r.checked = r.value === state.brain));
  $("brainHint").textContent =
    state.brain === "claude-code"
      ? state.claudeCode.installed
        ? `Using your Claude account through Claude Code ${state.claudeCode.installed.version}.${state.connectedChat ? ` Continuing “${state.connectedChat}”.` : ""}`
        : "Claude Code isn't installed, so this won't work yet. See the Claude Code page."
      : state.apiKey.source === "none" ? "No API key yet: add one on the API key page." : "";

  // chats
  renderChats();

  // models
  $("models").innerHTML = "";
  for (const m of state.models) {
    const card = document.createElement("label");
    card.className = "card";
    card.innerHTML = `<input type="radio" name="model" /><b></b><small></small>`;
    card.querySelector("input").checked = m.id === state.model;
    card.querySelector("b").textContent = m.label;
    card.querySelector("small").textContent = m.blurb;
    card.querySelector("input").addEventListener("change", async () => {
      state = await api.set("model", m.id);
      render();
      react("model-switch");
    });
    $("models").append(card);
  }

  // sizes
  $("sizes").innerHTML = "";
  for (const s of state.scales) {
    const b = document.createElement("button");
    b.textContent = s.label;
    b.className = s.value === state.scale ? "on" : "";
    b.addEventListener("click", async () => {
      state = await api.set("scale", s.value);
      render();
    });
    $("sizes").append(b);
  }
  $("autoApprove").checked = state.autoApprove;
  $("openAtLogin").checked = state.openAtLogin;

  // API key
  const k = state.apiKey;
  $("keyStatus").innerHTML =
    k.source === "none"
      ? `<span class="dot bad"></span><div><b>No API key yet</b><small>Clawd can't think until you add one.</small></div>`
      : `<span class="dot ok"></span><div><b>Using a ${k.source === "saved" ? "saved" : "terminal (ANTHROPIC_API_KEY)"} key</b><small><code></code></small></div>`;
  const code = $("keyStatus").querySelector("code");
  if (code) code.textContent = k.hint;
  $("removeKey").classList.toggle("hidden", k.source !== "saved");

  // GitHub & Linear
  const gh = state.github;
  $("githubStatus").textContent = gh.connected ? `Connected as @${gh.login}${gh.readOnly ? " · read-only" : ""}` : "Not connected";
  const li = state.linear;
  $("linearStatus").textContent = li.connected ? `Connected to ${li.org} as ${li.name}${li.readOnly ? " · read-only" : ""}` : "Not connected";
  for (const [name, s] of [["github", gh], ["linear", li]]) {
    $(`${name}Connect`).classList.toggle("hidden", s.connected);
    $(`${name}Disconnect`).classList.toggle("hidden", !s.connected);
    $(`${name}RO`).classList.toggle("hidden", !s.connected);
    $(`${name}RO`).querySelector("input").checked = !!s.readOnly;
  }

  // notification summaries
  const w = state.watch;
  const statusText = (s, base) =>
    !s ? base : s.ok ? `On · checked ${s.ago}${s.found ? ` · ${s.found} summarized so far` : ""}` : `Problem: ${s.error}`;
  $("slackWatch").classList.toggle("hidden", !state.slack.connected);
  $("slackMentions").classList.toggle("hidden", !state.slack.connected || !w.slack.enabled);
  $("slackWatch").querySelector("input").checked = w.slack.enabled;
  $("slackMentions").querySelector("input").checked = w.slack.mentions !== false;
  $("slackWatchStatus").textContent = w.slack.enabled
    ? statusText(w.slack.status, "Starting…")
    : "When someone DMs you, Clawd wakes up and sums it up. Checks every minute. Needs a User token with search:read.";
  $("slackWatchStatus").style.color = w.slack.enabled && w.slack.status && !w.slack.status.ok ? "var(--bad)" : "";
  $("linearWatch").classList.toggle("hidden", !state.linear.connected);
  $("linearWatch").querySelector("input").checked = w.linear.enabled;
  $("linearWatchStatus").textContent = w.linear.enabled
    ? statusText(w.linear.status, "Starting…")
    : "When an issue is assigned to you, Clawd wakes up and sums it up. Checks every 2 minutes.";
  $("linearWatchStatus").style.color = w.linear.enabled && w.linear.status && !w.linear.status.ok ? "var(--bad)" : "";

  // Slack
  const sl = state.slack;
  $("slackStatus").textContent = sl.connected ? `Connected to ${sl.team} as ${sl.user}` : "Not connected";
  $("slackConnect").classList.toggle("hidden", sl.connected);
  $("slackDisconnect").classList.toggle("hidden", !sl.connected);

  // app servers: only reset the editable rows when nothing is being edited
  if (!document.activeElement || !document.activeElement.closest("#mcpList")) {
    mcpRows = state.mcpServers.map((s) => ({ ...s, originalName: s.name, token: "", keepToken: s.hasToken }));
    renderMcp();
  }

  // Claude Code
  const cc = state.claudeCode;
  $("ccStatus").innerHTML = cc.installed
    ? `<span class="dot ok"></span><div><b>Claude Code is installed</b><small></small></div><button id="ccDetect" class="ghost">Re-check</button>`
    : `<span class="dot warn"></span><div><b>Claude Code isn't installed</b><small>Install it, then press Re-check.</small></div><a href="#" data-ext="https://code.claude.com/docs/en/quickstart">Install ↗</a><button id="ccDetect" class="ghost">Re-check</button>`;
  const ccSmall = $("ccStatus").querySelector("small");
  if (cc.installed) ccSmall.textContent = `${cc.installed.version} · ${cc.installed.path}`;
  $("ccDetect").addEventListener("click", async () => {
    $("ccDetect").disabled = true;
    state = await api.detectClaudeCode();
    render();
  });
  $("ccEnabled").checked = cc.enabled;
  $("ccEnabled").disabled = !cc.installed && !cc.enabled;
  if (document.activeElement !== $("ccFolder")) $("ccFolder").value = cc.folder;
  document.querySelectorAll('input[name="ccMode"]').forEach((r) => (r.checked = r.value === cc.permissionMode));
}

// ---------------------------------------------------------------- brain & chats
document.querySelectorAll('input[name="brain"]').forEach((r) =>
  r.addEventListener("change", async () => {
    state = await api.set("brain", r.value);
    render();
    react("model-switch");
  })
);

function renderChats() {
  const list = $("chatList");
  list.innerHTML = "";
  if (!state.chats.length) {
    list.innerHTML = `<div class="mcp-empty">No Claude Code chats found on this Mac yet.</div>`;
    return;
  }
  for (const c of state.chats) {
    const el = document.createElement("div");
    const on = state.brain === "claude-code" && state.connectedChat === c.title;
    el.className = "chat" + (on ? " on" : "");
    el.innerHTML = `<b></b><button></button><div class="meta"></div><div class="preview"></div>`;
    el.querySelector("b").textContent = c.title;
    el.querySelector(".meta").textContent = `${c.project} · ${c.source} · ${c.ago}`;
    el.querySelector(".preview").textContent = c.lastReply || "";
    const btn = el.querySelector("button");
    btn.textContent = on ? "Continuing" : "Continue with Clawd";
    btn.className = on ? "ghost" : "primary";
    btn.disabled = on;
    btn.addEventListener("click", async () => {
      const res = await api.connectChat(c.sessionId);
      state = res.state;
      render();
      react(res.ok ? "resume" : "sorry");
    });
    list.append(el);
  }
}
$("chatRefresh").addEventListener("click", async () => {
  state = await api.state();
  render();
});
$("chatFresh").addEventListener("click", async () => {
  state = await api.freshChat();
  render();
  react("session-start");
});

// ---------------------------------------------------------------- general
$("autoApprove").addEventListener("change", async (e) => {
  state = await api.set("autoApprove", e.target.checked);
  render();
});
$("openAtLogin").addEventListener("change", async (e) => {
  state = await api.set("openAtLogin", e.target.checked);
  render();
});

// ---------------------------------------------------------------- API key
$("keyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  msg("keyMsg", "Checking the key…", true);
  const res = await api.saveApiKey($("keyInput").value);
  if (res.ok) {
    $("keyInput").value = "";
    msg("keyMsg", "Saved! Clawd is using the new key.", true);
    react("celebrate");
  } else {
    msg("keyMsg", res.error, false);
    react("sorry");
  }
  state = await api.state();
  render();
});
$("testKey").addEventListener("click", async () => {
  msg("keyMsg", "Testing…", true);
  const res = await api.testApiKey();
  msg("keyMsg", res.ok ? res.message : res.error, res.ok);
  react(res.ok ? "tests-pass" : "sorry");
});
$("removeKey").addEventListener("click", async () => {
  if (!confirm("Remove the saved API key? Clawd won't be able to think until you add one again.")) return;
  state = await api.removeApiKey();
  render();
  msg("keyMsg", "Removed.", true);
});

// ---------------------------------------------------------------- GitHub & Linear
async function connected(msgId, res) {
  if (res.ok) {
    msg(msgId, "", true);
    react("celebrate");
  } else {
    msg(msgId, res.error, false);
    react("tool-failure");
  }
  state = await api.state();
  render();
}
$("githubCli").addEventListener("click", async () => {
  msg("githubMsg", "Checking your GitHub CLI sign-in…", true);
  await connected("githubMsg", await api.githubUseCli());
});
$("githubForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  msg("githubMsg", "Connecting…", true);
  const res = await api.connectGithub($("githubToken").value);
  if (res.ok) $("githubToken").value = "";
  await connected("githubMsg", res);
});
$("linearForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  msg("linearMsg", "Connecting…", true);
  const res = await api.connectLinear($("linearToken").value);
  if (res.ok) $("linearToken").value = "";
  await connected("linearMsg", res);
});
for (const name of ["github", "linear"]) {
  $(`${name}Disconnect`).addEventListener("click", async () => {
    state = await api.disconnectApp(name);
    render();
  });
  $(`${name}RO`).querySelector("input").addEventListener("change", async (e) => {
    state = await api.setAppReadOnly(name, e.target.checked);
    render();
  });
}

// ---------------------------------------------------------------- notification summaries
for (const [id, service, key] of [["slackWatch", "slack", "enabled"], ["slackMentions", "slack", "mentions"], ["linearWatch", "linear", "enabled"]]) {
  $(id).querySelector("input").addEventListener("change", async (e) => {
    state = await api.setWatch(service, key, e.target.checked);
    render();
    if (e.target.checked && key === "enabled") react(service === "slack" ? "new-mail" : "todo-list");
  });
}

// ---------------------------------------------------------------- Slack
$("slackForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  msg("slackMsg", "Connecting…", true);
  const res = await api.connectSlack($("slackToken").value);
  if (res.ok) {
    $("slackToken").value = "";
    msg("slackMsg", "", true);
    react("celebrate");
  } else {
    msg("slackMsg", res.error, false);
    react("tool-failure");
  }
  state = await api.state();
  render();
});
$("slackDisconnect").addEventListener("click", async () => {
  state = await api.disconnectSlack();
  render();
});

// ---------------------------------------------------------------- app servers (MCP)
function renderMcp() {
  const list = $("mcpList");
  list.innerHTML = "";
  if (!mcpRows.length) {
    list.innerHTML = `<div class="mcp-empty">No app servers yet.</div>`;
    return;
  }
  mcpRows.forEach((row, i) => {
    const el = document.createElement("div");
    el.className = "mcp-row";
    el.innerHTML = `
      <input type="text" placeholder="name" spellcheck="false" />
      <input type="url" placeholder="https://mcp.example.com/mcp" spellcheck="false" />
      <input type="password" autocomplete="off" />
      <label class="toggle" title="Enabled"><input type="checkbox" /></label>
      <button class="ghost danger" title="Remove">✕</button>`;
    const [name, url, token, enabled] = el.querySelectorAll("input");
    name.value = row.name || "";
    url.value = row.url || "";
    token.placeholder = row.keepToken ? "•••• saved" : "token (optional)";
    enabled.checked = row.enabled !== false;
    name.addEventListener("input", () => (row.name = name.value));
    url.addEventListener("input", () => (row.url = url.value));
    token.addEventListener("input", () => (row.token = token.value));
    enabled.addEventListener("change", () => (row.enabled = enabled.checked));
    el.querySelector("button").addEventListener("click", () => {
      mcpRows.splice(i, 1);
      renderMcp();
    });
    list.append(el);
  });
}
$("mcpAdd").addEventListener("click", () => {
  mcpRows.push({ name: "", url: "", token: "", enabled: true });
  renderMcp();
  const inputs = $("mcpList").querySelectorAll(".mcp-row:last-child input");
  if (inputs[0]) inputs[0].focus();
});
$("mcpSave").addEventListener("click", async () => {
  const res = await api.saveMcp(mcpRows);
  if (res.ok) {
    msg("mcpMsg", "Saved. Clawd can use these apps in his next reply.", true);
    state = res.state;
    mcpRows = state.mcpServers.map((s) => ({ ...s, originalName: s.name, token: "", keepToken: s.hasToken }));
    renderMcp();
    render();
    react("ide-connected");
  } else {
    msg("mcpMsg", res.error, false);
    react("sorry");
  }
});

// ---------------------------------------------------------------- Claude Code
$("ccEnabled").addEventListener("change", async (e) => {
  state = await api.setClaudeCode({ enabled: e.target.checked });
  render();
  if (e.target.checked) react("celebrate");
});
$("ccFolder").addEventListener("change", async (e) => {
  state = await api.setClaudeCode({ folder: e.target.value });
  render();
});
$("ccPick").addEventListener("click", async () => {
  state = await api.pickFolder();
  render();
});
document.querySelectorAll('input[name="ccMode"]').forEach((r) =>
  r.addEventListener("change", async () => {
    state = await api.setClaudeCode({ permissionMode: r.value });
    render();
  })
);
