import WebSocket from 'ws';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { readWav } from './wav.mjs';

const args = process.argv.slice(2);
const path = args[0];
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const log = (event, fields = {}) => process.stdout.write(JSON.stringify({ event, ...fields }) + '\n');
let socket;
try {
  if (!path || path.startsWith('--')) throw new Error('Usage: node tests/stream-smoke.mjs file.wav [--fast] [--expect phrase] [--url ws://127.0.0.1:8765/realtime] [--timeout-ms 120000]');
  const wav = await readWav(path);
  const timeoutMs = Number(option('--timeout-ms', 120000));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid timeout');
  const expected = option('--expect', null);
  if (args.includes('--expect') && !expected) throw new Error('--expect requires a phrase');
  socket = new WebSocket(option('--url', 'ws://127.0.0.1:8765/realtime'));
  const started = performance.now();
  let audioStarted, committedAt, firstTextAt;
  const segments = [];
  let deltas = '';
  let ended = false;
  const waiters = new Map();
  let rejectFailure;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  // Register a rejection handler immediately, including during paced streaming.
  failure.catch(() => {});
  const timer = setTimeout(() => rejectFailure(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  const wait = type => Promise.race([new Promise(resolve => waiters.set(type, resolve)), failure]);
  socket.on('error', rejectFailure);
  socket.on('close', (code, reason) => { if (!ended) rejectFailure(new Error(`Unexpected close ${code}: ${reason}`)); });
  socket.on('message', raw => {
    try {
      const event = JSON.parse(raw.toString());
      log('server', { message: event });
      if (event.type === 'error' || event.error) throw new Error(JSON.stringify(event));
      if (typeof event.delta === 'string' && event.delta) { deltas += event.delta; firstTextAt ??= performance.now(); }
      if (event.type?.endsWith('.completed') && typeof event.transcript === 'string' && event.transcript.trim()) {
        segments.push(event.transcript.trim()); firstTextAt ??= performance.now();
      }
      const resolve = waiters.get(event.type);
      if (resolve) { waiters.delete(event.type); resolve(event); }
    } catch (error) { rejectFailure(error); }
  });
  try {
    await Promise.race([new Promise(resolve => socket.once('open', resolve)), failure]);
    const updated = wait('session.updated');
    socket.send(JSON.stringify({ type: 'session.update', session: { sample_rate: wav.sampleRate, language: 'en', endpointing_ms: 700 } }));
    await updated;
    audioStarted = performance.now();
    const chunkBytes = Math.max(2, Math.floor(wav.sampleRate * 0.02) * 2);
    for (let offset = 0; offset < wav.pcm.length; offset += chunkBytes) {
      if (!args.includes('--fast')) {
        const target = audioStarted + offset / (wav.sampleRate * 2) * 1000;
        await Promise.race([delay(Math.max(0, target - performance.now())), failure]);
      }
      await Promise.race([new Promise((resolve, reject) => socket.send(wav.pcm.subarray(offset, offset + chunkBytes), error => error ? reject(error) : resolve())), failure]);
    }
    if (!args.includes('--fast')) await Promise.race([delay(Math.max(0, audioStarted + wav.durationSeconds * 1000 - performance.now())), failure]);
    const committed = wait('input_audio_buffer.committed');
    committedAt = performance.now();
    socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    await committed;
    const transcript = segments.join(' ').trim();
    if (!transcript) throw new Error(`No completed transcript received (partial text: ${JSON.stringify(deltas)})`);
    const normalize = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (expected && !normalize(transcript).includes(normalize(expected))) throw new Error(`Expected phrase missing: ${JSON.stringify(expected)}; transcript: ${JSON.stringify(transcript)}`);
    log('result', { success: true, transcript, segments, sampleRate: wav.sampleRate, durationSeconds: wav.durationSeconds, fast: args.includes('--fast'), firstTextLatencySeconds: (firstTextAt - audioStarted) / 1000, finalizationSeconds: (performance.now() - committedAt) / 1000, elapsedSeconds: (performance.now() - started) / 1000 });
  } finally { ended = true; clearTimeout(timer); socket.terminate(); }
} catch (error) {
  socket?.terminate();
  log('result', { success: false, error: error.message });
  process.exitCode = 1;
}
