# Changelog

All notable changes to coc-bridge are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

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
