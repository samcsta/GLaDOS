'use strict';

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function compactNode(value, state, depth = 0) {
  if (state.remaining <= 0) return '[truncated: summary budget exhausted]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') {
    state.remaining -= 16;
    return value;
  }
  if (typeof value === 'string') {
    const limit = Math.max(0, Math.min(600, state.remaining));
    const text = value.length > limit ? `${value.slice(0, Math.max(0, limit - 20))}…[truncated]` : value;
    state.remaining -= text.length + 8;
    return text;
  }
  if (depth >= 3) {
    const shape = Array.isArray(value)
      ? `[array: ${value.length} items]`
      : `{object keys: ${Object.keys(value).slice(0, 20).join(', ')}}`;
    state.remaining -= shape.length + 8;
    return shape;
  }
  if (Array.isArray(value)) {
    const sample = [];
    for (const item of value.slice(0, 4)) {
      if (state.remaining <= 0) break;
      sample.push(compactNode(item, state, depth + 1));
    }
    return { count: value.length, sample, truncated: value.length > sample.length };
  }
  if (typeof value === 'object') {
    const out = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, 24)) {
      if (state.remaining <= 0) break;
      state.remaining -= key.length + 8;
      out[key] = compactNode(value[key], state, depth + 1);
    }
    if (keys.length > Object.keys(out).length) out.__truncated_keys__ = keys.length - Object.keys(out).length;
    return out;
  }
  return String(value);
}

function compactBaselineSummary(summary, { maxBytes = 18000 } = {}) {
  const originalBytes = byteLength(summary);
  if (originalBytes <= maxBytes) {
    return { summary, originalBytes, summaryBytes: originalBytes, truncated: false };
  }
  const state = { remaining: Math.max(2000, maxBytes - 3000) };
  let compact = compactNode(summary, state);
  let summaryBytes = byteLength(compact);
  if (summaryBytes > maxBytes) {
    const source = summary && typeof summary === 'object' ? summary : { value: summary };
    compact = Object.fromEntries(Object.entries(source).slice(0, 24).map(([key, value]) => [key, {
      type: Array.isArray(value) ? 'array' : typeof value,
      count: Array.isArray(value) ? value.length : undefined,
      keys: value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).slice(0, 30) : undefined,
      preview: JSON.stringify(value).slice(0, 400),
    }]));
    summaryBytes = byteLength(compact);
  }
  return { summary: compact, originalBytes, summaryBytes, truncated: true };
}

module.exports = { compactBaselineSummary };
