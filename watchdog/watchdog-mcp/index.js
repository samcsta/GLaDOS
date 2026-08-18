#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const { probe, getHealth, listHealth, markHealth } = require('../lib/health');
const { agentHalt, agentResume, agentStatus } = require('../lib/halt');
const { planCheckDispatch } = require('../lib/plan-gate');

const TOOLS = [
  {
    name: 'target_probe',
    description:
      'Actively probe a target URL (HEAD request through the local network stack) and record the fresh result in target_health. Call this BEFORE dispatching any agent against a target. Returns the probe result and derived state (healthy|degraded|down|paused|unknown).',
    inputSchema: {
      type: 'object',
      required: ['target_url'],
      properties: {
        target_url: { type: 'string', description: 'Absolute URL to probe (e.g. https://www.askfiona.ford.com)' },
        method: { type: 'string', description: 'HTTP method, default HEAD' },
      },
    },
  },
  {
    name: 'target_health',
    description:
      'Read the most recently recorded health state for a target_url. Historical rows are diagnostic; use a fresh target_probe result for dispatch decisions.',
    inputSchema: {
      type: 'object',
      required: ['target_url'],
      properties: { target_url: { type: 'string' } },
    },
  },
  {
    name: 'target_list',
    description: 'List all known target_health rows, newest first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'target_mark',
    description:
      'Operator override: force a target_url into a specific state (healthy|degraded|down|paused|unknown) with a reason. Use after manual verification or when explicitly pausing a target during cooldown.',
    inputSchema: {
      type: 'object',
      required: ['target_url', 'state'],
      properties: {
        target_url: { type: 'string' },
        state: { type: 'string', enum: ['unknown', 'healthy', 'degraded', 'down', 'paused'] },
        reason: { type: 'string' },
      },
    },
  },
  {
    name: 'agent_halt',
    description:
      'Halt one GLaDOS Agent SDK agent. Writes an owner-only marker under ~/.glados/halts that the authoritative PreToolUse hook checks before every tool call.',
    inputSchema: {
      type: 'object',
      required: ['agent_id'],
      properties: {
        agent_id: { type: 'string', description: 'GLaDOS agent id (e.g. webapp-recon)' },
        reason: { type: 'string' },
      },
    },
  },
  {
    name: 'agent_resume',
    description: 'Resume one halted GLaDOS Agent SDK agent by removing its owner-only halt marker.',
    inputSchema: {
      type: 'object',
      required: ['agent_id'],
      properties: { agent_id: { type: 'string' } },
    },
  },
  {
    name: 'agent_status',
    description: 'Report whether a per-agent GLaDOS halt marker is active.',
    inputSchema: {
      type: 'object',
      required: ['agent_id'],
      properties: { agent_id: { type: 'string' } },
    },
  },
  {
    name: 'plan_check_dispatch',
    description:
      'Hard dispatch gate for GLaDOS v4. Call before dispatching an exploitation-tier agent. Returns {allowed, reason, phase, plan_id?, engagement_id?}. Recon and meta agents pass; exploitation agents require an approved blackboard plan whose agent chain or proposed vectors include the agent.',
    inputSchema: {
      type: 'object',
      required: ['agent_id'],
      properties: {
        agent_id: { type: 'string', description: 'GLaDOS Agent SDK agent id to check (e.g. webapp-vuln)' },
        engagement_id: { type: 'string', description: 'Optional engagement id. If omitted, the most recent active engagement is used.' },
      },
    },
  },
];

const server = new Server({ name: 'watchdog-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;
  try {
    let result;
    switch (name) {
      case 'target_probe':
        result = await probe(args.target_url, { method: args.method });
        break;
      case 'target_health':
        result = getHealth(args.target_url);
        break;
      case 'target_list':
        result = listHealth();
        break;
      case 'target_mark':
        result = markHealth(args.target_url, args.state, args.reason);
        break;
      case 'agent_halt':
        result = await agentHalt(args.agent_id, args.reason, { initiator: 'mcp', sessionId: process.env.GLADOS_SESSION_ID || 'legacy' });
        break;
      case 'agent_resume':
        result = await agentResume(args.agent_id, { initiator: 'mcp', sessionId: process.env.GLADOS_SESSION_ID || 'legacy' });
        break;
      case 'agent_status':
        result = agentStatus(args.agent_id, { sessionId: process.env.GLADOS_SESSION_ID || 'legacy' });
        break;
      case 'plan_check_dispatch':
        result = planCheckDispatch(args.agent_id, args.engagement_id);
        break;
      default:
        throw new Error(`unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${e.message}` }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch(err => { console.error(err); process.exit(1); });
