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

  // 1. Tool names allowed
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    for (const tool of body.tools) {
      if (tool && tool.name) allowedTools.push(tool.name);
    }
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
 * Map an OpenCode-native tool name + input to the Claude Code equivalent.
 */
function mapOpenCodeTool(toolName, input, allowedTools, projectDir) {
  const norm = (toolName || '').toLowerCase();

  function cleanPath(p) {
    if (!p) return '';
    if (p.startsWith(projectDir)) return p.slice(projectDir.length).replace(/^\/+/, '');
    const SANDBOX_DIR_PATH = require('path').join(require('os').tmpdir(), 'coc-bridge-sandbox');
    if (p.startsWith(SANDBOX_DIR_PATH)) return p.slice(SANDBOX_DIR_PATH.length).replace(/^\/+/, '');
    return p;
  }

  const find = (...names) =>
    (allowedTools && allowedTools.find(t => names.includes(t.toLowerCase()))) || names[0];

  if (norm === 'read' || norm === 'view') {
    return { name: find('read', 'view'), input: { file_path: cleanPath(input.path || input.file_path || '.') } };
  }
  if (norm === 'shell' || norm === 'bash') {
    return { name: find('bash', 'shell'), input: { command: input.command || input.cmd || '' } };
  }
  if (norm === 'glob' || norm === 'list') {
    return { name: find('glob'), input: { pattern: input.pattern || '*', path: cleanPath(input.path || '.') } };
  }
  if (norm === 'grep' || norm === 'search') {
    return { name: find('grep'), input: { pattern: input.pattern || '', path: cleanPath(input.path || '.') } };
  }
  if (norm === 'edit' || norm === 'str_replace') {
    return {
      name: find('edit', 'str_replace_based_edit_tool'),
      input: {
        file_path: cleanPath(input.path || input.file_path || ''),
        old_string: input.old_string || input.original || '',
        new_string: input.new_string || input.replacement || ''
      }
    };
  }
  if (norm === 'write' || norm === 'create') {
    return {
      name: find('write', 'create'),
      input: { file_path: cleanPath(input.path || input.file_path || ''), content: input.content || '' }
    };
  }
  if (norm === 'patch' || norm === 'multiedit') {
    return { name: find('multiedit', 'patch'), input };
  }
  return { name: toolName, input };
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

  // ── Determine working directory ──────────────────────────────────────────────
  // Claude Code passes an x-opencode-directory header with its project path.
  // Fall back to the bridge process cwd (user's project when run from terminal).
  const projectDir =
    req.headers['x-opencode-directory'] ||
    req.headers['x-project-directory'] ||
    process.env.CLAUDE_DIR ||
    process.cwd();

  console.log(`[Bridge] Request: ${modelName} (tools: ${allowedTools.length}, streaming=${isStreaming}, dir=${projectDir})`);

  // ── Spawn opencode ────────────────────────────────────────────────────────────
  // --standalone: own private server, no port conflict with background opencode.
  const childArgs = ['run', '-m', modelName, '--format', 'json'];
  // Note: --standalone may not be supported by all opencode versions; try without if it fails
  const binDir = path.dirname(OPENCODE_BIN);
  const childEnv = {
    ...process.env,
    PATH: binDir + (process.env.PATH ? path.delimiter + process.env.PATH : '')
  };
  const child = spawn(OPENCODE_BIN, childArgs, {
    cwd: projectDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv
  });

  // Request timeout safety (default 5 minutes)
  const timeoutMs = parseInt(process.env.BRIDGE_TIMEOUT_MS || '300000', 10);
  const timer = setTimeout(() => {
    if (!child.killed) {
      console.warn(`[Bridge] Request timed out after ${timeoutMs}ms, terminating child process`);
      child.kill('SIGTERM');
    }
  }, timeoutMs);

  // ── SSE state ─────────────────────────────────────────────────────────────────
  let sseStarted = false;
  let blockIndex = 0;
  let textBlockIndex = -1;
  let inputTokens = Math.ceil(prompt.length / 4);
  let outputTokens = 0;
  let accumulatedText = '';
  let reportedTokens = null;
  let clientClosed = false;
  let nativeToolsEmitted = 0; // count of tool_use events from OpenCode

  function startSSE() {
    if (sseStarted || !isStreaming) return;
    sseStarted = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
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
  }

  function sseWrite(event, data) {
    if (clientClosed) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  }

  function emitToolUse(toolName, toolInput) {
    if (!isStreaming) return;
    startSSE();
    const mapped = mapOpenCodeTool(toolName, toolInput || {}, allowedTools, projectDir);

    // Only emit if the tool is in Claude Code's allowed list
    const lcAllowed = allowedTools.map(t => t.toLowerCase());
    if (allowedTools.length > 0 && !lcAllowed.includes(mapped.name.toLowerCase())) {
      console.log(`[Bridge] Skipping tool not in allowed list: ${toolName} → ${mapped.name}`);
      return;
    }

    const toolUseId = `toolu_${crypto.randomBytes(12).toString('hex')}`;
    console.log(`[Bridge] ToolUse emit: ${toolName} → ${mapped.name}`);
    nativeToolsEmitted++;

    sseWrite('content_block_start', {
      type: 'content_block_start', index: blockIndex,
      content_block: { type: 'tool_use', id: toolUseId, name: mapped.name, input: {} }
    });
    sseWrite('content_block_delta', {
      type: 'content_block_delta', index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(mapped.input) }
    });
    sseWrite('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    blockIndex++;
  }

  function emitText(text) {
    if (!text || !text.trim() || !isStreaming) return;
    startSSE();
    sseWrite('content_block_start', {
      type: 'content_block_start', index: blockIndex,
      content_block: { type: 'text', text: '' }
    });
    sseWrite('content_block_delta', {
      type: 'content_block_delta', index: blockIndex,
      delta: { type: 'text_delta', text: text }
    });
    sseWrite('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    blockIndex++;
  }

  // ── Clean up if client disconnects ───────────────────────────────────────────
  res.on('close', () => {
    clientClosed = true;
    clearTimeout(timer);
    if (!child.killed) child.kill('SIGTERM');
  });

  child.stdin.write(prompt);
  child.stdin.end();

  let stdoutBuffer = '';
  let accumulatedError = '';
  const pendingTools = new Map(); // toolId → { toolName, input }

  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (_) { continue; }

      // ── OpenCode native tool events ──────────────────────────────────────
      if (ev.type === 'tool_use' && ev.part) {
        const part      = ev.part;
        const toolName  = part.tool || part.name || '';
        const toolState = part.state || {};
        const toolId    = part.id || part.tool_use_id || `${toolName}_${Date.now()}`;

        const status = toolState.status || '';
        if (status === 'running' || status === 'pending') {
          // Tool started — remember, emit on completion (so we have full input)
          pendingTools.set(toolId, { toolName, input: toolState.input || {} });
        } else if (status === 'completed' || status === 'error') {
          const input = toolState.input || (pendingTools.get(toolId) || {}).input || {};
          pendingTools.delete(toolId);
          emitToolUse(toolName, input);
        } else {
          // No explicit status — emit immediately
          emitToolUse(toolName, toolState.input || {});
        }
      }

      // ── Model text ───────────────────────────────────────────────────────
      if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string') {
        accumulatedText += ev.part.text;
        if (isStreaming && allowedTools.length === 0) {
          if (!sseStarted) startSSE();
          if (textBlockIndex === -1) {
            textBlockIndex = blockIndex++;
            sseWrite('content_block_start', {
              type: 'content_block_start',
              index: textBlockIndex,
              content_block: { type: 'text', text: '' }
            });
          }
          sseWrite('content_block_delta', {
            type: 'content_block_delta',
            index: textBlockIndex,
            delta: { type: 'text_delta', text: ev.part.text }
          });
        }
      }

      // ── Token counts ─────────────────────────────────────────────────────
      if (ev.type === 'step_finish' && ev.part && ev.part.tokens) {
        reportedTokens = ev.part.tokens;
      }
    }
  });

  child.stderr.on('data', chunk => {
    accumulatedError += chunk.toString();
  });

  child.on('close', code => {
    clearTimeout(timer);
    if (clientClosed) return;

    // Flush any remaining buffered line
    if (stdoutBuffer.trim()) {
      try {
        const ev = JSON.parse(stdoutBuffer);
        if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string') {
          accumulatedText += ev.part.text;
        } else if (ev.type === 'step_finish' && ev.part && ev.part.tokens) {
          reportedTokens = ev.part.tokens;
        } else if (ev.type === 'tool_use' && ev.part) {
          const part = ev.part;
          const toolState = part.state || {};
          emitToolUse(part.tool || '', toolState.input || {});
        }
      } catch (_) {}
    }

    // Error: process failed, nothing useful
    if (code !== 0 && !accumulatedText.trim() && nativeToolsEmitted === 0) {
      console.error(`[Bridge] OpenCode exited with code ${code}: ${accumulatedError}`);
      const errMsg = accumulatedError.trim() || `OpenCode process exited with code ${code}`;
      if (isStreaming) {
        if (!sseStarted) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: errMsg } })}\n\n`);
        res.end();
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'api_error', message: errMsg } }));
      }
      return;
    }

    // Token accounting
    inputTokens  = (reportedTokens && reportedTokens.input)  || Math.ceil(prompt.length / 4);
    outputTokens = (reportedTokens && reportedTokens.output)
      ? (reportedTokens.output + (reportedTokens.reasoning || 0))
      : Math.ceil(accumulatedText.length / 4);

    if (isStreaming) {
      let hasToolCalls = false;
      // If no native tool events came from OpenCode, try text-based tool_call fallback
      if (nativeToolsEmitted === 0) {
        const { text: cleanText, toolCalls: textToolCalls } = extractToolCalls(accumulatedText, allowedTools);
        if (textToolCalls.length > 0) {
          hasToolCalls = true;
          if (cleanText.length > 0) emitText(cleanText);
          for (const tc of textToolCalls) emitToolUse(tc.name, tc.input);
        } else {
          // If text wasn't already streamed in real-time, emit it now
          if (textBlockIndex === -1) {
            emitText(accumulatedText);
          } else {
            sseWrite('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
          }
        }
      } else {
        hasToolCalls = true;
        // Native tool_use blocks were already emitted during the stream.
        // We do not emit trailing text here because stop_reason is 'tool_use'
        // and Claude Code will execute the tool and request the final answer in Turn 2.
      }

      if (!sseStarted) startSSE();

      const stopReason = hasToolCalls ? 'tool_use' : 'end_turn';
      sseWrite('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens }
      });
      sseWrite('message_stop', { type: 'message_stop' });
      res.end();

    } else {
      // Non-streaming response
      const { text: cleanText, toolCalls: textToolCalls } = extractToolCalls(accumulatedText, allowedTools);
      const content = [];
      if (cleanText.length > 0) content.push({ type: 'text', text: cleanText });
      for (const tc of textToolCalls) {
        content.push({
          type: 'tool_use',
          id: `toolu_${crypto.randomBytes(12).toString('hex')}`,
          name: tc.name,
          input: tc.input
        });
      }
      if (content.length === 0) content.push({ type: 'text', text: accumulatedText.trim() });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: messageId, type: 'message', role: 'assistant', model: modelName, content,
        stop_reason: content.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens }
      }));
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
