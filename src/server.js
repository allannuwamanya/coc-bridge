#!/usr/bin/env node
/**
 * coc-bridge server — v1.1.0
 *
 * Architecture: Claude Code is the AGENT (reads files, edits, runs bash, asks permission).
 *               OpenCode is ONLY the LLM (pure text in → text out).
 *
 * Uses `opencode api session.generate` — stateless, zero-agent, zero-tool-call LLM inference.
 * OpenCode never searches your files or runs commands. Claude Code does all of that.
 */
'use strict';

const http    = require('http');
const { execSync, spawnSync } = require('child_process');
const crypto  = require('crypto');
const path    = require('path');
const os      = require('os');
const fs      = require('fs');

const PORT              = parseInt(process.env.BRIDGE_PORT || process.env.PORT || '4045', 10);
const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const CONFIG_FILE       = path.join(os.homedir(), '.coc-bridge', 'config.json');

// ─── Config ──────────────────────────────────────────────────────────────────
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { return {}; }
}
const config        = readConfig();
const DEFAULT_MODEL = process.env.OPENCODE_MODEL || config.defaultModel || 'opencode/space-bunny-free';

// ─── Find opencode binary ─────────────────────────────────────────────────────
function findOpencodeBin() {
  if (process.env.OPENCODE_BIN) {
    try { return fs.realpathSync(process.env.OPENCODE_BIN); } catch (_) { return process.env.OPENCODE_BIN; }
  }
  const candidates = [
    path.join(os.homedir(), '.nvm', 'versions', 'node', 'v24.21.0', 'bin', 'opencode'),
    path.join(os.homedir(), '.nvm', 'versions', 'node', 'v22.0.0', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
    path.join(os.homedir(), '.local', 'bin', 'opencode'),
  ];
  try {
    const which = execSync('which opencode', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (which && !candidates.includes(which)) candidates.unshift(which);
  } catch (_) {}
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return fs.realpathSync(c);
    } catch (_) {}
  }
  console.error('[coc-bridge] ❌  Cannot find opencode binary.\n  Install: npm install -g opencode\n  Or set: OPENCODE_BIN=/path/to/opencode');
  process.exit(1);
}
const OPENCODE_BIN = findOpencodeBin();
const OPENCODE_BIN_DIR = path.dirname(OPENCODE_BIN);

// ─── Model list ──────────────────────────────────────────────────────────────
function fetchAvailableModels() {
  try {
    const result = spawnSync(OPENCODE_BIN, ['models'], {
      encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, PATH: OPENCODE_BIN_DIR + path.delimiter + process.env.PATH }
    });
    if (result.status !== 0 || !result.stdout) return null;
    return result.stdout.split('\n').map(l => l.trim()).filter(Boolean).map(id => ({
      id, display_name: formatModelName(id)
    }));
  } catch (_) { return null; }
}
function formatModelName(id) {
  const slug = id.replace(/^[^/]+\//, '');
  return slug
    .replace(/-free$/, ' (Free)').replace(/-preview$/, ' (Preview)')
    .replace(/-contributor-free$/, ' (Free)').replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\(free\)/i, '(Free)').replace(/\(preview\)/i, '(Preview)').trim();
}
let OPENCODE_MODELS = fetchAvailableModels() || [
  { id: 'opencode/space-bunny-free', display_name: 'Space Bunny (Free)' }
];
console.log(`[coc-bridge] Loaded ${OPENCODE_MODELS.length} model(s) from opencode`);
setInterval(() => {
  const fresh = fetchAvailableModels();
  if (fresh && fresh.length > 0) {
    OPENCODE_MODELS = fresh;
    console.log(`[coc-bridge] Refreshed model list: ${OPENCODE_MODELS.length} model(s)`);
  }
}, 10 * 60 * 1000);

// ─── Model resolution ─────────────────────────────────────────────────────────
function resolveModel(requested) {
  if (!requested) return DEFAULT_MODEL;
  if (OPENCODE_MODELS.some(m => m.id === requested)) return requested;
  if (requested.startsWith('opencode/') || requested.includes('/')) return requested;
  const lower = requested.toLowerCase();
  const fuzzy = OPENCODE_MODELS.find(m => m.id.toLowerCase().includes(lower));
  if (fuzzy) return fuzzy.id;
  const tierMap = config.tierMap || {};
  const builtinTierMap = {
    'opus':   config.opusModel   || OPENCODE_MODELS.find(m => m.id.includes('nemotron') && m.id.includes('ultra'))?.id || DEFAULT_MODEL,
    'sonnet': config.sonnetModel || OPENCODE_MODELS.find(m => m.id.includes('muse') || m.id.includes('spark'))?.id     || DEFAULT_MODEL,
    'haiku':  config.haikuModel  || OPENCODE_MODELS.find(m => m.id.includes('cat') || m.id.includes('jam'))?.id        || DEFAULT_MODEL,
  };
  for (const [tier, target] of Object.entries({ ...builtinTierMap, ...tierMap })) {
    if (lower.includes(tier)) return target;
  }
  return DEFAULT_MODEL;
}

// ─── Parse model string "opencode/space-bunny-free" → { providerID, id } ─────
function parseModel(modelStr) {
  const parts = modelStr.split('/');
  if (parts.length >= 2) {
    const providerID = parts[0];
    const id = parts.slice(1).join('/');
    return { providerID, id };
  }
  return { providerID: 'opencode', id: modelStr };
}

// ─── Session pool: one reusable session per (providerID/model) ───────────────
const sessionPool = new Map(); // modelStr → sessionID

function runOpenCodeApi(...args) {
  const result = spawnSync(OPENCODE_BIN, ['api', ...args], {
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: OPENCODE_BIN_DIR + path.delimiter + process.env.PATH }
  });
  const out = result.stdout ? result.stdout.trim() : '';
  const err = result.stderr ? result.stderr.trim() : '';
  if (result.status !== 0) throw new Error(`opencode api exit ${result.status}: ${err || out}`);
  return out;
}

function getOrCreateSession(modelStr) {
  if (sessionPool.has(modelStr)) return sessionPool.get(modelStr);
  try {
    const { providerID, id } = parseModel(modelStr);
    const body = JSON.stringify({
      title: `coc-bridge-${providerID}-${id}`,
    });
    const out = runOpenCodeApi('POST', '/api/session', '-d', body);
    const json = JSON.parse(out);
    const sessionID = json.data?.id || json.id;
    if (!sessionID) throw new Error('No session ID in response: ' + out);
    // Set the model for this session
    try {
      runOpenCodeApi('PUT', `/api/session/${sessionID}/model`,
        '-d', JSON.stringify({ providerID, id })
      );
    } catch (_) {} // non-fatal — uses session default
    sessionPool.set(modelStr, sessionID);
    console.log(`[Bridge] Created session ${sessionID} for model ${modelStr}`);
    return sessionID;
  } catch (err) {
    throw new Error('Failed to create opencode session: ' + err.message);
  }
}

// ─── Build a plain-text prompt from Anthropic message array ──────────────────
function buildPrompt(body) {
  const parts = [];

  // System prompt
  if (body.system) {
    let sys = '';
    if (typeof body.system === 'string') sys = body.system;
    else if (Array.isArray(body.system)) {
      sys = body.system.map(s => typeof s === 'string' ? s : (s.text || '')).join('\n');
    }
    if (sys.trim()) parts.push(`[SYSTEM]\n${sys.trim()}\n[/SYSTEM]`);
  }

  // Message history
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const role = msg.role === 'assistant' ? 'Assistant' : 'User';
      if (typeof msg.content === 'string') {
        parts.push(`${role}: ${msg.content.trim()}`);
      } else if (Array.isArray(msg.content)) {
        const textParts = [];
        for (const part of msg.content) {
          if (part.type === 'text' && part.text) {
            textParts.push(part.text);
          } else if (part.type === 'tool_use') {
            textParts.push(`[Tool: ${part.name}]\nInput: ${JSON.stringify(part.input)}`);
          } else if (part.type === 'tool_result') {
            const content = typeof part.content === 'string'
              ? part.content
              : Array.isArray(part.content)
                ? part.content.map(c => c.text || JSON.stringify(c)).join('\n')
                : JSON.stringify(part.content || '');
            textParts.push(`[Tool Result]:\n${content}`);
          } else if (part.type === 'thinking') {
            // Skip prior thinking blocks in history — they confuse the model
          }
        }
        if (textParts.length > 0) parts.push(`${role}: ${textParts.join('\n\n')}`);
      }
    }
  }

  return parts.join('\n\n');
}

// ─── Extract tool calls from text ────────────────────────────────────────────
function extractToolCalls(text, allowedTools = []) {
  if (!text) return { text: '', toolCalls: [] };
  const toolCalls = [];

  // Match ```tool_call / ```json blocks
  const blockRegex = /```(?:tool_call|json)?\s*\n?([\s\S]*?)\n?```/gi;
  let match, textSegments = [], lastIndex = 0;
  while ((match = blockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed && typeof parsed.name === 'string' && parsed.input !== undefined) {
        const matchedTool = allowedTools.length === 0
          ? parsed.name
          : allowedTools.find(t => t.toLowerCase() === parsed.name.toLowerCase());
        if (matchedTool) {
          toolCalls.push({ name: matchedTool, input: parsed.input });
          textSegments.push(text.slice(lastIndex, match.index));
          lastIndex = blockRegex.lastIndex;
        }
      }
    } catch (_) {}
  }
  if (toolCalls.length > 0) {
    textSegments.push(text.slice(lastIndex));
    return { text: textSegments.join('\n').replace(/\n{3,}/g, '\n\n').trim(), toolCalls };
  }

  // Match <tool_call> XML tags
  const xmlRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  lastIndex = 0; textSegments = [];
  while ((match = xmlRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed && typeof parsed.name === 'string' && parsed.input !== undefined) {
        const matchedTool = allowedTools.length === 0
          ? parsed.name
          : allowedTools.find(t => t.toLowerCase() === parsed.name.toLowerCase());
        if (matchedTool) {
          toolCalls.push({ name: matchedTool, input: parsed.input });
          textSegments.push(text.slice(lastIndex, match.index));
          lastIndex = xmlRegex.lastIndex;
        }
      }
    } catch (_) {}
  }
  if (toolCalls.length > 0) {
    textSegments.push(text.slice(lastIndex));
    return { text: textSegments.join('\n').replace(/\n{3,}/g, '\n\n').trim(), toolCalls };
  }

  return { text: text.trim(), toolCalls: [] };
}

// ─── POST /v1/messages ───────────────────────────────────────────────────────
function handleMessagesRequest(req, res, rawBody) {
  let body;
  try { body = JSON.parse(rawBody); }
  catch (_) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON body' } }));
  }

  const modelStr     = resolveModel(body.model);
  const isStreaming  = Boolean(body.stream);
  const messageId    = `msg_${crypto.randomBytes(12).toString('hex')}`;
  const allowedTools = Array.isArray(body.tools) ? body.tools.map(t => t.name).filter(Boolean) : [];

  console.log(`[Bridge] Request: ${modelStr} (tools: ${allowedTools.length}, streaming=${isStreaming})`);
  if (allowedTools.length) console.log(`[Bridge] Tools from Claude Code: ${allowedTools.join(', ')}`);

  const prompt = buildPrompt(body);

  // ── Run opencode api session.generate (pure LLM, no agent) ────────────────
  let sessionID;
  try {
    sessionID = getOrCreateSession(modelStr);
  } catch (err) {
    console.error('[Bridge] Session error:', err.message);
    if (isStreaming) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: err.message } })}\n\n`);
      return res.end();
    }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { type: 'api_error', message: err.message } }));
  }

  // Spawn opencode api session.generate asynchronously
  const { spawnSync: _s, ...cp } = require('child_process');
  const { spawn } = cp;

  const env = { ...process.env, PATH: OPENCODE_BIN_DIR + path.delimiter + process.env.PATH };
  const child = spawn(OPENCODE_BIN, [
    'api', 'session.generate',
    '--param', `sessionID=${sessionID}`,
    '-d', JSON.stringify({ prompt })
  ], { stdio: ['ignore', 'pipe', 'pipe'], env });

  const timeoutMs = parseInt(process.env.BRIDGE_TIMEOUT_MS || '300000', 10);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (!child.killed) child.kill('SIGTERM');
  }, timeoutMs);

  let stdoutBuf = '';
  let stderrBuf = '';
  let clientClosed = false;

  res.on('close', () => {
    clientClosed = true;
    clearTimeout(timer);
    if (!child.killed) child.kill('SIGTERM');
  });

  child.stdout.on('data', d => { stdoutBuf += d.toString(); });
  child.stderr.on('data', d => { stderrBuf += d.toString(); });

  child.on('close', code => {
    clearTimeout(timer);
    if (clientClosed) return;

    // Parse the response
    let text = '';
    let parseError = null;
    try {
      const parsed = JSON.parse(stdoutBuf.trim());
      if (parsed.data && typeof parsed.data.text === 'string') {
        text = parsed.data.text;
      } else if (parsed._tag || parsed.message) {
        // opencode returned an error
        const msg = parsed.message || JSON.stringify(parsed);
        parseError = msg;

        // If session was invalidated (session not found), clear it from pool
        if (msg.includes('not found') || msg.includes('SessionNotFound')) {
          sessionPool.delete(modelStr);
          console.warn(`[Bridge] Session ${sessionID} invalidated, will recreate on next request`);
        }
      } else {
        text = stdoutBuf.trim();
      }
    } catch (_) {
      parseError = `Failed to parse opencode response: ${stdoutBuf.slice(0, 200)}`;
      if (stderrBuf) parseError += `\nStderr: ${stderrBuf.slice(0, 200)}`;
    }

    if (parseError && !text) {
      console.error(`[Bridge] Error from opencode: ${parseError}`);
      if (isStreaming) {
        if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: parseError } })}\n\n`);
        return res.end();
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { type: 'api_error', message: parseError } }));
    }

    if (!text) text = 'Done.';

    // Check if text contains embedded tool calls
    const { text: cleanText, toolCalls } = extractToolCalls(text, allowedTools);
    const inputTokens  = Math.ceil(prompt.length / 4);
    const outputTokens = Math.max(1, Math.ceil(text.length / 4));

    if (isStreaming) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      const sseWrite = (event, data) => {
        if (!clientClosed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      sseWrite('message_start', {
        type: 'message_start',
        message: {
          id: messageId, type: 'message', role: 'assistant', model: modelStr,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 1 }
        }
      });

      let blockIndex = 0;
      const hasToolCalls = toolCalls.length > 0;

      // Emit text if present
      const textToEmit = (cleanText || (!hasToolCalls ? text : '')).trim();
      if (textToEmit) {
        sseWrite('content_block_start', {
          type: 'content_block_start', index: blockIndex,
          content_block: { type: 'text', text: '' }
        });
        sseWrite('content_block_delta', {
          type: 'content_block_delta', index: blockIndex,
          delta: { type: 'text_delta', text: textToEmit }
        });
        sseWrite('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        blockIndex++;
      }

      // Emit tool_use blocks
      for (const tc of toolCalls) {
        const toolUseId = `toulu_${crypto.randomBytes(12).toString('hex')}`;
        sseWrite('content_block_start', {
          type: 'content_block_start', index: blockIndex,
          content_block: { type: 'tool_use', id: toolUseId, name: tc.name, input: {} }
        });
        sseWrite('content_block_delta', {
          type: 'content_block_delta', index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.input) }
        });
        sseWrite('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        blockIndex++;
      }

      // Guard: at least one content block must exist
      if (blockIndex === 0) {
        sseWrite('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        sseWrite('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } });
        sseWrite('content_block_stop', { type: 'content_block_stop', index: 0 });
      }

      sseWrite('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: hasToolCalls ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: outputTokens }
      });
      sseWrite('message_stop', { type: 'message_stop' });
      res.end();

    } else {
      // Non-streaming
      const content = [];
      const textToInclude = (cleanText || (!toolCalls.length ? text : '')).trim();
      if (textToInclude) content.push({ type: 'text', text: textToInclude });
      for (const tc of toolCalls) {
        content.push({
          type: 'tool_use',
          id: `toolu_${crypto.randomBytes(12).toString('hex')}`,
          name: tc.name, input: tc.input
        });
      }
      if (content.length === 0) content.push({ type: 'text', text: text.trim() || 'Done.' });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: messageId, type: 'message', role: 'assistant', model: modelStr, content,
        stop_reason: content.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens }
      }));
    }
  });
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = req.url.split('?')[0];

  // Health
  if (req.method === 'GET' && (url === '/' || url === '/health' || url === '/api/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      version: require('../package.json').version,
      defaultModel: DEFAULT_MODEL,
      availableModels: OPENCODE_MODELS.map(m => m.id),
      backend: 'opencode-session-generate',
      description: 'Pure LLM inference — Claude Code handles all tools'
    }));
  }

  // Models list (OpenAI-compat)
  if (req.method === 'GET' && (url === '/v1/models' || url === '/api/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      object: 'list',
      data: OPENCODE_MODELS.map(m => ({
        id: m.id, object: 'model', created: 1700000000, owned_by: 'opencode',
        display_name: m.display_name
      }))
    }));
  }

  // Messages
  if (req.method === 'POST' && (url === '/v1/messages' || url === '/api/v1/messages')) {
    const chunks = [];
    let receivedBytes = 0;
    req.on('data', chunk => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_PAYLOAD_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Payload exceeds 50MB limit' } }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (receivedBytes > MAX_PAYLOAD_BYTES) return;
      handleMessagesRequest(req, res, Buffer.concat(chunks).toString('utf8'));
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `Route ${req.method} ${url} not found` } }));
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`=======================================================`);
    console.log(` [OpenCode-Claude Bridge] v1.1.0`);
    console.log(` Listening on http://127.0.0.1:${PORT}`);
    console.log(` Default model: ${DEFAULT_MODEL}`);
    console.log(` Backend: opencode session.generate (pure LLM, no agent)`);
    console.log(` Claude Code handles all file reads/edits/bash commands`);
    console.log(`=======================================================`);
  });
}

module.exports = { server, buildPrompt, extractToolCalls, resolveModel, parseModel };
