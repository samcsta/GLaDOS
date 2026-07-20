'use strict';

function actionRequiresOperator({ action, riskToTarget, preApprovedClass, hasApprovedPlan }) {
  if (riskToTarget === 'high') return true;
  const actionText = String(action || '');
  const riskyAction = /post|exploit|mutat|delete|write|send|phish/i.test(actionText);
  if (!riskyAction) return false;
  const clearlyNegatedRisk = /\b(no|without|non[- ]?)\s+(post|exploit|exploitation|mutation|mutating|delete|write|send|phish|phishing|fuzzing)\b/i.test(actionText);
  if (clearlyNegatedRisk) return false;
  if (hasApprovedPlan && ['low', 'medium'].includes(riskToTarget)) return false;
  if (preApprovedClass && riskToTarget === 'low') return false;
  return true;
}

module.exports = { actionRequiresOperator };
