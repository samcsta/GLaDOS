const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const sourcePath = 'gh-example-deploy-123/sca-opus-v2/findings/critical/SC-002-01.md';

function sourceContext(extra = {}) {
  const context = vm.createContext({ URL, URLSearchParams, AbortController, setTimeout, clearTimeout, escapeHtml, ...extra });
  vm.runInContext(section('const CLIPPY_SEVERITIES =', 'function openClippy()'), context);
  return context;
}

test('Clippy citations survive relative paths and historical localhost dashboard ports', () => {
  const context = sourceContext();
  for (const href of [sourcePath, `/${sourcePath}`, `http://127.0.0.1:64459/${sourcePath}`, `https://localhost:59916/${sourcePath}`, `http://[::1]:5000/${sourcePath}`]) {
    const result = context.clippySourceReference(`${href}#L42-L58`, { allowRelative: true });
    assert.deepEqual({ ...result }, { repo: 'gh-example-deploy-123', path: sourcePath, line: 42 });
    assert.match(context.clippySourceHref(result), /^\/api\/clippy\/file\?repo=gh-example-deploy-123&path=.*#L42$/);
  }
  const stable = context.clippySourceHref({ repo: 'gh-example-deploy-123', path: sourcePath, line: 42 });
  assert.deepEqual({ ...context.clippySourceReference(stable) }, { repo: 'gh-example-deploy-123', path: sourcePath, line: 42 });
  assert.equal(context.clippySourceReference(sourcePath), null, 'ordinary assistant links are not assumed to be Clippy sources');
});

test('relative links inside evidence stay within their engagement repository', () => {
  const context = sourceContext();
  const options = { allowRelative: true, source: { repo: 'repo-a', path: 'repo-a/notes/current_position.md' } };
  assert.equal(context.clippySourceReference('../findings/high/auth.md#L28', options).path, 'repo-a/findings/high/auth.md');
  assert.equal(context.clippySourceReference('#L17', options).path, 'repo-a/notes/current_position.md');
  assert.equal(context.clippySourceReference('#L17', options).line, 17);
  assert.equal(context.clippySourceReference('../../repo-b/file.md', options), null);
});

test('source links reject foreign hosts, executable schemes, malformed paging, and traversal', () => {
  const context = sourceContext();
  const unsafe = [
    `https://example.test/${sourcePath}`, `http://127.0.0.1.example.test/${sourcePath}`,
    `http://analyst:secret@localhost/${sourcePath}`, `file:///${sourcePath}`, 'javascript:alert(1)',
    '/api/settings.json', 'repo-a/../secret.md', 'repo-a/%2e%2e/secret.md', 'repo-a/%252e%252e/secret.md',
    'repo-a//secret.md', 'repo-a\\secret.md', `/${sourcePath}?token=secret`, `/${sourcePath}#L10000001`,
    '/api/clippy/file?repo=repo-a&path=repo-b%2Fsecret.md',
    '/api/clippy/file?repo=repo-a&path=repo-a%2Fsecret.md&path=repo-a%2Fother.md',
    '/api/clippy/file?repo=repo-a&path=repo-a%2Fsecret.md&url=https://example.test',
  ];
  for (const href of unsafe) assert.equal(context.clippySourceReference(href, { allowRelative: true }), null, href);
});

test('completion handoff extracts six unique safe finding paths without treating external URLs as evidence', () => {
  const context = sourceContext();
  const text = [
    `[Finding](http://127.0.0.1:64459/${sourcePath}#L42)`,
    `Duplicate: \`${sourcePath}\``,
    '[Foreign](https://example.test/repo-foreign/findings/high/auth.md)',
    'https://example.test/repo-foreign/findings/high/auth.md',
    '`repo-a/../findings/high/outside.md`',
    ...Array.from({ length: 8 }, (_, index) => `\`repo-${index}/findings/high/F-${index}.md\``),
  ].join('\n');
  const paths = Array.from(context.clippySourcePathsFromText(text));
  assert.equal(paths.length, 6);
  assert.equal(paths[0], sourcePath);
  assert.equal(new Set(paths).size, 6);
  assert.equal(paths.some(value => /foreign|\.\./.test(value)), false);
  assert.ok(paths.includes('repo-0/findings/high/F-0.md'));
  const stable = context.clippySourceHref({ repo: 'gh-example-deploy-123', path: sourcePath });
  assert.deepEqual(Array.from(context.clippySourcePathsFromText(`[Source](${stable})`)), [sourcePath]);
});

function anchor(href) {
  const attrs = { href };
  return {
    attrs, dataset: {}, listeners: [],
    getAttribute: name => attrs[name],
    setAttribute: (name, value) => { attrs[name] = value; },
    removeAttribute: name => { delete attrs[name]; },
    addEventListener() {},
  };
}

test('Markdown opens source evidence internally on click and leaves other links unchanged', () => {
  const context = sourceContext();
  vm.runInContext(section('function enhanceMarkdownContent(', 'function addAskGladosAction('), context);
  const citations = [anchor(`http://127.0.0.1:64459/${sourcePath}#L42`), anchor('https://dradis.example.test/projects/42')];
  for (const item of citations) item.addEventListener = (_type, listener) => item.listeners.push(listener);
  const container = { querySelectorAll: selector => selector === 'a[href]' ? citations : [] };
  const opened = [];
  context.openClippySourcePreview = value => opened.push(value);
  context.enhanceMarkdownContent(container, { clippySources: true });
  context.enhanceMarkdownContent(container, { clippySources: true });
  assert.equal(opened.length, 0, 'rendering performs no source lookup');
  assert.match(citations[0].attrs.href, /^\/api\/clippy\/file\?/);
  assert.equal(citations[0].attrs.target, undefined);
  assert.equal(citations[0].listeners.length, 1);
  let prevented = false;
  citations[0].listeners[0]({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(opened[0].path, sourcePath);
  assert.equal(opened[0].line, 42);
  assert.equal(citations[1].attrs.href, 'https://dradis.example.test/projects/42');
  assert.equal(citations[1].attrs.target, '_blank');
  assert.equal(citations[1].attrs.rel, 'noopener noreferrer');
  assert.equal(citations[1].listeners.length, 0);
});

function previewFixture(fetch) {
  const buttons = new Map();
  const element = selector => {
    if (!buttons.has(selector)) buttons.set(selector, { addEventListener: (_type, listener) => { buttons.get(selector).click = listener; } });
    return buttons.get(selector);
  };
  const target = { isConnected: true, innerHTML: '', querySelector: element };
  const backdrop = { innerHTML: '', querySelector: selector => selector === '[data-clippy-source-content]' ? target : element(selector) };
  let close;
  const errors = [];
  const context = sourceContext({
    fetch,
    document: { createElement: () => backdrop, getElementById: () => ({ appendChild() {} }) },
    prepareCollectionDialog: (_backdrop, { onClose }) => { close = () => { onClose(); target.isConnected = false; }; return close; },
    clippyEmpty: (title, text) => `${title}: ${text}`,
    clippyError: (_target, error) => errors.push(error.message),
    clippyViewAlive: () => true,
  });
  vm.runInContext(section('async function openClippyLeadSource(', 'function renderClippyFindings('), context);
  return { context, target, buttons, errors, close: () => close() };
}

test('source preview reads the connected MCP proxy in bounded pages and escapes source content', async () => {
  const requests = [];
  const fixture = previewFixture(async (url, options) => {
    requests.push({ url, options });
    const offset = Number(new URL(url, 'http://127.0.0.1:5000').searchParams.get('offset'));
    const lines = Array.from({ length: Math.min(200, 450 - offset + 1) }, (_, index) => `${offset + index}: <script>untrusted source</script>`).join('\n');
    return { ok: true, json: async () => ({ ok: true, content: lines, offset, limit: 200, total_lines: 450, lineNumbered: true }) };
  });
  await fixture.context.openClippySourcePreview({ repo: 'gh-example-deploy-123', path: sourcePath, line: 241 });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^\/api\/clippy\/file\?/);
  assert.match(requests[0].url, /offset=233&limit=200$/);
  assert.match(fixture.target.innerHTML, /lines 233–432 of 450/);
  assert.match(fixture.target.innerHTML, /&lt;script&gt;untrusted source/);
  assert.doesNotMatch(fixture.target.innerHTML, /<script>/);
  await fixture.buttons.get('[data-clippy-source-next]').click();
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /offset=433&limit=200$/);
  assert.match(fixture.target.innerHTML, /lines 433–450 of 450/);
  assert.match(fixture.target.innerHTML, /data-clippy-source-next disabled/);
  await fixture.buttons.get('[data-clippy-source-prev]').click();
  assert.match(requests[2].url, /offset=233&limit=200$/);
  fixture.close();
});

test('closing source evidence aborts the lookup and ignores a late transport response', async () => {
  let respond;
  let signal;
  const fixture = previewFixture((_url, options) => { signal = options.signal; return new Promise(resolve => { respond = resolve; }); });
  const pending = fixture.context.openClippySourcePreview({ repo: 'gh-example-deploy-123', path: sourcePath });
  fixture.close();
  assert.equal(signal.aborted, true);
  respond({ ok: true, json: async () => ({ content: 'late private evidence', offset: 1, limit: 200 }) });
  await pending;
  assert.doesNotMatch(fixture.target.innerHTML, /late private evidence/);
  assert.deepEqual(fixture.errors, []);
});
