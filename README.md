# coc-bridge 🔌✨

> **Just two agents. One little secret 🔥**

Claude Code wanted to hang out with OpenCode. OpenCode wanted to hang out with Claude Code.  
So we built the handshake. 🥂

---

### What is this? 💡

`coc-bridge` is a lightweight local proxy that connects the **Claude Code** CLI directly to **OpenCode**.

You get:
* 🪄 Claude Code's terminal UX & workflow
* ⚡ OpenCode powering the backend
* 💸 Zero setup headaches, zero extra friction

```
Claude Code ──( Anthropic Format )──> coc-bridge ──> OpenCode
Claude Code <──( Stream Output )───── coc-bridge <── OpenCode
```

---

### Quick Start 🏁

#### 1. Fire up the bridge 🔌
```bash
git clone https://github.com/allannuwamanya/coc-bridge.git
cd coc-bridge
./start.sh
```
The bridge will start chilling on `http://127.0.0.1:4045`.

#### 2. Connect Claude Code 🤖
In your working terminal, point Claude Code to the bridge:
```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:4045"
export ANTHROPIC_AUTH_TOKEN="coc-local"

claude
```

That’s it! Claude Code is now running through OpenCode. 🎉

---

### Verify It Works 🧪

Want to see it in action before launching?
```bash
node test-client.js
```
If you see the response stream in, you're good to go! 🟢

---

### License 📄
MIT — Go build cool stuff. 🚀
