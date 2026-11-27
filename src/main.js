const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, safeStorage, globalShortcut, protocol, net, shell, dialog, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { pathToFileURL } = require("url");
const Anthropic = require("@anthropic-ai/sdk").default;
const { Agent, captureScreen, MODELS, DEFAULT_MODEL } = require("./agent");
const { slackTest, findClaudeCode } = require("./integrations");

const ROOT = path.join(__dirname, "..");
const SHORTCUT = "CommandOrControl+Shift+Space";
const SCALES = [1, 1.5, 2, 2.5, 3, 4]; // screen pixels per Clawd pixel
const SIZE_NAMES = { 1: "Tiny", 1.5: "Small", 2: "Medium", 2.5: "Large", 3: "Extra large", 4: "Huge" };

let win = null;
let tray = null;
let agent = null;
const sets = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "sets.json"), "utf8"));

// Only one Clawd at a time: opening the app again just opens the chat box.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---------- settings (API key kept encrypted with the macOS Keychain) ----------
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
let settings = {
  autoApprove: false,
  apiKeyEnc: null,
  position: null,
  flipped: false,
  scale: 2,
  model: DEFAULT_MODEL,
  slack: null, // {tokenEnc, team, user}
  mcpServers: [], // [{name, url, tokenEnc, enabled}]
  claudeCode: { enabled: false, folder: path.join(os.homedir(), "Clawd Projects"), permissionMode: "acceptEdits" },
};
const PERMISSION_MODES = ["acceptEdits", "auto", "plan"];
let claudeInfo = null; // {path, version} of the installed Claude Code CLI

// Secrets (API key, tokens) are stored encrypted with the macOS Keychain.
function enc(s) {
  return safeStorage.encryptString(s).toString("base64");
}
function dec(b64) {
  if (!b64 || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(b64, "base64"));
  } catch {
    return null;
  }
}

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) };
  } catch {}
  if (!MODELS[settings.model]) settings.model = DEFAULT_MODEL;
  if (!SCALES.includes(settings.scale)) settings.scale = 2;
  settings.claudeCode = { enabled: false, folder: path.join(os.homedir(), "Clawd Projects"), permissionMode: "acceptEdits", ...(settings.claudeCode || {}) };
  if (!PERMISSION_MODES.includes(settings.claudeCode.permissionMode)) settings.claudeCode.permissionMode = "acceptEdits";
  if (!Array.isArray(settings.mcpServers)) settings.mcpServers = [];
}

// What the agent can use right now, with secrets decrypted.
function getIntegrations() {
  return {
    slackToken: settings.slack ? dec(settings.slack.tokenEnc) : null,
    mcpServers: settings.mcpServers
      .filter((s) => s.enabled && s.url)
      .map((s) => ({ name: s.name, url: s.url, token: s.tokenEnc ? dec(s.tokenEnc) : null })),
    claudeCode: { ...settings.claudeCode, path: claudeInfo ? claudeInfo.path : null },
  };
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error("could not save settings", e);
  }
}
function getApiKey() {
  return dec(settings.apiKeyEnc) || process.env.ANTHROPIC_API_KEY || null;
}
function setApiKey(key) {
  key = (key || "").trim();
  if (!key) return false;
  if (!safeStorage.isEncryptionAvailable()) return false;
  settings.apiKeyEnc = safeStorage.encryptString(key).toString("base64");
  saveSettings();
  return true;
}

// ---------- geometry ----------
// Normal layout: speech bubble on top, Clawd, then the text box at the bottom.
// Flipped layout (near the top of the screen): Clawd on top, text box right under him, bubble below.
// These numbers mirror style.css.
function geom(scale = settings.scale) {
  const clawdW = 192 * scale;
  const clawdH = 64 * scale;
  const w = Math.round(Math.max(420, clawdW + 36));
  const h = Math.round(288 + clawdH);
  return { w, h, clawdH, topNormal: h - 50 - clawdH, topFlipped: 8 };
}
const clawdTop = (g = geom()) => (settings.flipped ? g.topFlipped : g.topNormal);

// ---------- window ----------
function send(type, payload = {}) {
  if (win && !win.isDestroyed()) win.webContents.send("buddy", { type, ...payload });
}

function sendLayout() {
  send("layout", { flipped: !!settings.flipped, scale: settings.scale });
}

function defaultPosition() {
  const g = geom();
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + workArea.width - g.w - 24, y: workArea.y + workArea.height - g.h };
}

function onScreen(pos) {
  const g = geom();
  return screen.getAllDisplays().some(({ workArea: a }) => pos.x + g.w / 2 >= a.x && pos.x + g.w / 2 <= a.x + a.width && pos.y + g.h / 2 >= a.y - g.h / 2 && pos.y + g.h / 2 <= a.y + a.height);
}

function createWindow() {
  const g = geom();
  const pos = settings.position && onScreen(settings.position) ? settings.position : defaultPosition();
  win = new BrowserWindow({
    width: g.w,
    height: g.h,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    enableLargerThanScreen: true, // don't let macOS push the window back below the menu bar
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Clicks pass through the clear parts of the window; the page turns this off over Clawd and the bubbles.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadURL("app://buddy/src/renderer/index.html");
  win.once("ready-to-show", () => win.showInactive());
  // Links in Clawd's replies open in the default browser, never inside the buddy window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

// Resize Clawd, keeping his feet (or, when flipped, his head) where they are on screen.
function setScale(scale) {
  scale = SCALES.reduce((best, s) => (Math.abs(s - scale) < Math.abs(best - scale) ? s : best), SCALES[0]);
  if (scale === settings.scale) return;
  const oldG = geom();
  const newG = geom(scale);
  const [wx, wy] = win.getPosition();
  let y;
  if (settings.flipped) y = wy;
  else y = wy + oldG.topNormal + oldG.clawdH - (newG.topNormal + newG.clawdH);
  settings.scale = scale;
  win.setBounds({ x: wx, y: Math.round(y), width: newG.w, height: newG.h });
  settings.position = { x: wx, y: Math.round(y) };
  saveSettings();
  sendLayout();
  refreshMenus();
}
function stepScale(dir) {
  const i = SCALES.indexOf(settings.scale);
  const next = SCALES[Math.min(SCALES.length - 1, Math.max(0, i + dir))];
  setScale(next);
}

function setModel(model) {
  if (!MODELS[model]) return false;
  settings.model = model;
  saveSettings();
  refreshMenus();
  return true;
}

// ---------- menu bar icon (a tiny Clawd, drawn pixel by pixel) ----------
function trayImage() {
  // 16x12 Clawd from the MyClawd favicon, drawn at 2x for Retina, as a template image.
  const body = [[3, 0, 10, 4], [0, 4, 16, 3], [3, 7, 10, 3], [3, 10, 2, 2], [7, 10, 2, 2], [11, 10, 2, 2]];
  const eyes = [[5, 2, 2, 2], [9, 2, 2, 2]];
  const W = 18, H = 14, S = 2, OX = 1, OY = 1;
  const buf = Buffer.alloc(W * S * H * S * 4);
  const fill = (rects, a) => {
    for (const [x, y, w, h] of rects)
      for (let yy = (y + OY) * S; yy < (y + OY + h) * S; yy++)
        for (let xx = (x + OX) * S; xx < (x + OX + w) * S; xx++) {
          const i = (yy * W * S + xx) * 4;
          buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = a;
        }
  };
  fill(body, 255);
  fill(eyes, 0); // eyes are holes
  const img = nativeImage.createFromBitmap(buf, { width: W * S, height: H * S, scaleFactor: S });
  img.setTemplateImage(true);
  return img;
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: "Talk to Clawd", accelerator: SHORTCUT, click: () => toggleInput() },
    { label: "Open Companion…", accelerator: "Command+,", click: () => openCompanion() },
    { label: "Stop", click: () => agent.stop() },
    { label: "New chat", click: () => newChat() },
    { type: "separator" },
    {
      label: `Model: ${MODELS[settings.model].label}`,
      submenu: Object.entries(MODELS).map(([id, m]) => ({
        label: `${m.label} — ${m.blurb}`,
        type: "radio",
        checked: settings.model === id,
        click: () => {
          if (setModel(id)) send("model", { model: id, label: m.label, by: "menu" });
        },
      })),
    },
    {
      label: `Size: ${SIZE_NAMES[settings.scale]}`,
      submenu: [
        ...SCALES.map((s) => ({ label: SIZE_NAMES[s], type: "radio", checked: settings.scale === s, click: () => setScale(s) })),
        { type: "separator" },
        { label: "Bigger", accelerator: "Command+=", click: () => stepScale(1) },
        { label: "Smaller", accelerator: "Command+-", click: () => stepScale(-1) },
      ],
    },
    {
      label: "Auto-approve commands",
      type: "checkbox",
      checked: settings.autoApprove,
      click: (item) => {
        settings.autoApprove = item.checked;
        saveSettings();
        send("settings", { autoApprove: settings.autoApprove });
        refreshMenus();
      },
    },
    {
      label: "Open at login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { label: "Set API key…", click: () => openCompanion("api-key") },
    {
      label: "Move Clawd back to the corner",
      click: () => {
        settings.flipped = false;
        sendLayout();
        const p = defaultPosition();
        win.setPosition(p.x, p.y);
        settings.position = p;
        saveSettings();
      },
    },
    { label: win && win.isVisible() ? "Hide Clawd" : "Show Clawd", click: () => (win.isVisible() ? win.hide() : win.showInactive(), refreshMenus()) },
    { type: "separator" },
    { label: "Animations by MyClawd (fan project)", click: () => shell.openExternal("https://codechrisb.github.io/MyClawd/") },
    { label: "Quit Clawd Buddy", accelerator: "Command+Q", click: () => app.quit() },
  ]);
}
function refreshMenus() {
  if (tray) tray.setContextMenu(buildMenu());
  sendCompanionState();
}

// ---------- companion window ----------
let companion = null;

function openCompanion(section) {
  if (companion && !companion.isDestroyed()) {
    if (section) companion.webContents.send("companion", { type: "section", section });
    companion.show();
    app.focus({ steal: true });
    companion.focus();
    return;
  }
  companion = new BrowserWindow({
    width: 860,
    height: 620,
    minWidth: 700,
    minHeight: 520,
    title: "Clawd Companion",
    titleBarStyle: "hiddenInset",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1a19" : "#f7f2ec",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "companion-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  companion.loadURL("app://buddy/src/companion/index.html" + (section ? `#${section}` : ""));
  companion.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  companion.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("app://buddy/src/companion/")) e.preventDefault();
  });
  companion.once("ready-to-show", () => {
    // Show a Dock icon while the companion is open so it can be found with ⌘-Tab.
    if (app.dock) app.dock.show().then(() => app.dock.setIcon(path.join(ROOT, "assets", "icon.png"))).catch(() => {});
    companion.show();
    app.focus({ steal: true });
  });
  companion.on("closed", () => {
    companion = null;
    if (app.dock) app.dock.hide();
  });
}

function companionState() {
  const key = dec(settings.apiKeyEnc);
  const envKey = process.env.ANTHROPIC_API_KEY;
  const k = key || envKey;
  return {
    models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, blurb: m.blurb })),
    model: settings.model,
    scales: SCALES.map((s) => ({ value: s, label: SIZE_NAMES[s] })),
    scale: settings.scale,
    autoApprove: settings.autoApprove,
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    apiKey: { source: key ? "saved" : envKey ? "env" : "none", hint: k ? `${k.slice(0, 7)}…${k.slice(-4)}` : null },
    slack: settings.slack ? { connected: true, team: settings.slack.team, user: settings.slack.user } : { connected: false },
    mcpServers: settings.mcpServers.map((s) => ({ name: s.name, url: s.url, hasToken: !!s.tokenEnc, enabled: !!s.enabled })),
    claudeCode: { ...settings.claudeCode, installed: claudeInfo },
    shortcut: "⌘⇧Space",
    version: app.getVersion(),
  };
}
function sendCompanionState() {
  if (companion && !companion.isDestroyed()) companion.webContents.send("companion", { type: "state", state: companionState() });
}

async function detectClaudeCode() {
  claudeInfo = await findClaudeCode();
  sendCompanionState();
  return claudeInfo;
}

function toggleInput() {
  if (!win.isVisible()) win.showInactive();
  win.focus();
  send("toggle-input");
}

function newChat() {
  agent.newChat();
  send("new-chat");
}

// ---------- approvals ----------
let approvalSeq = 0;
const approvals = new Map();
function requestApproval({ kind, detail }) {
  const id = ++approvalSeq;
  return new Promise((resolve) => {
    approvals.set(id, resolve);
    send("approval", { id, kind, detail });
  });
}

// ---------- app ----------
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// `open -a "Clawd Buddy" --args --companion` opens the companion window.
app.on("second-instance", (_e, argv) => {
  if (argv.includes("--companion")) openCompanion();
  else if (win) toggleInput();
});

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) app.dock.hide();
  loadSettings();

  // Serve the page and the GIFs from the app folder, and nothing outside it.
  protocol.handle("app", (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    const file = path.normalize(path.join(ROOT, rel));
    const allowed = [path.join(ROOT, "src", "renderer"), path.join(ROOT, "src", "companion"), path.join(ROOT, "assets")];
    if (!allowed.some((dir) => file.startsWith(dir + path.sep))) {
      return new Response("not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });

  agent = new Agent({
    sets,
    getApiKey,
    getAutoApprove: () => settings.autoApprove,
    getModel: () => settings.model,
    setModel,
    getIntegrations,
    openCompanion: (section) => openCompanion(section),
    requestApproval,
    takeScreenshot: async () => {
      // Step out of the picture so Claude sees the screen, not Clawd.
      const wasVisible = win.isVisible();
      if (wasVisible) win.hide();
      await new Promise((r) => setTimeout(r, 250));
      try {
        return await captureScreen();
      } finally {
        if (wasVisible) win.showInactive();
      }
    },
  });
  for (const ev of ["activity", "emote", "text", "thinking", "tool", "turn-start", "turn-end", "error", "model", "context", "progress"]) {
    agent.on(ev, (p) => send(ev, typeof p === "string" ? { text: p } : p || {}));
  }
  agent.on("need-key", () => send("need-key", { reason: "missing" }));

  createWindow();
  tray = new Tray(trayImage());
  tray.setToolTip("Clawd Buddy");
  refreshMenus();
  globalShortcut.register(SHORTCUT, toggleInput);
  detectClaudeCode();
  if (process.argv.includes("--companion")) openCompanion();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (agent) agent.shell.kill();
});
app.on("window-all-closed", () => app.quit());

// ---------- IPC from the page ----------
ipcMain.handle("init", () => ({
  sets,
  hasKey: !!getApiKey(),
  autoApprove: settings.autoApprove,
  flipped: !!settings.flipped,
  scale: settings.scale,
  model: settings.model,
  modelLabel: MODELS[settings.model].label,
  shortcut: "⌘⇧Space",
}));
ipcMain.on("send", (_e, text) => {
  if (typeof text === "string" && text.trim()) agent.send(text.trim());
});
ipcMain.on("stop", () => agent.stop());
ipcMain.on("new-chat", () => newChat());
ipcMain.on("approval", (_e, { id, decision }) => {
  const resolve = approvals.get(id);
  if (resolve) {
    approvals.delete(id);
    resolve(["allow", "always", "deny"].includes(decision) ? decision : "deny");
  }
});
ipcMain.handle("set-api-key", (_e, key) => {
  const ok = setApiKey(key);
  return { ok, hasKey: !!getApiKey() };
});
ipcMain.on("set-ignore", (_e, ignore) => {
  if (win) win.setIgnoreMouseEvents(!!ignore, { forward: true });
});
ipcMain.on("focus", () => win && win.focus());
ipcMain.on("context-menu", () => buildMenu().popup({ window: win }));
ipcMain.on("resize", (_e, dir) => stepScale(dir > 0 ? 1 : -1));

// ---------- IPC from the companion window ----------
ipcMain.handle("c:state", () => companionState());

ipcMain.handle("c:set", (_e, { key, value }) => {
  if (key === "model" && MODELS[value]) {
    setModel(value);
    send("model", { model: value, label: MODELS[value].label, by: "menu" });
  } else if (key === "scale") setScale(Number(value));
  else if (key === "autoApprove") {
    settings.autoApprove = !!value;
    saveSettings();
    send("settings", { autoApprove: settings.autoApprove });
  } else if (key === "openAtLogin") app.setLoginItemSettings({ openAtLogin: !!value });
  refreshMenus();
  return companionState();
});

ipcMain.handle("c:apiKey:save", async (_e, key) => {
  key = (key || "").trim();
  if (!/^sk-ant-/.test(key)) return { ok: false, error: "That doesn't look like an Anthropic API key (they start with sk-ant-)." };
  const test = await testApiKey(key);
  if (!test.ok) return test;
  setApiKey(key);
  send("key-saved");
  refreshMenus();
  return { ok: true };
});
ipcMain.handle("c:apiKey:test", () => testApiKey(getApiKey()));
ipcMain.handle("c:apiKey:remove", () => {
  settings.apiKeyEnc = null;
  saveSettings();
  refreshMenus();
  return companionState();
});

async function testApiKey(key) {
  if (!key) return { ok: false, error: "No API key set." };
  try {
    const m = await new Anthropic({ apiKey: key, maxRetries: 0, timeout: 15000 }).models.retrieve(settings.model);
    return { ok: true, message: `Works! ${m.display_name || settings.model} is available.` };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, error: "Anthropic rejected this key." };
    if (err instanceof Anthropic.PermissionDeniedError) return { ok: false, error: "This key doesn't have access to that model." };
    if (err instanceof Anthropic.APIConnectionError) return { ok: false, error: "Couldn't reach the Anthropic API. Are you online?" };
    return { ok: false, error: err.message || String(err) };
  }
}

ipcMain.handle("c:slack:connect", async (_e, token) => {
  token = (token || "").trim();
  if (!/^xox[bpe]-/.test(token)) return { ok: false, error: "Slack tokens start with xoxb- (bot) or xoxp- (user)." };
  try {
    const who = await slackTest(token);
    settings.slack = { tokenEnc: enc(token), team: who.team, user: who.user };
    saveSettings();
    refreshMenus();
    return { ok: true, team: who.team, user: who.user };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("c:slack:disconnect", () => {
  settings.slack = null;
  saveSettings();
  refreshMenus();
  return companionState();
});

// Remote app servers (MCP). `token` is a new token; keepToken keeps the stored one.
ipcMain.handle("c:mcp:save", (_e, list) => {
  if (!Array.isArray(list)) return { ok: false, error: "Bad list." };
  const out = [];
  const used = new Set();
  for (const item of list) {
    const url = String(item.url || "").trim();
    if (!url) continue;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: `"${url}" isn't a valid URL.` };
    }
    if (parsed.protocol !== "https:") return { ok: false, error: `${url}: app servers must use https.` };
    let name = String(item.name || parsed.hostname).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app";
    while (used.has(name)) name += "-2";
    used.add(name);
    const prev = settings.mcpServers.find((s) => s.name === item.originalName || s.url === url);
    const token = String(item.token || "").trim();
    out.push({ name, url, enabled: item.enabled !== false, tokenEnc: token ? enc(token) : item.keepToken && prev ? prev.tokenEnc : null });
  }
  settings.mcpServers = out;
  saveSettings();
  refreshMenus();
  return { ok: true, state: companionState() };
});

ipcMain.handle("c:cc:set", (_e, patch) => {
  const cc = settings.claudeCode;
  if (patch && "enabled" in patch) cc.enabled = !!patch.enabled;
  if (patch && typeof patch.folder === "string" && patch.folder.trim()) cc.folder = patch.folder.trim();
  if (patch && PERMISSION_MODES.includes(patch.permissionMode)) cc.permissionMode = patch.permissionMode;
  saveSettings();
  refreshMenus();
  return companionState();
});
ipcMain.handle("c:cc:pickFolder", async () => {
  const res = await dialog.showOpenDialog(companion, {
    title: "Where should Claude Code work?",
    defaultPath: settings.claudeCode.folder,
    properties: ["openDirectory", "createDirectory"],
  });
  if (!res.canceled && res.filePaths[0]) {
    settings.claudeCode.folder = res.filePaths[0];
    saveSettings();
  }
  return companionState();
});
ipcMain.handle("c:cc:detect", async () => {
  await detectClaudeCode();
  return companionState();
});
ipcMain.on("c:open", (_e, url) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.on("open-companion", (_e, section) => openCompanion(section));

// Dragging. Near the top of the screen the layout flips (Clawd on top, bubble below)
// so Clawd can go all the way up instead of stopping where the bubble space hits the menu bar.
let dragOrigin = null;

ipcMain.on("drag-start", (_e, { x, y }) => {
  const [wx, wy] = win.getPosition();
  dragOrigin = { mx: x, my: y, wx, cy: wy + clawdTop() };
});
ipcMain.on("drag-move", (_e, { x, y }) => {
  if (!dragOrigin) return;
  const g = geom();
  const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  // Where Clawd's top edge should be on screen; never tucked under the menu bar.
  const cy = Math.max(dragOrigin.cy + y - dragOrigin.my, display.workArea.y - g.topFlipped);
  const flipped = cy - g.topNormal < display.workArea.y;
  if (flipped !== !!settings.flipped) {
    settings.flipped = flipped;
    sendLayout();
  }
  win.setPosition(Math.round(dragOrigin.wx + x - dragOrigin.mx), Math.round(cy - clawdTop(g)));
});
ipcMain.on("drag-end", () => {
  dragOrigin = null;
  const [x, y] = win.getPosition();
  settings.position = { x, y };
  saveSettings();
});
