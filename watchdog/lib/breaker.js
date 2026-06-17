const { BURP_EXT_API, BREAKER_THRESHOLD, BREAKER_WINDOW_MS } = require('./config');
const { db } = require('./db');

/**
 * Diagnostic Burp error monitor. It can record bursts of 5xx/429 responses
 * in breaker_trips for operator visibility, but it does not mark targets down
 * or halt an engagement.
 *
 * If the extension isn't reachable (not installed / Burp closed), the poll
 * quietly no-ops.
 */
class CircuitBreaker {
  constructor({ intervalMs = 5000, onTrip } = {}) {
    this.intervalMs = intervalMs;
    this.onTrip = onTrip || (() => {});
    this.timer = null;
    this.lastSeenId = 0;
    this.samplesByHost = new Map(); // host -> [{ts, status}]
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => this._tick().catch(() => {}), this.intervalMs);
    return this;
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async _tick() {
    const url = `${BURP_EXT_API}/proxy/history?since=${this.lastSeenId}&limit=500`;
    let rows;
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      rows = await res.json();
    } catch { return; }
    if (!Array.isArray(rows) || rows.length === 0) return;

    const now = Date.now();
    for (const r of rows) {
      const id = Number(r.id || 0);
      if (id && id > this.lastSeenId) this.lastSeenId = id;
      const host = r.host || hostOf(r.url);
      const status = Number(r.status || 0);
      if (!host || !status) continue;
      let arr = this.samplesByHost.get(host);
      if (!arr) { arr = []; this.samplesByHost.set(host, arr); }
      arr.push({ ts: r.ts || now, status });
      while (arr.length && (now - arr[0].ts) > BREAKER_WINDOW_MS) arr.shift();
      const recentFails = arr.filter(s => s.status >= 500 || s.status === 429);
      if (recentFails.length >= BREAKER_THRESHOLD) {
        await this._trip(host, recentFails);
        arr.length = 0;
      }
    }
  }

  async _trip(host, samples) {
    const last = samples[samples.length - 1];
    const url = `https://${host}`;
    db.prepare(`INSERT INTO breaker_trips (target_host, tripped_at, sample_count, last_status) VALUES (?, ?, ?, ?)`)
      .run(host, Date.now(), samples.length, last.status);
    this.onTrip({ host, samples, url, automaticHalt: false });
  }
}

function hostOf(u) {
  if (!u) return null;
  try { return new URL(u).host; } catch { return null; }
}

/**
 * RPS over a rolling window. Source: GLaDOS extension /proxy/rps endpoint.
 * Returns null if the extension is unreachable (so the dashboard indicator
 * stays "—" rather than showing 0, which would falsely imply "quiet").
 */
async function getBurpRps({ windowSec = 10 } = {}) {
  try {
    const url = `${BURP_EXT_API}/proxy/rps?window=${windowSec}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.rps === 'number' ? body.rps : null;
  } catch { return null; }
}

module.exports = { CircuitBreaker, getBurpRps };
