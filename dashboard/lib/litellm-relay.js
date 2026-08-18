const http = require('node:http');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const Database = require('better-sqlite3');
const { loadLlmAuthToken } = require('./secrets/llm-secrets');
const { BLACKBOARD_DB } = require('./config');

const DEFAULT_BASE_URL = 'https://llmapi.redteamstuff.com';
const FORWARDED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'transfer-encoding',
]);

function upstreamBaseUrl(env = process.env) {
  return String(env.GLADOS_LITELLM_UPSTREAM_BASE_URL || env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function finiteCost(value) {
  const parsed = Number(value);
  // LiteLLM 1.83 reports 0.0 on streamed response headers before final usage
  // is known. Preserve a genuine positive charge; otherwise leave it unsettled.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

class LiteLlmResponseRelay {
  constructor({ env = process.env, fetchImpl = global.fetch, tokenLoader = loadLlmAuthToken, maxReceipts = 5000, dbPath = BLACKBOARD_DB } = {}) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.tokenLoader = tokenLoader;
    this.maxReceipts = Math.max(100, Number(maxReceipts) || 5000);
    this.upstream = upstreamBaseUrl(env);
    this.dbPath = dbPath;
    this.server = null;
    this.starting = null;
    this.receipts = new Map();
  }

  async ensureStarted() {
    if (this.server?.listening) return `http://127.0.0.1:${this.server.address().port}`;
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._handle(req, res));
      const fail = error => {
        this.starting = null;
        try { server.close(); } catch {}
        reject(error);
      };
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', fail);
        server.on('error', error => console.warn('[litellm-relay] server error:', error.message));
        this.server = server;
        resolve(`http://127.0.0.1:${server.address().port}`);
      });
    });
    return this.starting;
  }

  receipt(requestId) {
    const id = String(requestId || '');
    const memory = this.receipts.get(id);
    if (memory) return memory;
    let db;
    try {
      db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
      const row = db.prepare('SELECT * FROM litellm_relay_receipts WHERE request_id=?').get(id);
      return row ? {
        requestId: row.request_id,
        gatewayCallId: row.gateway_call_id,
        requestedModel: row.logical_model_alias,
        logicalModelAlias: row.logical_model_alias,
        gatewayModelId: row.gateway_model_id,
        gatewayModelGroup: row.gateway_model_group,
        providerModel: row.provider_model || null,
        costUsd: row.final_cost_usd ?? row.provisional_cost_usd ?? null,
        source: 'litellm:response-headers',
        observedAt: row.responded_at || row.created_at,
      } : null;
    } catch { return null; }
    finally { try { db?.close(); } catch {} }
  }

  reconcile(requestId, evidence) {
    if (!requestId || !evidence?.gatewayModelId) return false;
    const existing = this.receipt(requestId);
    if (!existing) return false;
    const reconciled = {
      ...existing,
      gatewayCallId: evidence.gatewayCallId || existing.gatewayCallId,
      gatewayModelId: evidence.gatewayModelId,
      providerModel: evidence.providerModel || null,
      costUsd: evidence.costUsd,
      source: 'litellm:spend-log',
      observedAt: new Date().toISOString(),
    };
    this.receipts.set(requestId, reconciled);
    let db;
    try {
      db = new Database(this.dbPath);
      db.prepare(`
        UPDATE litellm_relay_receipts
        SET provider_model=?, final_cost_usd=?, status='RECONCILED', last_error=NULL, reconciled_at=?
        WHERE request_id=?
      `).run(reconciled.providerModel, reconciled.costUsd, reconciled.observedAt, requestId);
      return true;
    } catch { return false; }
    finally { try { db?.close(); } catch {} }
  }

  _remember(receipt) {
    if (!receipt?.requestId) return;
    this.receipts.set(receipt.requestId, receipt);
    while (this.receipts.size > this.maxReceipts) this.receipts.delete(this.receipts.keys().next().value);
    let db;
    try {
      db = new Database(this.dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS litellm_relay_receipts (
          request_id TEXT PRIMARY KEY,
          gateway_call_id TEXT UNIQUE,
          logical_model_alias TEXT,
          gateway_model_id TEXT,
          gateway_model_group TEXT,
          provider_model TEXT,
          provisional_cost_usd REAL,
          final_cost_usd REAL,
          status TEXT NOT NULL DEFAULT 'CAPTURED',
          last_error TEXT,
          created_at TEXT NOT NULL,
          responded_at TEXT,
          reconciled_at TEXT
        )
      `);
      db.prepare(`
        INSERT INTO litellm_relay_receipts
          (request_id, gateway_call_id, logical_model_alias, gateway_model_id, gateway_model_group,
           provider_model, provisional_cost_usd, status, created_at, responded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'RESPONDED', ?, ?)
        ON CONFLICT(request_id) DO UPDATE SET
          gateway_call_id=excluded.gateway_call_id,
          logical_model_alias=excluded.logical_model_alias,
          gateway_model_id=excluded.gateway_model_id,
          gateway_model_group=excluded.gateway_model_group,
          provider_model=excluded.provider_model,
          provisional_cost_usd=excluded.provisional_cost_usd,
          status='RESPONDED', responded_at=excluded.responded_at
      `).run(receipt.requestId, receipt.gatewayCallId, receipt.logicalModelAlias,
        receipt.gatewayModelId, receipt.gatewayModelGroup, receipt.providerModel,
        receipt.costUsd, receipt.createdAt, receipt.observedAt);
    } catch {}
    finally { try { db?.close(); } catch {} }
  }

  async _handle(req, res) {
    try {
      const configuredToken = this.tokenLoader(this.env);
      const presented = String(req.headers['x-api-key'] || '').trim()
        || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (!configuredToken || presented !== configuredToken) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'GLaDOS LiteLLM relay rejected the request.' } }));
        return;
      }

      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      let requestBody = null;
      try { requestBody = body.length ? JSON.parse(body.toString('utf8')) : null; } catch {}

      const headers = { ...req.headers };
      delete headers.host;
      delete headers['content-length'];
      const init = { method: req.method, headers };
      if (!['GET', 'HEAD'].includes(req.method) && body.length) init.body = body;
      const upstreamResponse = await this.fetchImpl(`${this.upstream}${req.url}`, init);
      const requestId = crypto.randomUUID();
      const gatewayCallId = upstreamResponse.headers.get('x-litellm-call-id')
        || upstreamResponse.headers.get('request-id');
      const gatewayModelId = upstreamResponse.headers.get('x-litellm-model-id');
      const gatewayModelGroup = upstreamResponse.headers.get('x-litellm-model-group');
      const requestedModel = String(requestBody?.model || '').trim() || null;
      if (gatewayCallId && requestedModel) {
        const stamp = new Date().toISOString();
        this._remember({
          requestId,
          gatewayCallId,
          requestedModel,
          logicalModelAlias: requestedModel,
          gatewayModelGroup,
          gatewayModelId,
          providerModel: null,
          costUsd: finiteCost(upstreamResponse.headers.get('x-litellm-response-cost-original')
            || upstreamResponse.headers.get('x-litellm-response-cost')),
          source: 'litellm:response-headers',
          createdAt: stamp,
          observedAt: stamp,
        });
      }

      for (const [name, value] of upstreamResponse.headers) {
        if (!FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase())) res.setHeader(name, value);
      }
      // The Agent SDK only surfaces the conventional request-id header. LiteLLM
      // publishes its authoritative call identifier as x-litellm-call-id.
       res.setHeader('request-id', requestId);
      res.statusCode = upstreamResponse.status;
      if (upstreamResponse.body) Readable.fromWeb(upstreamResponse.body).pipe(res);
      else res.end();
    } catch (error) {
      if (res.headersSent) {
        try { res.destroy(error); } catch {}
        return;
      }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'GLaDOS could not reach LiteLLM.' } }));
    }
  }

  async close() {
    const server = this.server;
    this.server = null;
    this.starting = null;
    if (!server) return;
    await new Promise(resolve => server.close(resolve));
  }
}

module.exports = { LiteLlmResponseRelay, finiteCost, upstreamBaseUrl };
