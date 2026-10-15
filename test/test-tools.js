#!/usr/bin/env node
/**
 * coc-bridge — unit test suite for tool mapping & fallbacks
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { mapOpenCodeTool, extractToolCalls } = require('../src/server.js');

const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';

let passed = 0;
let failed = 0;

function it(name, fn) {
  try {
    fn();
    console.log(`  ${GREEN}✔ PASS${RESET} — ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ${RED}✖ FAIL${RESET} — ${name}`);
    console.error('   ', err.message);
    failed++;
  }
}

console.log(`\n${BOLD}coc-bridge unit tests (Tool Mapping & Fallbacks) 🧪${RESET}\n`);

// 1. Glob tool mapping
it('maps glob to Bash find command when Glob is not in allowedTools', () => {
  const allowed = ['Bash', 'Read', 'Edit', 'Write'];
  const res = mapOpenCodeTool('glob', { pattern: '*.js', path: 'src' }, allowed, __dirname);
  assert.strictEqual(res.name, 'Bash');
  assert.ok(res.input.command.includes('find "src" -name "*.js"'));
  assert.ok(res.input.command.includes('head -n 100'));
});

it('maps glob to Glob when Glob is in allowedTools', () => {
  const allowed = ['Glob', 'Bash', 'Read'];
  const res = mapOpenCodeTool('glob', { pattern: '*.ts', path: '.' }, allowed, __dirname);
  assert.strictEqual(res.name, 'Glob');
  assert.strictEqual(res.input.pattern, '*.ts');
});

it('handles recursive glob pattern with Bash find', () => {
  const allowed = ['Bash', 'Read'];
  const res = mapOpenCodeTool('glob', { pattern: '**/*.json' }, allowed, __dirname);
  assert.strictEqual(res.name, 'Bash');
  assert.ok(res.input.command.includes('find "." -name "*.json"'));
});

it('handles path pattern like src/**/*.ts with Bash find -path', () => {
  const allowed = ['Bash'];
  const res = mapOpenCodeTool('glob', { pattern: 'src/**/*.ts' }, allowed, __dirname);
  assert.strictEqual(res.name, 'Bash');
  assert.ok(res.input.command.includes('-path "*src/**/*.ts*"'));
});

// 2. Grep tool mapping
it('maps grep to Bash grep command when Grep is not in allowedTools', () => {
  const allowed = ['Bash', 'Read', 'Edit', 'Write'];
  const res = mapOpenCodeTool('grep', { pattern: 'function test', path: '.' }, allowed, __dirname);
  assert.strictEqual(res.name, 'Bash');
  assert.ok(res.input.command.includes('grep -rn'));
  assert.ok(res.input.command.includes('function test'));
  assert.ok(res.input.command.includes('--exclude-dir=.git'));
});

it('maps grep to Grep when Grep is in allowedTools', () => {
  const allowed = ['Grep', 'Bash'];
  const res = mapOpenCodeTool('grep', { pattern: 'test_string', path: 'src' }, allowed, __dirname);
  assert.strictEqual(res.name, 'Grep');
  assert.strictEqual(res.input.pattern, 'test_string');
});

// 3. Edit tool parameter normalization
it('maps camelCase oldString/newString to snake_case old_string/new_string', () => {
  const allowed = ['Edit', 'Bash'];
  const res = mapOpenCodeTool('edit', {
    file_path: 'test.js',
    oldString: 'const a = 1;',
    newString: 'const a = 2;',
    replaceAll: true
  }, allowed, __dirname);
  assert.strictEqual(res.name, 'Edit');
  assert.strictEqual(res.input.old_string, 'const a = 1;');
  assert.strictEqual(res.input.new_string, 'const a = 2;');
  assert.strictEqual(res.input.replace_all, true);
});

// 4. Read tool mapping
it('maps read to Read with file_path', () => {
  const allowed = ['Read', 'Bash'];
  const res = mapOpenCodeTool('read', { path: 'package.json' }, allowed, path.join(__dirname, '..'));
  assert.strictEqual(res.name, 'Read');
  assert.strictEqual(res.input.file_path, 'package.json');
});

// 5. Tool call extraction from text
it('extracts tool calls from json blocks', () => {
  const text = 'Here is a command:\n```json\n{"name":"Bash","input":{"command":"ls -la"}}\n```\nDone.';
  const res = extractToolCalls(text, ['Bash']);
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'Bash');
  assert.strictEqual(res.toolCalls[0].input.command, 'ls -la');
  assert.ok(res.text.includes('Here is a command:'));
});

console.log('');
if (failed === 0) {
  console.log(`${GREEN}${BOLD}All ${passed} unit tests passed! ✅${RESET}\n`);
  process.exit(0);
} else {
  console.log(`${RED}${BOLD}${failed} test(s) failed out of ${passed + failed}.${RESET}\n`);
  process.exit(1);
}
