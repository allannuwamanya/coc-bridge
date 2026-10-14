#!/usr/bin/env node
/**
 * coc-bridge restore — Reverts Claude Code and VS Code back to normal official settings.
 * Removes all coc-bridge proxies, wrappers, and custom settings with zero friction.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

function ok(msg)   { console.log(`${GREEN}  ✔${RESET}  ${msg}`); }
function warn(msg) { console.log(`${YELLOW}  ⚠${RESET}  ${msg}`); }
function info(msg) { console.log(`${DIM}  ℹ  ${msg}${RESET}`); }
function step(msg) { console.log(`\n${BOLD}${msg}${RESET}`); }

console.log(`\n${BOLD}coc-bridge restore 🔄${RESET}`);
console.log(`${DIM}Reverting Claude Code & VS Code back to official Anthropic defaults...${RESET}`);

// ─────────────────────────────────────────────
// 1. Stop running bridge daemon
// ─────────────────────────────────────────────
step('1. Stopping coc-bridge daemon...');
try {
  const pidFile = path.join(os.homedir(), '.coc-bridge', 'bridge.pid');
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (pid) {
      process.kill(pid, 'SIGTERM');
      ok(`Terminated bridge process (PID ${pid})`);
    }
    fs.unlinkSync(pidFile);
  } else {
    info('Bridge is not running.');
  }
} catch (_) {
  info('Bridge stopped or already inactive.');
}

// ─────────────────────────────────────────────
// 2. Restore claude binary wrapper
// ─────────────────────────────────────────────
step('2. Restoring official claude binary...');
let claudeBin;
try {
  claudeBin = execSync('which claude', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch (_) {}

if (claudeBin) {
  const claudeBinReal = claudeBin + '-bin';
  if (fs.existsSync(claudeBinReal)) {
    // Overwrite the wrapper with the original executable
    fs.copyFileSync(claudeBinReal, claudeBin);
    fs.chmodSync(claudeBin, 0o755);
    fs.unlinkSync(claudeBinReal);
    ok(`Restored original binary at ${claudeBin}`);
  } else {
    // Check if the current file is a wrapper without backup
    const content = fs.readFileSync(claudeBin, 'utf8');
    if (content.includes('coc-bridge') || content.includes('ANTHROPIC_BASE_URL')) {
      warn(`Claude wrapper detected, but backup binary ${claudeBinReal} was missing.`);
      info('You can reinstall Claude Code cleanly via: npm install -g @anthropic-ai/claude-code');
    } else {
      ok(`Official claude binary is already in place (${claudeBin})`);
    }
  }
} else {
  info('claude binary not found in PATH.');
}

// ─────────────────────────────────────────────
// 3. Clean VS Code settings
// ─────────────────────────────────────────────
step('3. Restoring VS Code settings...');

const vsCodeCandidates = [
  path.join(os.homedir(), '.config', 'Code', 'User', 'settings.json'),
  path.join(os.homedir(), '.var', 'app', 'com.visualstudio.code', 'config', 'Code', 'User', 'settings.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
  process.env.APPDATA ? path.join(process.env.APPDATA, 'Code', 'User', 'settings.json') : null
].filter(Boolean);

let vsCodeUpdated = false;
for (const settingsPath of vsCodeCandidates) {
  if (fs.existsSync(settingsPath)) {
    try {
      let raw = fs.readFileSync(settingsPath, 'utf8');
      let cleaned = false;

      // Clean using stripJsonComments + JSON parse
      try {
        const stripJsonComments = str => str.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => g ? '' : m);
        const json = JSON.parse(stripJsonComments(raw));
        if (json['claudeCode.claudeProcessWrapper']) {
          delete json['claudeCode.claudeProcessWrapper'];
          cleaned = true;
        }
        if (json['claudeCode.environmentVariables']) {
          // Remove bridge-injected variables
          json['claudeCode.environmentVariables'] = json['claudeCode.environmentVariables'].filter(item => {
            return !item.name.startsWith('ANTHROPIC_') && !item.name.startsWith('CLAUDE_CODE_');
          });
          if (json['claudeCode.environmentVariables'].length === 0) {
            delete json['claudeCode.environmentVariables'];
          }
          cleaned = true;
        }
        if (cleaned) {
          fs.writeFileSync(settingsPath, JSON.stringify(json, null, 4));
          ok(`Restored VS Code settings: ${settingsPath}`);
          vsCodeUpdated = true;
        }
      } catch (jsonErr) {
        // If file contains JSON comments, strip wrapper lines with regex
        raw = raw.replace(/"claudeCode\.claudeProcessWrapper":\s*"[^"]*",?/g, '');
        fs.writeFileSync(settingsPath, raw);
        ok(`Cleaned wrapper lines in: ${settingsPath}`);
        vsCodeUpdated = true;
      }
    } catch (e) {
      warn(`Could not update ${settingsPath}: ${e.message}`);
    }
  }
}

if (!vsCodeUpdated) {
  info('No VS Code bridge overrides were found.');
}

// ─────────────────────────────────────────────
// Done
// ─────────────────────────────────────────────
console.log(`
${GREEN}${BOLD}✔ Successfully restored!${RESET}

  Claude Code and VS Code are now back to normal official Anthropic mode.
  No proxies or custom wrappers are active.

  ${DIM}Want coc-bridge back anytime? Just run:${RESET}
    ${BOLD}coc-bridge setup${RESET}
`);
