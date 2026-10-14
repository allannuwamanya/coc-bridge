#!/usr/bin/env node
const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');

const PORT = parseInt(process.env.BRIDGE_PORT || process.env.PORT || '4045', 10);
const OPENCODE_BIN = process.env.OPENCODE_BIN || '/home/alan/.nvm/versions/node/v24.21.0/bin/opencode';
const DEFAULT_MODEL = process.env.OPENCODE_MODEL || 'opencode/space-bunny-free';

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
            if (part.type === 'text') return part.text || '';
            if (part.type === 'tool_result') return `[Tool Result: ${part.content || ''}]`;
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

  // Determine model: if requested model starts with "opencode/", use it directly;
  // otherwise default to space-bunny-free (or configured default)
  let modelName = body.model || DEFAULT_MODEL;
  if (!modelName.startsWith('opencode/')) {
    modelName = DEFAULT_MODEL;
  }

  const prompt = buildPrompt(body);
  const isStreaming = Boolean(body.stream);
  const messageId = `msg_${crypto.randomBytes(12).toString('hex')}`;

  console.log(`[Bridge] Incoming request for model: ${modelName} (streaming=${isStreaming})`);

  // Spawn OpenCode CLI as child process
  const child = spawn(OPENCODE_BIN, ['run', '-m', modelName], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env }
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
      opencodeBinary: OPENCODE_BIN
    }));
    return;
  }

  // Handle Anthropic /v1/messages or /api/v1/messages
  if (req.method === 'POST' && (url === '/v1/messages' || url === '/api/v1/messages')) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
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
  console.log(` Compatible endpoint: http://127.0.0.1:${PORT}/v1/messages`);
  console.log(`=======================================================`);
});
