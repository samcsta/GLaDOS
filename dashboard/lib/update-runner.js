const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
let activeRun = null;

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    return '';
  }
}

function updateStatus({ activeAgents = 0 } = {}) {
  const dirty = git(['status', '--porcelain']);
  return {
    repoRoot: REPO_ROOT,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) || null,
    head: git(['rev-parse', '--short', 'HEAD']) || null,
    dirty: dirty.length > 0,
    dirtySummary: dirty.split(/\r?\n/).filter(Boolean).slice(0, 20),
    activeAgents,
    running: !!activeRun,
  };
}

function sseWrite(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function startUpdateStream({ res, force = false, activeAgents = 0 }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  if (activeRun) {
    sseWrite(res, 'error', { error: 'update already running' });
    res.end();
    return null;
  }

  const status = updateStatus({ activeAgents });
  sseWrite(res, 'status', status);
  if (!force && status.activeAgents > 0) {
    sseWrite(res, 'blocked', { reason: 'active engagement', activeAgents: status.activeAgents });
    res.end();
    return null;
  }
  if (!force && status.dirty) {
    sseWrite(res, 'blocked', { reason: 'dirty working tree', dirtySummary: status.dirtySummary });
    res.end();
    return null;
  }

  const args = ['scripts/update.sh', '--no-restart', ...(force ? ['--force'] : [])];
  const child = spawn('bash', args, {
    cwd: REPO_ROOT,
    env: { ...process.env, GLADOS_IN_APP_UPDATE: '1' },
  });
  activeRun = child;
  sseWrite(res, 'started', { args });

  const sendChunk = (stream, chunk) => {
    sseWrite(res, 'output', { stream, text: chunk.toString('utf8') });
  };
  child.stdout.on('data', chunk => sendChunk('stdout', chunk));
  child.stderr.on('data', chunk => sendChunk('stderr', chunk));
  child.on('error', e => {
    sseWrite(res, 'error', { error: e.message });
  });
  child.on('close', code => {
    activeRun = null;
    sseWrite(res, 'complete', {
      code,
      ok: code === 0,
      restartRecommended: code === 0,
      note: code === 0
        ? 'Update complete. Restart the dashboard process or let the Electron supervisor relaunch it.'
        : 'Update failed. Review the streamed output before retrying.',
    });
    res.end();
    if (code === 0 && typeof process.send === 'function') {
      setTimeout(() => {
        try { process.send({ type: 'glados-dashboard-restart-request', reason: 'source update complete' }); } catch {}
      }, 750).unref();
    }
  });
  res.on('close', () => {
    if (activeRun === child) {
      try { child.kill('SIGTERM'); } catch {}
    }
  });
  return child;
}

module.exports = {
  REPO_ROOT,
  updateStatus,
  startUpdateStream,
};
