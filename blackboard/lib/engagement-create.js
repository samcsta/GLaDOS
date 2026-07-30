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
  const hasSessionColumn = db.prepare('PRAGMA table_info(engagements)').all().some(column => column.name === 'session_id');
  const requested = {
    id: String(args.id),
    session_id: String(args.session_id || process.env.GLADOS_SESSION_ID || 'legacy'),
    target_name: String(args.target_name),
    scope: args.scope || null,
  };
  const existing = db.prepare(`SELECT id, ${hasSessionColumn ? 'session_id,' : ''} target_name, scope, status FROM engagements WHERE id = ?`).get(requested.id);
  if (existing) {
    if (hasSessionColumn && existing.session_id !== requested.session_id) throw new Error(`Engagement '${requested.id}' belongs to another investigation session`);
    const sameTarget = existing.target_name === requested.target_name;
    const sameScope = canonicalScope(existing.scope) === canonicalScope(requested.scope);
    if (!sameTarget || !sameScope) {
      throw new Error(`Engagement '${requested.id}' already exists with different target or scope`);
    }
    return { created: false, engagement: existing };
  }

  if (hasSessionColumn) {
    db.prepare('INSERT INTO engagements (id, session_id, target_name, scope) VALUES (?, ?, ?, ?)')
      .run(requested.id, requested.session_id, requested.target_name, requested.scope);
  } else {
    db.prepare('INSERT INTO engagements (id, target_name, scope) VALUES (?, ?, ?)')
      .run(requested.id, requested.target_name, requested.scope);
  }
  return {
    created: true,
    engagement: db.prepare(`SELECT id, ${hasSessionColumn ? 'session_id,' : ''} target_name, scope, status FROM engagements WHERE id = ?`).get(requested.id),
  };
}

module.exports = { canonicalScope, createOrReuseEngagement };
