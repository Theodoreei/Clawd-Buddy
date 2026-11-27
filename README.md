# Clawd Buddy

An animated pixel Clawd who lives in a see-through, always-on-top window on your Mac.
Chat with him and he does real tasks on your computer with the Claude API, acting out everything
he's doing with the [MyClawd](https://codechrisb.github.io/MyClawd/) animations. He can also work in
Slack and other apps, and hand coding jobs to Claude Code.

## Install (macOS)

Needs [Node.js](https://nodejs.org) 20+ and an [Anthropic API key](https://console.anthropic.com/settings/keys).

```bash
git clone https://github.com/Theodoreei/Clawd-Buddy.git
cd Clawd-Buddy
npm install
npm run build-app
```

`build-app` draws the icon, packages **Clawd Buddy.app**, signs it for your Mac and installs it in
`/Applications`. Open it from Launchpad or Spotlight. Clawd lives in the menu bar; opening the app
again while he's running just opens his chat box.

For development, `npm start` runs it from source.

The first time, Clawd asks for your API key. It's stored encrypted with the macOS Keychain in
`~/Library/Application Support/clawd-buddy/settings.json`, never in this folder.

## Using Clawd

| Do this | And Clawd… |
|---|---|
| Click Clawd, or press **⌘⇧Space** | opens the chat box |
| Right-click Clawd or the menu-bar icon | menu: companion, model, size, new chat, stop… |
| **⌘,** or ask "open your settings" | opens the companion app |
| Click 3× quickly | gets petted (hearts, dances, confetti) |
| Drag Clawd | gets carried (falls through the clouds) and bounces when dropped; near the top of the screen his speech bubble flips below him |
| **Esc** | stops the current task |
| **⌘N** | new chat |
| **⌘+ / ⌘−**, pinch on the trackpad | makes Clawd bigger or smaller |
| Ask "switch to Sonnet" | changes which Claude model powers him |
| × on his speech bubble | dismisses it |

Clicks go straight through the clear parts of his window to whatever is behind it.
With nothing to do, he falls asleep; anything you ask wakes him up.

## Two brains: API key or your Claude account

Right-click Clawd › **Brain** (or the companion's General page) to choose how he thinks:

- **Claude API (API key):** uses your Anthropic API key and API billing. All of Clawd's own tools
  work, including Slack and model switching by asking.
- **Claude account (via Claude Code):** Clawd thinks through your installed
  [Claude Code](https://code.claude.com/docs/en/quickstart), signed in with your Claude account, so
  it uses your Claude plan instead of an API key. Anything risky Claude Code wants to do still comes
  to Clawd's Allow / Deny bubble. App servers from the companion are passed along; Slack isn't
  available in this mode.

### Continue your Claude chats

Right-click Clawd › **Continue a Claude chat** (or the companion's **Claude chats** page) lists your
recent chats from the Claude app's **Code** tab and from Claude Code, with the same titles as in the
app. Pick one and Clawd picks up where it left off, in that chat's project folder. He continues it
in a copy (`--fork-session`), so the original chat is never changed.

Conversations from the Claude app's **Chat** tab are stored on Anthropic's servers and apps can't
read them, so only Code-tab and Claude Code chats are listed.

## The companion app

Right-click Clawd › **Open Companion…**, press **⌘,**, or ask him to open it.
(`open -a "Clawd Buddy" --args --companion` works too.)

- **General:** model, size, auto-approve, open at login.
- **API key:** change, test or remove your Anthropic API key.
- **Connections:**
  - **GitHub:** click **Use my GitHub CLI sign-in** (if you've run `gh auth login`) or paste a
    personal access token. Clawd can browse repos and code, and work with issues, pull requests and
    Actions through GitHub's official MCP server.
  - **Linear:** paste a personal API key. Clawd can search, read, create and update issues,
    projects, cycles and comments through Linear's official MCP server.
  - GitHub and Linear each have a **Read-only** switch. With the Claude API brain, Clawd says what
    he'll change and waits for your OK in the chat; with the Claude account brain, each change comes
    to his Allow / Deny bubble.
  - **Notification summaries** (off until you turn them on, on each card):
    - **Slack › Summarize new messages:** when someone DMs you (and, optionally, @mentions you in a
      channel), Clawd wakes up, plays a reaction and sums it up in his bubble with links to open each
      message. Checks every minute; needs a Slack **User** token with `search:read`.
    - **Linear › Tell me about new assignments:** when an issue is assigned to you, Clawd sums it up
      with a link to the issue. Checks every 2 minutes.
    - Summaries use whichever brain you picked; they're separate from your chat with Clawd. If
      he's busy with a task, they wait until he's done.
  - **Slack:** paste a Slack token (setup steps are in the app). Clawd can list channels, read and
    search messages, and send messages. He always asks before sending.
  - **Other apps (MCP servers):** add any remote MCP server by URL (and token if it needs one), such as
    Notion, Asana, Atlassian or Sentry. Claude calls these servers directly through the
    API's MCP connector, so their actions run without Clawd asking first: only add apps you trust.
- **Claude Code:** let Clawd hand coding jobs (build an app, fix a bug, run tests) to
  [Claude Code](https://code.claude.com/docs/en/quickstart). Pick a projects folder and how much it may
  do on its own: *Edit files*, *Auto* or *Plan only*. Clawd asks before starting each job, and acts
  out what Claude Code is doing (writing, reading, testing, spawning agents…) while it works.
  Claude Code uses its own sign-in, not Clawd's key.

## What Clawd can do

- **Shell commands** in a persistent bash session (`open`, `osascript`, `mdfind`, git, brew…).
  He asks before every command: **Allow**, **Allow all this chat**, or **Deny**. *Auto-approve*
  skips the questions (use with care).
- **Screenshots**, so he can see your screen (asks first; macOS asks you to allow Screen Recording
  the first time).
- **Web search and fetch.**
- **Slack, other apps and Claude Code**, once you connect them in the companion.

## How he's expressive

- **What he's doing:** each kind of task has its own animation. Thinking (and "Hmm, let me think"
  when it takes a while), writing code, reading, searching, git commit/push/PR, code review, tests,
  builds, deploys, containers, databases, downloads, docs, video, PDFs, spreadsheets, Slack,
  waiting for permission, handing off to Claude Code…
- **How it went:** passing tests get confetti, failing ones a bug hunt; broken builds sweat; merge
  conflicts, errors, being offline or rate-limited all have their own reactions.
- **His own reactions:** Claude writes tags like `[[celebrate:confetti]]` or `[[sorry:sweat]]` in
  its reply to act things out. All 129 MyClawd sets are available, plus particles (hearts, sparkles,
  confetti, ?, !, zzz, sweat, music) and squash/hop/shake motion.
- **Sleep:** after a few quiet seconds he dozes off and snores; the animation's ending is his
  wake-up stretch.

## Models

Defaults to Claude Opus 5.5. Ask Clawd to switch, or pick one in the companion:

| Model | Good for |
|---|---|
| Opus 5.5 (default) | smart all-rounder |
| Sonnet 5.5 | fast and capable, cheaper |
| Haiku 5.5 | fastest and cheapest |
| Fable 5.2 | most capable, priciest |

All use adaptive thinking (summarized thoughts show in the bubble) and prompt caching; Opus,
Sonnet and Fable also get server-side refusal fallbacks. Per-model settings are in the `MODELS`
table in `src/agent.js`.

## Files

```
src/main.js              windows, menu-bar icon, settings, IPC (Electron main process)
src/agent.js             the Claude tool-use loop, tools, and which animation goes with each task
src/integrations.js      Slack and Claude Code (as a coding tool)
src/cc-brain.js          the "Claude account" brain: Clawd thinking through Claude Code
src/claude-chats.js      lists the Claude Code chats saved on this Mac
src/watchers.js          checks Slack and Linear for new messages and assignments
src/shell.js             persistent bash session
src/renderer/            Clawd's window: player.js (GIF clip player), renderer.js (UI and personality)
src/companion/           the companion app
assets/sets/             MyClawd GIFs (enter / loop / exit per set)
assets/sets.json         set timings and descriptions
scripts/build-app.sh     packages and installs Clawd Buddy.app
```

## Credits

Animations: [MyClawd](https://github.com/CodeChrisB/MyClawd) by CodeChrisB, a fan project whose
GIFs are free to use for fun and non-commercial projects. Clawd, Claude and Claude Code are
Anthropic's names and marks; Clawd Buddy is an unofficial, non-commercial fan project.
