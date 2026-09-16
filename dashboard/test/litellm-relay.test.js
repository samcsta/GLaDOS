const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReadableStream } = require('node:stream/web');
const {
  LiteLlmResponseRelay,
  finiteCost,
  sanitizeUnsupportedParams,
} = require('../lib/litellm-relay');

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

test('DeepSeek compatibility removes effort while preserving output formatting', () => {
  const request = {
    model: 'deepseek-v4-flash-0731',
    reasoning_effort: 'xhigh',
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: { type: 'object' } },
    },
    messages: [{ role: 'user', content: 'hello' }],
  };
  const result = sanitizeUnsupportedParams(request);
  assert.deepEqual(result.removed, ['reasoning_effort', 'thinking', 'output_config.effort']);
  assert.equal(result.body.reasoning_effort, undefined);
  assert.equal(result.body.thinking, undefined);
  assert.deepEqual(result.body.output_config, {
    format: { type: 'json_schema', schema: { type: 'object' } },
  });
  assert.equal(request.reasoning_effort, 'xhigh');
  assert.deepEqual(request.thinking, { type: 'adaptive' });
  assert.equal(request.output_config.effort, 'high');
});

test('DeepSeek compatibility drops an effort-only output_config and leaves other models alone', () => {
  assert.deepEqual(sanitizeUnsupportedParams({
    model: 'deepseek-v4-flash-0731', output_config: { effort: 'high' },
  }), {
    body: { model: 'deepseek-v4-flash-0731' },
    removed: ['output_config.effort'],
  });
  const sol = { model: 'gpt-5.6-sol', output_config: { effort: 'xhigh' } };
  assert.deepEqual(sanitizeUnsupportedParams(sol), { body: sol, removed: [] });
});

test('relay strips unsupported DeepSeek effort before forwarding upstream', async () => {
  const fixtureCredential = ['fixture', 'relay', 'credential'].join('-');
  let forwardedBody;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    forwardedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const relay = new LiteLlmResponseRelay({
    env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}` },
    tokenLoader: () => fixtureCredential,
    dbPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glados-relay-test-')), 'receipts.db'),
  });
  try {
    const url = await relay.ensureStarted();
    const response = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': fixtureCredential, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-0731',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'xhigh', format: { type: 'json_schema' } },
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(forwardedBody, {
      model: 'deepseek-v4-flash-0731',
      output_config: { format: { type: 'json_schema' } },
    });
  } finally {
    await relay.close();
    await close(upstream);
  }
});

test('upstream stream failure closes only the relay response', async () => {
  const fixtureCredential = ['fixture', 'relay', 'credential'].join('-');
  const relay = new LiteLlmResponseRelay({
    tokenLoader: () => fixtureCredential,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('event: content_block_delta\n'));
        setImmediate(() => controller.error(new Error('fixture upstream socket closed')));
      },
    }), {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-litellm-call-id': 'call-stream-error',
        'x-litellm-model-id': 'deployment-terra',
      },
    }),
    dbPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glados-relay-test-')), 'receipts.db'),
  });
  try {
    const url = await relay.ensureStarted();
    await assert.rejects(fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': fixtureCredential, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-terra', stream: true }),
    }).then(response => response.text()), /terminated|fetch failed|socket/i);
    assert.equal(relay.server.listening, true);
  } finally { await relay.close(); }
});
