#!/usr/bin/env node
/**
 * coc-bridge CLI entry point
 * Starts the bridge server and optionally runs setup
 */
'use strict';

const path = require('path');
const args = process.argv.slice(2);

const COMMANDS = {
  start: 'Start the bridge server (default)',
  setup: 'Configure Claude Code to use coc-bridge automatically',
  doctor: 'Check that everything is installed and working',
  help: 'Show this help message',
  '--help': 'Show this help message',
  '-h': 'Show this help message',
  '--version': 'Show version',
  '-v': 'Show version',
};

const cmd = args[0] || 'start';

if (cmd === '--version' || cmd === '-v') {
  const pkg = require('../package.json');
  console.log(`coc-bridge v${pkg.version}`);
  process.exit(0);
}

if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(`
╔══════════════════════════════════════════════════════╗
║           coc-bridge 🔌  —  Claude ↔ OpenCode       ║
╚══════════════════════════════════════════════════════╝

USAGE
  coc-bridge [command]

COMMANDS`);
  for (const [name, desc] of Object.entries(COMMANDS)) {
    if (name.startsWith('-')) continue;
    console.log(`  ${name.padEnd(12)} ${desc}`);
  }
  console.log(`
ENVIRONMENT VARIABLES
  BRIDGE_PORT        Port to listen on (default: 4045)
  OPENCODE_MODEL     Default OpenCode model (default: opencode/space-bunny-free)
  OPENCODE_BIN       Path to opencode binary (auto-detected if not set)
  BRIDGE_TIMEOUT_MS  Max time per request in ms (default: 300000)

AVAILABLE MODELS
  opencode/space-bunny-free
  opencode/cat-jam-free
  opencode/muse-spark-1.3-contributor-free
  opencode/nemotron-3-ultra-free
  opencode/nemotron-3.5-lightning-free
  opencode/ling-3.1-flash-free
  opencode/longcat-2.5-preview-free
  opencode/mimo-v2.6-flash-free
  opencode/big-pickle

EXAMPLES
  coc-bridge                   # Start the server on port 4045
  coc-bridge setup             # Wire up Claude Code automatically
  coc-bridge doctor            # Verify installation
  BRIDGE_PORT=5000 coc-bridge  # Use a custom port
`);
  process.exit(0);
}

if (cmd === 'setup') {
  require(path.join(__dirname, '..', 'scripts', 'setup-claude.js'));
  return;
}

if (cmd === 'doctor') {
  require(path.join(__dirname, '..', 'scripts', 'doctor.js'));
  return;
}

// Default: start the server
require(path.join(__dirname, '..', 'src', 'server.js'));
