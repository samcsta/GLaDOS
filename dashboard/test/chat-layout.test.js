const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');

test('operator chat uses a bounded right rail with the Red Team avatar on the right', () => {
  const css = fs.readFileSync(path.join(ROOT, 'dashboard/public/chat-alternate.css'), 'utf8');
  const asset = path.join(ROOT, 'dashboard/public/assets/red-team-operator.png');
  assert.equal(fs.existsSync(asset), true);
  assert.match(css, /\.entry\.user-message\s*\{[^}]*align-self:\s*flex-end/s);
  assert.match(css, /\.entry\.user-message\s*\{[^}]*width:\s*fit-content/s);
  assert.match(css, /\.entry\.user-message\s*\{[^}]*max-width:\s*min\(74%/s);
  assert.match(css, /\.entry\.user-message::before\s*\{[^}]*red-team-operator\.png/s);
  assert.match(css, /html\[data-theme="quantum"\][^}]*\.entry\.user-message::before\s*\{[^}]*right:\s*4px/s);
  assert.doesNotMatch(css, /\.entry\.user-message::before\s*\{\s*content:\s*none/);
});

test('agent chat uses a bounded left rail', () => {
  const css = fs.readFileSync(path.join(ROOT, 'dashboard/public/chat-alternate.css'), 'utf8');
  const rule = css.match(/html\[data-theme="quantum"\] \.chat-visual-chamber \.entry\.assistant-text\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(rule, /align-self:\s*flex-start/);
  assert.match(rule, /margin:\s*8px auto 16px 0/);
});

test('Quantum timestamps remain in document flow so they cannot overlap output', () => {
  const css = fs.readFileSync(path.join(ROOT, 'dashboard/public/chat-alternate.css'), 'utf8');
  const rule = css.match(/html\[data-theme="quantum"\] \.chat-visual-chamber \.entry \.ts\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(rule, /position:\s*static/);
  assert.match(rule, /display:\s*block/);
  assert.match(rule, /text-align:\s*left/);
  assert.doesNotMatch(rule, /position:\s*absolute/);
});

test('chat composer is a shared centered shell', () => {
  const css = fs.readFileSync(path.join(ROOT, 'dashboard/public/chat-alternate.css'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'dashboard/public/app.js'), 'utf8');
  assert.match(css, /\.chat-composer-shell\s*\{[^}]*width:\s*min\(100%, 980px\)/s);
  assert.match(css, /button\.secondary:disabled\s*\{\s*display:\s*none/);
  assert.equal((app.match(/class="chat-composer-shell"/g) || []).length, 2);
  assert.equal((app.match(/class="chat-composer-actions"/g) || []).length, 2);
});
