const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

test('the bundled Dradis workflow authentication block contains no embedded credential fallback', () => {
  const archive = fs.readFileSync(path.resolve(__dirname, '../../templates/agents/default/glados/skills/dradis-workflow.skill'));
  // This known template stores SKILL.md as its first deflated ZIP entry. Read
  // that entry directly with Node built-ins, without requiring Python/unzip or
  // executing any instructions from the archived document.
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.equal(archive.readUInt16LE(8), 8);
  assert.equal(archive.readUInt16LE(6) & 8, 0);
  const nameLength = archive.readUInt16LE(26);
  const extraLength = archive.readUInt16LE(28);
  assert.ok(archive.subarray(30, 30 + nameLength).toString('utf8') === 'dradis-workflow/SKILL.md', 'The expected workflow entry must remain first');
  const start = 30 + nameLength + extraLength;
  const document = zlib.inflateRawSync(archive.subarray(start, start + archive.readUInt32LE(18))).toString('utf8');
  const authentication = document.match(/^## Authentication\n\n([\s\S]*?)\n---\n\n## Engagement Start Protocol/m)?.[1];
  const expected = 'Use configured GLaDOS local credentials through its approved credential flow, or ask the operator to complete an interactive login. Never embed credential values in this skill, expose them in chat/artifacts, or use a hardcoded fallback. If credentials are unavailable, stop at the login page and report the access gap.\n\nFor Dradis Professional, select the Active Directory option and let the operator complete any required ADFS/MFA login.\n';
  // A strict allowlist for this small, known authentication section detects an
  // accidental credential reintroduction without storing the removed secret
  // in this test or echoing a contaminated document in a failed assertion.
  assert.ok(authentication === expected, 'Dradis template authentication must use only configured credentials or interactive operator login, with no embedded values or fallback');
});
