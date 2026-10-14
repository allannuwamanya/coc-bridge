#!/usr/bin/env node
const http   = require('http');
const { spawn, execSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');

const PORT             = parseInt(process.env.BRIDGE_PORT || process.env.PORT || '4045', 10);
const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50MB
const CONFIG_FILE      = path.join(os.homedir(), '.coc-bridge', 'config.json');

// ─── Config (persists user's chosen default model) ────────────────────────────
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { return {}; }
}

const config       = readConfig();
const DEFAULT_MODEL = process.env.OPENCODE_MODEL || config.defaultModel || 'opencode/space-bunny-free';

// ─── Find opencode binary ─────────────────────────────────────────────────────
function findOpencodeBin() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  try { return execSync('which opencode', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_) {}
  const candidates = [
    path.join(os.homedir(), '.nvm', 'versions', 'node', 'v24.21.0', 'bin', 'opencode'),
    path.join(os.homedir(), '.nvm', 'versions', 'node', 'v22.0.0', 'bin', 'opencode'),
    path.join(os.homedir(), '.local', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_) {}
  }
  console.error('[coc-bridge] ❌  Cannot find opencode binary.\n  Install it: npm install -g opencode\n  Or set: OPENCODE_BIN=/path/to/opencode');
  process.exit(1);
}
const OPENCODE_BIN = findOpencodeBin();

// ─── Dynamic model discovery ──────────────────────────────────────────────────
// Calls `opencode models` to get whatever models the user's opencode instance
// actually has access to — free, paid, or custom providers.
function fetchAvailableModels() {
  try {
    const result = spawnSync(OPENCODE_BIN, ['models'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0 || !result.stdout) return null;
    const ids = result.stdout
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    return ids.map(id => ({
      id,
      display_name: formatModelName(id),
    }));
  } catch (_) {
    return null;
  }
}

// Make a readable name from the model id, e.g. "opencode/cat-jam-free" → "Cat Jam (Free)"
function formatModelName(id) {
  const slug = id.replace(/^[^/]+\//, ''); // strip provider prefix
  return slug
    .replace(/-free$/, ' (Free)')
    .replace(/-preview$/, ' (Preview)')
    .replace(/-contributor-free$/, ' (Free)')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\(free\)/i, '(Free)')
    .replace(/\(preview\)/i, '(Preview)')
    .trim();
}

// Fetch at startup; fall back to a minimal list if opencode models fails
let OPENCODE_MODELS = fetchAvailableModels() || [
  { id: 'opencode/space-bunny-free', display_name: 'Space Bunny (Free)' },
];
console.log(`[coc-bridge] Loaded ${OPENCODE_MODELS.length} model(s) from opencode`);

// Refresh model list periodically (every 10 min) without restarting the server
setInterval(() => {
  const fresh = fetchAvailableModels();
  if (fresh && fresh.length > 0) {
    OPENCODE_MODELS = fresh;
    console.log(`[coc-bridge] Refreshed model list: ${OPENCODE_MODELS.length} model(s)`);
  }
}, 10 * 60 * 1000);

// ─── Model resolution ─────────────────────────────────────────────────────────
// Resolves whatever Claude Code sends (full id, short name, or Claude tier name)
// to the actual opencode model string.
function resolveModel(requested) {
  if (!requested) return DEFAULT_MODEL;

  // Exact match in the live model list
  if (OPENCODE_MODELS.some(m => m.id === requested)) return requested;

  // Any opencode/ prefixed id is passed through directly (user might have
  // models not yet in the cached list, e.g. just added a provider)
  if (requested.startsWith('opencode/') || requested.includes('/')) return requested;

  const lower = requested.toLowerCase();

  // Substring fuzzy match against known model ids
  const fuzzy = OPENCODE_MODELS.find(m => m.id.toLowerCase().includes(lower));
  if (fuzzy) return fuzzy.id;

  // Claude Code tier names → sensible defaults (user can override with config)
  const tierMap = config.tierMap || {};
  const builtinTierMap = {
    'opus':   config.opusModel   || OPENCODE_MODELS.find(m => m.id.includes('nemotron') && m.id.includes('ultra'))?.id || DEFAULT_MODEL,
    'sonnet': config.sonnetModel || OPENCODE_MODELS.find(m => m.id.includes('muse') || m.id.includes('spark'))?.id     || DEFAULT_MODEL,
    'haiku':  config.haikuModel  || OPENCODE_MODELS.find(m => m.id.includes('cat') || m.id.includes('jam'))?.id        || DEFAULT_MODEL,
    'fable':  config.fableModel  || OPENCODE_MODELS.find(m => m.id.includes('ling') || m.id.includes('flash'))?.id     || DEFAULT_MODEL,
  };
  for (const [tier, target] of Object.entries({ ...builtinTierMap, ...tierMap })) {
    if (lower.includes(tier)) return target;
  }

  return DEFAULT_MODEL;
}


/**
 * Convert Anthropic message format into a clean prompt string for OpenCode CLI
 */
function buildPrompt(body) {
  let promptParts = [];

  // Add system instruction if present
  if (body.system) {
    if (typeof body.system === 'string') {
      promptParts.push(`[System Instructions]\n${body.system}\n`);
    } else if (Array.isArray(body.system)) {
      const sysText = body.system.map(s => s.text || '').join('\n');
      if (sysText.trim()) {
        promptParts.push(`[System Instructions]\n${sysText}\n`);
      }
    }
  }

  // Add messages history
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const role = msg.role === 'assistant' ? 'Assistant' : 'User';
      let content = '';

      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = msg.content
          .map(part => {
            if (part.type === 'text') {
              return part.text || '';
            }
            if (part.type === 'tool_use') {
              const input = typeof part.input === 'object' ? JSON.stringify(part.input) : (part.input || '');
              return `[Executed Tool: ${part.name}(${input})]`;
            }
            if (part.type === 'tool_result') {
              const resContent = typeof part.content === 'string' ? part.content : JSON.stringify(part.content || '');
              return `[Tool Result: ${resContent}]`;
            }
            return '';
          })
          .filter(Boolean)
          .join('\n');
      }

      if (content.trim()) {
        promptParts.push(`${role}: ${content}`);
      }
    }
  }

  // If there's an agent prompt turn, make sure Assistant is ready to answer
  promptParts.push('Assistant:');
  return promptParts.join('\n\n');
}

/**
 * Handle POST /v1/messages (Anthropic API compatible)
 */
function handleMessagesRequest(req, res, reqBody) {
  let body;
  try {
    body = JSON.parse(reqBody);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON body' } }));
    return;
  }

  const modelName = resolveModel(body.model);
  const prompt = buildPrompt(body);
  const isStreaming = Boolean(body.stream);
  const messageId = `msg_${crypto.randomBytes(12).toString('hex')}`;

  console.log(`[Bridge] Incoming request for model: ${modelName} (requested: ${body.model || 'none'}, streaming=${isStreaming})`);

  // Spawn OpenCode CLI as child process
  const child = spawn(OPENCODE_BIN, ['run', '-m', modelName], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env }
  });

  // Request timeout safety (default 5 minutes)
  const timeoutMs = parseInt(process.env.BRIDGE_TIMEOUT_MS || '300000', 10);
  const timer = setTimeout(() => {
    if (!child.killed) {
      console.warn(`[Bridge] Request timed out after ${timeoutMs}ms, terminating child process`);
      child.kill('SIGTERM');
    }
  }, timeoutMs);

  // Clean up child process if client disconnects early
  res.on('close', () => {
    clearTimeout(timer);
    if (!res.writableEnded && !child.killed) {
      console.warn(`[Bridge] Client connection closed prematurely, terminating child process`);
      child.kill('SIGTERM');
    }
  });

  // Write prompt to stdin and close
  child.stdin.write(prompt);
  child.stdin.end();

  let accumulatedOutput = '';
  let accumulatedError = '';

  if (isStreaming) {
    // Anthropic SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // 1. message_start
    res.write(`event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: modelName,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: 1 }
      }
    })}\n\n`);

    // 2. content_block_start
    res.write(`event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    })}\n\n`);

    // Stream chunks as they arrive from OpenCode stdout
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      accumulatedOutput += text;
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: text }
      })}\n\n`);
    });

    child.stderr.on('data', chunk => {
      accumulatedError += chunk.toString();
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !accumulatedOutput.trim()) {
        console.error(`[Bridge] OpenCode exited with code ${code}: ${accumulatedError}`);
        const errMsg = accumulatedError.trim() || `OpenCode CLI process exited with code ${code}`;
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: errMsg } })}\n\n`);
        res.end();
        return;
      }

      // 3. content_block_stop
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0
      })}\n\n`);

      // 4. message_delta
      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: Math.ceil(accumulatedOutput.length / 4) }
      })}\n\n`);

      // 5. message_stop
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();
    });

  } else {
    // Non-streaming response
    child.stdout.on('data', chunk => {
      accumulatedOutput += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      accumulatedError += chunk.toString();
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !accumulatedOutput.trim()) {
        console.error(`[Bridge] OpenCode exited with code ${code}: ${accumulatedError}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            type: 'api_error',
            message: accumulatedError.trim() || `OpenCode CLI failed with exit code ${code}`
          }
        }));
        return;
      }

      const responsePayload = {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: modelName,
        content: [
          {
            type: 'text',
            text: accumulatedOutput.trim()
          }
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: Math.ceil(prompt.length / 4),
          output_tokens: Math.ceil(accumulatedOutput.length / 4)
        }
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responsePayload));
    });
  }
}

// HTTP Server
const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  // Health check
  if (req.method === 'GET' && (url === '/' || url === '/health' || url === '/api/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'opencode-claude-bridge',
      defaultModel: DEFAULT_MODEL,
      availableModels: OPENCODE_MODELS.map(m => m.id),
      opencodeBinary: OPENCODE_BIN
    }));
    return;
  }

  // Model discovery endpoint for Claude Code (/v1/models)
  if (req.method === 'GET' && (url === '/v1/models' || url === '/api/v1/models' || url === '/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: OPENCODE_MODELS.map(m => ({
        id: m.id,
        display_name: m.display_name,
        type: 'model',
        created_at: 1728864000
      }))
    }));
    return;
  }

  // Handle Anthropic /v1/messages or /api/v1/messages
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
      const rawBody = Buffer.concat(chunks).toString('utf8');
      handleMessagesRequest(req, res, rawBody);
    });
    return;
  }

  // Fallback 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `Route ${req.method} ${url} not found` } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`=======================================================`);
  console.log(` [OpenCode-Claude Bridge] listening on http://127.0.0.1:${PORT}`);
  console.log(` Default model: ${DEFAULT_MODEL}`);
  console.log(` Model discovery: http://127.0.0.1:${PORT}/v1/models`);
  console.log(` Compatible endpoint: http://127.0.0.1:${PORT}/v1/messages`);
  console.log(`=======================================================`);
});
