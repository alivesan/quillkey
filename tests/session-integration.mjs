import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { readWav } from './wav.mjs';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8765';
const url = base.replace(/^http/, 'ws') + '/realtime';
const fixture = await readWav(new URL('./fixtures/synthetic-english.wav', import.meta.url));
const sessions = new Set();
function connect(options = {}) {
  const socket = new WebSocket(url, options);
  sessions.add(socket);
  const events = [];
  socket.on('message', raw => { events.push(JSON.parse(raw.toString())); });
  socket.on('close', (code) => events.push({ type: '_closed', code }));
  socket.on('error', error => events.push({ type: '_error', message: error.message }));
  socket.on('unexpected-response', (_, response) => { events.push({ type: '_http', status: response.statusCode }); response.resume(); socket.terminate(); });
  async function until(predicate, description) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const found = events.find(predicate);
      if (found) return found;
      await delay(10);
    }
    throw new Error(`Timeout: ${description}; events=${JSON.stringify(events)}`);
  }
  return { socket, events, until, async ready() {
    await until(() => socket.readyState === WebSocket.OPEN, 'socket open');
    socket.send(JSON.stringify({ type: 'session.update', session: { sample_rate: fixture.sampleRate, language: 'en', endpointing_ms: 700 } }));
    await until(e => e.type === 'session.updated', 'session.updated');
  } };
}
async function idle() {
  for (let n = 0; n < 100; n++) {
    const response = await fetch(base + '/api/status');
    if (!(await response.json()).busy) { await delay(200); return; }
    await delay(50);
  }
  throw new Error('Server remained busy after session close');
}
const results = [];
async function check(name, fn) {
  const start = performance.now();
  await fn();
  const result = { name, success: true, seconds: (performance.now() - start) / 1000 };
  results.push(result); console.log(JSON.stringify(result));
}
try {
  await check('origin rejection', async () => {
    assert.equal((await fetch(base + '/api/status', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    const session = connect({ origin: 'https://untrusted.example' });
    assert.equal((await session.until(e => e.type === '_http', 'origin HTTP rejection')).status, 403);
  });
  await check('concurrent session rejection', async () => {
    const first = connect(); await first.ready();
    const second = connect();
    const error = await second.until(e => e.type === 'error', 'busy error');
    assert.match(error.error.message, /another recording/i);
    assert.equal((await second.until(e => e.type === '_closed', 'busy close')).code, 1013);
    first.socket.close(); await idle();
  });
  await check('empty commit', async () => {
    const session = connect(); await session.ready();
    session.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    await session.until(e => e.type === 'input_audio_buffer.committed', 'empty commit acknowledgement');
    assert.ok(!session.events.some(e => e.transcript?.trim()), 'Empty input must not fabricate transcript');
    session.socket.close(); await idle();
  });
  await check('cancel then fresh session with real transcript', async () => {
    const cancelled = connect(); await cancelled.ready();
    cancelled.socket.send(fixture.pcm.subarray(0, fixture.sampleRate));
    cancelled.socket.terminate(); await idle();
    const fresh = connect(); await fresh.ready();
    for (let p = 0; p < fixture.pcm.length; p += 3200) fresh.socket.send(fixture.pcm.subarray(p, p + 3200));
    fresh.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    await fresh.until(e => e.type === 'input_audio_buffer.committed', 'fresh commit');
    const transcript = fresh.events.filter(e => e.type?.endsWith('.completed')).map(e => e.transcript || '').join(' ').trim();
    assert.ok(transcript.length > 0, 'Fresh session must produce real completed transcript');
    console.log(JSON.stringify({ event: 'fresh_transcript', transcript }));
    fresh.socket.close(); await idle();
  });
  console.log(JSON.stringify({ success: true, tests: results }));
} catch (error) { console.error(JSON.stringify({ success: false, error: error.message, tests: results })); process.exitCode = 1; }
finally { for (const socket of sessions) if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); }
