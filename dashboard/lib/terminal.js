const pty = require('node-pty');
const os = require('node:os');

// Spawns a PTY and bridges it to a WebSocket. One shell per connection.
// Client frames (JSON): { type: "data", data: "<str>" } or { type: "resize", cols, rows }.
// Server frames: raw text chunks.
function attachTerminal(ws) {
  const shell = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/zsh');
  let term;
  try {
    term = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } catch (e) {
    try {
      ws.send(`\r\n\x1b[31m[terminal: shell spawn failed — ${e.message}]\x1b[0m\r\n`);
      ws.close();
    } catch {}
    return;
  }

  term.onData(d => {
    if (ws.readyState === ws.OPEN) ws.send(d);
  });
  term.onExit(() => { try { ws.close(); } catch {} });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'data' && typeof msg.data === 'string') term.write(msg.data);
    else if (msg.type === 'resize' && msg.cols && msg.rows) {
      try { term.resize(msg.cols, msg.rows); } catch {}
    }
  });
  ws.on('close', () => { try { term.kill(); } catch {} });
  ws.on('error', () => { try { term.kill(); } catch {} });
}

module.exports = { attachTerminal };
