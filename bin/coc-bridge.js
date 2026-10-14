#!/usr/bin/env node
/**
 * coc-bridge CLI entry point
 *
 * Default behaviour: daemonize the server in the background, confirm it's
 * connected, then return the terminal prompt immediately.
 *
 * Commands:
 *   (none / start)   Start daemon in background and confirm connection
 *   stop             Stop the running daemon
 *   status           Show whether the daemon is running
 *   restart          Stop then start
 *   logs             Tail the live log file
 *   server           Run the server IN the foreground (for debugging)
 *   setup            Wire Claude Code to auto-start the bridge
 *   doctor           Health-check the full installation
 *   help / --help    Show this help
 *   --version / -v   Show version
 */
'use strict';

const path   = require('path');
const fs     = require('fs');
const http   = require('http');
const os     = require('os');
const { spawn, execSync } = require('child_process');

// ─── paths ────────────────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.BRIDGE_PORT || '4045', 10);
const LOG_DIR     = path.join(os.homedir(), '.coc-bridge');
const LOG_FILE    = path.join(LOG_DIR, 'bridge.log');
const PID_FILE    = path.join(LOG_DIR, 'bridge.pid');
const CONFIG_FILE = path.join(LOG_DIR, 'config.json');
const SERVER_JS   = path.join(__dirname, '..', 'src', 'server.js');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { return {}; }
}

// ─── colours ──────────────────────────────────────────────────────────────────
const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', B = '\x1b[34m';
const BOLD = '\x1b[1m', DIM = '\x1b[2m', RESET = '\x1b[0m';

// ─── helpers ──────────────────────────────────────────────────────────────────
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function readPid() {
  try { return parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10); } catch (_) { return null; }
}

function writePid(pid) {
  ensureLogDir();
  fs.writeFileSync(PID_FILE, String(pid));
}

function clearPid() {
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function healthCheck() {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${PORT}/health`, { timeout: 2000 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function waitForBridge(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const health = await healthCheck();
    if (health && health.status === 'ok') return health;
    await new Promise(r => setTimeout(r, 150));
  }
  return null;
}

// ─── commands ─────────────────────────────────────────────────────────────────

async function cmdStart() {
  // Already running?
  const existingPid = readPid();
  if (isProcessAlive(existingPid)) {
    const health = await healthCheck();
    if (health) {
      console.log(`\n${G}${BOLD}✔  coc-bridge already running${RESET}  ${DIM}(pid ${existingPid}, port ${PORT})${RESET}`);
      console.log(`   ${DIM}Default model: ${health.defaultModel}${RESET}`);
      console.log(`   ${DIM}${health.availableModels.length} models available${RESET}\n`);
      return;
    }
    // PID alive but bridge not responding — stale, clean up
    clearPid();
  }

  // Spawn the daemon — stdout/stderr both go to the log file
  ensureLogDir();
  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [SERVER_JS], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, COC_BRIDGE_DAEMON: '1' },
  });
  fs.closeSync(logFd);
  child.unref();

  writePid(child.pid);

  process.stdout.write(`\n   Starting coc-bridge`);
  const health = await waitForBridge(10000);

  if (!health) {
    process.stdout.write(`\n${R}${BOLD}✖  Bridge failed to start${RESET}\n`);
    console.log(`   Check logs: ${LOG_FILE}\n`);
    clearPid();
    process.exit(1);
  }

  console.log(`\r${G}${BOLD}✔  coc-bridge connected${RESET}  ${DIM}http://127.0.0.1:${PORT}  (pid ${child.pid})${RESET}`);
  console.log(`   ${DIM}Default model : ${health.defaultModel}${RESET}`);
  console.log(`   ${DIM}Models        : ${health.availableModels.length} available${RESET}`);
  console.log(`   ${DIM}Logs          : ${LOG_FILE}${RESET}`);
  console.log(`\n   ${DIM}Run ${RESET}${BOLD}coc-bridge stop${RESET}${DIM} to shut it down.${RESET}\n`);
}

async function cmdStop() {
  const pid = readPid();
  if (!pid || !isProcessAlive(pid)) {
    console.log(`\n${Y}  coc-bridge is not running.${RESET}\n`);
    clearPid();
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    // Wait up to 3s for process to die
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (!isProcessAlive(pid)) break;
    }
    clearPid();
    console.log(`\n${G}  ✔  coc-bridge stopped.${RESET}\n`);
  } catch (e) {
    console.log(`\n${R}  ✖  Could not stop process ${pid}: ${e.message}${RESET}\n`);
  }
}

async function cmdStatus() {
  const pid = readPid();
  const alive = isProcessAlive(pid);
  const health = await healthCheck();

  console.log('');
  if (alive && health) {
    console.log(`${G}${BOLD}  ● coc-bridge is running${RESET}`);
    console.log(`    pid     : ${pid}`);
    console.log(`    port    : ${PORT}`);
    console.log(`    model   : ${health.defaultModel}`);
    console.log(`    models  : ${health.availableModels.length} available`);
    console.log(`    log     : ${LOG_FILE}`);
  } else if (alive && !health) {
    console.log(`${Y}${BOLD}  ⚠  Process alive (pid ${pid}) but not responding on port ${PORT}${RESET}`);
  } else {
    console.log(`${R}${BOLD}  ○  coc-bridge is not running${RESET}`);
    console.log(`    Run ${BOLD}coc-bridge${RESET} to start it.`);
  }
  console.log('');
}

async function cmdRestart() {
  await cmdStop();
  await new Promise(r => setTimeout(r, 500));
  await cmdStart();
}

function cmdLogs() {
  ensureLogDir();
  if (!fs.existsSync(LOG_FILE)) {
    console.log(`\n${Y}  No log file yet. Start the bridge first: coc-bridge${RESET}\n`);
    return;
  }
  console.log(`\n${DIM}  Tailing ${LOG_FILE} (Ctrl+C to exit)${RESET}\n`);
  // Print last 20 lines then follow
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-20).join('\n');
    if (lines.trim()) console.log(lines);
  } catch (_) {}
  const tail = spawn('tail', ['-f', LOG_FILE], { stdio: 'inherit' });
  tail.on('exit', () => process.exit(0));
  process.on('SIGINT', () => { tail.kill(); process.exit(0); });
}

function cmdServer() {
  // Foreground mode — just run the server directly, no daemonizing
  console.log(`\n${B}${BOLD}  coc-bridge — foreground mode${RESET}  ${DIM}(Ctrl+C to stop)${RESET}\n`);
  require(SERVER_JS);
}

// ── coc-bridge models ──────────────────────────────────────────────────────────
function cmdModels() {
  const { spawnSync } = require('child_process');
  const NODE = process.execPath;

  // Ask the bridge's own health endpoint first (if running)
  http.get(`http://127.0.0.1:${PORT}/v1/models`, { timeout: 2000 }, res => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        printModelList(data.data, '(from running bridge)');
      } catch (_) {
        fetchAndPrint();
      }
    });
  }).on('error', () => fetchAndPrint());

  function fetchAndPrint() {
    // Bridge not running — call opencode models directly
    let opencodebin;
    try {
      const { execSync } = require('child_process');
      opencodebin = execSync('which opencode', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch (_) {
      const candidates = [
        path.join(os.homedir(), '.nvm', 'versions', 'node', 'v24.21.0', 'bin', 'opencode'),
        path.join(os.homedir(), '.local', 'bin', 'opencode'),
        '/usr/local/bin/opencode',
      ];
      opencodebin = candidates.find(c => { try { fs.accessSync(c, fs.constants.X_OK); return true; } catch (_) { return false; } });
    }
    if (!opencodebin) {
      console.log(`\n${R}  Cannot find opencode. Install it: npm install -g opencode${RESET}\n`);
      return;
    }
    const r = spawnSync(opencodebin, ['models'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status !== 0 || !r.stdout) {
      console.log(`\n${R}  opencode models failed.${RESET}\n`);
      return;
    }
    const models = r.stdout.trim().split('\n').filter(Boolean).map(id => ({ id, display_name: id }));
    printModelList(models, '(from opencode)');
  }

  function printModelList(models, source) {
    const cfg = readConfig();
    const current = cfg.defaultModel || 'opencode/space-bunny-free';
    console.log(`\n${BOLD}  Available OpenCode models ${DIM}${source}${RESET}\n`);
    for (const m of models) {
      const isDefault = m.id === current;
      const tag = isDefault ? ` ${G}← current default${RESET}` : '';
      console.log(`  ${isDefault ? G + BOLD : DIM}${m.id}${RESET}${tag}`);
    }
    console.log(`\n  ${DIM}Set default: ${RESET}${BOLD}coc-bridge use <model-id>${RESET}\n`);
  }
}

// ── coc-bridge use <model> ─────────────────────────────────────────────────────
function cmdUse(modelId) {
  if (!modelId) {
    console.log(`\n${R}  Usage: coc-bridge use <model-id>${RESET}`);
    console.log(`  Example: coc-bridge use opencode/cat-jam-free\n`);
    console.log(`  Run ${BOLD}coc-bridge models${RESET} to see what's available.\n`);
    return;
  }
  ensureLogDir();
  const cfg = readConfig();
  const previous = cfg.defaultModel || 'opencode/space-bunny-free';
  cfg.defaultModel = modelId;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  console.log(`\n${G}${BOLD}  ✔  Default model updated${RESET}`);
  console.log(`     ${DIM}Was:${RESET} ${previous}`);
  console.log(`     ${DIM}Now:${RESET} ${G}${modelId}${RESET}`);
  console.log(`\n  ${DIM}Restart the bridge to apply: ${RESET}${BOLD}coc-bridge restart${RESET}\n`);
}

function showHelp() {
  const pkg = require('../package.json');
  console.log(`
${BOLD}╔══════════════════════════════════════════════════════╗
║         coc-bridge 🔌  v${pkg.version}  —  Claude ↔ OpenCode    ║
╚══════════════════════════════════════════════════════╝${RESET}

${BOLD}USAGE${RESET}
  coc-bridge [command]

${BOLD}COMMANDS${RESET}
  ${G}(default)${RESET}    Start the bridge in the background, return your prompt
  ${G}stop${RESET}         Stop the running background bridge
  ${G}restart${RESET}      Stop then start again
  ${G}status${RESET}       Show whether the bridge is running
  ${G}logs${RESET}         Tail the live log file
  ${G}models${RESET}       List all available OpenCode models
  ${G}use <id>${RESET}     Set the default model (saved to ~/.coc-bridge/config.json)
  ${G}server${RESET}       Run in the foreground (useful for debugging)
  ${G}setup${RESET}        Wire Claude Code to auto-start the bridge on login
  ${G}doctor${RESET}       Check that Node, opencode, and claude are all wired up

${BOLD}ENVIRONMENT VARIABLES${RESET}
  BRIDGE_PORT        Port to listen on          (default: 4045)
  OPENCODE_MODEL     Default model              (overrides config.json)
  OPENCODE_BIN       Path to opencode binary    (auto-detected)
  BRIDGE_TIMEOUT_MS  Max ms per request         (default: 300000)

${BOLD}EXAMPLES${RESET}
  coc-bridge                             # Start daemon, get prompt back
  coc-bridge models                      # See all models you can use
  coc-bridge use opencode/cat-jam-free   # Switch default model
  coc-bridge restart                     # Apply model change
  coc-bridge stop                        # Shut it down
  coc-bridge status                      # Is it running?
  coc-bridge logs                        # Watch live logs
  coc-bridge setup                       # One-time Claude Code wiring
  BRIDGE_PORT=5000 coc-bridge            # Custom port
`);
}

// ─── router ───────────────────────────────────────────────────────────────────
const cmd = process.argv[2] || 'start';

(async () => {
  switch (cmd) {
    case 'start':     await cmdStart();              break;
    case 'stop':      await cmdStop();               break;
    case 'status':    await cmdStatus();             break;
    case 'restart':   await cmdRestart();            break;
    case 'logs':      cmdLogs();                     break;
    case 'server':    cmdServer();                   break;
    case 'models':    cmdModels();                   break;
    case 'use':       cmdUse(process.argv[3]);       break;
    case 'setup':     require(path.join(__dirname, '..', 'scripts', 'setup-claude.js')); break;
    case 'doctor':    require(path.join(__dirname, '..', 'scripts', 'doctor.js'));       break;
    case '--version':
    case '-v': {
      const pkg = require('../package.json');
      console.log(`coc-bridge v${pkg.version}`);
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;
    default:
      console.log(`\n${R}  Unknown command: ${cmd}${RESET}\n  Run ${BOLD}coc-bridge help${RESET} for available commands.\n`);
      process.exit(1);
  }
})();

