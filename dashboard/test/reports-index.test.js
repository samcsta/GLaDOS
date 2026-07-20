const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { walk, shouldIgnoreDirectory, shouldIgnoreFile } = require('../lib/reports');

test('report index omits repositories, virtual environments, and dependency trees', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-report-index-'));
  const evidence = path.join(root, 'target', 'evidence');
  const gitRepo = path.join(root, 'target', 'source-copy');
  const namedVenv = path.join(root, 'target', 'venv');
  const renamedVenv = path.join(root, 'target', 'python-runtime');
  const dependencies = path.join(root, 'target', 'node_modules');
  const repoBucket = path.join(root, 'target', 'repos');
  const humanNamedRepoBucket = path.join(root, 'Github Repos');
  for (const dir of [gitRepo, namedVenv, renamedVenv, dependencies, repoBucket, humanNamedRepoBucket]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'noise.txt'), dir);
  }
  fs.mkdirSync(evidence, { recursive: true });
  fs.mkdirSync(path.join(gitRepo, '.git'));
  fs.writeFileSync(path.join(renamedVenv, 'pyvenv.cfg'), 'home = /usr/bin');
  fs.writeFileSync(path.join(evidence, 'finding.md'), '# Finding\n');

  assert.equal(shouldIgnoreDirectory('source-copy', gitRepo), true);
  assert.equal(shouldIgnoreDirectory('python-runtime', renamedVenv), true);

  const serialized = JSON.stringify(walk(root));
  assert.match(serialized, /finding\.md/);
  assert.doesNotMatch(serialized, /source-copy|python-runtime|node_modules|repos|venv|noise\.txt/i);
});

test('report index omits loose Playwright artifacts but preserves engagement evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-report-artifacts-'));
  const engagement = path.join(root, 'target');
  const evidence = path.join(root, 'target', 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const snapshot = 'page-2026-07-14T22-33-55-791Z.png';
  const consoleLog = 'console-2026-07-14T22-33-36-616Z.log';
  fs.writeFileSync(path.join(root, snapshot), 'disposable');
  fs.writeFileSync(path.join(engagement, consoleLog), 'disposable');
  fs.writeFileSync(path.join(root, consoleLog), 'disposable');
  fs.writeFileSync(path.join(evidence, snapshot), 'durable evidence');

  assert.equal(shouldIgnoreFile(snapshot, ''), true);
  assert.equal(shouldIgnoreFile(consoleLog, ''), true);
  assert.equal(shouldIgnoreFile(consoleLog, 'target'), true);
  assert.equal(shouldIgnoreFile(snapshot, 'target/evidence'), false);

  const serialized = JSON.stringify(walk(root));
  assert.doesNotMatch(serialized, /console-2026/);
  assert.match(serialized, /target\/evidence\/page-2026/);
});
