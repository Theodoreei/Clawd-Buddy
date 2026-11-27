"use strict";

const $ = (id) => document.getElementById(id);
const stage = $("stage");
const canvas = $("clawd");
const fx = $("fx");
const bubble = $("bubble");
const tail = $("tail");
const reply = $("reply");
const thought = $("thought");
const tools = $("tools");
const approval = $("approval");
const keyForm = $("keyForm");
const inputRow = $("inputRow");
const promptInput = $("prompt");
const sendBtn = $("sendBtn");

let player;
let busy = false;
let replyText = "";
let emotedThisTurn = false;
let pendingApproval = null;
let lastInteraction = Date.now();
let hideBubbleTimer = null;
let dozing = false;

const PET_REACTIONS = ["idle-heart", "hello", "great-question", "right", "idle-juggle", "disco", "celebrate"];

// ---------------------------------------------------------------- startup
(async function start() {
  const init = await window.buddy.init();
  applyLayout(init);
  player = new ClawdPlayer(canvas, init.sets);
  player.preload(["idle", "idle-doze", "hello", "prompt", "thinking", "bash", "permission", "done", "idle-yawn"]);
  player.react("hello");
  setTimeout(() => effect("sparkles"), 700);
  if (!init.hasKey) {
    setTimeout(() => showKeyForm("Hi! I'm Clawd 👋 Paste your Anthropic API key so I can think and help you out."), 1600);
  } else {
    setTimeout(() => say(`Hi! Click me or press ${init.shortcut} to chat. Drag me anywhere, right-click for options.`, { fade: 9000 }), 1600);
  }
  setInterval(idleTick, 1000);
})();

window.buddy.on((msg) => {
  switch (msg.type) {
    case "turn-start": return onTurnStart();
    case "activity": return onActivity(msg);
    case "emote": return onEmote(msg);
    case "text": return onText(msg);
    case "thinking": return onThinking(msg);
    case "tool": return onTool(msg);
    case "approval": return onApproval(msg);
    case "turn-end": return onTurnEnd(msg);
    case "error": return onError(msg);
    case "need-key": return showKeyForm(msg.reason === "change" ? "Paste a new Anthropic API key:" : "I need an Anthropic API key to think. Paste one here:");
    case "toggle-input": return toggleInput();
    case "new-chat": return onNewChat();
    case "layout": return applyLayout(msg);
    case "model": return onModel(msg);
    case "context": return onContext(msg);
    case "progress":
      thought.textContent = "⌨︎ " + msg.text;
      thought.classList.remove("hidden");
      return scrollBubble();
    case "key-saved":
      keyForm.classList.add("hidden");
      player.setMode(null);
      player.react("celebrate");
      effect("confetti");
      return say("New API key, who dis? 🧠 All set!", { fade: 6000 });
    case "settings": return say(msg.autoApprove ? "Auto-approve is on: I'll run commands without asking. Careful!" : "Okay, I'll ask before running each command again.", { fade: 5000 });
  }
});

// ---------------------------------------------------------------- layout, size & model
let scale = 2;
function applyLayout({ flipped, scale: s }) {
  document.body.classList.toggle("flip", !!flipped);
  if (s) {
    scale = s;
    document.documentElement.style.setProperty("--s", String(s));
  }
}

function onModel({ label, by }) {
  player.react("model-switch", { front: true });
  effect("sparkles");
  if (by === "menu") {
    say(`Switched my brain to ${label}! 🧠`, { fade: 5000 });
  } else {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.textContent = `🧠 now using ${label}`;
    tools.append(chip);
    breakBeforeText = true;
    scrollBubble();
  }
}

// ⌘+ / ⌘− or a trackpad pinch over Clawd resizes him.
let pinch = 0;
document.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return; // Chromium reports pinch-to-zoom as ctrl+wheel
    e.preventDefault();
    pinch += e.deltaY;
    if (Math.abs(pinch) > 40) {
      window.buddy.resize(pinch < 0 ? 1 : -1);
      pinch = 0;
    }
  },
  { passive: false }
);

// ---------------------------------------------------------------- agent events
function onTurnStart() {
  busy = true;
  emotedThisTurn = false;
  replyText = "";
  wake();
  reply.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  tools.innerHTML = "";
  thought.textContent = "";
  thought.dataset.full = "";
  thought.classList.add("hidden");
  bubble.classList.remove("error");
  showBubble();
  sendBtn.textContent = "■";
  sendBtn.classList.add("stop");
  sendBtn.title = "Stop (esc)";
  bump("hop");
}

function onActivity({ anim, once }) {
  if (!player) return;
  if (once) player.react(anim);
  else player.setMode(anim);
}

function onEmote({ anim, effect: eff }) {
  emotedThisTurn = true;
  if (anim) player.react(anim, { front: true });
  if (eff) effect(eff);
  else if (anim) effect(autoEffect(anim));
}

let breakBeforeText = false;
function onText({ text }) {
  if (!text) return;
  if (breakBeforeText && replyText.trim()) replyText = replyText.trimEnd() + "\n\n";
  breakBeforeText = false;
  replyText += text;
  renderReply();
}

function onThinking({ text: delta }) {
  if (!delta) return;
  const t = (thought.dataset.full || "") + delta;
  thought.dataset.full = t.slice(-400);
  const line = t.replace(/\s+/g, " ").trim().slice(-90);
  thought.textContent = "💭 " + line;
  thought.classList.remove("hidden");
}

function onTool({ name, detail }) {
  breakBeforeText = true;
  const chip = document.createElement("div");
  chip.className = "chip";
  const code = document.createElement("code");
  code.textContent = detail.length > 120 ? detail.slice(0, 117) + "…" : detail;
  const icons = { bash: "▸ ", screenshot: "📸 ", slack: "# ", "claude-code": "⌨︎ ", app: "⇄ " };
  chip.append(icons[name] || "• ", code);
  // keep the list short while Claude Code is busy
  while (tools.children.length > 6) tools.firstElementChild.remove();
  tools.append(chip);
  thought.classList.add("hidden");
  scrollBubble();
}

function onApproval({ id, kind, detail }) {
  pendingApproval = id;
  $("approvalTitle").textContent =
    kind === "screenshot" ? "Can I look at your screen?" :
    kind === "slack" ? "Can I send this Slack message?" :
    kind === "claude-code" ? "Can I start Claude Code on this?" : "Can I run this?";
  $("alwaysBtn").classList.toggle("hidden", kind === "slack"); // messages are approved one at a time
  $("approvalDetail").textContent = detail;
  approval.classList.remove("hidden");
  showBubble();
  bump("hop");
  effect("question");
  window.buddy.focus();
  setTimeout(() => $("allowBtn").focus(), 50);
}

function answerApproval(decision) {
  if (pendingApproval == null) return;
  window.buddy.answerApproval(pendingApproval, decision);
  pendingApproval = null;
  approval.classList.add("hidden");
  if (decision === "deny") {
    const last = tools.lastElementChild;
    if (last) last.classList.add("denied");
    player.react("sorry");
  } else {
    bump("squish");
  }
  if (!inputRow.classList.contains("hidden")) promptInput.focus();
}

function onTurnEnd({ ok, usedTools }) {
  busy = false;
  player.setMode(null);
  thought.classList.add("hidden");
  approval.classList.add("hidden");
  pendingApproval = null;
  sendBtn.textContent = "➤";
  sendBtn.classList.remove("stop");
  sendBtn.title = "Send";
  if (ok && !replyText.trim()) reply.textContent = "Done!";
  if (ok && !emotedThisTurn) {
    if (usedTools) {
      player.react("done");
      effect("sparkles");
    } else {
      bump("hop");
    }
  }
  lastInteraction = Date.now();
  scheduleBubbleFade(30000);
}

function onError({ anim, message }) {
  busy = false;
  player.setMode(null);
  player.react(anim || "stop-failure", { front: true });
  if (anim === "interrupt") effect("exclaim");
  else {
    effect("sweat");
    bump("shake");
  }
  if (replyText.trim()) replyText += "\n\n";
  replyText += message;
  renderReply();
  if (anim !== "interrupt") bubble.classList.add("error");
  showBubble();
  scheduleBubbleFade(30000);
}

// The conversation's context gauge: react once each time it fills past another quarter.
const CONTEXT_LEVELS = [[0.9, "context-full"], [0.75, "context-three-quarters"], [0.5, "context-half"], [0.25, "context-quarter"]];
let contextLevel = 0;
function onContext({ used, window: size }) {
  const frac = used / size;
  const hit = CONTEXT_LEVELS.find(([lvl]) => frac >= lvl);
  if (hit && hit[0] > contextLevel) {
    contextLevel = hit[0];
    player.react(hit[1]);
  }
}

function onNewChat() {
  contextLevel = 0;
  replyText = "";
  reply.textContent = "";
  tools.innerHTML = "";
  player.react("clear");
  say("Fresh start! ✨", { fade: 4000 });
}

// ---------------------------------------------------------------- bubble
function renderReply() {
  reply.innerHTML = formatText(replyText.trim());
  showBubble();
  scrollBubble();
}

function formatText(s) {
  const esc = s.replace(/[ \t]{2,}/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|\s)(https?:\/\/[^\s<]+[^\s<.,)])/g, '$1<a href="$2" target="_blank">$2</a>');
}

function say(text, { fade } = {}) {
  replyText = text;
  reply.innerHTML = formatText(text);
  tools.innerHTML = "";
  thought.classList.add("hidden");
  bubble.classList.remove("error");
  showBubble();
  if (fade) scheduleBubbleFade(fade);
}

function showBubble() {
  clearTimeout(hideBubbleTimer);
  bubble.classList.remove("hidden", "fading");
  tail.classList.remove("hidden");
}

function hideBubble() {
  bubble.classList.add("hidden");
  tail.classList.add("hidden");
}

function scheduleBubbleFade(ms) {
  clearTimeout(hideBubbleTimer);
  hideBubbleTimer = setTimeout(() => {
    if (busy || pendingApproval != null || !keyForm.classList.contains("hidden") || bubble.matches(":hover")) {
      return scheduleBubbleFade(5000);
    }
    bubble.classList.add("fading");
    tail.classList.add("hidden");
    setTimeout(() => bubble.classList.contains("fading") && hideBubble(), 800);
  }, ms);
}

function scrollBubble() {
  bubble.scrollTop = bubble.scrollHeight;
}

// ---------------------------------------------------------------- API key
function showKeyForm(text) {
  say(text);
  keyForm.classList.remove("hidden");
  player && player.setMode("login");
  window.buddy.focus();
  setTimeout(() => $("keyInput").focus(), 50);
}

keyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("keyInput").value;
  const res = await window.buddy.setApiKey(key);
  $("keyInput").value = "";
  keyForm.classList.add("hidden");
  player.setMode(null);
  if (res.ok) {
    player.react("celebrate");
    effect("confetti");
    say("Got it, thank you! Click me whenever you need something. 🦀", { fade: 8000 });
  } else {
    player.react("sorry");
    say("Hmm, I couldn't save that key (is Keychain encryption available?). You can also launch me with ANTHROPIC_API_KEY set.", { fade: 12000 });
  }
});
$("keyCancel").addEventListener("click", () => {
  keyForm.classList.add("hidden");
  player.setMode(null);
  scheduleBubbleFade(1500);
});

// ---------------------------------------------------------------- input
function toggleInput(force) {
  const show = force !== undefined ? force : inputRow.classList.contains("hidden");
  if (show) {
    inputRow.classList.remove("hidden");
    window.buddy.focus();
    setTimeout(() => promptInput.focus(), 30);
    if (!busy) player.react("lets-look");
  } else if (!busy) {
    inputRow.classList.add("hidden");
  }
  wake();
}

inputRow.addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) {
    window.buddy.stop();
    return;
  }
  const text = promptInput.value.trim();
  if (!text) return;
  promptInput.value = "";
  window.buddy.send(text);
  wake();
});

document.addEventListener("keydown", (e) => {
  if (pendingApproval != null) {
    if (e.key === "Enter") { e.preventDefault(); answerApproval("allow"); return; }
    if (e.key === "Escape") { e.preventDefault(); answerApproval("deny"); return; }
  }
  if (e.key === "Escape") {
    if (busy) window.buddy.stop();
    else if (!keyForm.classList.contains("hidden")) $("keyCancel").click();
    else { inputRow.classList.add("hidden"); hideBubble(); }
  }
  if (e.key === "n" && e.metaKey) {
    e.preventDefault();
    window.buddy.newChat();
  }
  if (e.metaKey && (e.key === "=" || e.key === "+")) {
    e.preventDefault();
    window.buddy.resize(1);
  }
  if (e.metaKey && e.key === "-") {
    e.preventDefault();
    window.buddy.resize(-1);
  }
});
// × in the bubble: dismiss it. A pending question counts as "Deny", the key form as "Later".
$("closeBubble").addEventListener("click", () => {
  if (pendingApproval != null) answerApproval("deny");
  if (!keyForm.classList.contains("hidden")) {
    keyForm.classList.add("hidden");
    player.setMode(null);
  }
  clearTimeout(hideBubbleTimer);
  hideBubble();
  bump("squish");
});
$("allowBtn").addEventListener("click", () => answerApproval("allow"));
$("alwaysBtn").addEventListener("click", () => answerApproval("always"));
$("denyBtn").addEventListener("click", () => answerApproval("deny"));

window.addEventListener("blur", () => {
  if (!busy && !promptInput.value && pendingApproval == null) inputRow.classList.add("hidden");
});

// ---------------------------------------------------------------- click-through
// The window covers a big clear area; only Clawd's own pixels, the bubble and the input take the mouse.
let ignoring = true;
function setIgnore(v) {
  if (v !== ignoring) {
    ignoring = v;
    window.buddy.setIgnoreMouse(v);
  }
}

function overClawd(e) {
  if (!player) return false;
  const r = canvas.getBoundingClientRect();
  return player.hitTest(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
}

document.addEventListener("mousemove", (e) => {
  if (dragging) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const onUi = el && el.closest("[data-hit]") && !el.closest(".hidden");
  const onClawd = el === canvas && overClawd(e);
  setIgnore(!(onUi || onClawd));
  stage.classList.toggle("hover", !!onClawd);
});
document.addEventListener("mouseleave", () => {
  if (!dragging) {
    setIgnore(true);
    stage.classList.remove("hover");
  }
});

// ---------------------------------------------------------------- petting & dragging
let dragging = false;
let downAt = null;
let clicks = [];
let modeBeforeDrag = null;

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !overClawd(e)) return;
  canvas.setPointerCapture(e.pointerId);
  downAt = { x: e.screenX, y: e.screenY };
});

canvas.addEventListener("pointermove", (e) => {
  if (!downAt) return;
  if (!dragging && Math.hypot(e.screenX - downAt.x, e.screenY - downAt.y) > 4) {
    dragging = true;
    window.buddy.dragStart(downAt.x, downAt.y);
    stage.classList.add("carried");
    modeBeforeDrag = busy ? player.mode : null;
    if (!busy) player.setMode("idle-fall"); // wheee
    wake();
  }
  if (dragging) window.buddy.dragMove(e.screenX, e.screenY);
});

canvas.addEventListener("pointerup", (e) => {
  if (!downAt) return;
  canvas.releasePointerCapture(e.pointerId);
  downAt = null;
  if (dragging) {
    dragging = false;
    window.buddy.dragEnd();
    stage.classList.remove("carried");
    if (!busy) player.setMode(modeBeforeDrag);
    bump("bounce");
    return;
  }
  onClawdClick();
});

canvas.addEventListener("contextmenu", (e) => {
  if (!overClawd(e)) return;
  e.preventDefault();
  window.buddy.contextMenu();
});

function onClawdClick() {
  const now = Date.now();
  clicks = clicks.filter((t) => now - t < 1500);
  clicks.push(now);
  if (dozing) {
    // woken up: stretch, yawn, then open the chat box
    wake();
    player.react("idle-yawn", { front: true });
    effect("exclaim");
    bump("hop");
    toggleInput(true);
    return;
  }
  if (clicks.length >= 3) {
    // petting!
    clicks = [];
    bump("squish");
    if (!busy) {
      const pick = PET_REACTIONS[Math.floor(Math.random() * PET_REACTIONS.length)];
      player.react(pick, { front: true });
      effect(pick === "celebrate" ? "confetti" : pick === "disco" ? "music" : "hearts");
    } else {
      effect("hearts");
    }
    return;
  }
  bump("squish");
  toggleInput(true);
}

// ---------------------------------------------------------------- sleeping when idle
// With nothing to do, Clawd dozes off (MyClawd "idle-doze") and snores. Anything that
// gives him something to do wakes him; the set's exit is his wake-up stretch.
const SLEEP_AFTER_MS = 12000;

function wake() {
  lastInteraction = Date.now();
  if (dozing) {
    dozing = false;
    player.setIdle("idle");
  }
}

function idleTick() {
  if (!player) return;
  const inputInUse = !inputRow.classList.contains("hidden") && (document.activeElement === promptInput || promptInput.value);
  const occupied = busy || dragging || pendingApproval != null || !keyForm.classList.contains("hidden") || inputInUse;
  if (occupied) {
    if (dozing) wake();
    else lastInteraction = Date.now();
    return;
  }
  if (!dozing && Date.now() - lastInteraction > SLEEP_AFTER_MS) {
    dozing = true;
    player.setIdle("idle-doze");
  }
  if (dozing && player.current() === "idle-doze" && Math.random() < 0.12) effect("zzz");
}

// ---------------------------------------------------------------- effects
function bump(cls) {
  stage.classList.remove("bounce", "hop", "shake", "squish");
  void stage.offsetWidth; // restart the CSS animation
  stage.classList.add(cls);
  setTimeout(() => stage.classList.remove(cls), 600);
}

function autoEffect(anim) {
  const map = {
    celebrate: "confetti", "tests-pass": "confetti", done: "sparkles", hello: "sparkles", learned: "sparkles",
    "idle-heart": "hearts", sorry: "sweat", "tool-failure": "sweat", crash: "sweat", "stop-failure": "sweat",
    "great-question": "exclaim", right: "exclaim", "thinking-aloud": "question", proceed: "question", ask: "question",
    radio: "music", dj: "music", disco: "music", "idle-doze": "zzz", interrupt: "exclaim",
  };
  return map[anim] || null;
}

function effect(kind) {
  if (!kind) return;
  const HEAD = { x: 40 * scale, y: 9 * scale }; // Clawd's head, in stage CSS px
  if (kind === "bounce" || kind === "shake") return bump(kind);
  const spawn = (n, make, spacing = 90) => {
    for (let i = 0; i < n; i++) setTimeout(make, i * spacing);
  };
  const particle = (text, color, cls = "") => {
    const el = document.createElement("div");
    el.className = "p " + cls;
    el.textContent = text;
    el.style.color = color;
    el.style.left = HEAD.x - 8 + (Math.random() * 60 - 30) + "px";
    el.style.top = HEAD.y + (Math.random() * 10 - 5) + "px";
    el.style.setProperty("--dx", Math.random() * 40 - 20 + "px");
    fx.append(el);
    el.addEventListener("animationend", () => el.remove());
    return el;
  };
  switch (kind) {
    case "hearts": return spawn(6, () => particle("♥", Math.random() < 0.5 ? "#f0a0b4" : "#dc5050"), 140);
    case "sparkles": return spawn(7, () => particle(Math.random() < 0.5 ? "✦" : "✧", Math.random() < 0.5 ? "#f0c850" : "#fff"), 80);
    case "music": return spawn(5, () => particle(Math.random() < 0.5 ? "♪" : "♫", ["#a064c8", "#a0c8f0", "#f0c850"][Math.floor(Math.random() * 3)]), 220);
    case "question": return particle("?", "#a0c8f0");
    case "exclaim": return particle("!", "#f0c850");
    case "zzz": return spawn(3, () => particle("z", "#a0c8f0"), 350);
    case "sweat": return spawn(3, () => {
      const el = particle("💧", "#a0c8f0", "drop");
      el.style.fontSize = "12px";
    }, 160);
    case "confetti": {
      const colors = ["#d4845a", "#f0c850", "#50b464", "#a0c8f0", "#f0a0b4", "#a064c8"];
      for (let i = 0; i < 36; i++) {
        const el = document.createElement("div");
        el.className = "p confetti";
        el.style.background = colors[i % colors.length];
        el.style.left = HEAD.x + "px";
        el.style.top = HEAD.y + 10 + "px";
        const ang = Math.random() * Math.PI * 2;
        const dist = 60 + Math.random() * 90;
        el.style.setProperty("--dx", Math.cos(ang) * dist + "px");
        el.style.setProperty("--dy", Math.sin(ang) * dist * 0.7 - 30 + "px");
        el.style.animationDelay = Math.random() * 120 + "ms";
        fx.append(el);
        el.addEventListener("animationend", () => el.remove());
      }
      bump("bounce");
    }
  }
}
