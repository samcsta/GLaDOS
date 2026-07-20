'use strict';

function canonicalScope(scope) {
  if (scope == null || scope === '') return null;
  try {
    const parsed = typeof scope === 'string' ? JSON.parse(scope) : scope;
    return JSON.stringify(parsed);
  } catch {
    return String(scope);
  }
}

function createOrReuseEngagement(db, args) {
  const requested = {
    id: String(args.id),
    target_name: String(args.target_name),
    scope: args.scope || null,
  };
  const existing = db.prepare('SELECT id, target_name, scope, status FROM engagements WHERE id = ?').get(requested.id);
  if (existing) {
    const sameTarget = existing.target_name === requested.target_name;
    const sameScope = canonicalScope(existing.scope) === canonicalScope(requested.scope);
    if (!sameTarget || !sameScope) {
      throw new Error(`Engagement '${requested.id}' already exists with different target or scope`);
    }
    return { created: false, engagement: existing };
  }

  db.prepare('INSERT INTO engagements (id, target_name, scope) VALUES (?, ?, ?)')
    .run(requested.id, requested.target_name, requested.scope);
  return {
    created: true,
    engagement: db.prepare('SELECT id, target_name, scope, status FROM engagements WHERE id = ?').get(requested.id),
  };
}

module.exports = { canonicalScope, createOrReuseEngagement };
