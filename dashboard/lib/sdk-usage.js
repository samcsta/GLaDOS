function metric(value, keys) {
  for (const key of keys) {
    const number = Number(value?.[key]);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function aggregateSdkResultEvents(rows = []) {
  const totals = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    completedTurns: 0,
  };
  const models = new Map();
  const events = [];
  const sessionIndexes = new Map();
  for (const row of rows) {
    let event = row?.event_json || row?.eventJson || row;
    if (typeof event === 'string') {
      try { event = JSON.parse(event); } catch { continue; }
    }
    if (!event || typeof event !== 'object') continue;
    const sessionId = String(event.sessionId || '').trim();
    if (sessionId && sessionIndexes.has(sessionId)) events[sessionIndexes.get(sessionId)] = event;
    else {
      if (sessionId) sessionIndexes.set(sessionId, events.length);
      events.push(event);
    }
  }
  for (const event of events) {
    const cost = Number(event.costUsd);
    if (Number.isFinite(cost)) totals.costUsd += cost;
    totals.completedTurns += 1;
    for (const [name, usage] of Object.entries(event.modelUsage || {})) {
      const current = models.get(name) || {
        name, costUsd: 0, inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0,
      };
      current.costUsd += metric(usage, ['costUSD', 'costUsd', 'cost_usd']);
      current.inputTokens += metric(usage, ['inputTokens', 'input_tokens']);
      current.outputTokens += metric(usage, ['outputTokens', 'output_tokens']);
      current.cacheReadTokens += metric(usage, ['cacheReadInputTokens', 'cache_read_input_tokens']);
      current.cacheCreationTokens += metric(usage, ['cacheCreationInputTokens', 'cache_creation_input_tokens']);
      current.totalTokens = current.inputTokens + current.outputTokens + current.cacheReadTokens + current.cacheCreationTokens;
      models.set(name, current);
    }
  }
  for (const model of models.values()) {
    totals.inputTokens += model.inputTokens;
    totals.outputTokens += model.outputTokens;
    totals.cacheReadTokens += model.cacheReadTokens;
    totals.cacheCreationTokens += model.cacheCreationTokens;
  }
  totals.totalTokens = totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
  totals.costUsd = Number(totals.costUsd.toFixed(6));
  return {
    source: 'Claude Agent SDK terminal usage',
    provisional: true,
    totals,
    models: [...models.values()].sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens),
  };
}

function sdkUsageForPeriod(db, period) {
  if (!db || !period?.startDate || !period?.endDate) return aggregateSdkResultEvents([]);
  const rows = db.prepare(`
    SELECT event_json
    FROM dashboard_transcript_events
    WHERE (kind='result' OR (kind='prompt-error' AND json_extract(event_json, '$.sdkType')='result'))
      AND substr(ts, 1, 10) BETWEEN ? AND ?
    ORDER BY id
  `).all(period.startDate, period.endDate);
  return aggregateSdkResultEvents(rows);
}

module.exports = { aggregateSdkResultEvents, sdkUsageForPeriod };
