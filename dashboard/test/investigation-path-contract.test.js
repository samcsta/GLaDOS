const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('core investigation prompts encode the operator-controlled iterative lifecycle', () => {
  const glados = [
    read('templates/agents/default/glados/RUNBOOK.md'),
    read('templates/agents/default/glados/SOUL.md'),
    read('templates/agents/default/glados/webapp-assessment-playbook.md'),
  ].join('\n');

  assert.match(glados, /baseline\.context_intake/);
  assert.match(glados, /context_mode=blind/);
  assert.match(glados, /net-recon.*operator-optional/is);
  assert.match(glados, /operator_requested_net_recon: true/);
  assert.match(glados, /every observed inline\/external script/is);
  assert.match(glados, /landing[-_ ]page JavaScript checkpoint/is);
  assert.match(glados, /resume_after_js_analysis: true/);
  assert.match(glados, /post-pivot recon.*JavaScript analysis.*new plan/is);
  assert.match(glados, /operator_modifications/);
  assert.match(glados, /End investigation/);
  assert.match(glados, /operator_wrap_approved: true/);
  assert.match(glados, /never infer wrap-up/is);
  assert.match(glados, /report-writer\(initial\).*report-validator\(review-and-edit\).*report-writer\(final\)/is);
  assert.doesNotMatch(glados, /revalidate until|repeat until validation|failures loop back to the writer/is);
});

test('security-review prompts bypass report-agent wrap approval for built-in deliverables', () => {
  const glados = [
    read('templates/agents/default/glados/RUNBOOK.md'),
    read('templates/agents/default/glados/SOUL.md'),
    read('templates/agents/default/glados/TOOLS.md'),
    read('templates/agents/default/glados/REDTEAM_MASTER.md'),
  ].join('\n');
  assert.match(glados, /controller-owned built-in `\/security-review`[\s\S]*Never dispatch report agents or wait for wrap approval/i);
  assert.match(glados, /For `\/security-review`, do not dispatch report agents/);
  assert.match(glados, /controller owns final status, sealing, and automatic built-in report generation/);
});

test('recon and JavaScript analyzer require raw-artifact completeness and meaningful CWE leads', () => {
  const recon = read('templates/agents/default/webapp-recon/RUNBOOK.md');
  const js = read('templates/agents/default/js-reverser/RUNBOOK.md');

  assert.match(recon, /raw HTML\/DOM/);
  assert.match(recon, /UUIDs\/object identifiers/);
  assert.match(recon, /complete request shape/);
  assert.match(recon, /identity\/authorization graph/);
  assert.match(recon, /Capture every observed client artifact/);
  assert.match(recon, /mandatory `js_handoff`/);
  assert.match(recon, /SQL injection.*XSS.*XXE.*RCE/is);

  assert.match(js, /process every listed/is);
  assert.match(js, /hardcoded credentials/);
  assert.match(js, /DOM XSS/);
  assert.match(js, /role checks/);
  assert.match(js, /chain toward RCE/);
});

test('planning, exploitation, validation, and reporting preserve pivots and operator gates', () => {
  const plan = read('templates/agents/default/plan-synthesizer/RUNBOOK.md');
  const vuln = read('templates/agents/default/webapp-vuln/RUNBOOK.md');
  const validator = read('templates/agents/default/webapp-validator/RUNBOOK.md');
  const writer = read('templates/agents/default/report-writer/RUNBOOK.md');
  const reportValidator = read('templates/agents/default/report-validator/RUNBOOK.md');
  const reportTemplate = read('templates/reporting/REPORT-TEMPLATE.md');

  assert.match(plan, /every meaningful evidence-backed vector/);
  assert.match(plan, /dependencies and pivots/);
  assert.match(plan, /SQL injection lead.*escalation ladder/is);
  assert.match(plan, /operator_modifications/);
  assert.match(vuln, /non-existent identifier.*never reject or close/is);
  assert.match(vuln, /requires_post_pivot_recon=true/);
  assert.match(vuln, /Confirmed SQLi.*never a terminal result/is);
  assert.match(vuln, /rce_escalation_status/);
  assert.match(validator, /mark it\s+`disputed`/);
  assert.match(validator, /pivot_detected=true/);
  assert.match(writer, /operator_wrap_approved: true/);
  assert.match(reportValidator, /operator_wrap_approved: true/);
  for (const pathPart of [
    'CWEs/Critical/', 'CWEs/High/', 'CWEs/Medium/', 'CWEs/Low/',
    'RT/Timeline.md', 'RT/Errors.md', 'RT/ExecSummary.md', 'RT/Writeup.md',
  ]) {
    assert.match(reportTemplate, new RegExp(pathPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const dradisFields = ['#CWE-XXX: [NAME]#', '#Summary#', '#Remediation#', '#CVSS 3.1 Score#', '#Action#', '#Result#'];
  let previous = -1;
  for (const field of dradisFields) {
    const offset = reportTemplate.indexOf(field, previous + 1);
    assert.ok(offset > previous, `${field} must exist in canonical Dradis order`);
    previous = offset;
  }
  assert.match(reportTemplate, /\[Action 1\]/);
  assert.match(reportTemplate, /\[Final Result\]/);
  assert.match(reportTemplate, /#Evidence X: \[Title\]#/);
  assert.match(reportTemplate, /exact sanitized command/);
  assert.match(reportTemplate, /Embed screenshots in place/);
  assert.match(writer, /#Evidence X: \[Title\]#/);
  assert.match(reportValidator, /numbering must start at 1 and remain sequential/);
  assert.match(reportValidator, /paths must resolve/);
  assert.match(writer, /glados-ops__engagement_metrics/);
  assert.match(reportValidator, /glados-ops__engagement_metrics/);
  assert.match(reportValidator, /newest available\s+`meteredThrough`/);
  assert.match(writer, /report_pass: initial/);
  assert.match(writer, /report_pass: final/);
  assert.match(reportValidator, /report_pass: review-and-edit/);
  assert.match(reportValidator, /Do not\s+request revalidation/is);
  assert.doesNotMatch([writer, reportValidator, reportTemplate].join('\n'), /revalidate until|repeat until validation|complete package must be revalidated/is);
});

test('Plans UI exposes plan edits and a no-report end-investigation decision', () => {
  const ui = read('dashboard/public/app.js');
  const route = read('dashboard/routes/plans.js');
  assert.match(ui, /Request changes/);
  assert.match(ui, /Send changes to GLaDOS/);
  assert.match(ui, /End investigation/);
  assert.match(ui, /do not start report generation/);
  assert.match(route, /end_investigation/);
  assert.match(route, /reports_started: false/);
});
