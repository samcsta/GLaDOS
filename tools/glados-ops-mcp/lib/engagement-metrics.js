'use strict';

function firstMetric(object, keys) {
  for (const key of keys) {
    if (object && object[key] != null && Number.isFinite(Number(object[key]))) return Number(object[key]);
  }
  return 0;
}

function parseUtc(value) {
  if (!value) return null;
  const text = String(value);
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatElapsed(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}h` : null, minutes || hours ? `${minutes}m` : null, `${remainder}s`]
    .filter(Boolean)
    .join(' ');
}

function engagementMetrics(db, engagementId, options = {}) {
  if (!db) throw new Error('blackboard database is unavailable');
  if (!engagementId) throw new Error('engagement_id is required');
  const engagement = db.prepare(`
    SELECT id, target_name, status, started_at, completed_at
    FROM engagements WHERE id = ?
  `).get(engagementId);
  if (!engagement) throw new Error(`engagement '${engagementId}' not found`);

  const started = parseUtc(engagement.started_at);
  if (!started) throw new Error(`engagement '${engagementId}' has an invalid started_at timestamp`);
  const requestedEnd = parseUtc(options.meteredThrough) || options.now || new Date();
  const completed = parseUtc(engagement.completed_at);
  const ended = completed && completed <= requestedEnd ? completed : requestedEnd;

  const rows = db.prepare(`
    SELECT agent_id, event_json, ts
    FROM dashboard_transcript_events
    WHERE engagement_id = ?
      AND (kind = 'result' OR (kind = 'prompt-error' AND json_extract(event_json, '$.sdkType') = 'result'))
    ORDER BY id
  `).all(engagementId);
  let gatewayRows = [];
  let unresolvedGatewayRequests = 0;
  try {
    gatewayRows = db.prepare(`
      SELECT o.review_role, o.worker_id, o.requested_model, o.actual_model, o.billed_model_name,
             o.cost_usd, o.request_id
      FROM security_review_model_observations AS o
      WHERE o.engagement_id=? AND o.source='litellm:spend-log'
      ORDER BY o.observed_at, o.observation_id
    `).all(engagementId);
    unresolvedGatewayRequests = db.prepare(`
      SELECT COUNT(*) AS n FROM security_review_llm_requests
      WHERE engagement_id=? AND status!='SETTLED'
    `).get(engagementId).n;
  } catch {}

  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  const byAgent = new Map();
  const byModel = new Map();
  let costUsd = 0;
  let meteredCostEvents = 0;
  let tokenEvents = 0;

  for (const row of rows) {
    let event = {};
    try { event = JSON.parse(row.event_json) || {}; } catch {}
    const agent = byAgent.get(row.agent_id) || {
      agentId: row.agent_id,
      resultEvents: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    agent.resultEvents += 1;

    if (event.costUsd != null && Number.isFinite(Number(event.costUsd))) {
      const cost = Number(event.costUsd);
      costUsd += cost;
      agent.costUsd += cost;
      meteredCostEvents += 1;
    }

    const modelUsage = event.modelUsage && typeof event.modelUsage === 'object'
      ? event.modelUsage
      : null;
    const usage = event.usage && typeof event.usage === 'object' ? event.usage : null;
    if (modelUsage && Object.keys(modelUsage).length) {
      const aggregate = Object.values(modelUsage).reduce((sum, metrics) => ({
        input: sum.input + firstMetric(metrics, ['inputTokens', 'input_tokens']),
        output: sum.output + firstMetric(metrics, ['outputTokens', 'output_tokens']),
        cacheRead: sum.cacheRead + firstMetric(metrics, ['cacheReadInputTokens', 'cache_read_input_tokens']),
        cacheCreation: sum.cacheCreation + firstMetric(metrics, ['cacheCreationInputTokens', 'cache_creation_input_tokens']),
      }), { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
      totals.inputTokens += aggregate.input;
      totals.outputTokens += aggregate.output;
      totals.cacheReadTokens += aggregate.cacheRead;
      totals.cacheCreationTokens += aggregate.cacheCreation;
      agent.inputTokens += aggregate.input + aggregate.cacheRead + aggregate.cacheCreation;
      agent.outputTokens += aggregate.output;
      tokenEvents += 1;
    } else if (usage) {
      const input = firstMetric(usage, ['input_tokens', 'inputTokens']);
      const output = firstMetric(usage, ['output_tokens', 'outputTokens']);
      const cacheRead = firstMetric(usage, ['cache_read_input_tokens', 'cacheReadInputTokens']);
      const cacheCreation = firstMetric(usage, ['cache_creation_input_tokens', 'cacheCreationInputTokens']);
      totals.inputTokens += input;
      totals.outputTokens += output;
      totals.cacheReadTokens += cacheRead;
      totals.cacheCreationTokens += cacheCreation;
      agent.inputTokens += input + cacheRead + cacheCreation;
      agent.outputTokens += output;
      tokenEvents += 1;
    }

    for (const [modelId, modelMetrics] of Object.entries(modelUsage || {})) {
      if (!modelMetrics || typeof modelMetrics !== 'object') continue;
      const model = byModel.get(modelId) || {
        modelId,
        resultEvents: 0,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      model.resultEvents += 1;
      model.costUsd += firstMetric(modelMetrics, ['costUSD', 'costUsd', 'cost_usd']);
      model.inputTokens += firstMetric(modelMetrics, ['inputTokens', 'input_tokens']);
      model.outputTokens += firstMetric(modelMetrics, ['outputTokens', 'output_tokens']);
      model.cacheReadTokens += firstMetric(modelMetrics, ['cacheReadInputTokens', 'cache_read_input_tokens']);
      model.cacheCreationTokens += firstMetric(modelMetrics, ['cacheCreationInputTokens', 'cache_creation_input_tokens']);
      byModel.set(modelId, model);
    }
    byAgent.set(row.agent_id, agent);
  }

  const taskRows = db.prepare(`
    SELECT lower(COALESCE(status, 'pending')) AS status, COUNT(*) AS count
    FROM tasks WHERE engagement_id = ? GROUP BY status
  `).all(engagementId);
  const tasks = Object.fromEntries(taskRows.map(row => [row.status, row.count]));
  const elapsedSeconds = Math.max(0, (ended.getTime() - started.getTime()) / 1000);
  const totalTokens = totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
  const gatewayCost = gatewayRows.reduce((sum, row) => sum + (Number.isFinite(Number(row.cost_usd)) ? Number(row.cost_usd) : 0), 0);

  return {
    engagement: {
      id: engagement.id,
      target: engagement.target_name,
      status: engagement.status,
    },
    timing: {
      startedAt: started.toISOString(),
      completedAt: completed?.toISOString() || null,
      meteredThrough: ended.toISOString(),
      elapsedSeconds: Math.round(elapsedSeconds),
      elapsedHuman: formatElapsed(elapsedSeconds),
    },
    metering: {
      source: gatewayRows.length ? 'LiteLLM request spend logs' : 'Claude Agent SDK result events in dashboard_transcript_events',
      attribution: 'result events carrying this engagement_id through the terminal metering cutoff',
      resultEvents: rows.length,
      meteredCostEvents,
      costAvailable: gatewayRows.length > 0 || meteredCostEvents > 0,
      costUsd: gatewayRows.length ? Number(gatewayCost.toFixed(6)) : meteredCostEvents > 0 ? Number(costUsd.toFixed(6)) : null,
      costSettled: gatewayRows.length > 0 && unresolvedGatewayRequests === 0,
      unresolvedGatewayRequests,
      provisionalSdkCostUsd: meteredCostEvents > 0 ? Number(costUsd.toFixed(6)) : null,
      gatewayRequests: gatewayRows.length,
      tokensAvailable: tokenEvents > 0,
      tokenEvents,
      tokens: tokenEvents > 0 ? { ...totals, totalTokens } : null,
      byAgent: [...byAgent.values()]
        .map(agent => ({
          ...agent,
          costUsd: Number(agent.costUsd.toFixed(6)),
          totalTokens: agent.inputTokens + agent.outputTokens,
        }))
        .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens),
      byModel: [...byModel.values()]
        .map(model => ({
          ...model,
          costUsd: Number(model.costUsd.toFixed(6)),
          totalTokens: model.inputTokens + model.outputTokens
            + model.cacheReadTokens + model.cacheCreationTokens,
        }))
        .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens),
      caveat: 'The currently executing report/validation turn is not metered until that turn returns. Always print meteredThrough and never present this as an unbounded lifetime total.',
    },
    tasks,
  };
}

module.exports = { engagementMetrics, formatElapsed };
