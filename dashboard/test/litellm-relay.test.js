const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LiteLlmResponseRelay, finiteCost } = require('../lib/litellm-relay');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('stream relay exposes LiteLLM call IDs to the Agent SDK and retains deployment evidence', async () => {
  const fixtureCredential = ['fixture', 'relay', 'credential'].join('-');
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.headers['x-api-key'], fixtureCredential);
    assert.equal(JSON.parse(Buffer.concat(chunks).toString('utf8')).model, 'gpt-5.6-terra');
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-litellm-call-id': 'call-123',
      'x-litellm-model-id': 'deployment-terra',
      'x-litellm-response-cost-original': '0.0',
    });
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  const upstreamPort = await listen(upstream);
  const relay = new LiteLlmResponseRelay({
    env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}` },
    tokenLoader: () => fixtureCredential,
    dbPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glados-relay-test-')), 'receipts.db'),
  });
  try {
    const url = await relay.ensureStarted();
    const response = await fetch(`${url}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'x-api-key': fixtureCredential, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-terra', stream: true }),
    });
    assert.equal(response.status, 200);
    const requestId = response.headers.get('request-id');
    assert.notEqual(requestId, 'call-123');
    assert.match(requestId, /^[0-9a-f-]{36}$/);
    assert.match(await response.text(), /message_stop/);
    assert.deepEqual(relay.receipt(requestId), {
      requestId,
      gatewayCallId: 'call-123',
      requestedModel: 'gpt-5.6-terra',
      logicalModelAlias: 'gpt-5.6-terra',
      gatewayModelGroup: null,
      gatewayModelId: 'deployment-terra',
      providerModel: null,
      costUsd: null,
      source: 'litellm:response-headers',
      createdAt: relay.receipt(requestId).createdAt,
      observedAt: relay.receipt(requestId).observedAt,
    });
  } finally {
    await relay.close();
    await close(upstream);
  }
});

test('stream relay rejects credentials other than the configured GLaDOS key', async () => {
  const fixtureCredential = ['fixture', 'relay', 'credential'].join('-');
  const relay = new LiteLlmResponseRelay({
    tokenLoader: () => fixtureCredential,
    dbPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glados-relay-test-')), 'receipts.db'),
  });
  try {
    const url = await relay.ensureStarted();
    const response = await fetch(`${url}/v1/messages`, {
      method: 'POST', headers: { 'x-api-key': 'wrong-token' }, body: '{}',
    });
    assert.equal(response.status, 401);
  } finally { await relay.close(); }
});

test('streamed zero-cost headers remain unsettled instead of claiming a free request', () => {
  assert.equal(finiteCost('0.0'), null);
  assert.equal(finiteCost('0.125'), 0.125);
});
