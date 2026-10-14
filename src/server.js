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
const SANDBOX_DIR      = path.join(os.tmpdir(), 'coc-bridge-sandbox');
try { fs.mkdirSync(SANDBOX_DIR, { recursive: true }); } catch (_) {}

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
 * Extract tool calls from model output.
 * Supports:
 *  1. ```tool_call ... ``` or ```json ... ``` blocks
 *  2. <tool_call> ... </tool_call> XML tags
 *  3. Bare JSON object containing "name" and "input" matching an allowed tool
 */
function extractToolCalls(text, allowedTools = []) {
  if (!text) return { text: '', toolCalls: [] };
  const toolCalls = [];

  // 1. Match markdown blocks
  const blockRegex = /```(?:tool_call|json)?\s*\n?([\s\S]*?)\n?```/gi;
  let match;
  let textSegments = [];
  let lastIndex = 0;

  while ((match = blockRegex.exec(text)) !== null) {
    let isTool = false;
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
          isTool = true;
        }
      }
    } catch (_) {}
  }

  if (toolCalls.length > 0) {
    textSegments.push(text.slice(lastIndex));
    const cleanText = textSegments.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text: cleanText, toolCalls };
  }

  // 2. Match <tool_call> tags
  const xmlRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  lastIndex = 0;
  textSegments = [];
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
    const cleanText = textSegments.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text: cleanText, toolCalls };
  }

  // 3. Match bare JSON object with "name" and "input"
  const bareMatch = text.match(/(\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"input"\s*:\s*\{[\s\S]*?\}\s*\})/);
  if (bareMatch) {
    try {
      const parsed = JSON.parse(bareMatch[1].trim());
      if (parsed && typeof parsed.name === 'string' && parsed.input !== undefined) {
        const matchedTool = allowedTools.length === 0
          ? parsed.name
          : allowedTools.find(t => t.toLowerCase() === parsed.name.toLowerCase());
        if (matchedTool) {
          const pre = text.slice(0, bareMatch.index).trim();
          const post = text.slice(bareMatch.index + bareMatch[1].length).trim();
          return {
            text: [pre, post].filter(Boolean).join('\n'),
            toolCalls: [{ name: matchedTool, input: parsed.input }]
          };
        }
      }
    } catch (_) {}
  }

  return { text: text.trim(), toolCalls: [] };
}

/**
 * Convert Anthropic message format into a clean prompt string for OpenCode CLI,
 * with full tool schemas injected so Claude Code controls tool execution.
 */
function buildPrompt(body) {
  let promptParts = [];
  const allowedTools = [];

  // 1. Tool schemas and instructions
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    let toolsDesc = '## Available Tools & Instructions\n';
    toolsDesc += 'You are acting as the AI model for Claude Code. You do NOT have any built-in tools or direct filesystem access.\n';
    toolsDesc += 'Do NOT attempt to use any internal OpenCode tools (like read, glob, shell, or edit).\n';
    toolsDesc += 'Instead, to view files, make edits, run terminal commands, or list directories, you MUST emit a tool call in this exact JSON block:\n\n';
    toolsDesc += '```tool_call\n';
    toolsDesc += '{"name": "<ToolName>", "input": { ...arguments according to input schema... }}\n';
    toolsDesc += '```\n\n';
    toolsDesc += 'Claude Code will execute the tool on the user\'s local machine and return the result to you in the next message.\n';
    toolsDesc += 'When you have enough information to answer the user without tools, reply with your normal explanation and NO tool_call blocks.\n\n';
    toolsDesc += 'Tools available to request:\n';

    for (const tool of body.tools) {
      if (tool && tool.name) {
        allowedTools.push(tool.name);
        toolsDesc += `\n### Tool: ${tool.name}\n`;
        if (tool.description) toolsDesc += `Description: ${tool.description}\n`;
        if (tool.input_schema) toolsDesc += `Input Schema: ${JSON.stringify(tool.input_schema)}\n`;
      }
    }

    promptParts.push(`[System Instructions & Tools]\n${toolsDesc}\n`);
  }

  // 2. Add system prompt from Claude Code
  if (body.system) {
    let sysText = '';
    if (typeof body.system === 'string') {
      sysText = body.system;
    } else if (Array.isArray(body.system)) {
      sysText = body.system.map(s => (typeof s === 'string' ? s : (s.text || ''))).join('\n');
    }
    if (sysText.trim()) {
      promptParts.push(`[Claude Code Instructions]\n${sysText.trim()}\n`);
    }
  }

  // 3. Add message history
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const role = msg.role === 'assistant' ? 'Assistant' : 'User';

      if (typeof msg.content === 'string') {
        promptParts.push(`${role}: ${msg.content.trim()}`);
      } else if (Array.isArray(msg.content)) {
        let textParts = [];
        for (const part of msg.content) {
          if (part.type === 'text' && part.text) {
            textParts.push(part.text);
          } else if (part.type === 'tool_use') {
            textParts.push(`\`\`\`tool_call\n${JSON.stringify({ name: part.name, input: part.input })}\n\`\`\``);
          } else if (part.type === 'tool_result') {
            const resContent = typeof part.content === 'string'
              ? part.content
              : (Array.isArray(part.content)
                  ? part.content.map(c => c.text || JSON.stringify(c)).join('\n')
                  : JSON.stringify(part.content || ''));
            textParts.push(`[Tool Result for ${part.tool_use_id || 'tool'}]:\n${resContent}`);
          }
        }
        if (textParts.length > 0) {
          promptParts.push(`${role}: ${textParts.join('\n\n')}`);
        }
      }
    }
  }

  promptParts.push('Assistant:');
  return { prompt: promptParts.join('\n\n'), allowedTools };
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
  const { prompt, allowedTools } = buildPrompt(body);
  const isStreaming = Boolean(body.stream);
  const messageId = `msg_${crypto.randomBytes(12).toString('hex')}`;

  console.log(`[Bridge] Request: ${modelName} (tools: ${allowedTools.length}, streaming=${isStreaming})`);

  // Run in empty sandbox dir so OpenCode cannot touch user files directly
  const child = spawn(OPENCODE_BIN, ['run', '-m', modelName, '--format', 'json'], {
    cwd: SANDBOX_DIR,
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

  child.stdin.write(prompt);
  child.stdin.end();

  let stdoutBuffer = '';
  let accumulatedText = '';
  let accumulatedError = '';
  let reportedTokens = null;

  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop(); // keep partial line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string') {
          accumulatedText += ev.part.text;
        } else if (ev.type === 'step_finish' && ev.part && ev.part.tokens) {
          reportedTokens = ev.part.tokens;
        }
      } catch (_) {
        accumulatedText += line + '\n';
      }
    }
  });

  child.stderr.on('data', chunk => {
    accumulatedError += chunk.toString();
  });

  child.on('close', code => {
    clearTimeout(timer);

    // Process any remaining buffered stdout
    if (stdoutBuffer.trim()) {
      try {
        const ev = JSON.parse(stdoutBuffer);
        if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string') {
          accumulatedText += ev.part.text;
        } else if (ev.type === 'step_finish' && ev.part && ev.part.tokens) {
          reportedTokens = ev.part.tokens;
        }
      } catch (_) {
        accumulatedText += stdoutBuffer;
      }
    }

    if (code !== 0 && !accumulatedText.trim()) {
      console.error(`[Bridge] OpenCode exited with code ${code}: ${accumulatedError}`);
      const errMsg = accumulatedError.trim() || `OpenCode process exited with code ${code}`;
      if (isStreaming) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: errMsg } })}\n\n`);
        res.end();
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'api_error', message: errMsg } }));
      }
      return;
    }

    // Token accounting
    const inputTokens = (reportedTokens && reportedTokens.input) || Math.ceil(prompt.length / 4);
    const outputTokens = (reportedTokens && reportedTokens.output)
      ? (reportedTokens.output + (reportedTokens.reasoning || 0))
      : Math.ceil(accumulatedText.length / 4);

    // Extract tool calls
    const { text: cleanText, toolCalls } = extractToolCalls(accumulatedText, allowedTools);
    const hasToolCalls = toolCalls.length > 0;
    const stopReason = hasToolCalls ? 'tool_use' : 'end_turn';

    if (isStreaming) {
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
          usage: { input_tokens: inputTokens, output_tokens: 1 }
        }
      })}\n\n`);

      let blockIndex = 0;

      // 2. Text block (if clean text exists)
      if (cleanText.length > 0) {
        res.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'text', text: '' }
        })}\n\n`);

        res.write(`event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: cleanText }
        })}\n\n`);

        res.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index: blockIndex
        })}\n\n`);

        blockIndex++;
      }

      // 3. Tool use blocks
      for (const tc of toolCalls) {
        const toolUseId = `toolu_${crypto.randomBytes(12).toString('hex')}`;

        res.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: toolUseId,
            name: tc.name,
            input: {}
          }
        })}\n\n`);

        res.write(`event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: blockIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(tc.input)
          }
        })}\n\n`);

        res.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index: blockIndex
        })}\n\n`);

        blockIndex++;
      }

      // 4. message_delta
      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens }
      })}\n\n`);

      // 5. message_stop
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();

    } else {
      // Non-streaming response
      const content = [];
      if (cleanText.length > 0) {
        content.push({ type: 'text', text: cleanText });
      }
      for (const tc of toolCalls) {
        content.push({
          type: 'tool_use',
          id: `toolu_${crypto.randomBytes(12).toString('hex')}`,
          name: tc.name,
          input: tc.input
        });
      }
      if (content.length === 0) {
        content.push({ type: 'text', text: accumulatedText.trim() });
      }

      const responsePayload = {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: modelName,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens
        }
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responsePayload));
    }
  });
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
