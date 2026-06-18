const test = require('node:test');
const assert = require('node:assert/strict');
const { convertToEvents } = require('../lib/jsonl-tail');

function toolResult({ isError = false, details = {}, text = 'result' } = {}) {
  return {
    type: 'message',
    timestamp: '2026-06-18T00:00:00.000Z',
    message: {
      role: 'toolResult',
      toolName: 'example',
      isError,
      details,
      content: [{ type: 'text', text }],
    },
  };
}

test('marks a non-zero exec exit code as an error', () => {
  const [event] = convertToEvents(toolResult({
    details: { status: 'completed', exitCode: 1 },
  }));
  assert.equal(event.isError, true);
  assert.equal(event.exitCode, 1);
});

test('marks semantic browser status:error as an error', () => {
  const [event] = convertToEvents(toolResult({
    details: { status: 'error', tool: 'browser' },
  }));
  assert.equal(event.isError, true);
});

test('keeps successful tool results successful', () => {
  const [event] = convertToEvents(toolResult({
    details: { status: 'completed', exitCode: 0 },
  }));
  assert.equal(event.isError, false);
});

test('surfaces length-limited assistant turns without hiding tool calls', () => {
  const events = convertToEvents({
    type: 'message',
    timestamp: '2026-06-18T00:00:00.000Z',
    message: {
      role: 'assistant',
      stopReason: 'length',
      provider: 'custom',
      model: 'model',
      content: [{
        type: 'toolCall',
        id: 'call-1',
        name: 'write',
        arguments: { path: '/tmp/incomplete' },
      }],
    },
  });
  assert.deepEqual(events.map(event => event.kind), ['prompt-error', 'tool-call']);
  assert.match(events[0].error, /token limit/);
});
