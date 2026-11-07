# muse-bridge

A small HTTP + Server-Sent Events server that drives [Muse Code](https://dev.meta.ai/products/muse-code)
(Meta's coding CLI, `muse`) on your machine, one persistent session per project.

A client (a chat bot, a script, or a VR app such as **Agent Huddle** on Quest) sends
`/<project> <message>`. The bridge runs a `muse exec --json` turn in that project's directory
and streams back everything the agent does: what it says, each tool call, subagents starting and
finishing, and the final reply with a structured next-step decision.

Muse does not keep a connection open. Each turn is a one-shot `muse exec` subprocess, resumed with
a stable `--session-id` per project, so the conversation continues across turns and bridge
restarts.

> **Security first.** Agents run with every action pre-approved (`muse exec --yolo`). Anything
> that can reach the bridge can run shell commands as you. By default the bridge listens on
> loopback and, for [pairing](#pairing-a-headset-lan--qr-code) a headset, on your private LAN
> addresses, where every request needs the pairing token. `--no-pair` keeps it on loopback only.
> Read [Security](#security).

## Install

1. Install Muse Code from <https://dev.meta.ai/products/muse-code> and sign in, so that `muse`
   works in a terminal (`muse --version`). The installer puts it in `~/.local/bin/muse`, which the
   bridge finds automatically. Otherwise it uses `muse` from `PATH`, or `MUSE_PATH`.
2. Run the bridge (Node.js 18.18 or newer):

   ```sh
   npx muse-bridge
   # or
   npm install -g muse-bridge
   muse-bridge
   ```

   From a checkout: `npm install && npm run build && npm start`, or `npm run dev` (tsx, no build).

   On start it prints a QR code to pair a headset over Wi-Fi
   ([Pairing](#pairing-a-headset-lan--qr-code)) and, shortly after, your most recently edited
   projects as suggestions ([Project suggestions](#project-suggestions)).

3. Accept a suggestion (from the headset, or
   `curl -X POST localhost:3141/suggestions/<slug>/accept`), or register a project, either with
   any client (`/register my-app /abs/path/to/my-app My App`) or with curl:

   ```sh
   curl -s localhost:3141/ask -H 'Content-Type: application/json' \
     -d '{"trigger":{"type":"inline","query":null,"replyTo":null,"originalMessage":"/register my-app /Users/me/code/my-app My App"}}'
   ```

## Configuration

Environment variables, overridden by command-line flags (`muse-bridge --help`):

| Variable | Flag | Default | Meaning |
|---|---|---|---|
| `PORT` | `-p, --port` | `3141` | Port |
| `BRIDGE_HOSTS` | `-H, --host` (repeatable) | `127.0.0.1,::1` | Interfaces to listen on. A non-loopback host is refused unless `BRIDGE_TOKEN` is set |
| `BRIDGE_TOKEN` | (env only) | unset | If set, every route except `/health` needs `Authorization: Bearer <token>`, from loopback too. With pairing on, it is also the pairing token |
| `MUSE_BRIDGE_PAIR` | `--no-pair` | on | [Pairing](#pairing-a-headset-lan--qr-code): also listen on private LAN addresses (pairing token required there) and show a QR code. `0` = loopback only |
| (flag only) | `--reset-pairing` | | Rotate the pairing token, unpairing every device |
| `MUSE_BRIDGE_DISCOVER` | `--no-discover` | on | [Project suggestions](#project-suggestions) at startup. `0` disables them |
| `MUSE_BRIDGE_SCAN_ROOTS` | `--scan-root` (repeatable) | see below | Folders to scan for projects (comma- or colon-separated) |
| `MUSE_PATH` | `--muse-path` | `~/.local/bin/muse`, else `muse` | The Muse Code executable |
| `MUSE_BRIDGE_HOME` | `--home` | `~/.muse-bridge` | State directory (usage snapshot, `pairing.json`) |
| `MUSE_BRIDGE_PROJECTS_DIR` | `--projects-dir` | `~/.muse-bridge/projects` | One `<slug>.md` file per project |
| `MUSE_BRIDGE_SENDER` | `--sender` | `user` | Sender name used when a request has no `trigger.sender` |
| `MUSE_BRIDGE_CRON` | `--no-cron` | on | Hourly auto-decide job (see below). `0` disables it |
| `MUSE_ENV_PASSTHROUGH` | (env only) | empty | Comma-separated secret-looking variables to pass to `muse` anyway (e.g. `GH_TOKEN`) |
| `BRIDGE_ORIGINS` | (env only) | empty | Browser origins allowed to call the bridge. Requests with any other `Origin` header get 403 |
| `MAX_RPM` | (env only) | `60` | Requests per minute across `/ask`, `/ask/stream` and `POST /agents/:slug/ask` |
| `AUTO_DECIDE_TIMEOUT_MS` | (env only) | `3600000` | Cap on one cron auto-decide turn |
| `DEBUG` | (env only) | empty | `1` or comma-separated scopes (`ask`) for verbose logs |

The bridge doesn't read `.env` files. Use your shell, a process manager, or
`node --env-file=.env $(which muse-bridge)` on Node 20.6 and newer.

### Project files

Each project is a Markdown file with YAML front matter in the projects directory. `/register`
creates it, and you can edit it by hand:

```yaml
---
title: My App
slug: my-app
description: ''
directory: /Users/me/code/my-app   # Muse's workspace (absolute path)
autoDecide: false                  # let the hourly cron answer pending decisions
sessionId: 0b7c…                   # Muse session id, set on the first turn
status: Awaiting first message
decision: null
createdAt: '2026-11-07T11:43:42.224Z'
# Optional, for VR clients (GET /agents). Add them by hand:
avatar: robot-02                   # an avatar id or URL the client understands
color: '#4caf50'
voice: en-US-Neural2-F             # a text-to-speech voice name
---
```

Registering also adds `.muse-bridge/` to the project's `.gitignore`. The agent is asked to keep
decision notes in `.muse-bridge/PROJECT_DECISIONS.md` there.

## Pairing a headset (LAN + QR code)

Pairing is on by default, so a Quest on the same Wi-Fi can connect without a cable:

1. Besides loopback, the bridge listens on each **private LAN IPv4 address** of this machine
   (10/8, 172.16/12, 192.168/16), never on `0.0.0.0`. Loopback-only, link-local and VPN or virtual
   interfaces (`utun`, `tun`, `wg`, `tailscale`, `docker`, `bridge`, `awdl`, `feth`, …) are
   skipped.
2. It keeps a **pairing token** (128 random bits, base64url) in `~/.muse-bridge/pairing.json`
   (mode 0600), so a paired headset stays paired across restarts. `muse-bridge --reset-pairing`
   rotates it. If `BRIDGE_TOKEN` is set, that is the pairing token.
3. After the "Listening" lines it prints a **QR code** with the caption *"Scan with Monkey Agents
   on your Quest to connect (same Wi-Fi). Pairing token stays on this machine; anyone who scans
   this code can run agents as you."* The same code is at `http://localhost:3141/pair`.

The QR payload is short (QR version 10 or less):

```
musebridge://pair?u=http%3A%2F%2F192.168.1.20%3A3141&u=http%3A%2F%2F10.0.0.7%3A3141&t=<token>&n=my-mac
```

- `u`: a base URL, URL-encoded, once per LAN address, best first (the primary Wi-Fi/Ethernet
  interface, such as `en0`, `eth0` or `wlan0`, comes first). Try them in order.
- `t`: the pairing token. Send it as `Authorization: Bearer <t>` on every request.
- `n`: the machine's short hostname, for display.

**Auth rules:**

| Request from | Needs |
|---|---|
| Loopback (`127.0.0.1`, `::1`) | Nothing, or `BRIDGE_TOKEN` when it is set (as before) |
| Any other address (the LAN) | `Authorization: Bearer <pairing token>` (or `BRIDGE_TOKEN`), always. 401 otherwise; 403 when pairing is off and there's no `BRIDGE_TOKEN` |
| `GET /health` | Nothing, from anywhere (the connection indicator) |

Tokens are compared in constant time. `BRIDGE_ORIGINS` and `MAX_RPM` apply as before.

**The trade-off:** the LAN listeners use plain HTTP. Anyone on the network who gets the token
(by scanning the code, seeing your screen, or sniffing the Wi-Fi traffic) can run agents with
every action pre-approved, as you. Pair only on a Wi-Fi you trust, rotate with `--reset-pairing`
if the code leaked, and use `--no-pair` (or `MUSE_BRIDGE_PAIR=0`) to keep the bridge on loopback,
with `adb reverse` over USB instead ([below](#connecting-from-a-quest)). The LAN addresses are
read at startup: restart the bridge after switching networks.

### `GET /pair`, `GET /pair.json`

Only for a browser or script on this machine: they answer only to loopback clients that use a
loopback `Host` (`localhost`, `127.0.0.1`, `[::1]`), and are 403 from the LAN, even with the token
(this also stops DNS-rebinding pages from reading the token). With `BRIDGE_TOKEN` set they need it
like any loopback request. They are 404 when pairing is off or no LAN address was found.

- `GET /pair`: an HTML page with the QR code as inline SVG, the caption and the addresses.
- `GET /pair.json`:

  ```json
  {"payload":"musebridge://pair?u=http%3A%2F%2F192.168.1.20%3A3141&t=…&n=my-mac","urls":["http://192.168.1.20:3141"],"hostname":"my-mac"}
  ```

## Project suggestions

At startup, while the bridge binds its ports, it looks for the projects you edited most
recently and suggests them as agents. Nothing is registered until you accept one.

1. **Scan** (usually well under a second, capped at about 4 s): the folders in
   `MUSE_BRIDGE_SCAN_ROOTS` / `--scan-root`, else those of `~/Projects`, `~/projects`, `~/code`,
   `~/Code`, `~/src`, `~/dev`, `~/Developer`, `~/repos`, `~/workspace` and `~/Documents/GitHub`
   that exist, else `~` itself (2 levels deep). A project is a directory up to 3 levels down with
   `.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, a `*.sln` or a Unity
   `ProjectSettings` folder. Hidden folders and `node_modules`, `Library`, `Temp`, `build`,
   `dist`, `.venv`, `vendor`, `Pods`, `DerivedData` (and similar) are skipped. For the most recent
   candidates it walks at most 2000 entries each to find the newest files. Registered directories
   are left out; the 8 newest are kept.
2. **Rank:** one `muse exec --json` turn **without `--yolo`**, with shell, writes and web tools
   disabled, in an empty temporary workspace. The prompt carries everything Muse needs (name,
   path, last edit, recent files, the first 400 characters of the README). Muse picks up to 5 and
   writes one line about what seems to be in progress. Its answer is validated: the directory
   must be one of the candidates, and a slug that is invalid, reserved, taken or repeated is
   replaced. If Muse fails, takes more than 90 s or answers something unusable, the scan's order
   is used, with reasons like `Edited 12 min ago: src/app.ts, README.md`.
3. The terminal prints the list with a `curl` line to accept one.

The state goes `idle` → `scanning` → `ranking` → `ready` (or `failed`). Dismissed suggestions stay
hidden until the bridge restarts. `--no-discover` / `MUSE_BRIDGE_DISCOVER=0` turns all of this off.

### `GET /suggestions`

```json
{
  "state": "ready",
  "updatedAt": "2026-11-08T09:12:03.120Z",
  "enabled": true,
  "items": [{
    "slug": "todo-api", "title": "Todo API", "directory": "/Users/me/code/todo-api",
    "reason": "Adding pagination to the users endpoint",
    "lastModified": "2026-11-08T09:00:41.000Z",
    "recentFiles": ["src/routes/users.ts", "src/server.ts", "README.md"]
  }]
}
```

`enabled` is `false` with `--no-discover`. In state `failed` there is also an `error` string.

### `POST /suggestions/:slug/accept`

Registers the project exactly as `/register <slug> <directory> <title>` does, removes it from the
suggestions and returns `{"agent": {…}}`, the new agent in the same shape as an item of
`GET /agents`. 404 for an unknown suggestion, 409 if the slug was registered meanwhile, 400 if the
directory is gone. A feed `agents_changed` event follows.

### `POST /suggestions/:slug/dismiss`, `POST /suggestions/refresh`

`dismiss` removes a suggestion (`{"status":"ok"}`, 404 if unknown). `refresh` re-runs discovery
and returns **202** with the current state (409 with `--no-discover`); a refresh already running is
joined, not restarted.

## How a turn works

Every project turn asks Muse to answer in a JSON envelope:

```json
{"tldr": "…", "other_findings": "…", "assumptions_made": "…", "decision": "what to do next", "rating": 0}
```

The bridge strips the envelope for display (`# TLDR`, `# Other Findings`, `# Assumptions Made`)
and uses `decision` / `rating` (0-10):

- **0:** a trivial continuation. The bridge continues on its own ("make an informed decision for
  me"), up to 30 laps, with a stall detector and a kill switch.
- **1-9:** waits for you. The deadline is `2 × rating − 1` active hours (9:00-21:00 local). After
  it passes, the hourly cron auto-decides, but only for projects with `autoDecide: true`, and not
  in `/vacation` mode. A question-shaped decision first gets a pros/cons check. If the agent
  finds no real cons, it continues by itself.
- **10:** always waits for you.

An exchange that needed several round-trips ends with one summary turn. In a message,
`For later: …` or `Continuation: …` queue a task behind a running turn instead of interrupting it,
and `Effort: low|medium|high|xhigh|max` sets `muse exec --reasoning-effort` for that turn.

Chat commands: `/<slug> <message>`, `/list`, `/details [slug]`,
`/register <slug> <absolute-dir> [title]`, `/reset <slug>`, `/nudge <slug>`, `/vacation`,
`/unvacation`, `/auto-decide-extend [slug]`, `/help`.

## HTTP / SSE API

All bodies are JSON. With `BRIDGE_TOKEN` set, send `Authorization: Bearer <token>` (except for
`/health`).

### `GET /health`

```json
{"status":"ok","timestamp":"…","uptime":12345,"stats":{"requestsServed":3,"avgResponseMs":0,"lastError":null}}
```

### `GET /projects`

```json
{"slugs":["my-app","site"],"commands":["list","details","info","register","reset","nudge","vacation","unvacation","auto-decide-extend","help"]}
```

### `POST /ask/stream` (SSE)

Body:

```json
{
  "trigger": {
    "type": "inline",
    "query": null,
    "sender": "pilot",
    "replyTo": null,
    "originalMessage": "/my-app add a jump button"
  },
  "recentMessages": [],
  "repliedToMessage": null
}
```

`originalMessage` is the whole command line: `/<slug> <text>` goes straight to that project's
Muse session. `sender` is optional. `recentMessages` and `repliedToMessage` are accepted for
compatibility and are not used by project turns.

The response is `text/event-stream`. Each event has an `id:` (its sequence number in the run) and
a JSON `data:` line. Comment lines (`: heartbeat`) arrive every 30 s.

| `type` | Fields | Meaning |
|---|---|---|
| `run` | `runId` | First event. Keep `runId` for resuming |
| `meta` | `projectDirectory` | The project's directory |
| `final_prompt` | `text` | The exact prompt sent to Muse (shown again for follow-up prompts) |
| `cli_params` | `text` | The `muse exec …` flags of each spawn (prompt hidden) |
| `message` | `text`, `speech`, `parentId?` | Agent text (markdown) and its [`speech`](#speech) form. With `parentId`, a subagent is speaking |
| `tool` | `name`, `detail`, `id?`, `parentId` | A tool call: `Bash`, `Read`, `Write`, `Edit`, `Grep`, `WebSearch`, `WebFetch`, `TodoWrite` (detail is `{"todos":[…]}` JSON), MCP tools, and `Agent` (a subagent started; `id` is its id) |
| `agent_done` | `id`, `status` | A subagent ended: `completed`, `failed`, `stopped` or `abandoned` |
| `done` | `response`, `speech`, `decision`, `rating`, `singleShot`, `projectDirectory`, `parked` | Final reply. `decision` (string) and `rating` (0-10) come from the last reply's JSON envelope, both `null` when it had none. `singleShot: true` means nothing was streamed as `message` (e.g. a command reply), so show `response`. `parked: true` means the message was queued behind a running turn |
| `error` | `error` | The turn failed (`Stopped by user 🛑` after `/stop`) |
| `aborted` | | The turn's process was terminated unexpectedly |

`POST /ask` takes the same body and returns `{"response": "…", "timestamp": "…"}` when the turn is
finished.

### `GET /runs/:id/events?after=<seq>` (SSE)

Resumes a stream that dropped (for example after the headset slept): it replays every event after
`seq`, then continues live until `done`, `error` or `aborted`. Runs are kept in memory for one hour
after they finish. An unknown or expired run returns 404. This works for every run id the bridge
hands out (`/ask/stream`, `POST /agents/:slug/ask`, `/ask` and cron turns of a project).

### `GET /agents`

Every registered project's state in one call, sorted by slug:

```json
{"agents":[{
  "slug":"my-app","title":"My App",
  "busy":true,"runId":"6f1c…","lastRunAt":"2026-11-07T12:01:44.000Z",
  "decision":{"text":"Use Postgres or SQLite?","rating":6,"at":"2026-11-07T11:58:10.000Z"},
  "lastSpeech":"Added the jump button and a test.",
  "avatar":"robot-02","color":"#4caf50","voice":"en-US-Neural2-F"
}]}
```

- `busy`: a turn for the agent is running or queued. `runId` is the newest such run, else `null`.
- `lastRunAt`: when the newest run started. After a bridge restart, until the next run, it is the
  project's last finished turn (`lastConversationAt`), or `null`.
- `decision`: the pending decision, that is, a reply whose JSON had rating 1 or more and that
  nobody has answered yet (the next message to the project answers it, and so does an
  auto-decide). Rating 0 never waits, so it never shows here. `at` is when the agent asked.
  Project files written before `at` existed fall back to `lastConversationAt`.
- `lastSpeech`: the `speech` of the agent's last main-session message or reply since the bridge
  started, else `null`.
- `avatar`, `color`, `voice`: copied from the [project file](#project-files), else `null`.

### `GET /feed` (SSE)

One stream for all agents. It carries the events of every project run, whoever started it:
`/ask/stream`, `/ask`, `POST /agents/:slug/ask`, `/nudge`, the hourly cron, and the
auto-continue, pros/cons and wrap-up rounds inside a turn, plus the bridge-wide `suggestions` and
`agents_changed` events. Bridge commands without a project (`/list`, `/help`, …) are not on it.

```
id: 42
data: {"seq":42,"slug":"my-app","runId":"6f1c…","type":"message","text":"# TLDR\nAdded **jump**.","speech":"Added jump.","parentId":null}
```

Each event's `id:` is its `seq`, a counter shared by all agents that only goes up. The data is
`{seq, slug, runId, type, …}`:

| `type` | Fields | Meaning |
|---|---|---|
| `run` | `source` | A run started. `source` is `ask/stream`, `ask`, `agents` or `cron` |
| `agent_state` | `busy` | Sent right after `run` (`true`) and right after the run's last event (`false`, or `true` while another run for that agent is queued) |
| `message` | `text`, `speech`, `parentId` | Agent text. `parentId` is `null` for the main session, else the subagent's id |
| `tool` | `name`, `detail`, `id`, `parentId` | A tool call, as on `/ask/stream`. `id` is `null` except for `Agent` (the subagent's id) |
| `agent_done` | `id`, `status` | A subagent ended |
| `done` | `response`, `speech`, `decision`, `rating` | The run finished. `decision` and `rating` are parsed from the reply's JSON (`{tldr, other_findings, assumptions_made, decision, rating}`), `null` if it wasn't JSON. `speech` is the `tldr`. This is the agent's own rating: the bridge may raise it before storing the decision (to 10 for a turn with no tool calls, or one that is "waiting for" something), so `GET /agents` can show a higher one |
| `error` | `error` | The run failed (`Stopped by user 🛑` after a stop) |
| `aborted` | | The run's process was terminated unexpectedly |
| `suggestions` | `state`, `updatedAt`, `enabled`, `items`, `error?` | The [suggestions](#project-suggestions) changed: the same fields as `GET /suggestions`. `slug` and `runId` are `null` |
| `agents_changed` | | A project was registered (`/register` or an accepted suggestion). Reload `GET /agents`. `slug` and `runId` are `null` |

`suggestions` and `agents_changed` are bridge-wide, not part of any run. Every run ends with exactly one of `done`, `error` or `aborted`, followed by `agent_state`. The
`/ask/stream`-only events (`meta`, `final_prompt`, `cli_params`) are not on the feed. A `run`
event's `runId` is the same id `/ask/stream` sends and `POST /agents/:slug/ask` returns.

- **Resume:** connect with `?after=<seq>` or a `Last-Event-ID: <seq>` header (what `EventSource`
  sends on reconnect) to get every buffered event after `seq` first, then the live ones. Without
  either you get live events only. Use `GET /agents` for the current state. The buffer keeps the
  last hour, up to 5000 events.
- **Bridge restarts:** `seq` starts again at 1. A cursor greater than the newest `seq` is treated
  as coming from an earlier bridge process and replays the whole buffer. A client should reset its
  cursor when it sees a `seq` lower than the last one it has.
- **Keep-alive:** a `: ping` comment on connect and every 15 s.
- `?client=<name>` is optional and only used in logs. `/feed` is not rate-limited.

### `POST /agents/:slug/ask`

```json
{"text":"add a jump button","sender":"pilot"}
```

Sends `text` to the agent as a turn (the same as `/<slug> <text>` on `/ask`) and returns at once
with **202** `{"runId":"6f1c…"}`. The run's events arrive on `GET /feed` (and on
`GET /runs/:id/events`). `sender` is optional. If the agent is busy, the turn queues behind the
running one as it would on `/ask` (or parks, for `For later: …`), and the response is
`{"runId":"…","queued":true}`. An unknown slug is 404, a missing or empty `text` is 400, and the
request counts against `MAX_RPM` (429).

### `POST /agents/:slug/stop`

The same as `POST /stop` with `{"slug":"<slug>"}`, and the same response.

### Speech

`speech` is plain text for text-to-speech and captions, on `message` and `done` events (both
`/ask/stream` and `/feed`). It drops code blocks, inline code, URLs and emoji. It keeps the text of
links and images (`[docs](https://…)` becomes `docs`) and of headings (which end a sentence). It
removes emphasis, list, quote and `-#` markers and the bridge's own `# TLDR` / `# Other Findings` /
`# Assumptions Made` labels, then collapses whitespace. For a JSON reply, the speech of `done` is the
`tldr`. Because inline code is removed, a decision notice such as ``⏳ **Decision needed (rating 3):** `pick a DB` ``
is spoken as "Decision needed (rating 3):". Read the decision text from `done.decision` or
`GET /agents`.

### `POST /stop`

`{"slug":"my-app"}`. This stops the running turn (SIGTERM to `muse` and its child processes, then
SIGKILL after 5 s). The session is kept, so the next message continues it. The response is
`{"status":"ok","stopped":true,"reason":"…"}`. Stop is never rate-limited, and stopping an idle
project still returns 200.

`POST /emergency-reset` with `{"slug":"my-app"}` stops the turn and also discards the session.

### `GET /events` (SSE)

The broadcast feed: output of cron auto-decides and `POST /notify` messages, as
`{"type":"message","text":"…","slug":"my-app","projectDirectory":"…"}`. The first event is
`{"type":"connected"}`. You can identify a client with `?client=<name>` (used for logging).

### Other endpoints

- `POST /notify` with `{"slug":"my-app","message":"Build finished"}` sends a message to the
  `/events` subscribers (404 for an unknown slug).
- `GET /usage` returns Muse token usage, `{"muse":{"lastRun":{…},"today":{…},"allowance":…}}`,
  from each run's `run.usage` event and `muse usage --json`.

## Connecting from a Quest

Over Wi-Fi: scan the QR code the bridge prints ([Pairing](#pairing-a-headset-lan--qr-code)). The
app keeps the URLs and the token, and sends `Authorization: Bearer <token>` to the first URL that
answers `GET /health`.

Over USB, with `--no-pair`: keep the bridge on loopback and tunnel the headset's localhost to it:

```sh
adb reverse tcp:3141 tcp:3141
```

The app then calls `http://127.0.0.1:3141` on the device and reaches the bridge on your computer.
Run the command again after reconnecting the headset. On Android, plain HTTP to localhost has to be
allowed, for example with a network security config limited to `127.0.0.1`.

In VR: `GET /agents` is the agent list and its state, and one `GET /feed` connection drives
every avatar (resume it with `Last-Event-ID` after the headset sleeps). `GET /suggestions` and the
`suggestions` feed event offer projects to add as agents (`POST /suggestions/:slug/accept`), and
`agents_changed` says when to reload `GET /agents`. `POST /agents/:slug/ask`
sends a turn, `POST /agents/:slug/stop` is the stop gesture, `speech` is what the avatar says, and
`GET /health` is the connection indicator. `POST /ask/stream` still works for a client that wants
one stream per turn.

## Security

- **Agents run with `--yolo`:** every shell command, file write and web request they choose runs
  without asking. A request to `/ask` can run arbitrary commands as your user.
- **Loopback, plus the LAN with a token.** Loopback (`127.0.0.1`, `::1`) behaves as it always
  did. With pairing on (the default), the bridge also listens on this machine's private LAN
  addresses, and every request from a non-loopback address needs the pairing token. That traffic
  is **plain HTTP**: anyone on the network who has the token, or can sniff it, can run agents as
  you. Use a trusted Wi-Fi, `--reset-pairing` if the code leaked, and `--no-pair` to stay on
  loopback. Explicit `--host` / `BRIDGE_HOSTS` addresses beyond loopback are still refused unless
  `BRIDGE_TOKEN` is set.
- **Discovery reads, it doesn't run.** The startup scan only lists directories and reads file
  times and README excerpts. The ranking turn runs without `--yolo`, with no tools, in an empty
  temporary workspace. Its prompt contains project names, paths, recent file names and README
  excerpts, which go to Muse like any other prompt. `--no-discover` turns it off.
- **Beyond your LAN, add TLS.** If you need the bridge beyond this machine and network, prefer
  an SSH or Tailscale tunnel, or a TLS-terminating reverse proxy with a long random
  `BRIDGE_TOKEN`. Don't put the token on the command line. Even then, treat anyone with the token
  as having shell access.
- **Browser requests are refused.** Any request with an `Origin` header not in `BRIDGE_ORIGINS`
  gets 403. This blocks web pages (and DNS rebinding) from driving the bridge through your
  browser.
- **Secrets are not passed to agents.** Variables whose names end in `_TOKEN`, `_KEY`, `_SECRET`,
  `_PASSWORD` or `_PASSWD` (including `BRIDGE_TOKEN`) are removed from the environment of spawned
  `muse` processes. `PATH`, `HOME` and the rest are kept. Use `MUSE_ENV_PASSTHROUGH` for the ones an
  agent really needs. Files on disk (`~/.ssh`, `~/.config/gh`, …) are still readable by agents.

## Roadmap for Agent Huddle

### Done

- **Wi-Fi pairing:** LAN listeners guarded by a persistent pairing token, shown as a QR code in
  the terminal and on `GET /pair`.
- **Project suggestions:** recently edited projects found at startup, ranked by a read-only Muse
  turn, accepted with `POST /suggestions/:slug/accept`; `suggestions` and `agents_changed` feed
  events.
- **`GET /agents`:** every project's state in one call (busy, run id, last run, pending decision
  and rating, last speech), plus optional `avatar`, `color` and `voice` fields in the project file.
- **One live feed for all agents:** `GET /feed` carries every run's events tagged
  `{seq, slug, runId}`, including cron auto-decide turns and auto-continue rounds, with resume.
- **Fire-and-forget turns:** `POST /agents/:slug/ask` (202 with the run id) and
  `POST /agents/:slug/stop`.
- **Plain speech text:** a markup-free `speech` field on `message` and `done` (no markdown, emoji
  or code), for text-to-speech.
- **Structured `done`:** `decision` and `rating` as fields on `done`, not only inside the
  response text.

### Next

- **Approvals via `muse serve`:** pinch-to-approve individual tool calls instead of `--yolo`, by
  driving Muse's JSON-RPC server (`approval/request`, `approval/decide`, `turn/interrupt`). It is
  undocumented and listens only on stdio or a Unix socket, so a small local relay is needed.

## Development

```sh
npm install
npm test           # vitest
npm run typecheck  # src + tests
npm run build      # dist/
npm run dev        # run from source with tsx
```

The Muse event mapping (`src/muse-events.ts`) and the session runner (`src/session-manager.ts`)
are tested against event shapes recorded from Muse Code 1.4.14 (`muse exec --json`).

## License

MIT
