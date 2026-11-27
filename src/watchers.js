// Background watchers: new Slack DMs/@mentions and newly assigned Linear issues.
// They only collect new items; main.js has Clawd summarize them in his bubble.

const SLACK_API = process.env.CLAWD_SLACK_API || "https://slack.com/api";
const LINEAR_API = process.env.CLAWD_LINEAR_API || "https://api.linear.app/graphql";
const SLACK_EVERY_MS = 60 * 1000;
const LINEAR_EVERY_MS = 2 * 60 * 1000;
const MAX_REMEMBERED = 400;

async function slack(token, method, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined) body.set(k, String(v));
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (res.status === 429) throw Object.assign(new Error("Slack is rate limiting; I'll try again shortly."), { retryAfter: Number(res.headers.get("retry-after")) || 60 });
  const data = await res.json();
  if (!data.ok) {
    const e = data.error;
    const msg =
      e === "missing_scope" ? `Slack token is missing the "${data.needed}" scope. Add it (as a User Token Scope) and reinstall your Slack app.` :
      e === "not_allowed_token_type" ? "Notifications need a Slack User token (xoxp-…), not a bot token." :
      e === "invalid_auth" || e === "token_revoked" ? "Slack token no longer works. Reconnect Slack." :
      `Slack: ${e}`;
    throw new Error(msg);
  }
  return data;
}

class SlackWatcher {
  constructor({ token, state, includeMentions }) {
    this.token = token;
    this.state = state; // persisted: {since, seen: []}
    this.includeMentions = includeMentions;
    this.userId = null;
  }

  async poll() {
    if (!this.userId) this.userId = (await slack(this.token, "auth.test")).user_id;
    const first = !this.state.since;
    const queries = ["to:me"]; // direct messages and group DMs sent to you
    if (this.includeMentions) queries.push(`<@${this.userId}>`); // @mentions of you
    const seen = new Set(this.state.seen || []);
    // Search can index a message a little late, so look back a bit and rely on `seen` to dedupe.
    const since = (Number(this.state.since) || Date.now() / 1000) - 300;
    let newest = Number(this.state.since) || Date.now() / 1000;
    const found = [];
    for (const query of queries) {
      const d = await slack(this.token, "search.messages", { query, sort: "timestamp", sort_dir: "desc", count: 20 });
      for (const m of (d.messages && d.messages.matches) || []) {
        const ts = Number(m.ts);
        const key = `${m.channel && m.channel.id}:${m.ts}`;
        newest = Math.max(newest, ts);
        if (seen.has(key) || ts <= since || m.user === this.userId) continue;
        if (query !== "to:me" && !String(m.text || "").includes(`<@${this.userId}>`)) continue;
        seen.add(key);
        const ch = m.channel || {};
        found.push({
          key,
          ts,
          from: m.username || m.user || "someone",
          where: ch.is_im ? "a direct message" : ch.is_mpim ? "a group DM" : ch.name ? `#${ch.name}` : "Slack",
          text: String(m.text || "").slice(0, 1500),
          link: m.permalink || null,
          kind: query === "to:me" ? "dm" : "mention",
        });
      }
    }
    this.state.since = String(newest);
    this.state.seen = [...seen].slice(-MAX_REMEMBERED);
    // The first check only sets the starting point, so you aren't flooded with old messages.
    if (first) return [];
    const byKey = new Map(found.map((f) => [f.key, f]));
    return [...byKey.values()].sort((a, b) => a.ts - b.ts);
  }
}

async function linear(token, query) {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: { Authorization: token.startsWith("lin_oauth_") ? `Bearer ${token}` : token, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 400 && /auth/i.test(JSON.stringify(data.errors || ""))) throw new Error("Linear key no longer works. Reconnect Linear.");
  if (!res.ok || data.errors) throw new Error(`Linear: ${(data.errors && data.errors[0] && data.errors[0].message) || res.status}`);
  return data.data;
}

class LinearWatcher {
  constructor({ token, state }) {
    this.token = token;
    this.state = state; // persisted: {known: [issue ids], seeded: bool}
  }

  async poll() {
    const d = await linear(
      this.token,
      `{ viewer { assignedIssues(first: 40, orderBy: updatedAt) { nodes {
          id identifier title url priorityLabel dueDate description
          state { name type } team { name } creator { name }
        } } } }`
    );
    const nodes = d.viewer.assignedIssues.nodes || [];
    const known = new Set(this.state.known || []);
    const fresh = nodes.filter((n) => !known.has(n.id) && !["completed", "canceled"].includes(n.state && n.state.type));
    for (const n of nodes) known.add(n.id);
    this.state.known = [...known].slice(-MAX_REMEMBERED);
    // First check: remember what's already assigned, report nothing.
    if (!this.state.seeded) {
      this.state.seeded = true;
      return [];
    }
    return fresh.map((n) => ({
      key: n.id,
      id: n.identifier,
      title: n.title,
      link: n.url,
      team: n.team && n.team.name,
      from: n.creator && n.creator.name,
      priority: n.priorityLabel,
      due: n.dueDate,
      state: n.state && n.state.name,
      text: String(n.description || "").slice(0, 1200),
    }));
  }
}

/**
 * Runs the enabled watchers on timers.
 * opts.config() -> {slack: {token, includeMentions} | null, linear: {token} | null}
 * opts.state(name) -> persisted state object for that watcher; opts.save() persists it
 * opts.onItems(name, items); opts.onStatus(name, {ok, at, error, items})
 */
class Watchers {
  constructor(opts) {
    this.opts = opts;
    this.timers = {};
    this.watchers = {};
    this.status = {};
  }

  restart() {
    for (const t of Object.values(this.timers)) clearTimeout(t);
    this.timers = {};
    this.watchers = {};
    const cfg = this.opts.config();
    if (cfg.slack) this.start("slack", new SlackWatcher({ ...cfg.slack, state: this.opts.state("slack") }), SLACK_EVERY_MS);
    else this.status.slack = null;
    if (cfg.linear) this.start("linear", new LinearWatcher({ ...cfg.linear, state: this.opts.state("linear") }), LINEAR_EVERY_MS);
    else this.status.linear = null;
    this.opts.onStatus();
  }

  start(name, watcher, every) {
    this.watchers[name] = watcher;
    const tick = async () => {
      if (this.watchers[name] !== watcher) return; // restarted since
      let wait = every;
      try {
        const items = await watcher.poll();
        this.opts.save();
        this.status[name] = { ok: true, at: Date.now(), found: (this.status[name] && this.status[name].found || 0) + items.length };
        if (items.length) this.opts.onItems(name, items);
      } catch (err) {
        this.status[name] = { ok: false, at: Date.now(), error: err.message };
        if (err.retryAfter) wait = Math.max(every, err.retryAfter * 1000);
        else wait = every * 3; // back off on errors
      }
      this.opts.onStatus();
      if (this.watchers[name] === watcher) this.timers[name] = setTimeout(tick, wait);
    };
    this.timers[name] = setTimeout(tick, 3000);
  }

  stop() {
    for (const t of Object.values(this.timers)) clearTimeout(t);
    this.timers = {};
    this.watchers = {};
  }
}

module.exports = { Watchers, SlackWatcher, LinearWatcher };
