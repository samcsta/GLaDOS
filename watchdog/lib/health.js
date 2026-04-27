const { db } = require('./db');

const VALID_STATES = new Set(['unknown', 'healthy', 'degraded', 'down', 'paused']);

async function probe(targetUrl, { method = 'HEAD', timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let status = 0;
  let err = null;
  try {
    const res = await fetch(targetUrl, { method, signal: controller.signal, redirect: 'manual' });
    status = res.status;
  } catch (e) {
    err = e.message;
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - started;
  const row = db.prepare('SELECT consecutive_failures FROM target_health WHERE target_url = ?').get(targetUrl);
  const prevFails = row?.consecutive_failures || 0;
  const isFail = status === 0 || status >= 500 || status === 429;
  const consecutive = isFail ? prevFails + 1 : 0;
  const state = deriveState(status, consecutive);
  const now = Date.now();
  db.prepare(`
    INSERT INTO target_health (target_url, last_probed_at, last_status, consecutive_failures, state, reason, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(target_url) DO UPDATE SET
      last_probed_at = excluded.last_probed_at,
      last_status = excluded.last_status,
      consecutive_failures = excluded.consecutive_failures,
      state = excluded.state,
      reason = excluded.reason,
      updated_at = excluded.updated_at
  `).run(targetUrl, now, status, consecutive, state, err || null, now);
  return { target_url: targetUrl, status, latencyMs, state, consecutive_failures: consecutive, error: err };
}

function deriveState(status, consecutiveFailures) {
  if (status === 0) return consecutiveFailures >= 2 ? 'down' : 'degraded';
  if (status >= 500) return consecutiveFailures >= 3 ? 'down' : 'degraded';
  if (status === 429) return 'degraded';
  if (status >= 200 && status < 400) return 'healthy';
  return 'degraded';
}

function getHealth(targetUrl) {
  const row = db.prepare('SELECT * FROM target_health WHERE target_url = ?').get(targetUrl);
  if (!row) return { target_url: targetUrl, state: 'unknown' };
  return row;
}

function listHealth() {
  return db.prepare('SELECT * FROM target_health ORDER BY updated_at DESC').all();
}

function markHealth(targetUrl, state, reason) {
  if (!VALID_STATES.has(state)) throw new Error(`invalid state ${state}`);
  const now = Date.now();
  db.prepare(`
    INSERT INTO target_health (target_url, state, reason, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(target_url) DO UPDATE SET state=excluded.state, reason=excluded.reason, updated_at=excluded.updated_at
  `).run(targetUrl, state, reason || null, now);
  return getHealth(targetUrl);
}

module.exports = { probe, getHealth, listHealth, markHealth, VALID_STATES };
