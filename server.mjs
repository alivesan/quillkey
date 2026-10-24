import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.QUILLKEY_PORT || 8765);
const enginePort = Number(process.env.QUILLKEY_ENGINE_PORT || 8766);
const runtimeRoot = process.env.QUILLKEY_RUNTIME_ROOT || path.join(root, 'vendor/runtime');
const exe = path.join(runtimeRoot, 'nemo-speech-0.2.0-windows-x86_64-cuda/bin/nemo-speech.exe');
const model = process.env.QUILLKEY_MODEL_PATH || path.join(root, 'models/nemotron-en-q8.gguf');
const logDir = process.env.QUILLKEY_LOG_DIR || path.join(root, 'logs');
const uiRoot = path.join(root, 'ui');
const secret = randomBytes(32).toString('hex');
const origin = `http://127.0.0.1:${port}`;
const engineBase = `http://127.0.0.1:${enginePort}`;
let engine, activeSocket, shuttingDown = false;
let state = { ready: false, status: 'loading', engine: 'Nemotron ASR Streaming', language: 'English', device: null, error: null };
mkdirSync(logDir, { recursive: true });

function launchEngine() {
  if (!existsSync(exe) || !existsSync(model)) {
    state = { ...state, status: 'error', error: 'Runtime or model is missing. Run Setup.ps1, then restart.' };
    return;
  }
  const out = openSync(path.join(logDir, 'engine.stdout.log'), 'w');
  const err = openSync(path.join(logDir, 'engine.stderr.log'), 'w');
  engine = spawn(exe, ['serve', '--asr-model', model, '--device', 'cuda:0', '--host', '127.0.0.1', '--port', String(enginePort), '--api-key', secret, '--no-ui'], {
    cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', out, err],
  });
  closeSync(out); closeSync(err);
  engine.on('error', e => { state = { ...state, ready: false, status: 'error', error: e.message }; });
  engine.on('exit', code => {
    if (!shuttingDown) state = { ...state, ready: false, status: 'error', error: `Speech engine stopped (exit ${code}). See logs/engine.stderr.log.` };
    activeSocket?.close(1011, 'Speech engine stopped');
  });
}

async function checkReady() {
  if (!engine || engine.exitCode !== null || state.status === 'error') return;
  try {
    const r = await fetch(`${engineBase}/ready`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(1500) });
    const data = await r.json();
    state = { ...state, ready: r.ok && data.ready === true, status: data.ready ? 'ready' : 'loading', device: data.device || null, error: null };
  } catch {
    if (state.ready) state = { ...state, ready: false, status: 'loading' };
  }
}

function allowedHost(req) { return req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`; }
function allowedOrigin(req) { return !req.headers.origin || req.headers.origin === origin || req.headers.origin === `http://localhost:${port}`; }
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (!allowedHost(req) || !allowedOrigin(req)) { res.writeHead(403); res.end('Local requests only'); return; }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  const url = new URL(req.url, origin);
  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...state, busy: Boolean(activeSocket), model: 'nemotron-speech-streaming-en-0.6b', local: true })); return;
  }
  try {
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const target = path.resolve(uiRoot, `.${relative}`);
    if (!target.startsWith(uiRoot + path.sep) || !(await stat(target)).isFile()) throw new Error('not found');
    res.setHeader('Content-Type', mime[path.extname(target)] || 'application/octet-stream');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:" + port + ' ws://localhost:' + port + "; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'");
    createReadStream(target).pipe(res);
  } catch { res.writeHead(404); res.end('Not found'); }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (!allowedHost(req) || !allowedOrigin(req) || req.url !== '/realtime') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
});
wss.on('connection', client => {
  function error(message) { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'error', error: { message } })); }
  if (!state.ready || activeSocket) { error(activeSocket ? 'Another recording is active.' : state.error || 'Model is still loading.'); client.close(1013); return; }
  activeSocket = client;
  const upstream = new WebSocket(`ws://127.0.0.1:${enginePort}/v1/audio/transcriptions/realtime`, { headers: { Authorization: `Bearer ${secret}` }, maxPayload: 2 * 1024 * 1024 });
  const queue = []; let queuedBytes = 0;
  // Bound a session even if a client disappears without stopping its microphone.
  const deadline = setTimeout(() => { error('Recording session timed out. Completed transcript remains available.'); client.close(1000); upstream.close(); }, 32 * 60 * 1000);
  upstream.on('open', () => { for (const [data, binary] of queue) upstream.send(data, { binary }); queue.length = 0; queuedBytes = 0; });
  client.on('message', (data, binary) => {
    if (upstream.bufferedAmount > 4 * 1024 * 1024) { error('Speech engine is not keeping up. Recording stopped.'); client.close(1011); return; }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
    else if (upstream.readyState === WebSocket.CONNECTING && queuedBytes + data.length <= 512 * 1024) { queue.push([data, binary]); queuedBytes += data.length; }
    else { error('Speech connection is unavailable.'); client.close(1011); }
  });
  upstream.on('message', (data, binary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary }); });
  upstream.on('error', () => { error('Could not connect to the local speech engine.'); client.close(1011); });
  upstream.on('close', () => { if (client.readyState === WebSocket.OPEN) client.close(1000); });
  client.on('error', () => upstream.close());
  client.on('close', () => { clearTimeout(deadline); if (activeSocket === client) activeSocket = null; upstream.close(); });
});
server.on('error', e => { console.error(e.message); shutdown(); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => { console.log(`QuillKey: ${origin}`); launchEngine(); });
const poll = setInterval(checkReady, 1000);
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true; clearInterval(poll); activeSocket?.terminate(); wss.close(); server.close();
  engine?.kill();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); process.on('exit', () => engine?.kill());
if (process.env.QUILLKEY_DESKTOP === '1') {
  process.stdin.resume();
  process.stdin.on('data', data => { if (data.toString().trim() === 'quit') shutdown(); });
  process.stdin.on('end', shutdown);
}
