const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isKickoffApproval,
  isKickoffCancel,
  isNetReconRequested,
  resolveKickoffResources,
} = require('../lib/kickoff-intent');

test('kickoff cancellation requires a direct cancellation command', () => {
  for (const message of [
    'cancel',
    'Please stop this assessment.',
    'halt the kickoff',
    'never mind',
    'do not proceed',
  ]) {
    assert.equal(isKickoffCancel(message), true, message);
  }
});

test('safety boundaries do not cancel an approved kickoff', () => {
  for (const message of [
    'Proceed, but stop before exploitation until the plan is approved.',
    'Continue. No denial of service or stress testing.',
    'Approved; do not proceed beyond proof of vulnerability.',
    'Skip Dradis and proceed with no OSINT.',
  ]) {
    assert.equal(isKickoffApproval(message), true, message);
    assert.equal(isKickoffCancel(message), false, message);
  }
});

test('network recon is opt-in and respects explicit negative instructions', () => {
  for (const message of [
    'Include network recon in this investigation.',
    'Run net-recon too.',
    'I want infrastructure scanning as part of this assessment.',
  ]) assert.equal(isNetReconRequested(message), true, message);

  for (const message of [
    'Conduct a full web application assessment.',
    'No network recon; webapp only.',
    'Skip infrastructure scanning.',
  ]) assert.equal(isNetReconRequested(message), false, message);
});

test('resource skip clauses apply to every named comma-separated resource', () => {
  assert.deepEqual(
    resolveKickoffResources('Proceed blind. Explicitly skip DradisTab, Dradis, DomainsAI, OSINT.'),
    []
  );
  assert.deepEqual(
    resolveKickoffResources('Skip DradisTab and Dradis; use DomainsAI first.').map(resource => resource.id),
    ['domainsai']
  );
  assert.deepEqual(
    resolveKickoffResources('Skip DomainsAI; continue with DradisTab and Dradis.').map(resource => resource.id),
    ['dradistab', 'dradis']
  );
});

test('Clippy is the single default intake source when configured', () => {
  const configured = { clippyAvailable: true };
  assert.deepEqual(resolveKickoffResources('Continue', configured).map(resource => resource.id), ['clippy']);
  assert.deepEqual(resolveKickoffResources('Continue, also use Dradis for the full report', configured).map(resource => resource.id), ['clippy', 'dradis']);
  assert.deepEqual(resolveKickoffResources('Skip Clippy and proceed', configured).map(resource => resource.id), ['dradistab', 'dradis', 'domainsai']);
  assert.deepEqual(resolveKickoffResources('Proceed blind', configured), []);
  assert.deepEqual(resolveKickoffResources('Only DomainsAI', configured).map(resource => resource.id), ['domainsai']);
  assert.deepEqual(resolveKickoffResources('Skip Clippy and use Dradis', configured).map(resource => resource.id), ['dradis']);
});
