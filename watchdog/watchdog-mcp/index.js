#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const { probe, getHealth, listHealth, markHealth } = require('../lib/health');
const { agentHalt, agentResume, agentStatus, engagementHaltAll } = require('../lib/halt');
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
      'Halt an agent: write deny rules to ~/.openclaw/exec-approvals.json for all network-capable tools AND call burp-gate.sh halt-agent. The agent\'s next tool call will be rejected.',
    inputSchema: {
      type: 'object',
      required: ['agent_id'],
      properties: {
        agent_id: { type: 'string', description: 'OpenClaw agent id (e.g. webapp-recon)' },
        reason: { type: 'string' },
      },
    },
  },
  {
    name: 'agent_resume',
    description: 'Remove deny rules for an agent and re-enable its network tools.',
    inputSchema: {
      type: 'object',
      required: ['agent_id'],
      properties: { agent_id: { type: 'string' } },
    },
  },
  {
    name: 'agent_status',
    description: 'Report whether an agent currently has deny rules active.',
    inputSchema: {
      type: 'object',
      required: ['agent_id'],
      properties: { agent_id: { type: 'string' } },
    },
  },
  {
    name: 'engagement_halt_all',
    description:
      'Operator halt for every agent: call burp-gate.sh halt-all (flips Burp scope to drop-all). This is a manual kill switch used by the dashboard HALT ALL button or explicit operator instruction.',
    inputSchema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        reason: { type: 'string' },
      },
    },
  },
  {
    name: 'plan_check_dispatch',
    description:
      'v3.1 HARD DISPATCH GATE. Call this before dispatching any exploitation-tier agent (webapp-vuln, poc-coder, postex, ad-expert, phisherman, api-expert, c2-builder, data-exfil). Returns {allowed, reason, phase, plan_id?, engagement_id?}. Phase-1 recon agents (osint, origin-ip, net-recon, webapp-recon, source-code, plan-synthesizer) always pass. Meta agents (glados, validators, report-writer) always pass. Exploitation agents require an approved plan on the blackboard whose agent_chain or proposed_vectors.agents contains the agent_id.',
    inputSchema: {
      type: 'object',
      required: ['agent_id'],
      properties: {
        agent_id: { type: 'string', description: 'OpenClaw agent id to check (e.g. webapp-vuln)' },
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
        result = await agentHalt(args.agent_id, args.reason, { initiator: 'mcp' });
        break;
      case 'agent_resume':
        result = await agentResume(args.agent_id, { initiator: 'mcp' });
        break;
      case 'agent_status':
        result = agentStatus(args.agent_id);
        break;
      case 'engagement_halt_all':
        result = await engagementHaltAll(args.engagement_id, args.reason, { initiator: 'mcp' });
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
