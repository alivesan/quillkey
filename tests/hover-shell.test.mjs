import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function shell(argv = [], locked = false, clipboardMode = "ok") {
  const handlers = {}, commands = [], native = [], bounds = [], statuses = [];
  const switches = [], copied = [], timers = [];
  let clipboardText = "previous";
  const appHandlers = {};
  let quits = 0;
  const contents = { mainFrame: { url: 'http://127.0.0.1:18765/' }, send: (name, value) => commands.push(value) };
  const electron = { clipboard: { writeText(text) { if (clipboardMode === "throw") throw new Error("unavailable"); copied.push(text); clipboardText = text; }, readText() { return clipboardMode === "mismatch" ? "other" : clipboardText; } }, app: { disableHardwareAcceleration() {}, commandLine: { appendSwitch: (...args) => switches.push(args) }, requestSingleInstanceLock: () => locked, quit() { quits++; }, on: (name, fn) => appHandlers[name] = fn, whenReady: () => ({ then: () => ({ catch() {} }) }) }, ipcMain: { on: (name, fn) => handlers[name] = fn }, screen: { getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }) } };
  const context = vm.createContext({ require: name => name === 'electron' ? electron : require(name), __dirname: 'G:/test/desktop', process: { argv, env: {} }, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, URL, fetch() {} });
  vm.runInContext(readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8') + `\nglobalThis.api = { toggle, cancel, nativeEvent, nativeStopped, idle, ready(value) { nativeReady=value; }, set(s) { current=s; }, get() { return current; }, init(d,o,h) { dashboard=d; overlay=o; helper=h; nativeReady=true; rendererReady=true; } };`, context);
  const overlayContents = { mainFrame: { url: vm.runInContext('overlayURL', context) }, send: (_name, value) => statuses.push(value) };
  context.api.init({ isFocused: () => false, webContents: contents }, { isDestroyed: () => false, setBounds: value => bounds.push(value), webContents: overlayContents, showInactive() {} }, { stdin: { writable: true, write: text => native.push(JSON.parse(text)) } });
  return { api: context.api, handlers, commands, native, bounds, statuses, copied, timers, contents, overlayContents, switches, appHandlers, quits: () => quits };
}
test('click captures once, stale capture cannot start, recording click stops once', () => {
  const s = shell(); s.api.toggle(); const id = s.api.get().id;
  assert.equal(s.native.at(-1).type, 'capture');
  s.api.nativeEvent({ type: 'capture-result', id: 'stale', ok: true, target: { token: 'x' } });
  assert.equal(s.commands.length, 0);
  s.api.nativeEvent({ type: 'capture-result', id, ok: true, target: { token: 'x' } });
  assert.equal(s.commands.at(-1).type, 'start');
  s.handlers['quillkey:state']({ sender: s.contents, senderFrame: s.contents.mainFrame }, { sessionId: id, status: 'recording' });
  assert.equal(s.api.get().phase, 'recording'); s.api.toggle(); s.api.toggle();
  assert.equal(s.commands.filter(c => c.type === 'stop').length, 1);
});
test('second connecting click cancels and persistent idle stays visible', () => {
  const s = shell(); s.api.toggle(); s.api.toggle();
  assert.equal(s.api.get(), null); assert.equal(s.statuses.at(-1).phase, 'idle');
  assert.equal(s.bounds.at(-1).width, 64);
  s.api.nativeEvent({ type: 'capture-result', id: 'cancelled', ok: true, target: { token: 'x' } });
  assert.equal(s.commands.filter(c => c.type === 'start').length, 0);
});

test('synthetic microphone is available without automatic smoke orchestration', () => {
  const s = shell(['--synthetic-mic']);
  assert.ok(s.switches.some(([name]) => name === 'use-fake-device-for-media-stream'));
  assert.ok(s.switches.some(([name]) => name === 'use-file-for-fake-audio-capture'));
  assert.equal(s.commands.length, 0);
});

test('quit flag shuts down an existing instance and does not launch a fresh one', () => {
  const running = shell([], true);
  running.appHandlers['second-instance']({}, ['quillkey.exe', '--quit']);
  assert.equal(running.quits(), 1);
  const fresh = shell(['--quit'], true);
  assert.equal(fresh.quits(), 1);
  assert.equal(fresh.appHandlers['second-instance'], undefined);
});

test('final inserts into captured target and insertion completion clears the session', () => {
  const s = shell(); s.api.toggle(); const id = s.api.get().id;
  s.api.nativeEvent({ type: 'capture-result', id, ok: true, target: { token: 'original-field' } });
  const event = { sender: s.contents, senderFrame: s.contents.mainFrame };
  s.handlers['quillkey:state'](event, { sessionId: id, status: 'recording' });
  s.api.toggle();
  s.handlers['quillkey:final'](event, { sessionId: 'stale', text: 'wrong' });
  assert.equal(s.native.filter(c => c.type === 'insert').length, 0);
  s.handlers['quillkey:final'](event, { sessionId: id, text: 'Hello chat' });
  assert.equal(s.native.at(-1).target.token, 'original-field');
  s.handlers['quillkey:final'](event, { sessionId: id, text: 'duplicate' });
  assert.equal(s.native.filter(c => c.type === 'insert').length, 1);
  s.api.nativeEvent({ type: 'insert-result', id, ok: true });
  assert.equal(s.api.get(), null);
  s.api.idle(); assert.equal(s.statuses.at(-1).phase, 'idle');
});
test('overlay IPC rejects foreign frames and hover keeps bottom center stable', () => {
  const s = shell(); s.api.idle(); const initial = s.bounds.at(-1);
  s.handlers['quillkey:overlay-action']({ sender: {}, senderFrame: {} }, 'toggle');
  assert.equal(s.native.length, 0);
  s.handlers['quillkey:overlay-action']({ sender: s.overlayContents, senderFrame: s.overlayContents.mainFrame }, 'hover-enter');
  const open = s.bounds.at(-1);
  assert.equal(open.width, 320); assert.equal(open.x + open.width / 2, initial.x + initial.width / 2);
  assert.equal(open.y + open.height, initial.y + initial.height);
});


test('late hover and renderer IPC from destroyed windows is ignored without a crash', () => {
  const s = shell();
  const destroyed = { isDestroyed: () => true, get webContents() { throw new Error('Object has been destroyed'); } };
  s.api.init(destroyed, destroyed, { stdin: { writable: true, write() {} } });
  const event = { sender: s.overlayContents, get senderFrame() { throw new Error('Frame has been destroyed'); } };
  assert.doesNotThrow(() => s.handlers['quillkey:overlay-action'](event, 'hover-leave'));
  assert.doesNotThrow(() => s.handlers['quillkey:state'](event, { sessionId:'late',status:'recording' }));
  assert.doesNotThrow(() => s.api.cancel());
  assert.equal(s.commands.length, 0);
});

function finish(s, text = 'Final speech') {
  const id = s.api.get().id;
  s.handlers['quillkey:state']({ sender: s.contents, senderFrame: s.contents.mainFrame }, { sessionId: id, status: 'recording' });
  s.api.toggle();
  s.handlers['quillkey:final']({ sender: s.contents, senderFrame: s.contents.mainFrame }, { sessionId: id, text });
  return id;
}
test('refused native insertion copies final text and verifies success', () => {
  const s = shell(); s.api.toggle(); const id = s.api.get().id;
  s.api.nativeEvent({ type: 'capture-result', id, ok: true, target: { token: 'field' } });
  finish(s); assert.equal(s.api.get().text, 'Final speech');
  s.api.nativeEvent({ type: 'insert-result', id, ok: false });
  assert.deepEqual(s.copied, ['Final speech']);
  assert.match(s.statuses.at(-1).title, /^Copied .* press Ctrl\+V$/);
  assert.equal(s.commands.at(-1).ok, true);
});

test('automatic recording stop permits the final transcript without a second click', () => {
  const s = shell(); s.api.ready(false); s.api.toggle();
  const id = s.api.get().id;
  const event = { sender: s.contents, senderFrame: s.contents.mainFrame };
  s.handlers['quillkey:state'](event, { sessionId: id, status: 'recording' });
  s.handlers['quillkey:state'](event, { sessionId: id, status: 'processing' });
  s.handlers['quillkey:final'](event, { sessionId: id, text: 'Long dictation completed.' });
  assert.deepEqual(s.copied, ['Long dictation completed.']);
  assert.equal(s.api.get(), null);
});
test('capture failure and missing native helper allow copy-only click dictation', () => {
  for (const unavailable of [false, true]) {
    const s = shell(); s.api.ready(!unavailable); s.api.toggle();
    if (!unavailable) s.api.nativeEvent({ type: 'capture-result', id: s.api.get().id, ok: false });
    assert.equal(s.commands.at(-1).type, 'start');
    finish(s);
    assert.equal(s.native.filter(c => c.type === 'insert').length, 0);
    assert.deepEqual(s.copied, ['Final speech']);
  }
});
test('clipboard errors and failed verification retain transcript without claiming success', () => {
  for (const mode of ['throw', 'mismatch']) {
    const s = shell([], false, mode); s.api.ready(false); s.api.toggle(); finish(s);
    assert.equal(s.statuses.at(-1).title, 'Transcript ready');
    assert.equal(s.commands.at(-1).ok, false);
  }
});
test('empty, cancelled, stale and manual final messages never copy', () => {
  const s = shell(); const event = { sender: s.contents, senderFrame: s.contents.mainFrame };
  s.handlers['quillkey:final'](event, { sessionId: 'manual', text: 'manual' });
  s.api.ready(false); s.api.toggle();
  s.handlers['quillkey:final'](event, { sessionId: 'stale', text: 'stale' });
  finish(s, '   ');
  s.api.toggle(); const id = s.api.get().id; s.api.cancel();
  s.handlers['quillkey:final'](event, { sessionId: id, text: 'cancelled' });
  assert.deepEqual(s.copied, []);
});
test('native helper death with pending final text falls back once', () => {
  const s = shell(); s.api.toggle(); const id = s.api.get().id;
  s.api.nativeEvent({ type: 'capture-result', id, ok: true, target: { token: 'field' } });
  finish(s); s.api.nativeStopped();
  s.api.nativeEvent({ type: 'insert-result', id, ok: false });
  assert.deepEqual(s.copied, ['Final speech']);
});
test('capture timeout becomes copy-only and insertion timeout awaits helper termination', async () => {
  const s = shell(); s.api.toggle(); await s.timers.at(-1)();
  assert.equal(s.api.get().copyOnly, true); finish(s); assert.equal(s.copied.length, 1);
  const t = shell(); t.api.toggle(); const id = t.api.get().id;
  t.api.nativeEvent({ type: 'capture-result', id, ok: true, target: { token: 'field' } });
  finish(t); await t.timers.at(-1)();
  assert.deepEqual(t.copied, ['Final speech']);
});
