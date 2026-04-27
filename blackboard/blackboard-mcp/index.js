#!/usr/bin/env node

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const Database = require("better-sqlite3");
const path = require("path");
const os = require("os");

const GLADOS_RUNTIME_DIR = process.env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), ".glados");

const DB_PATH =
  process.env.BLACKBOARD_DB ||
  path.join(GLADOS_RUNTIME_DIR, "blackboard", "blackboard.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// --- Tool definitions ---

const TOOLS = [
  {
    name: "blackboard_read",
    description:
      "Search findings in the blackboard. Filter by target_url, cwe_id, engagement_id, discovered_by, validation_status, or free-text query across title/description.",
    inputSchema: {
      type: "object",
      properties: {
        target_url: { type: "string", description: "Filter by target URL (partial match)" },
        cwe_id: { type: "string", description: "Filter by CWE ID (exact match, e.g. CWE-89)" },
        engagement_id: { type: "string", description: "Filter by engagement ID" },
        discovered_by: { type: "string", description: "Filter by discovering agent ID" },
        validation_status: { type: "string", description: "Filter by status: pending, validated, disputed, rejected" },
        query: { type: "string", description: "Free-text search across title and description" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
    },
  },
  {
    name: "blackboard_write",
    description:
      "Insert or update a finding in the blackboard. If id is provided, updates that finding. Otherwise inserts a new one.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Finding ID to update (omit for new finding)" },
        engagement_id: { type: "string" },
        target_url: { type: "string" },
        finding_type: { type: "string", description: "vulnerability, recon, credential, infrastructure" },
        cwe_id: { type: "string" },
        affected_component: { type: "string" },
        severity: { type: "string", description: "critical, high, medium, low, informational" },
        priority: { type: "string", description: "PRIORITY or INFORMATIONAL" },
        cvss_score: { type: "number" },
        title: { type: "string" },
        description: { type: "string" },
        evidence: { type: "string", description: "JSON string with request/response, screenshots, etc." },
        reproduction_steps: { type: "string" },
        discovered_by: { type: "string", description: "Agent ID that found this" },
        validated_by: { type: "string", description: "Agent ID that validated this" },
        validation_status: { type: "string", description: "pending, validated, disputed, rejected" },
      },
      required: ["engagement_id", "target_url", "title", "discovered_by"],
    },
  },
  {
    name: "blackboard_task_read",
    description: "Get tasks assigned to a specific agent, or all tasks for an engagement.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Filter by assigned agent ID" },
        engagement_id: { type: "string", description: "Filter by engagement ID" },
        status: { type: "string", description: "Filter by status: pending, in_progress, completed, failed, cancelled" },
      },
    },
  },
  {
    name: "blackboard_task_update",
    description: "Update a task's status and/or result.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "number", description: "Task ID to update" },
        status: { type: "string", description: "pending, in_progress, completed, failed, cancelled" },
        result: { type: "string", description: "JSON string with task output" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "blackboard_task_create",
    description: "Create a new task assignment.",
    inputSchema: {
      type: "object",
      properties: {
        engagement_id: { type: "string" },
        assigned_to: { type: "string", description: "Agent ID" },
        assigned_by: { type: "string", description: "Agent ID (default: glados)" },
        task_type: { type: "string", description: "scan, validate, exploit, report, recon" },
        target: { type: "string" },
        description: { type: "string" },
      },
      required: ["engagement_id", "assigned_to", "task_type", "target"],
    },
  },
  {
    name: "blackboard_engagement_status",
    description: "Get engagement overview including finding counts and task status.",
    inputSchema: {
      type: "object",
      properties: {
        engagement_id: { type: "string", description: "Engagement ID to query" },
      },
      required: ["engagement_id"],
    },
  },
  {
    name: "blackboard_engagement_create",
    description: "Create a new engagement entry.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Unique engagement ID (e.g. target-domain-YYYYMMDD)" },
        target_name: { type: "string" },
        scope: { type: "string", description: "JSON array of in-scope targets" },
      },
      required: ["id", "target_name"],
    },
  },
  // v3.1.04252026 (Blocker D) — Baseline recon state. Phase 1 agents call
  // these so plan-synthesizer has a canonical source of truth.
  {
    name: "blackboard_baseline_get",
    description: "Read the baseline recon summary for an engagement (Phase 1 output). Returns { summary_json, complete, started_at, completed_at }.",
    inputSchema: {
      type: "object",
      properties: { engagement_id: { type: "string" } },
      required: ["engagement_id"],
    },
  },
  {
    name: "blackboard_baseline_upsert",
    description: "Merge keys into baseline_recon.summary_json for an engagement. Top-level keys are replaced, not deep-merged. Pass complete=true to mark Phase 1 done.",
    inputSchema: {
      type: "object",
      properties: {
        engagement_id: { type: "string" },
        merge: { type: "object", description: "Top-level keys to merge into summary_json (e.g. {dns:{...}, osint:{...}})" },
        complete: { type: "boolean", description: "If true, sets complete=1 and completed_at=now" },
      },
      required: ["engagement_id"],
    },
  },
  {
    name: "blackboard_recon_step_log",
    description: "Append a recon-step audit row (started, finished, ok/failed). Use this from Phase 1 agents at start AND finish so the dashboard can show timing.",
    inputSchema: {
      type: "object",
      properties: {
        engagement_id: { type: "string" },
        step: { type: "string", description: "dradistab|dns|tls|osint|origin-ip|net-recon|webapp-recon" },
        agent_id: { type: "string" },
        status: { type: "string", description: "pending|running|ok|failed|skipped" },
        output: { type: "object", description: "Step-specific output blob (will be JSON-encoded)" },
        duration_ms: { type: "number" },
        finish: { type: "boolean", description: "If true, sets finished_at=now" },
      },
      required: ["engagement_id", "step", "status"],
    },
  },
  {
    name: "blackboard_recon_steps_list",
    description: "List recon steps for an engagement, ordered by start time.",
    inputSchema: {
      type: "object",
      properties: { engagement_id: { type: "string" } },
      required: ["engagement_id"],
    },
  },
  // v3.1.04252026 (Blocker E) — Validator output schema for dynamic replan.
  {
    name: "blackboard_finding_validate",
    description: "Validators call this with a confidence_score (0..1) and enables_vectors (JSON array of vector names from cwe-cascade.json). Updates the finding and, if confidence >= 0.9 with non-empty enables_vectors, opens a replan_proposal row that the dashboard watcher will surface as plan-replan-proposed. Idempotent on (engagement_id, finding_id).",
    inputSchema: {
      type: "object",
      properties: {
        finding_id: { type: "number" },
        validation_status: { type: "string", description: "validated | disputed | rejected" },
        validated_by: { type: "string", description: "validator agent id" },
        confidence_score: { type: "number", description: "0..1; >= 0.9 + non-empty enables_vectors triggers replan proposal" },
        enables_vectors: { type: "array", items: { type: "string" }, description: "vector names from cwe-cascade.json (e.g. postex, ad-expert)" },
      },
      required: ["finding_id"],
    },
  },
  {
    name: "blackboard_replan_proposals_list",
    description: "List open replan proposals (or filter by engagement_id and/or state). Used by the dashboard Plans tab.",
    inputSchema: {
      type: "object",
      properties: {
        engagement_id: { type: "string" },
        state: { type: "string", description: "open|accepted|dismissed|superseded" },
      },
    },
  },
  {
    name: "blackboard_replan_proposal_resolve",
    description: "Mark a replan proposal accepted | dismissed | superseded with operator + reason. Called by the dashboard when the operator clicks Approve/Dismiss on a replan card.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        state: { type: "string", description: "accepted|dismissed|superseded" },
        resolved_by: { type: "string" },
      },
      required: ["id", "state"],
    },
  },
];

// --- Tool handlers ---

function handleBlackboardRead(args) {
  let sql = "SELECT * FROM findings WHERE 1=1";
  const params = [];

  if (args.target_url) {
    sql += " AND target_url LIKE ?";
    params.push(`%${args.target_url}%`);
  }
  if (args.cwe_id) {
    sql += " AND cwe_id = ?";
    params.push(args.cwe_id);
  }
  if (args.engagement_id) {
    sql += " AND engagement_id = ?";
    params.push(args.engagement_id);
  }
  if (args.discovered_by) {
    sql += " AND discovered_by = ?";
    params.push(args.discovered_by);
  }
  if (args.validation_status) {
    sql += " AND validation_status = ?";
    params.push(args.validation_status);
  }
  if (args.query) {
    sql += " AND (title LIKE ? OR description LIKE ?)";
    params.push(`%${args.query}%`, `%${args.query}%`);
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(args.limit || 50);

  const rows = db.prepare(sql).all(...params);
  return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
}

function handleBlackboardWrite(args) {
  if (args.id) {
    // Update
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(args)) {
      if (k === "id") continue;
      sets.push(`${k} = ?`);
      params.push(v);
    }
    sets.push("updated_at = datetime('now')");
    params.push(args.id);

    const result = db.prepare(`UPDATE findings SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return { content: [{ type: "text", text: `Updated finding #${args.id} (${result.changes} rows affected)` }] };
  } else {
    // Insert
    const stmt = db.prepare(`
      INSERT INTO findings (engagement_id, target_url, finding_type, cwe_id, affected_component, severity, priority, cvss_score, title, description, evidence, reproduction_steps, discovered_by, validated_by, validation_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      args.engagement_id, args.target_url, args.finding_type || "vulnerability",
      args.cwe_id || null, args.affected_component || args.target_url,
      args.severity || null, args.priority || "INFORMATIONAL",
      args.cvss_score || null, args.title, args.description || null,
      args.evidence || null, args.reproduction_steps || null,
      args.discovered_by, args.validated_by || null,
      args.validation_status || "pending"
    );
    return { content: [{ type: "text", text: `Created finding #${result.lastInsertRowid}` }] };
  }
}

function handleTaskRead(args) {
  let sql = "SELECT * FROM tasks WHERE 1=1";
  const params = [];

  if (args.agent_id) {
    sql += " AND assigned_to = ?";
    params.push(args.agent_id);
  }
  if (args.engagement_id) {
    sql += " AND engagement_id = ?";
    params.push(args.engagement_id);
  }
  if (args.status) {
    sql += " AND status = ?";
    params.push(args.status);
  }

  sql += " ORDER BY created_at DESC";
  const rows = db.prepare(sql).all(...params);
  return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
}

function handleTaskUpdate(args) {
  const sets = [];
  const params = [];

  if (args.status) { sets.push("status = ?"); params.push(args.status); }
  if (args.result) { sets.push("result = ?"); params.push(args.result); }
  sets.push("updated_at = datetime('now')");
  params.push(args.task_id);

  const result = db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return { content: [{ type: "text", text: `Updated task #${args.task_id} (${result.changes} rows affected)` }] };
}

function handleTaskCreate(args) {
  const stmt = db.prepare(`
    INSERT INTO tasks (engagement_id, assigned_to, assigned_by, task_type, target, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    args.engagement_id, args.assigned_to, args.assigned_by || "glados",
    args.task_type, args.target, args.description || null
  );
  return { content: [{ type: "text", text: `Created task #${result.lastInsertRowid}` }] };
}

function handleEngagementStatus(args) {
  const engagement = db.prepare("SELECT * FROM engagements WHERE id = ?").get(args.engagement_id);
  if (!engagement) {
    return { content: [{ type: "text", text: `Engagement '${args.engagement_id}' not found` }] };
  }

  const findingCounts = db.prepare(`
    SELECT priority, validation_status, COUNT(*) as count
    FROM findings WHERE engagement_id = ?
    GROUP BY priority, validation_status
  `).all(args.engagement_id);

  const taskCounts = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM tasks WHERE engagement_id = ?
    GROUP BY status
  `).all(args.engagement_id);

  const summary = { engagement, findings: findingCounts, tasks: taskCounts };
  return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
}

function handleEngagementCreate(args) {
  const stmt = db.prepare("INSERT INTO engagements (id, target_name, scope) VALUES (?, ?, ?)");
  stmt.run(args.id, args.target_name, args.scope || null);
  return { content: [{ type: "text", text: `Created engagement '${args.id}'` }] };
}

// --- v3.1.04252026 (Blocker D) — baseline recon handlers ---
function handleBaselineGet(args) {
  const row = db.prepare(
    "SELECT engagement_id, summary_json, complete, started_at, completed_at, updated_at FROM baseline_recon WHERE engagement_id = ?"
  ).get(args.engagement_id);
  if (!row) return { content: [{ type: "text", text: JSON.stringify({ engagement_id: args.engagement_id, summary_json: "{}", complete: 0, exists: false }, null, 2) }] };
  return { content: [{ type: "text", text: JSON.stringify({ ...row, exists: true, summary: safeJson(row.summary_json) }, null, 2) }] };
}

function handleBaselineUpsert(args) {
  const eng = args.engagement_id;
  const merge = (args.merge && typeof args.merge === "object") ? args.merge : {};
  // Begin transaction so concurrent Phase-1 agents writing different keys
  // don't trample each other.
  const tx = db.transaction(() => {
    const existing = db.prepare("SELECT summary_json, complete FROM baseline_recon WHERE engagement_id = ?").get(eng);
    let merged = {};
    if (existing) {
      try { merged = JSON.parse(existing.summary_json) || {}; } catch (_) { merged = {}; }
    }
    for (const [k, v] of Object.entries(merge)) merged[k] = v;
    const nextJson = JSON.stringify(merged);
    if (existing) {
      const setComplete = args.complete === true;
      if (setComplete) {
        db.prepare("UPDATE baseline_recon SET summary_json=?, complete=1, completed_at=datetime('now'), updated_at=datetime('now') WHERE engagement_id=?")
          .run(nextJson, eng);
      } else {
        db.prepare("UPDATE baseline_recon SET summary_json=?, updated_at=datetime('now') WHERE engagement_id=?")
          .run(nextJson, eng);
      }
    } else {
      const completeFlag = args.complete === true ? 1 : 0;
      const completedAt = completeFlag ? new Date().toISOString() : null;
      db.prepare("INSERT INTO baseline_recon (engagement_id, summary_json, complete, completed_at) VALUES (?, ?, ?, ?)")
        .run(eng, nextJson, completeFlag, completedAt);
    }
    return merged;
  });
  const merged = tx();
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, engagement_id: eng, complete: args.complete === true, summary: merged }, null, 2) }] };
}

function handleReconStepLog(args) {
  const outJson = args.output != null ? JSON.stringify(args.output) : null;
  if (args.finish === true) {
    // Update most-recent matching row to finished.
    const row = db.prepare(
      "SELECT id, started_at FROM recon_steps WHERE engagement_id=? AND step=? ORDER BY id DESC LIMIT 1"
    ).get(args.engagement_id, args.step);
    if (row) {
      db.prepare(
        "UPDATE recon_steps SET status=?, output_json=COALESCE(?, output_json), duration_ms=?, finished_at=datetime('now') WHERE id=?"
      ).run(args.status, outJson, args.duration_ms || null, row.id);
      return { content: [{ type: "text", text: `Finished recon-step #${row.id} (${args.step})` }] };
    }
    // No prior row to finish — fall through to insert.
  }
  const result = db.prepare(
    "INSERT INTO recon_steps (engagement_id, step, agent_id, status, output_json, duration_ms, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    args.engagement_id, args.step, args.agent_id || null,
    args.status, outJson, args.duration_ms || null,
    (args.status === 'ok' || args.status === 'failed' || args.status === 'skipped') ? new Date().toISOString() : null
  );
  return { content: [{ type: "text", text: `Logged recon-step #${result.lastInsertRowid}` }] };
}

function handleReconStepsList(args) {
  const rows = db.prepare(
    "SELECT id, step, agent_id, status, duration_ms, started_at, finished_at, output_json FROM recon_steps WHERE engagement_id = ? ORDER BY id ASC"
  ).all(args.engagement_id);
  // Inflate output_json for readability.
  const decoded = rows.map(r => ({ ...r, output: safeJson(r.output_json) }));
  return { content: [{ type: "text", text: JSON.stringify(decoded, null, 2) }] };
}

function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

// --- v3.1.04252026 (Blocker E) — Validator output + replan-proposal opener ---

const REPLAN_THRESHOLD = 0.9;

function handleFindingValidate(args) {
  const id = args.finding_id;
  const finding = db.prepare("SELECT id, engagement_id, cwe_id FROM findings WHERE id = ?").get(id);
  if (!finding) return { content: [{ type: "text", text: `Finding #${id} not found` }], isError: true };

  const sets = ["updated_at = datetime('now')"];
  const params = [];
  if (typeof args.validation_status === "string") { sets.push("validation_status = ?"); params.push(args.validation_status); }
  if (typeof args.validated_by === "string")     { sets.push("validated_by = ?");     params.push(args.validated_by); }
  if (typeof args.confidence_score === "number") { sets.push("confidence_score = ?"); params.push(args.confidence_score); }
  if (Array.isArray(args.enables_vectors))       { sets.push("enables_vectors = ?");  params.push(JSON.stringify(args.enables_vectors)); }
  params.push(id);
  db.prepare(`UPDATE findings SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  // Replan-trigger gate: confidence >= threshold AND non-empty enables_vectors.
  const conf = typeof args.confidence_score === "number" ? args.confidence_score : null;
  const vectors = Array.isArray(args.enables_vectors) ? args.enables_vectors : [];
  let proposal = null;
  if (conf !== null && conf >= REPLAN_THRESHOLD && vectors.length) {
    // Idempotent upsert on (engagement_id, finding_id). If an open proposal
    // already exists, refresh fields but don't reset state.
    const existing = db.prepare(
      "SELECT id, state FROM replan_proposals WHERE engagement_id = ? AND finding_id = ?"
    ).get(finding.engagement_id, id);
    // Snapshot the active plan id so the dashboard can compare proposed
    // vectors against what's already approved.
    const currentPlan = db.prepare(
      "SELECT id FROM plans WHERE engagement_id = ? AND state = 'approved' ORDER BY approved_at DESC LIMIT 1"
    ).get(finding.engagement_id);
    if (existing) {
      db.prepare(
        "UPDATE replan_proposals SET cwe_id = ?, confidence_score = ?, enables_vectors = ?, current_plan_id = ? WHERE id = ?"
      ).run(finding.cwe_id, conf, JSON.stringify(vectors), currentPlan?.id || null, existing.id);
      proposal = { id: existing.id, state: existing.state, refreshed: true };
    } else {
      const r = db.prepare(
        "INSERT INTO replan_proposals (engagement_id, finding_id, cwe_id, confidence_score, enables_vectors, current_plan_id) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(finding.engagement_id, id, finding.cwe_id, conf, JSON.stringify(vectors), currentPlan?.id || null);
      proposal = { id: r.lastInsertRowid, state: 'open', refreshed: false };
    }
  }

  const updated = db.prepare("SELECT id, engagement_id, cwe_id, validation_status, validated_by, confidence_score, enables_vectors FROM findings WHERE id = ?").get(id);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ ok: true, finding: updated, replan_proposal: proposal }, null, 2)
    }]
  };
}

function handleReplanProposalsList(args) {
  const where = [];
  const params = [];
  if (args.engagement_id) { where.push("engagement_id = ?"); params.push(args.engagement_id); }
  if (args.state)         { where.push("state = ?");         params.push(args.state); }
  const sql = "SELECT * FROM replan_proposals" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY created_at DESC LIMIT 100";
  const rows = db.prepare(sql).all(...params).map(r => ({ ...r, enables_vectors: safeJson(r.enables_vectors) }));
  return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
}

function handleReplanProposalResolve(args) {
  const r = db.prepare(
    "UPDATE replan_proposals SET state = ?, resolved_at = datetime('now'), resolved_by = ? WHERE id = ?"
  ).run(args.state, args.resolved_by || null, args.id);
  if (!r.changes) return { content: [{ type: "text", text: `Proposal #${args.id} not found` }], isError: true };
  return { content: [{ type: "text", text: `Proposal #${args.id} -> ${args.state}` }] };
}

// --- MCP Server ---

const server = new Server(
  { name: "blackboard-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "blackboard_read": return handleBlackboardRead(args || {});
      case "blackboard_write": return handleBlackboardWrite(args);
      case "blackboard_task_read": return handleTaskRead(args || {});
      case "blackboard_task_update": return handleTaskUpdate(args);
      case "blackboard_task_create": return handleTaskCreate(args);
      case "blackboard_engagement_status": return handleEngagementStatus(args);
      case "blackboard_engagement_create": return handleEngagementCreate(args);
      case "blackboard_baseline_get": return handleBaselineGet(args);
      case "blackboard_baseline_upsert": return handleBaselineUpsert(args);
      case "blackboard_recon_step_log": return handleReconStepLog(args);
      case "blackboard_recon_steps_list": return handleReconStepsList(args);
      case "blackboard_finding_validate": return handleFindingValidate(args);
      case "blackboard_replan_proposals_list": return handleReplanProposalsList(args);
      case "blackboard_replan_proposal_resolve": return handleReplanProposalResolve(args);
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
