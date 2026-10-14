# Contributing to coc-bridge 🤝

First off — thanks for taking the time! 🙏

## Ground rules

- Zero runtime dependencies. If a feature needs a package, make the case for it first.
- Keep the code readable and the comments honest.
- Every feature or bugfix gets a test in `test/test-client.js`.

## Getting started

```bash
git clone https://github.com/allannuwamanya/coc-bridge.git
cd coc-bridge
npm test     # make sure existing tests pass before changing anything
```

## Making changes

1. **Fork** the repo and create a branch: `git checkout -b feat/my-thing`
2. Edit files under `src/`, `bin/`, or `scripts/`.
3. Run `npm test` — all four tests must pass.
4. Commit with a meaningful message (`feat:`, `fix:`, `docs:`, `chore:` prefixes welcome).
5. Open a **pull request** against `main`.

## Reporting issues

Open an [issue](https://github.com/allannuwamanya/coc-bridge/issues) and include:
- Your OS + Node version (`node -v`)
- Your opencode version (`opencode --version`)
- The output of `coc-bridge doctor`
- Steps to reproduce

## Adding a new OpenCode model

Edit the `OPENCODE_MODELS` array and `MODEL_ALIASES` map in [`src/server.js`](src/server.js),
then add the model to the help text in [`bin/coc-bridge.js`](bin/coc-bridge.js).

## Code style

Plain ES2020 — `const`, arrow functions, template literals, `async/await`.  
No transpiler, no build step, no bundler. What you write is what runs.
