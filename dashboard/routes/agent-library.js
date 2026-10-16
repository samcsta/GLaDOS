const express = require('express');

function errorStatus(error) {
  if (error.status || error.statusCode) return error.status || error.statusCode;
  if (error.code === 'conflict') return 409;
  if (error.code === 'not_found') return 404;
  if (error.code === 'connection_failed') return 502;
  return error.code || /required|invalid|must |choose |too (?:large|many)|unavailable|not found|empty/i.test(error.message) ? 400 : 500;
}

function handle(action) {
  return async (req, res) => {
    try { await action(req, res); }
    catch (error) { if (!res.headersSent) res.status(errorStatus(error)).json({ ok: false, code: error.code || 'request_failed', error: error.message }); }
  };
}

function revisionFrom(req) { return req.body?.expectedRevision; }

function createAgentLibraryRouter({ store, catalog = () => ({}), changed = () => {}, testDraft, activeAgentIds = () => [] }) {
  const router = express.Router();
  let draftTests = 0;
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', handle((_req, res) => res.json({ ok: true, packages: store.list(), ...catalog() })));
  router.post('/import/preview', handle((req, res) => {
    const preview = store.preview(req.body);
    const capabilities = catalog();
    const knownTools = new Set(capabilities.tools || []);
    const unavailableTools = preview.tools.filter(tool => knownTools.size && !knownTools.has(tool)
      && !(['Task', 'Agent'].includes(tool) && preview.teams.length));
    res.json({ ok: true, preview: { ...preview, warnings: unavailableTools.length
      ? [`Unavailable tools will stay disabled: ${unavailableTools.join(', ')}`] : [] } });
  }));
  router.post('/import', handle((req, res) => {
    const result = store.import(req.body, { expectedRevision: revisionFrom(req) });
    changed('import', result);
    res.status(201).json({ ok: true, package: result });
  }));
  router.post('/test', handle(async (req, res) => {
    if (!testDraft) return res.status(503).json({ ok: false, error: 'Agent testing is unavailable' });
    if (draftTests >= 2) return res.status(409).json({ ok: false, error: 'Wait for the current test conversation to finish' });
    const agent = req.body?.agent;
    const messages = req.body?.messages;
    if (!agent || !Array.isArray(messages) || !messages.length || messages.length > 16) return res.status(400).json({ ok: false, error: 'An agent draft and a test message are required' });
    if (messages.some(message => !['user', 'assistant'].includes(message?.role) || typeof message.content !== 'string' || !message.content.trim())) return res.status(400).json({ ok: false, error: 'Test messages must contain user or assistant text' });
    const last = messages.at(-1);
    if (last.role !== 'user') return res.status(400).json({ ok: false, error: 'End the test conversation with a user message' });
    const controller = new AbortController();
    const close = () => { if (!res.writableEnded) controller.abort('test conversation closed'); };
    res.once('close', close);
    draftTests++;
    try {
      const result = await testDraft({ draft: agent, prompt: last.content, conversation: messages.slice(0, -1), options: { abortSignal: controller.signal } });
      res.json({ ok: true, ...result });
    } finally {
      draftTests--;
      res.off('close', close);
    }
  }));
  router.post('/', handle((req, res) => {
    const result = store.create(req.body?.package || req.body);
    changed('create', result);
    res.status(201).json({ ok: true, package: result });
  }));
  router.get('/:id/export', handle((req, res) => {
    const result = store.export(req.params.id, { version: req.query.version, revision: req.query.revision });
    res.type('application/json').attachment(result.filename).send(result.text);
  }));
  router.get('/:id', handle((req, res) => {
    const result = store.get(req.params.id, { version: req.query.version, revision: req.query.revision });
    if (!result) return res.status(404).json({ ok: false, error: 'Agent package not found' });
    res.json({ ok: true, package: result });
  }));
  router.patch('/:id', handle((req, res) => {
    requireIdle(req.params.id);
    const current = store.get(req.params.id);
    if (current.managedIntegration && !current.editableIntegration) {
      const error = new Error('Managed integration instructions are updated in their GLaDOS source package. Enable or disable this integration here.'); error.status = 409; throw error;
    }
    const result = store.save(req.params.id, req.body?.package || req.body, { expectedRevision: revisionFrom(req) });
    changed('save', result);
    res.json({ ok: true, package: result });
  }));
  router.post('/:id/activate', handle((req, res) => {
    requireIdle(req.params.id);
    const result = store.activate(req.params.id, { version: req.body?.version, revision: req.body?.revision, expectedRevision: revisionFrom(req) });
    changed('activate', result);
    res.json({ ok: true, package: result });
  }));
  function requireIdle(id) {
    const runtimeIds = new Set(store.runtimeEntries({ includeDisabled: true }).filter(row => row.packageId === id).map(row => row.id));
    if (activeAgentIds().some(id => runtimeIds.has(id))) {
      const error = new Error('Finish or stop this package’s active agents before disabling or archiving it');
      error.status = 409;
      throw error;
    }
  }
  router.patch('/:id/enabled', handle((req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ ok: false, error: 'Enabled must be true or false' });
    if (!req.body.enabled) requireIdle(req.params.id);
    const result = store.setEnabled(req.params.id, req.body.enabled, { expectedRevision: revisionFrom(req) });
    changed('enabled', result);
    res.json({ ok: true, package: result });
  }));
  const setTeamEnabled = handle((req, res) => {
    requireIdle(req.params.id);
    const result = store.setTeamEnabled(req.params.id, req.params.entryId, req.body?.enabled, { expectedRevision: revisionFrom(req) });
    changed('team-enabled', result);
    res.json({ ok: true, package: result });
  });
  router.patch('/:id/teams/:entryId/enabled', setTeamEnabled);
  router.post('/:id/teams/:entryId/enabled', setTeamEnabled);
  router.delete('/:id', handle((req, res) => {
    requireIdle(req.params.id);
    const result = store.remove(req.params.id, { expectedRevision: revisionFrom(req) });
    changed('archive', result);
    res.json({ ok: true, ...result });
  }));
  for (const [segment, kind] of [['agents', 'agent'], ['teams', 'team']]) {
    router.delete(`/:id/${segment}/:entryId`, handle((req, res) => {
      requireIdle(req.params.id);
      const result = store.removeEntry(req.params.id, kind, req.params.entryId, { expectedRevision: revisionFrom(req) });
      changed('delete-entry', result);
      res.json({ ok: true, ...result });
    }));
  }
  return router;
}

function createAgentTeamsRouter({ store, registry, changed = () => {}, activeAgentIds = () => [] }) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', handle((_req, res) => res.json({ ok: true, ...store.catalog(registry()) })));
  router.patch('/:id', handle((req, res) => {
    const registryRows = registry();
    const current = store.get(req.params.id, registryRows);
    const live = new Set(activeAgentIds());
    if (current.rosterIds.some(id => live.has(id))) {
      const error = new Error('Finish or stop this team’s active agents before changing its assignments'); error.status = 409; throw error;
    }
    const team = store.save(req.params.id, req.body?.assignedAgentIds, { expectedRevision: revisionFrom(req), registryRows });
    changed(team);
    res.json({ ok: true, team, ...store.catalog(registryRows) });
  }));
  return router;
}

function createConnectorsRouter({ store, catalog, changed = () => {} }) {
  const router = express.Router();
  const runningChecks = new Set();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', handle((_req, res) => res.json({ ok: true, ...catalog() })));
  router.post('/import/preview', handle((req, res) => res.json({ ok: true, preview: store.previewImport(req.body) })));
  router.post('/import', handle((req, res) => {
    const result = store.importConfig(req.body);
    changed('import');
    res.status(201).json({ ok: true, connectors: result });
  }));
  router.post('/', handle((req, res) => {
    const result = store.save(req.body?.connector || req.body, { createOnly: true });
    changed('create', result);
    res.status(201).json({ ok: true, connector: result });
  }));
  router.get('/:id', handle((req, res) => res.json({ ok: true, connector: store.get(req.params.id) })));
  router.patch('/:id', handle((req, res) => {
    const supplied = req.body?.connector || req.body;
    const result = store.save({ ...supplied, id: req.params.id }, { expectedRevision: revisionFrom(req) });
    changed('save', result);
    res.json({ ok: true, connector: result });
  }));
  router.post('/:id/test', handle(async (req, res) => {
    if (runningChecks.has(req.params.id)) return res.status(409).json({ ok: false, error: 'This connector is already being checked' });
    runningChecks.add(req.params.id);
    try {
      const result = await store.test(req.params.id);
      changed('test', result.connector);
      res.json({ ok: true, ...result });
    } finally { runningChecks.delete(req.params.id); }
  }));
  router.post('/:id/disconnect', handle((req, res) => {
    const result = store.disconnect(req.params.id, { expectedRevision: revisionFrom(req) });
    changed('disconnect', result);
    res.json({ ok: true, ...catalog(), connector: result });
  }));
  router.delete('/:id', handle((req, res) => {
    const result = store.remove(req.params.id, { expectedRevision: revisionFrom(req) });
    changed('archive', result);
    res.json({ ok: true, connector: result });
  }));
  return router;
}

function createFordAgenticTeamsRouter({ service }) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', handle(async (_req, res) => res.json({ ok: true, ...await service.catalog() })));
  router.get('/:id', handle(async (req, res) => res.json({ ok: true, ...await service.get(req.params.id) })));
  function requireLocalAction(req, res, next) {
    const origin = req.get('Origin');
    if (req.get('Sec-Fetch-Site') === 'cross-site' || (origin && origin !== `${req.protocol}://${req.get('Host')}`)) {
      return res.status(403).json({ ok: false, code: 'ford_team_origin_rejected', error: 'Install or uninstall teams from the GLaDOS app.' });
    }
    if ((Number(req.get('Content-Length')) > 0 || req.get('Transfer-Encoding')) && !req.is('application/json')) {
      return res.status(415).json({ ok: false, code: 'ford_team_json_required', error: 'Team actions require a JSON request.' });
    }
    next();
  }
  router.post('/:id/install', requireLocalAction, handle(async (req, res) => {
    const result = await service.install(req.params.id, { expectedRevision: revisionFrom(req) });
    res.status(202).json({ ok: true, ...result });
  }));
  router.delete('/:id', requireLocalAction, handle(async (req, res) => {
    res.json({ ok: true, ...await service.remove(req.params.id, { expectedRevision: revisionFrom(req) }) });
  }));
  return router;
}

module.exports = { createAgentLibraryRouter, createConnectorsRouter, createAgentTeamsRouter, createFordAgenticTeamsRouter };
