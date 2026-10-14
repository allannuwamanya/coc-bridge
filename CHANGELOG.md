# Changelog

All notable changes to coc-bridge are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.5] — 2026-10-15

### Added
- **Full Thinking & Reasoning Streaming**: Added `--thinking` flag to OpenCode execution, capturing model reasoning blocks (`ev.type === 'reasoning'`) and streaming them in Anthropic's extended thinking SSE protocol (`content_block_start` with `type: "thinking"` and `thinking_delta`). Claude Code now displays live collapsible "Thinking..." dropdown boxes just like native Claude 3.7 Thinking.

## [1.0.4] — 2026-10-15

### Fixed
- **Edit Tool Parameter Mapping**: Fixed critical bug where OpenCode's camelCase parameters (`oldString`, `newString`, `replaceAll`) resulted in empty string replacements in Claude Code, causing all file edits to fail with "Edit failed".
- **Dynamic Project Directory Detection**: Automatically extracts the user's active workspace directory from Claude Code's system prompt and message history, preventing OpenCode from running in the bridge's home folder.
- **Smart Path Resolution**: Recursively searches the workspace for file basenames (e.g. `AntigravityTitleBar.tsx` → `frontend/src/components/layout/AntigravityTitleBar.tsx`) so edits and reads target the exact workspace path.
- **Eliminated 5-Minute Retry Loops**: Fixed endless tool retry cycles that caused `API Error: Connection lost mid-response` timeouts.

## [1.0.3] — 2026-10-15

### Fixed
- **VS Code Extension Live Tool Calls**: Intercepts OpenCode native tool events in real time and immediately maps and forwards them as Anthropic SSE `tool_use` events (`Read`, `Bash`, `Glob`, `Grep`, `Edit`, `Write`) so Claude Code's extension displays live tool execution spinners, diffs, and approval prompts.
- **Accurate `stop_reason` Logic**: Fixed a bug where text blocks triggered an erroneous `stop_reason: "tool_use"`, ensuring Claude Code correctly transitions between tool execution turns and final answers (`stop_reason: "end_turn"`).
- **Multi-Turn Tool Result Handling**: Suppressed trailing text on tool_use pauses to prevent duplicate responses when Claude Code returns tool results.
- **Real-Time Text Streaming**: Stream text deltas immediately for tool-free chat requests without blocking until process exit.
- **Environment PATH Resilience**: Ensured child process PATH includes the node binary directory for headless and IDE extension invocations.

## [1.0.2] — 2026-10-14

### Added
- **Claude Code Tool Control**: Claude Code now retains 100% control of tool execution (`View`, `Edit`, `Bash`, `Glob`, `Grep`, `Write`), showing interactive diffs, user permission confirmations, and spinners instead of OpenCode silently intercepting them
- **Anthropic `tool_use` Event Streaming**: Bridges model responses directly to Anthropic SSE tool use events (`content_block_start`, `input_json_delta`, `message_delta` with `stop_reason: "tool_use"`)
- **Accurate Real-Time Token Counts**: Extracted directly from model execution metrics rather than estimated token formulas
- **`coc-bridge restore` command**: One-command rollback to revert Claude Code & VS Code back to official Anthropic defaults with zero friction
- **Automatic VS Code Settings**: Configures Claude Code VS Code extension settings with robust JSONC comment-stripping support
- **`coc-bridge models` & `coc-bridge use <id>`**: Live discovery and switching of default models saved to `~/.coc-bridge/config.json`

## [1.0.1] — 2026-10-14

### Fixed
- Fixed global CLI bin symlink path in `package.json` for seamless `npm install -g coc-bridge` installation
- Dynamic model discovery from `opencode models`
- Added `coc-bridge models` and `coc-bridge use <model-id>` commands
- Full daemon backgrounding with `coc-bridge start/stop/status/restart/logs`

## [1.0.0] — 2026-10-14

### Added
- Initial public release 🎉
- Zero-dependency HTTP proxy serving the Anthropic `/v1/messages` and `/v1/models` API
- Streaming SSE support (`message_start → content_block_delta → message_stop`)
- Non-streaming JSON response support
- Model discovery endpoint (`GET /v1/models`) for Claude Code's `/model` picker
- 9 OpenCode free models available out of the box
- Model alias table: short names (`cat-jam`, `nemotron`, `muse-spark`, etc.) and Claude tier names (`opus`, `sonnet`, `haiku`, `fable`) all resolve correctly
- Auto-detection of `opencode` binary from `$PATH`, NVM locations, and common paths
- `coc-bridge setup` — wraps the `claude` binary to auto-start the bridge and inject all env vars
- `coc-bridge doctor` — checks Node.js version, opencode presence, claude wrapper status, bridge health, and log directory
- `coc-bridge help` — full CLI help with all env vars and model list
- 5-minute request timeout with `BRIDGE_TIMEOUT_MS` override
- 50MB payload cap with `413` response
- Client disconnect detection — kills orphan opencode child processes immediately
- `tool_use` block support in `buildPrompt()` — preserves full agent tool-call history across turns
- CORS headers for VS Code extension compatibility
- `npm test` four-test suite: health, model discovery, non-streaming, streaming SSE

[1.0.0]: https://github.com/allannuwamanya/coc-bridge/releases/tag/v1.0.0
