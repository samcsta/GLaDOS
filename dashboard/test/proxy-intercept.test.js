const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { proxyInterceptStatus, setProxyIntercept, decideProxyIntercept } = require('../lib/proxy/mitmproxy-runner');

test('interception control only accepts current-session pending messages and writes owner-only decisions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-intercept-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { trafficDir: root, sessionId: 'current' };
  assert.deepEqual(proxyInterceptStatus(config), { interceptRequests: false, interceptResponses: false, interceptWebsocketClient: false, interceptWebsocketServer: false, pending: [] });
  assert.equal(setProxyIntercept(config, { interceptRequests: true }).interceptRequests, true);
  assert.equal(setProxyIntercept(config, { interceptWebsocketClient: true }).interceptWebsocketClient, true);
  assert.equal(setProxyIntercept(config, { interceptResponses: true }).interceptWebsocketClient, true);
  const pending = { id: 'request-123', sessionId: 'current', expiresAt: Date.now() + 60000, createdAt: Date.now(), editable: true };
  fs.writeFileSync(path.join(root, 'intercept/pending/request-123.json'), JSON.stringify(pending));
  fs.writeFileSync(path.join(root, 'intercept/pending/request-other.json'), JSON.stringify({ ...pending, id: 'request-other', sessionId: 'other' }));
  assert.equal(proxyInterceptStatus(config).pending.length, 1);
  assert.throws(() => decideProxyIntercept(config, 'request-other', { action: 'drop' }), /no longer pending/);
  assert.throws(() => decideProxyIntercept(config, '../request-123', { action: 'drop' }), /Invalid/);
  assert.throws(() => setProxyIntercept(config, { interceptResponses: 'true' }), /boolean/);
  const result = decideProxyIntercept(config, 'request-123', { action: 'forward', raw: 'GET / HTTP/1.1\r\nHost: fixture.test\r\n\r\n' });
  assert.equal(result.ok, true);
  const command = path.join(root, 'intercept/commands/request-123.json');
  assert.equal(JSON.parse(fs.readFileSync(command)).action, 'forward');
  if (process.platform !== 'win32') assert.equal(fs.statSync(command).mode & 0o777, 0o600);
  pending.editable = false;
  fs.writeFileSync(path.join(root, 'intercept/pending/request-123.json'), JSON.stringify(pending));
  assert.throws(() => decideProxyIntercept(config, 'request-123', { action: 'forward', raw: 'GET / HTTP/1.1\r\n\r\n' }), /cannot be forwarded/);
  assert.equal(decideProxyIntercept(config, 'request-123', { action: 'forward' }).ok, true);
  const websocket = { ...pending, id: 'websocket-1', phase: 'websocket', editable: true };
  fs.writeFileSync(path.join(root, 'intercept/pending/websocket-1.json'), JSON.stringify(websocket));
  assert.equal(decideProxyIntercept(config, 'websocket-1', { action: 'forward', raw: 'plain text with no HTTP header separator' }).ok, true);
});

test('addon holds, edits, forwards, drops and releases HTTP messages without leaking listener identity', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-intercept-addon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const addon = path.resolve(__dirname, '../lib/proxy/mitmproxy-glados-addon.py');
  const script = String.raw`
import asyncio, importlib.util, json, sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('addon', sys.argv[1])
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)
class Flow:
    def __init__(self):
        self.request = SimpleNamespace(method='POST', pretty_url='https://fixture.test/original', host='fixture.test', path='/original', http_version='HTTP/1.1', headers={'X-GLaDOS-Agent':'recon','X-GLaDOS-Session':'spoofed','Authorization':'Bearer confidential'}, raw_content=b'original')
        self.response = None
        self.metadata = {}
        self.error = None
        self.intercepted = False
        self.killed = False
    def intercept(self): self.intercepted = True
    def resume(self): self.intercepted = False
    def kill(self): self.killed = True; self.error = 'dropped'; self.intercepted = False
def pending():
    return json.loads(next((addon.INTERCEPT_DIR / 'pending').glob('*.json')).read_text())
def controls(requests=False, responses=False):
    addon._write_json(addon.INTERCEPT_DIR / 'control.json', {'interceptRequests':requests,'interceptResponses':responses})
async def settle():
    tasks = list(addon._pending_tasks.values())
    if tasks: await asyncio.wait_for(asyncio.gather(*tasks), 2)
async def main():
    addon.running()
    controls(True)
    flow = Flow()
    addon.request(flow)
    assert flow.intercepted and flow.metadata['glados_session_id'] == 'listener-session'
    assert not any(k.lower().startswith('x-glados-') for k in flow.request.headers)
    item = pending()
    assert item['sessionId'] == 'listener-session' and item['phase'] == 'request'
    assert 'Bearer confidential' in item['raw']
    addon._write_json(addon.INTERCEPT_DIR / 'commands' / (item['id'] + '.json'), {'id':item['id'],'action':'forward','raw':'PUT /edited HTTP/1.1\r\nAuthorization: Bearer confidential\r\nX-GLaDOS-Session: different\r\nContent-Length: 999\r\n\r\nchanged'})
    await settle()
    assert not flow.intercepted and flow.request.path == '/edited' and flow.request.method == 'PUT'
    assert flow.request.raw_content == b'changed' and flow.request.headers['Content-Length'] == '7'
    assert not any(k.lower().startswith('x-glados-') for k in flow.request.headers)
    assert not list((addon.INTERCEPT_DIR / 'pending').glob('*.json'))
    flow.response = SimpleNamespace(status_code=200, http_version='HTTP/1.1', reason='OK', headers={'Content-Type':'text/plain'}, raw_content=b'before')
    controls(False, True)
    addon.response(flow)
    assert flow.intercepted
    item = pending()
    addon._write_json(addon.INTERCEPT_DIR / 'commands' / (item['id'] + '.json'), {'id':item['id'],'action':'forward','raw':'HTTP/1.1 202 Accepted\r\nContent-Type: text/plain\r\n\r\nafter'})
    await settle()
    assert flow.response.status_code == 202 and flow.response.raw_content == b'after'
    event = json.loads(addon.TRAFFIC_JSONL.read_text().splitlines()[0])
    assert event['sessionId'] == 'listener-session' and event['request']['headers']['Authorization'] == '[REDACTED]'
    assert event['requestEdited'] and event['responseEdited'] and event['edited']
    assert event['response']['line'] == 'HTTP/1.1 202 Accepted'
    unchanged = Flow()
    try: addon._apply_raw(unchanged, 'request', 'invalid HTTP request')
    except ValueError: pass
    else: raise AssertionError('Invalid edit must fail')
    assert not unchanged.metadata.get('glados_request_edited') and not unchanged.metadata.get('glados_response_edited')
    controls(True)
    dropped = Flow(); addon.request(dropped); item = pending()
    addon._write_json(addon.INTERCEPT_DIR / 'commands' / (item['id'] + '.json'), {'id':item['id'],'action':'drop'})
    await settle(); assert dropped.killed
    released = Flow(); addon.request(released); controls(False); await settle()
    assert not released.intercepted and released.request.path == '/original'
    controls(True); binary = Flow(); binary.request.raw_content = b'\xff\x00'; addon.request(binary)
    assert not pending()['editable']; controls(False); await settle()
    controls(True); addon.INTERCEPT_TIMEOUT = 0
    expired = Flow(); addon.request(expired); await settle(); assert not expired.intercepted
    assert not list((addon.INTERCEPT_DIR / 'pending').glob('*.json'))
    flow.websocket = SimpleNamespace(messages=[SimpleNamespace(content=b'{"token":"private","ok":true}', is_text=True, from_client=True, type=1, timestamp=1.5)])
    await addon.websocket_message(flow)
    ws = json.loads(addon.WEBSOCKET_JSONL.read_text().splitlines()[0])
    assert ws['sessionId'] == 'listener-session' and ws['type'] == 'websocket' and ws['fromClient']
    assert json.loads(ws['body']) == {'token':'[REDACTED]','ok':True}
    print(json.dumps({'passed':True, 'pending':len(addon._pending_tasks), 'status':event['status']}))
asyncio.run(main())
`;
  const result = cp.spawnSync(process.platform === 'win32' ? 'python.exe' : 'python3', ['-c', script, addon], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, GLADOS_PROXY_TRAFFIC_JSONL: path.join(root, 'proxy-events.jsonl'), GLADOS_PROXY_WEBSOCKET_JSONL: path.join(root, 'websocket-events.jsonl'), GLADOS_PROXY_INTERCEPT_DIR: path.join(root, 'intercept'), GLADOS_PROXY_SESSION_ID: 'listener-session' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { passed: true, pending: 0, status: 202 });
});

test('WebSocket hook awaits directional text edit/drop decisions and preserves other messages and binary bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-websocket-intercept-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const addon = path.resolve(__dirname, '../lib/proxy/mitmproxy-glados-addon.py');
  const script = String.raw`
import asyncio, importlib.util, json, sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('addon', sys.argv[1]); addon = importlib.util.module_from_spec(spec); spec.loader.exec_module(addon)
class Message:
    def __init__(self, body, client=True, binary=False):
        self.content = body; self.from_client = client; self.is_text = not binary; self.type = 2 if binary else 1; self.timestamp = 2; self.dropped = False
    def drop(self): self.dropped = True
class Flow:
    def __init__(self):
        self.request = SimpleNamespace(pretty_url='https://fixture.test/ws')
        self.websocket = SimpleNamespace(messages=[])
        self.metadata = {'glados_agent_tag':'fixture'}
        self.intercepted = False; self.killed = False
    def kill(self): self.killed = True; raise AssertionError('Must not kill upgraded connection')
def controls(client=False, server=False):
    addon._write_json(addon.INTERCEPT_DIR / 'control.json', {'interceptWebsocketClient':client,'interceptWebsocketServer':server})
def pending(): return json.loads(next((addon.INTERCEPT_DIR / 'pending').glob('*.json')).read_text())
async def start(flow, message):
    flow.websocket.messages.append(message)
    task = asyncio.create_task(addon.websocket_message(flow)); await asyncio.sleep(0)
    return task
def decide(item, action, raw=None):
    command = {'id':item['id'],'action':action}
    if raw is not None: command['raw'] = raw
    addon._write_json(addon.INTERCEPT_DIR / 'commands' / (item['id'] + '.json'), command)
async def finish(task): await asyncio.wait_for(task, 2)
async def main():
    addon.running(); flow = Flow(); controls(True)
    message = Message(b'original')
    task = await start(flow, message)
    item = pending()
    assert not task.done() and item['phase'] == 'websocket' and item['raw'] == 'original' and item['editable'] and item['fromClient']
    assert message.content == b'original' and not message.dropped and not addon.WEBSOCKET_JSONL.exists()
    decide(item, 'forward', 'edited\x00text'); await finish(task)
    assert message.content == b'edited\x00text' and not message.dropped and not flow.killed
    first = json.loads(addon.WEBSOCKET_JSONL.read_text().splitlines()[0]); assert first['edited'] and not first['dropped'] and first['sessionId'] == 'ws-session'
    dropped = Message(b'only this frame'); task = await start(flow, dropped); decide(pending(), 'drop'); await finish(task)
    assert dropped.dropped and not message.dropped and not flow.killed
    assert json.loads(addon.WEBSOCKET_JSONL.read_text().splitlines()[-1])['dropped']
    server = Message(b'server passes', client=False); await finish(await start(flow, server))
    assert not server.dropped and not list((addon.INTERCEPT_DIR / 'pending').glob('*.json'))
    controls(False, True)
    server = Message(b'server held', client=False); task = await start(flow, server); item = pending(); assert not item['fromClient']
    decide(item, 'forward', 'server edited'); await finish(task); assert server.content == b'server edited'
    controls(True)
    binary = Message(b'\x00\xff', binary=True); task = await start(flow, binary); item = pending(); assert not item['editable'] and item['binary'] and item['encoding'] == 'base64'
    decide(item, 'forward'); await finish(task); assert binary.content == b'\x00\xff'
    released = Message(b'unchanged'); task = await start(flow, released); controls(); await finish(task); assert released.content == b'unchanged'
    assert not list((addon.INTERCEPT_DIR / 'pending').glob('*.json')) and not addon._pending_tasks
    print(json.dumps({'passed':True,'messages':len(addon.WEBSOCKET_JSONL.read_text().splitlines())}))
asyncio.run(main())
`;
  const result = cp.spawnSync(process.platform === 'win32' ? 'python.exe' : 'python3', ['-c', script, addon], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, GLADOS_PROXY_TRAFFIC_JSONL: path.join(root, 'proxy-events.jsonl'), GLADOS_PROXY_WEBSOCKET_JSONL: path.join(root, 'websocket-events.jsonl'), GLADOS_PROXY_INTERCEPT_DIR: path.join(root, 'intercept'), GLADOS_PROXY_SESSION_ID: 'ws-session' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { passed: true, messages: 6 });
});
