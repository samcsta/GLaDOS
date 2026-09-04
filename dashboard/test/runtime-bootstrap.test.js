const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { bootstrap } = require('../../scripts/lib/glados-local');

test('fresh runtime bootstrap seeds writable agent workspaces outside the app payload', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-fresh-runtime-'));
  const previous = {
    GLADOS_RUNTIME_DIR: process.env.GLADOS_RUNTIME_DIR,
    GLADOS_AGENT_WORKSPACES: process.env.GLADOS_AGENT_WORKSPACES,
    GLADOS_REPORTS_DIR: process.env.GLADOS_REPORTS_DIR,
    GLADOS_INVESTIGATIONS_DIR: process.env.GLADOS_INVESTIGATIONS_DIR,
    BLACKBOARD_DB: process.env.BLACKBOARD_DB,
    WATCHDOG_DB: process.env.WATCHDOG_DB,
  };
  const workspaces = path.join(runtimeDir, 'workspaces', 'agents');
  process.env.GLADOS_RUNTIME_DIR = runtimeDir;
  process.env.GLADOS_AGENT_WORKSPACES = workspaces;
  process.env.GLADOS_REPORTS_DIR = path.join(runtimeDir, 'reports');
  process.env.GLADOS_INVESTIGATIONS_DIR = path.join(runtimeDir, 'investigations');
  process.env.BLACKBOARD_DB = path.join(runtimeDir, 'blackboard', 'blackboard.db');
  process.env.WATCHDOG_DB = path.join(runtimeDir, 'watchdog', 'watchdog.db');

  try {
    const result = bootstrap();
    const gladosDir = path.join(workspaces, 'glados');
    assert.equal(result.paths.runtimeDir, runtimeDir);
    assert.ok(fs.existsSync(path.join(gladosDir, 'USER.md')));
    assert.ok(fs.existsSync(path.join(gladosDir, 'MEMORY.md')));
    assert.ok(fs.existsSync(path.join(gladosDir, 'agent.json')));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(runtimeDir, 'secrets')).mode & 0o777, 0o700);
    }
    assert.ok(!gladosDir.includes('.app/Contents/Resources'));

    fs.appendFileSync(path.join(gladosDir, 'USER.md'), '\nOperator-owned edit.\n');
    bootstrap();
    assert.match(fs.readFileSync(path.join(gladosDir, 'USER.md'), 'utf8'), /Operator-owned edit/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
