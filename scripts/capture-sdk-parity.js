#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  assembleAgentPrompt,
  mapSdkMessageToEvents,
} = require('../dashboard/lib/harness/agent-sdk');

function usage() {
  process.stderr.write('usage: scripts/capture-sdk-parity.js <agent-id> <sdk-messages.jsonl>\n');
  process.exit(2);
}

const [, , agentId, inputPath] = process.argv;
if (!agentId || !inputPath) usage();

const raw = fs.readFileSync(path.resolve(inputPath), 'utf8');
const messages = raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
  try { return JSON.parse(line); }
  catch (error) { throw new Error(`invalid JSON on line ${index + 1}: ${error.message}`); }
});
const context = { subagentByParentToolUseId: new Map() };
const expectedEvents = messages.flatMap(message => mapSdkMessageToEvents(agentId, message, context));
const prompt = assembleAgentPrompt(agentId);
const sdkVersion = require('../dashboard/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version;

process.stdout.write(`${JSON.stringify({
  fixture: `recorded-${agentId}`,
  sourceVersion: 'v3.6.0',
  recording: {
    kind: 'recorded-sdk-messages',
    sdkVersion,
    sha256: crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
  },
  agentId,
  assembledPromptFiles: prompt.files,
  recordedSdkMessages: messages,
  expectedEvents,
}, null, 2)}\n`);
