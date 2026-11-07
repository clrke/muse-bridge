import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, type Config } from './config.js';
import { startServer } from './server.js';

const HELP = `muse-bridge: HTTP/SSE bridge that drives Muse Code (\`muse\`) sessions per project.

Usage: muse-bridge [options]

Options:
  -p, --port <n>          Port (env PORT, default 3141)
  -H, --host <addr>       Interface to listen on; repeat or comma-separate
                          (env BRIDGE_HOSTS, default 127.0.0.1,::1)
      --muse-path <path>  muse executable (env MUSE_PATH, default ~/.local/bin/muse or muse on PATH)
      --projects-dir <d>  Project files (env MUSE_BRIDGE_PROJECTS_DIR, default ~/.muse-bridge/projects)
      --home <dir>        State directory (env MUSE_BRIDGE_HOME, default ~/.muse-bridge)
      --sender <name>     Sender name when a client sends none (env MUSE_BRIDGE_SENDER, default "user")
      --no-cron           Disable the hourly auto-decide job (env MUSE_BRIDGE_CRON=0)
      --no-pair           Loopback only: no LAN listeners, no pairing QR (env MUSE_BRIDGE_PAIR=0)
      --reset-pairing     Rotate the pairing token, unpairing every device
      --no-discover       Don't scan for recent projects to suggest (env MUSE_BRIDGE_DISCOVER=0)
      --scan-root <dir>   Folder to scan for projects; repeatable (env MUSE_BRIDGE_SCAN_ROOTS,
                          comma/colon list; default ~/Projects, ~/code, ~/src, … that exist)
  -v, --version           Print the version
  -h, --help              Show this help

Pairing (on by default): the bridge also listens on this machine's private LAN addresses and
prints a QR code for a headset to scan. LAN requests need the pairing token (stored in
<home>/pairing.json, or BRIDGE_TOKEN if set). Anyone with it can run agents as you, over plain
HTTP: use a trusted Wi-Fi, or --no-pair.

Auth: set BRIDGE_TOKEN in the environment to require "Authorization: Bearer <token>" from
loopback clients too. Agents run with every action pre-approved (muse --yolo).`;

function version(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, '..', 'package.json'), path.join(here, '..', '..', 'package.json')]) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')).version; } catch { /* try next */ }
  }
  return 'unknown';
}

/** Parse CLI flags into config overrides. Exported for tests. */
export function parseCliArgs(argv: string[]): { help?: boolean; version?: boolean; overrides: Partial<Config> } {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string', short: 'H', multiple: true },
      'muse-path': { type: 'string' },
      'projects-dir': { type: 'string' },
      home: { type: 'string' },
      sender: { type: 'string' },
      'no-cron': { type: 'boolean' },
      'no-pair': { type: 'boolean' },
      'reset-pairing': { type: 'boolean' },
      'no-discover': { type: 'boolean' },
      'scan-root': { type: 'string', multiple: true },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  const overrides: Partial<Config> = {};
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid --port: ${values.port}`);
    overrides.port = port;
  }
  if (values.host?.length) overrides.hosts = values.host.flatMap(h => h.split(',')).map(h => h.trim()).filter(Boolean);
  if (values['muse-path']) overrides.musePath = values['muse-path'];
  if (values['projects-dir']) overrides.projectsDir = values['projects-dir'];
  if (values.home) overrides.homeDir = values.home;
  if (values.sender) overrides.senderName = values.sender;
  if (values['no-cron']) overrides.cron = false;
  if (values['no-pair']) overrides.pair = false;
  if (values['reset-pairing']) overrides.resetPairing = true;
  if (values['no-discover']) overrides.discover = false;
  if (values['scan-root']?.length) overrides.scanRoots = values['scan-root'].flatMap(r => r.split(',')).map(r => r.trim()).filter(Boolean);
  return { help: values.help, version: values.version, overrides };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    console.error(`muse-bridge: ${(err as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  if (parsed.help) { console.log(HELP); return; }
  if (parsed.version) { console.log(version()); return; }

  const config = loadConfig(process.env, parsed.overrides);
  let bridge: Awaited<ReturnType<typeof startServer>>;
  try {
    bridge = await startServer(config);
  } catch (err) {
    console.error(`muse-bridge: ${(err as Error).message}`);
    process.exit(1);
  }

  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[Bridge] ${signal} received, releasing port + draining sessions (max 30s)...`);
      const drained = await bridge.close(30_000);
      console.log(`[Bridge] Drain ${drained ? 'complete' : 'timed out'}, exiting`);
      process.exit(0);
    });
  }
}
