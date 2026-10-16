const express = require('express');
const { createClippyService, normalizeError } = require('../lib/clippy-intel');

function createClippyRouter({ service = createClippyService(), agentInfo = () => ({ agentId: 'pkg-clippy-intel--clippy', teamId: 'agent:pkg-clippy-intel--clippy' }) } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const handle = action => async (req, res) => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new DOMException('Clippy request timed out', 'TimeoutError')), 40000);
    deadline.unref?.();
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', close);
    try { res.json({ ok: true, ...await action(req, controller.signal) }); }
    catch (error) {
      const safe = normalizeError(error);
      if (!res.headersSent && !res.destroyed) res.status(safe.status).json({ ok: false, code: safe.code, error: safe.message });
    } finally { clearTimeout(deadline); res.off('close', close); }
  };
  router.get('/status', handle(async (_req, signal) => ({ ...await service.status({ signal }), ...await agentInfo() })));
  router.get('/leads', handle(req => service.leads(req.query)));
  router.post('/leads/search', express.json({ limit: '8kb' }), handle(req => service.searchLeads(req.body || {})));
  router.post('/leads/from-sources', express.json({ limit: '16kb' }), handle(req => service.leadsFromSources(req.body || {})));
  router.post('/leads/cancel', handle(() => service.cancelLeadSearch()));
  router.post('/leads/:id/save', express.json({ limit: '8kb' }), handle(req => service.saveLead(req.params.id, req.body || {})));
  router.post('/leads/:id/coverage', express.json({ limit: '8kb' }), handle(req => service.verifyLead(req.params.id, req.body || {})));
  router.get('/findings', handle((req, signal) => service.findings({ ...req.query, signal })));
  router.get('/findings/:id', handle((req, signal) => service.finding({ id: req.params.id, signal })));
  router.get('/index', handle(() => service.indexStatus()));
  router.post('/index/sync', express.json({ limit: '8kb' }), handle(req => service.syncIndex(req.body || {})));
  router.post('/index/cancel', handle(() => service.cancelIndex()));
  router.get('/opportunities', handle(req => service.opportunities(req.query)));
  router.post('/opportunities/coverage', express.json({ limit: '8kb' }), handle((req, signal) => service.reportCoverage({ domain: req.body?.domain, signal })));
  router.get('/repos', handle((req, signal) => service.repos({ q: req.query.q, signal })));
  router.get('/repos/:repo/files', handle((req, signal) => service.files({ repo: req.params.repo, signal })));
  router.get('/file', handle((req, signal) => service.file({ ...req.query, signal })));
  return router;
}
module.exports = { createClippyRouter };
