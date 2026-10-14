#!/usr/bin/env node
/**
 * coc-bridge doctor — checks that everything is properly installed and working
 */
'use strict';

const { execSync } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

function ok(label, value)   { console.log(`  ${GREEN}✔${RESET}  ${label.padEnd(30)} ${DIM}${value || ''}${RESET}`); }
function warn(label, value) { console.log(`  ${YELLOW}⚠${RESET}  ${label.padEnd(30)} ${DIM}${value || ''}${RESET}`); }
function fail(label, value) { console.log(`  ${RED}✖${RESET}  ${label.padEnd(30)} ${DIM}${value || ''}${RESET}`); }

const PORT = parseInt(process.env.BRIDGE_PORT || '4045', 10);
let issues = 0;

console.log(`\n${BOLD}coc-bridge doctor 🩺${RESET}\n`);

// ── Node.js version ───────────────────────────────────────────────
const [major] = process.versions.node.split('.').map(Number);
if (major >= 18) {
  ok('Node.js', `v${process.versions.node}`);
} else {
  fail('Node.js', `v${process.versions.node} — need ≥18`);
  issues++;
}

// ── opencode binary ───────────────────────────────────────────────
let opencodeVersion;
try {
  opencodeVersion = execSync('opencode --version 2>/dev/null || true', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  if (!opencodeVersion) throw new Error();
  ok('opencode', opencodeVersion);
} catch (_) {
  // Try known paths
  const candidates = [
    path.join(os.homedir(), '.nvm', 'versions', 'node', 'v24.21.0', 'bin', 'opencode'),
    path.join(os.homedir(), '.local', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
  ];
  const found = candidates.find(c => { try { fs.accessSync(c, fs.constants.X_OK); return true; } catch (_) { return false; } });
  if (found) {
    ok('opencode', `found at ${found}`);
  } else {
    fail('opencode', 'not found — run: npm install -g opencode');
    issues++;
  }
}

// ── claude binary ─────────────────────────────────────────────────
try {
  const claudeBin = execSync('which claude', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  const content = fs.readFileSync(claudeBin, 'utf8');
  if (content.includes('coc-bridge') || content.includes('ANTHROPIC_BASE_URL')) {
    ok('claude wrapper', `${claudeBin} (patched ✓)`);
  } else {
    warn('claude wrapper', `${claudeBin} — not yet patched. Run: coc-bridge setup`);
  }
} catch (_) {
  fail('claude', 'not found — install Claude Code: https://claude.ai/download');
  issues++;
}

// ── Bridge server ─────────────────────────────────────────────────
function checkBridge() {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${PORT}/health`, { timeout: 3000 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.status === 'ok') {
            ok('Bridge server', `http://127.0.0.1:${PORT} ✓`);
            ok('Default model', data.defaultModel);
            ok('Available models', `${data.availableModels.length} models`);
          } else {
            warn('Bridge server', 'running but returned unexpected response');
          }
        } catch (_) {
          warn('Bridge server', 'running but returned non-JSON');
        }
        resolve(true);
      });
    });
    req.on('error', () => {
      warn('Bridge server', `not running on :${PORT} — start it with: coc-bridge`);
      resolve(false);
    });
    req.on('timeout', () => {
      warn('Bridge server', `timeout on :${PORT}`);
      req.destroy();
      resolve(false);
    });
  });
}

// ── Log directory ─────────────────────────────────────────────────
const logDir = path.join(os.homedir(), '.coc-bridge');
if (fs.existsSync(logDir)) {
  ok('Log directory', logDir);
} else {
  warn('Log directory', `${logDir} missing — run: coc-bridge setup`);
}

checkBridge().then(bridgeUp => {
  console.log('');
  if (issues === 0 && bridgeUp) {
    console.log(`${GREEN}${BOLD}Everything looks great! 🎉${RESET}\n`);
  } else if (issues === 0) {
    console.log(`${YELLOW}${BOLD}Almost there — start the bridge with: coc-bridge${RESET}\n`);
  } else {
    console.log(`${RED}${BOLD}${issues} issue(s) found — fix them and re-run: coc-bridge doctor${RESET}\n`);
    process.exit(1);
  }
});
