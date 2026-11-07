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
> that can reach the bridge can run shell commands as you. The bridge listens on loopback only by
> default. Read [Security](#security) before changing that.

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

3. Register a project, either with any client (`/register my-app /abs/path/to/my-app My App`) or
   with curl:

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
| `BRIDGE_TOKEN` | (env only) | unset | If set, every route except `/health` needs `Authorization: Bearer <token>` |
| `MUSE_PATH` | `--muse-path` | `~/.local/bin/muse`, else `muse` | The Muse Code executable |
| `MUSE_BRIDGE_HOME` | `--home` | `~/.muse-bridge` | State directory (usage snapshot) |
| `MUSE_BRIDGE_PROJECTS_DIR` | `--projects-dir` | `~/.muse-bridge/projects` | One `<slug>.md` file per project |
| `MUSE_BRIDGE_SENDER` | `--sender` | `user` | Sender name used when a request has no `trigger.sender` |
| `MUSE_BRIDGE_CRON` | `--no-cron` | on | Hourly auto-decide job (see below). `0` disables it |
| `MUSE_ENV_PASSTHROUGH` | (env only) | empty | Comma-separated secret-looking variables to pass to `muse` anyway (e.g. `GH_TOKEN`) |
| `BRIDGE_ORIGINS` | (env only) | empty | Browser origins allowed to call the bridge. Requests with any other `Origin` header get 403 |
| `MAX_RPM` | (env only) | `60` | Requests per minute across `/ask` and `/ask/stream` |
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
---
```

Registering also adds `.muse-bridge/` to the project's `.gitignore`. The agent is asked to keep
decision notes in `.muse-bridge/PROJECT_DECISIONS.md` there.

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
| `message` | `text`, `parentId?` | Agent text (markdown). With `parentId`, a subagent is speaking |
| `tool` | `name`, `detail`, `id?`, `parentId` | A tool call: `Bash`, `Read`, `Write`, `Edit`, `Grep`, `WebSearch`, `WebFetch`, `TodoWrite` (detail is `{"todos":[…]}` JSON), MCP tools, and `Agent` (a subagent started; `id` is its id) |
| `agent_done` | `id`, `status` | A subagent ended: `completed`, `failed`, `stopped` or `abandoned` |
| `done` | `response`, `singleShot`, `projectDirectory`, `parked` | Final reply. `singleShot: true` means nothing was streamed as `message` (e.g. a command reply), so show `response`. `parked: true` means the message was queued behind a running turn |
| `error` | `error` | The turn failed (`Stopped by user 🛑` after `/stop`) |
| `aborted` | | The turn's process was terminated unexpectedly |

`POST /ask` takes the same body and returns `{"response": "…", "timestamp": "…"}` when the turn is
finished.

### `GET /runs/:id/events?after=<seq>` (SSE)

Resumes a stream that dropped (for example after the headset slept): it replays every event after
`seq`, then continues live until `done`, `error` or `aborted`. Runs are kept in memory for one hour
after they finish. An unknown or expired run returns 404.

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

## Connecting from a Quest (Agent Huddle)

Keep the bridge on loopback and tunnel the headset's localhost to it over USB:

```sh
adb reverse tcp:3141 tcp:3141
```

The app then calls `http://127.0.0.1:3141` on the device and reaches the bridge on your computer.
Run the command again after reconnecting the headset. On Android, plain HTTP to localhost has to be
allowed, for example with a network security config limited to `127.0.0.1`.

In VR: `GET /projects` is the agent list. `POST /ask/stream` with
`"originalMessage": "/<slug> <text>"` sends a turn (no prefix is needed). `run`, `message`,
`tool`, `agent_done`, `done` and `error` drive the avatars. `GET /runs/:id/events` resumes after
the headset sleeps, `POST /stop` is the stop gesture, and `GET /health` is the connection
indicator.

## Security

- **Agents run with `--yolo`:** every shell command, file write and web request they choose runs
  without asking. A request to `/ask` can run arbitrary commands as your user.
- **Loopback only by default** (`127.0.0.1` and `::1`). The bridge refuses to start on any other
  interface unless `BRIDGE_TOKEN` is set.
- **Never expose the bridge without a token and TLS.** If you need it beyond this machine, prefer
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

None of this is implemented yet.

- **`GET /agents`:** every project's state in one call (busy or idle, last decision and rating,
  last activity), plus optional `avatar`, `color` and `voice` fields in the project file.
- **One live feed for all agents:** for example `GET /events?client=vr` or a WebSocket, carrying
  every run's events tagged `{slug, runId}`, including cron auto-decide turns. Today a client only
  sees the runs it started itself, plus broadcast messages.
- **Plain speech text:** a markup-free `speech` field on `message` and `done` (no markdown, emoji
  or code), for text-to-speech.
- **Structured `done`:** `decision` and `rating` as fields on `done`, not only inside the
  response text.
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
