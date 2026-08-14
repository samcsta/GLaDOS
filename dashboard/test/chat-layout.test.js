const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');

test('operator chat shares the centered reading rail with profile initials on the right', () => {
  const css = fs.readFileSync(path.join(ROOT, 'dashboard/public/chat-alternate.css'), 'utf8');
  const rule = css.match(/html\[data-theme="quantum"\] \.chat-visual-chamber \.entry\.user-message\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(rule, /align-self:\s*center/);
  assert.match(rule, /width:\s*min\(calc\(100% - 64px\), 900px\)/);
  assert.match(rule, /max-width:\s*min\(calc\(100% - 64px\), 900px\)/);
  assert.match(rule, /margin:\s*12px auto 20px/);
  assert.match(css, /\.entry\.user-message::before\s*\{[^}]*content:\s*attr\(data-operator-initials\)[^}]*place-items:\s*center/s);
  assert.match(css, /html\[data-theme="quantum"\][^}]*\.entry\.user-message::before\s*\{[^}]*right:\s*3px/s);
  assert.match(css, /html\[data-theme="quantum"\][^}]*\.entry\.user-message pre\s*\{[^}]*width:\s*max-content[^}]*max-width:\s*min\(78%, 720px\)[^}]*margin-left:\s*auto/s);
  assert.match(css, /html\[data-theme="quantum"\][^}]*\.entry\.user-message pre\s*\{[^}]*border-radius:\s*16px 16px 4px 16px/s);
  assert.match(css, /html\[data-theme="quantum"\][^}]*\.entry\.user-message pre\s*\{[^}]*background:\s*#272d35[^}]*box-shadow:/s);
  assert.doesNotMatch(css, /\.entry\.user-message::before\s*\{\s*content:\s*none/);
});

test('agent chat uses a centered reading rail', () => {
  const css = fs.readFileSync(path.join(ROOT, 'dashboard/public/chat-alternate.css'), 'utf8');
  const rule = css.match(/html\[data-theme="quantum"\] \.chat-visual-chamber \.entry\.assistant-text\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(rule, /align-self:\s*flex-start/);
  assert.match(rule, /width:\s*min\(calc\(100% - 64px\), 900px\)/);
  assert.match(rule, /margin:\s*10px auto 26px/);
  assert.match(css, /\.transcript\s*\{[^}]*padding:\s*24px clamp\(18px, 3vw, 52px\) 44px/s);
});

test('Quantum timestamps remain in document flow so they cannot overlap output', () => {
  const css = fs.readFileSync(path.join(ROOT, 'dashboard/public/chat-alternate.css'), 'utf8');
  const rule = css.match(/html\[data-theme="quantum"\] \.chat-visual-chamber \.entry \.ts\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(rule, /position:\s*static/);
  assert.match(rule, /display:\s*block/);
  assert.match(rule, /text-align:\s*left/);
  assert.doesNotMatch(rule, /position:\s*absolute/);
});

test('Quantum response follow-up action stays compact without a full-width divider', () => {
  const css = fs.readFileSync(path.join(ROOT, 'dashboard/public/chat-alternate.css'), 'utf8');
  const rule = css.match(/html\[data-theme="quantum"\] \.chat-visual-chamber \.ask-glados-action\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(rule, /width:\s*fit-content/);
  assert.match(rule, /border:\s*0/);
  assert.match(rule, /opacity:\s*0/);
});

test('chat composer is a shared Codex-style shell with attachments and no voice control', () => {
  const css = fs.readFileSync(path.join(ROOT, 'dashboard/public/chat-alternate.css'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'dashboard/public/app.js'), 'utf8');
  assert.match(css, /html\[data-theme="quantum"\][^}]*\.chat-composer-shell\s*\{[^}]*width:\s*min\(calc\(100% - 24px\), 980px\)/s);
  assert.match(css, /\.composer-send-button\s*\{[^}]*border-radius:\s*50%/s);
  assert.match(app, /data-chat-attach/);
  assert.match(app, /textarea\.addEventListener\('paste'/);
  assert.match(app, /event\.clipboardData\?\.items/);
  assert.match(app, /data-chat-full-access/);
  assert.match(app, /data-chat-model/);
  assert.match(app, /data-chat-effort/);
  assert.doesNotMatch(app, /data-chat-context-ring|data-chat-context-label/);
  assert.doesNotMatch(app, /data-chat-voice|composer-voice|voice-button/);
  assert.equal((app.match(/function chatComposerMarkup\(/g) || []).length, 1);
  assert.equal((app.match(/chatComposerMarkup\(/g) || []).length, 3);
});

test('long transcript output starts expanded and remains collapsible', () => {
  const app = fs.readFileSync(path.join(ROOT, 'dashboard/public/app.js'), 'utf8');
  assert.match(app, /<pre class="collapsible open \$\{extraClass\}">/);
  assert.match(app, /long \? 'collapsible open' : ''/);
  assert.match(app, /expand-toggle">▾ collapse/);
});

test('Classic gives operator input a bubble and uses a unified composer bar', () => {
  const css = fs.readFileSync(path.join(ROOT, 'dashboard/public/chat-alternate.css'), 'utf8');
  const bubble = css.match(/html\[data-theme="classic"\] \.chat-visual-chamber \.entry\.user-message\s*\{([^}]*)\}/)?.[1] || '';
  const composer = css.match(/html\[data-theme="classic"\] \.chat-visual-chamber \.chat-composer-shell\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(bubble, /border:\s*1px solid var\(--control-border\)/);
  assert.match(bubble, /border-radius:\s*16px 4px 16px 16px/);
  assert.match(bubble, /background:\s*var\(--bg-hi\)/);
  assert.match(composer, /width:\s*min\(calc\(100% - 24px\), 920px\)/);
  assert.match(composer, /border-radius:\s*14px/);
});

test('agent model settings render direct inline selectors without opening every card', () => {
  const app = fs.readFileSync(path.join(ROOT, 'dashboard/public/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'dashboard/public/styles.css'), 'utf8');
  assert.match(app, /settings-agent-row/);
  assert.match(app, /inlineSelect\.addEventListener\('change'/);
  assert.match(app, /includeModel:\s*false/);
  assert.match(css, /\.settings-agent-row\s*\{[^}]*grid-template-columns/s);
});

test('project navigation is a collapsible folder tree and Sessions contains only unassigned work', () => {
  const app = fs.readFileSync(path.join(ROOT, 'dashboard/public/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'dashboard/public/styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'dashboard/public/index.html'), 'utf8');
  assert.match(app, /sidebar-project-folder/);
  assert.match(app, /data-project-toggle/);
  assert.match(app, /sessions\.filter\(session => !session\.projectId\)/);
  assert.match(app, /data-session-row=.*draggable="true"/);
  assert.match(app, /dataTransfer\.setData\('text\/plain'/);
  assert.match(app, /moveInvestigationSession\(sessionId, projectId\)/);
  assert.match(app, /moveInvestigationSession\(sessionId, null\)/);
  assert.doesNotMatch(app, /data-project-select="all"/);
  assert.doesNotMatch(app, />Unfiled</);
  assert.doesNotMatch(app, /Create a project, then drag a session into it|All sessions are filed in projects|No unassigned sessions/);
  assert.match(html, /id="sidebar-project-new"[^>]*aria-label="Create project"/);
  assert.match(html, /id="sidebar-session-new"[^>]*aria-label="New session"/);
  for (const label of ['Workspace', 'Projects', 'Sessions', 'Agents']) {
    assert.match(html, new RegExp(`<span class="collapsible-heading-label">${label}<\\/span>`));
  }
  assert.match(app, /data-project-delete-id/);
  assert.match(app, /deleteInvestigationProject\(project\.id\)/);
  assert.match(app, /sessions and conversations will be preserved and returned to Sessions/);
  assert.doesNotMatch(app, /sidebar-collection-toolbar/);
  assert.match(css, /\.sidebar-project-sessions\s*\{/);
  assert.match(css, /\.sidebar-project-row\.session-drop-target/);
});

test('session switching leaves background work running and refreshes every session indicator', () => {
  const app = fs.readFileSync(path.join(ROOT, 'dashboard/public/app.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'dashboard/server.js'), 'utf8');
  assert.doesNotMatch(server, /stop active agent turns before (?:creating a new investigation|switching investigations)/);
  assert.match(server, /activeChatTurns\.set\(key, \{\s*sessionId,/);
  assert.match(server, /background sessions are still running/);
  assert.match(server, /pendingGladosKickoffs = new Map\(\)/);
  assert.match(server, /findIndex\(row => !activeChatTurns\.has\(runtimeKey\(row\.sessionId, 'glados'\)\)\)/);
  assert.match(app, /is still working in the background/);
  for (const eventName of ['session-started', 'session-ended', 'agent-liveness', 'chat-turn-started', 'chat-turn-ended']) {
    const handler = app.slice(app.indexOf(`es.addEventListener('${eventName}'`));
    const refresh = handler.indexOf('refreshInvestigationNavigationSoon()');
    const currentSessionFilter = handler.indexOf('!== state.currentSessionId');
    assert.ok(refresh >= 0 && currentSessionFilter > refresh, `${eventName} must refresh background session state before filtering the active view`);
  }
});

test('background session completion stays white until that session is opened', () => {
  const app = fs.readFileSync(path.join(ROOT, 'dashboard/public/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'dashboard/public/styles.css'), 'utf8');
  assert.match(app, /glados-dash\.unread-completed-sessions/);
  assert.match(app, /function markBackgroundSessionCompleted\(sessionId\)/);
  assert.match(app, /data\.agentId === 'glados'\) markBackgroundSessionCompleted\(data\.investigationSessionId\)/);
  assert.match(app, /markSessionSeen\(body\.session\.id\)/);
  assert.match(app, /needsReview \? ' attention' : ''/);
  assert.match(app, /Completed — open to review/);
  assert.match(css, /\.session-run-state\.attention i\s*\{[^}]*background:\s*#f7f9fc[^}]*box-shadow:/s);
});
