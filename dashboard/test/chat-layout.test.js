const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');

test('operator chat is a full-width Red Team row rather than a speech bubble', () => {
  const css = fs.readFileSync(path.join(ROOT, 'dashboard/public/chat-alternate.css'), 'utf8');
  const asset = path.join(ROOT, 'dashboard/public/assets/red-team-operator.png');
  assert.equal(fs.existsSync(asset), true);
  assert.match(css, /\.entry\.user-message\s*\{[^}]*width:\s*100%/s);
  assert.match(css, /\.entry\.user-message::before\s*\{[^}]*red-team-operator\.png/s);
  assert.match(css, /html\[data-theme="quantum"\][^}]*\.entry\.user-message\s*\{[^}]*background:\s*transparent/s);
  assert.doesNotMatch(css, /\.entry\.user-message::before\s*\{\s*content:\s*none/);
});

test('Quantum timestamps remain in document flow so they cannot overlap output', () => {
  const css = fs.readFileSync(path.join(ROOT, 'dashboard/public/chat-alternate.css'), 'utf8');
  const rule = css.match(/html\[data-theme="quantum"\] \.chat-visual-chamber \.entry \.ts\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(rule, /position:\s*static/);
  assert.match(rule, /display:\s*block/);
  assert.match(rule, /text-align:\s*right/);
  assert.doesNotMatch(rule, /position:\s*absolute/);
});
