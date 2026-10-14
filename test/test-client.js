#!/usr/bin/env node
/**
 * coc-bridge — test suite
 * Tests both streaming and non-streaming requests against a running bridge.
 */
'use strict';

const http = require('http');

const PORT = parseInt(process.env.BRIDGE_PORT || '4045', 10);

const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const DIM   = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';

function makeRequest(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    let streamOutput = '';
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'anthropic-version': '2023-06-01',
        'x-api-key': 'coc-local',
      },
      timeout: 60000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => {
        body += chunk;
        if (payload.stream) streamOutput += chunk.toString();
      });
      res.on('end', () => resolve({ status: res.statusCode, body, streamOutput }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(data);
    req.end();
  });
}

async function runTests() {
  console.log(`\n${BOLD}coc-bridge test suite 🧪${RESET}`);
  console.log(`${DIM}Testing bridge at http://127.0.0.1:${PORT}${RESET}\n`);

  let passed = 0;
  let failed = 0;

  // ── Health check ────────────────────────────────────────────────
  process.stdout.write('  Testing GET /health ... ');
  try {
    const health = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${PORT}/health`, { timeout: 3000 }, res => {
        let b = ''; res.on('data', d => b += d);
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', reject);
    });
    const json = JSON.parse(health.body);
    if (health.status === 200 && json.status === 'ok') {
      console.log(`${GREEN}✔ PASS${RESET} — ${json.availableModels.length} models available`);
      passed++;
    } else {
      console.log(`${RED}✖ FAIL${RESET} — unexpected response`);
      failed++;
    }
  } catch (e) {
    console.log(`${RED}✖ FAIL${RESET} — ${e.message}`);
    console.log(`\n${RED}Bridge is not running.${RESET} Start it first:\n  coc-bridge\n`);
    process.exit(1);
  }

  // ── Model discovery ─────────────────────────────────────────────
  process.stdout.write('  Testing GET /v1/models ... ');
  try {
    const models = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${PORT}/v1/models`, { timeout: 3000 }, res => {
        let b = ''; res.on('data', d => b += d);
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', reject);
    });
    const json = JSON.parse(models.body);
    if (models.status === 200 && Array.isArray(json.data) && json.data.length > 0) {
      console.log(`${GREEN}✔ PASS${RESET} — ${json.data.length} models listed`);
      passed++;
    } else {
      console.log(`${RED}✖ FAIL${RESET}`);
      failed++;
    }
  } catch (e) {
    console.log(`${RED}✖ FAIL${RESET} — ${e.message}`);
    failed++;
  }

  // ── Non-streaming message ────────────────────────────────────────
  process.stdout.write('  Testing POST /v1/messages (non-streaming) ... ');
  try {
    const res = await makeRequest({
      model: 'opencode/space-bunny-free',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Reply with exactly: "Space Bunny is online!" — nothing else.' }],
    });
    const json = JSON.parse(res.body);
    if (res.status === 200 && json.content && json.content[0] && json.content[0].text) {
      console.log(`${GREEN}✔ PASS${RESET} — "${json.content[0].text.trim()}"`);
      passed++;
    } else {
      console.log(`${RED}✖ FAIL${RESET} — status ${res.status}: ${res.body.slice(0, 120)}`);
      failed++;
    }
  } catch (e) {
    console.log(`${RED}✖ FAIL${RESET} — ${e.message}`);
    failed++;
  }

  // ── Streaming SSE message ────────────────────────────────────────
  process.stdout.write('  Testing POST /v1/messages (streaming SSE) ... ');
  try {
    const res = await makeRequest({
      model: 'opencode/space-bunny-free',
      max_tokens: 50,
      stream: true,
      messages: [{ role: 'user', content: 'Say "hopping!" in one word.' }],
    });
    const hasStart   = res.streamOutput.includes('message_start');
    const hasDelta   = res.streamOutput.includes('content_block_delta');
    const hasStop    = res.streamOutput.includes('message_stop');
    if (res.status === 200 && hasStart && hasDelta && hasStop) {
      console.log(`${GREEN}✔ PASS${RESET} — SSE events: message_start ✓  content_block_delta ✓  message_stop ✓`);
      passed++;
    } else {
      console.log(`${RED}✖ FAIL${RESET} — missing events. Got:\n${res.streamOutput.slice(0, 300)}`);
      failed++;
    }
  } catch (e) {
    console.log(`${RED}✖ FAIL${RESET} — ${e.message}`);
    failed++;
  }

  // ── Summary ──────────────────────────────────────────────────────
  console.log('');
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}All ${passed} tests passed! ✅${RESET}\n`);
  } else {
    console.log(`${RED}${BOLD}${failed} test(s) failed out of ${passed + failed}.${RESET}\n`);
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error(`\n${RED}Fatal error:${RESET}`, err.message);
  process.exit(1);
});
