#!/usr/bin/env node
const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');

const PORT = parseInt(process.env.BRIDGE_PORT || process.env.PORT || '4045', 10);
const OPENCODE_BIN = process.env.OPENCODE_BIN || '/home/alan/.nvm/versions/node/v24.21.0/bin/opencode';
const DEFAULT_MODEL = process.env.OPENCODE_MODEL || 'opencode/space-bunny-free';
const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50MB max request size

// List of available OpenCode free models for Claude Code's model discovery (/model)
const OPENCODE_MODELS = [
  { id: 'opencode/space-bunny-free', display_name: 'Space Bunny (Free - Default)' },
  { id: 'opencode/cat-jam-free', display_name: 'Cat Jam (Free)' },
  { id: 'opencode/muse-spark-1.3-contributor-free', display_name: 'Muse Spark 1.3 (Free - Meta Reasoning)' },
  { id: 'opencode/nemotron-3-ultra-free', display_name: 'NVIDIA Nemotron 3 Ultra (Free)' },
  { id: 'opencode/nemotron-3.5-lightning-free', display_name: 'NVIDIA Nemotron 3.5 Lightning (Free)' },
  { id: 'opencode/ling-3.1-flash-free', display_name: 'Ling 3.1 Flash (Free)' },
  { id: 'opencode/longcat-2.5-preview-free', display_name: 'Longcat 2.5 Preview (Free)' },
  { id: 'opencode/mimo-v2.6-flash-free', display_name: 'Mimo 2.6 Flash (Free)' },
  { id: 'opencode/big-pickle', display_name: 'Big Pickle (Free)' }
];

// Map shortcuts, aliases, and standard Anthropic menu names to OpenCode models
const MODEL_ALIASES = {
  // OpenCode aliases
  'space-bunny': 'opencode/space-bunny-free',
  'space-bunny-free': 'opencode/space-bunny-free',
  'cat-jam': 'opencode/cat-jam-free',
  'cat-jam-free': 'opencode/cat-jam-free',
  'muse-spark': 'opencode/muse-spark-1.3-contributor-free',
  'muse-spark-1.3': 'opencode/muse-spark-1.3-contributor-free',
  'nemotron': 'opencode/nemotron-3-ultra-free',
  'nemotron-ultra': 'opencode/nemotron-3-ultra-free',
  'nemotron-lightning': 'opencode/nemotron-3.5-lightning-free',
  'ling-flash': 'opencode/ling-3.1-flash-free',
  'longcat': 'opencode/longcat-2.5-preview-free',
  'mimo': 'opencode/mimo-v2.6-flash-free',
  'big-pickle': 'opencode/big-pickle',

  // Standard VS Code dropdown menu selections mapped to best OpenCode models
  'opus': 'opencode/nemotron-3-ultra-free',
  'claude-3-opus': 'opencode/nemotron-3-ultra-free',
  'claude-opus-5': 'opencode/nemotron-3-ultra-free',
  'claude-opus-5-5': 'opencode/nemotron-3-ultra-free',
  'sonnet': 'opencode/muse-spark-1.3-contributor-free',
  'claude-3-5-sonnet': 'opencode/muse-spark-1.3-contributor-free',
  'claude-sonnet-5-5': 'opencode/muse-spark-1.3-contributor-free',
  'haiku': 'opencode/cat-jam-free',
  'claude-3-5-haiku': 'opencode/cat-jam-free',
  'claude-haiku-5-5': 'opencode/cat-jam-free',
  'fable': 'opencode/ling-3.1-flash-free',
  'claude-3-5-fable': 'opencode/ling-3.1-flash-free',
  'claude-fable-5-1': 'opencode/ling-3.1-flash-free'
};

function resolveModel(requestedModel) {
  if (!requestedModel) return DEFAULT_MODEL;

  // Exact match against known models
  if (OPENCODE_MODELS.some(m => m.id === requestedModel)) return requestedModel;
  
  const lower = requestedModel.toLowerCase();
  if (MODEL_ALIASES[lower]) return MODEL_ALIASES[lower];

  for (const [alias, fullId] of Object.entries(MODEL_ALIASES)) {
    if (lower.includes(alias)) return fullId;
  }
  
  if (requestedModel.startsWith('opencode/')) return requestedModel;
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
