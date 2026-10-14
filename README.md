# coc-bridge 🔌

> **Claude Code ↔ OpenCode. Zero API keys. All free.**

[![npm](https://img.shields.io/npm/v/coc-bridge.svg)](https://www.npmjs.com/package/coc-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node ≥18](https://img.shields.io/badge/Node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

`coc-bridge` is a tiny local proxy that lets **Claude Code** use **OpenCode's free hosted models** — no Anthropic API key, no billing, no friction.

```
Claude Code ──( Anthropic format )──► coc-bridge ──► opencode run -m <model>
Claude Code ◄──( SSE stream      )─── coc-bridge ◄── model output
```

---

## ✨ Features

- **Zero dependencies** — pure Node.js, nothing to `npm install`
- **Drop-in replacement** — Claude Code doesn't know the difference
- **9 free models** out of the box (Space Bunny, Cat Jam, Nemotron Ultra, Muse Spark, and more)
- **Full streaming** — Anthropic SSE events, same as the real API
- **VS Code model picker** — custom model names show up in the sidebar dropdown
- **Auto-start** — the bridge starts itself when you run `claude`, so you never have to think about it
- **`coc-bridge doctor`** — one command checks everything is working

---

## 🚀 Quick start (3 steps)

### Step 1 — Install opencode

```bash
npm install -g opencode
```

> opencode is the only runtime requirement. coc-bridge itself has zero dependencies.

### Step 2 — Install coc-bridge

```bash
npm install -g coc-bridge
```

### Step 3 — Run setup

```bash
coc-bridge setup
```

That's it. From now on, running `claude` will automatically start the bridge and use free OpenCode models. 🎉

---

## 🧪 Verify it's working

```bash
coc-bridge doctor
```

```
coc-bridge doctor 🩺

  ✔  Node.js                         v24.21.0
  ✔  opencode                        0.3.x
  ✔  claude wrapper                  /usr/local/bin/claude (patched ✓)
  ✔  Bridge server                   http://127.0.0.1:4045 ✓
  ✔  Default model                   opencode/space-bunny-free
  ✔  Available models                9 models
  ✔  Log directory                   /home/you/.coc-bridge

Everything looks great! 🎉
```

Or run the full test suite:

```bash
npm test
```

---

## 🎛️ Available models

| Short name       | Full OpenCode ID                                  | Best for                        |
| :--------------- | :------------------------------------------------ | :------------------------------ |
| `space-bunny`    | `opencode/space-bunny-free`                       | General coding (default)        |
| `cat-jam`        | `opencode/cat-jam-free`                           | Fast edits & quick answers      |
| `muse-spark`     | `opencode/muse-spark-1.3-contributor-free`        | Reasoning & architecture        |
| `nemotron`       | `opencode/nemotron-3-ultra-free`                  | Deep reasoning (NVIDIA 500B)    |
| `nemotron-lightning` | `opencode/nemotron-3.5-lightning-free`        | Fast NVIDIA model               |
| `ling-flash`     | `opencode/ling-3.1-flash-free`                    | High-throughput tasks           |
| `longcat`        | `opencode/longcat-2.5-preview-free`               | Long-context tasks              |
| `mimo`           | `opencode/mimo-v2.6-flash-free`                   | Multimodal flash                |
| `big-pickle`     | `opencode/big-pickle`                             | 🥒                              |

**VS Code dropdown** maps to:
| Claude Code menu | Resolves to                                          |
| :--------------- | :--------------------------------------------------- |
| Opus             | `opencode/nemotron-3-ultra-free` (Nemotron 3 Ultra)  |
| Sonnet           | `opencode/muse-spark-1.3-contributor-free` (Muse Spark 1.3) |
| Haiku            | `opencode/cat-jam-free` (Cat Jam)                    |
| Fable            | `opencode/ling-3.1-flash-free` (Ling 3.1 Flash)     |
| Custom           | `opencode/space-bunny-free` (Space Bunny)            |

---

## ⚙️ Configuration

All configuration is via environment variables — no config files.

| Variable             | Default                        | Description                                  |
| :------------------- | :----------------------------- | :------------------------------------------- |
| `BRIDGE_PORT`        | `4045`                         | Port the bridge listens on                   |
| `OPENCODE_MODEL`     | `opencode/space-bunny-free`    | Default model when none is requested         |
| `OPENCODE_BIN`       | auto-detected                  | Path to the `opencode` binary                |
| `BRIDGE_TIMEOUT_MS`  | `300000` (5 min)               | Max time per request before killing the child process |

### Use a custom port

```bash
BRIDGE_PORT=5000 coc-bridge
```

### Use a specific model as default

```bash
OPENCODE_MODEL=opencode/nemotron-3-ultra-free coc-bridge
```

---

## 🛠️ Manual setup (without `coc-bridge setup`)

If you prefer not to let the installer touch your `claude` binary:

```bash
# Terminal 1 — start the bridge
coc-bridge

# Terminal 2 — set env vars and launch Claude Code
export ANTHROPIC_BASE_URL="http://127.0.0.1:4045"
export ANTHROPIC_AUTH_TOKEN="coc-local"
claude
```

---

## 🗂️ Project structure

```
coc-bridge/
├── bin/
│   └── coc-bridge.js        # CLI entry point
├── src/
│   └── server.js            # Bridge proxy server
├── scripts/
│   ├── setup-claude.js      # Wraps the claude binary
│   └── doctor.js            # Health check utility
├── test/
│   └── test-client.js       # Test suite
├── CHANGELOG.md
├── CONTRIBUTING.md
└── LICENSE
```

---

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome — especially new model aliases and better error messages.

---

## 📄 License

[MIT](LICENSE) © Allan Nuwamanya
