const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, session, screen, dialog, clipboard, nativeTheme } = require('electron');
const { spawn } = require('node:child_process');
const { mkdirSync, appendFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');
// Keep the transparent Windows widget stable across desktop/remote-session changes.
// ASR uses its separate native CUDA process and is unaffected by UI rendering.
app.disableHardwareAcceleration();
if (nativeTheme) nativeTheme.themeSource = 'dark';
const root = path.resolve(__dirname, '..');
const origin = 'http://127.0.0.1:18765';
let dashboard, overlay, tray, server, helper, current, nativeReady = false, rendererReady = false, quitting = false;
let hideTimer, sessionTimer, smokeTimer, anchor;
let overlayPhase = 'idle', expanded = false, hovered = false;
const overlayURL = pathToFileURL(path.join(__dirname, 'overlay.html')).href;
const smokeTest = process.argv.includes('--smoke-test');
const syntheticMic = process.argv.includes('--synthetic-mic');
const quitRequested = process.argv.includes('--quit');
if (smokeTest || syntheticMic) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', path.join(app.isPackaged ? process.resourcesPath : root, 'tests/fixtures/synthetic-english.wav'));
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (!app.requestSingleInstanceLock()) { app.quit(); } else if (quitRequested) { app.quit(); } else {
  app.on('second-instance', (_event, argv) => { if (argv.includes('--quit')) app.quit(); else showDashboard(); });
  app.whenReady().then(start).catch(e => { log('startup-error', { message: e.message }); dialog.showErrorBox('QuillKey could not start', e.message); app.quit(); });
}
function log(event, data = {}) {
  try { const dir = path.join(app.getPath('userData'), 'logs'); mkdirSync(dir, { recursive: true }); appendFileSync(path.join(dir, 'desktop.log'), JSON.stringify({ time: new Date().toISOString(), event, ...data }) + '\n'); } catch {}
}
function sendNative(value) { if (helper?.stdin.writable) helper.stdin.write(JSON.stringify(value) + '\n'); }
function alive(win) { return Boolean(win && !win.isDestroyed?.() && !win.webContents.isDestroyed?.()); }
function command(type, id) { if (alive(dashboard)) dashboard.webContents.send('quillkey:command', { type, sessionId: id }); }
function status(value) { if (!quitting && alive(dashboard)) dashboard.webContents.send('quillkey:status', { nativeReady, ...value }); }
function resizeOverlay(open) {
  expanded = open;
  if (quitting || !alive(overlay)) return;
  if (!anchor) {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    anchor = { x: Math.round(area.x + area.width / 2), bottom: area.y + area.height - 24 };
  }
  const width = open ? 320 : 64, height = open ? 96 : 48;
  overlay.setBounds({ x: anchor.x - width / 2, y: anchor.bottom - height, width, height });
}
function bubble(title, message, timeout = 0, phase) {
  clearTimeout(hideTimer);
  overlayPhase = phase || (current ? current.phase || 'connecting' : 'idle');
  if (quitting || !alive(overlay)) return;
  resizeOverlay(overlayPhase !== 'idle' || hovered);
  overlay.webContents.send('quillkey:status', { phase: overlayPhase, title, message, expanded });
  overlay.showInactive();
  if (timeout) hideTimer = setTimeout(idle, timeout);
}
function idle() { bubble('QuillKey', 'Click to dictate into your focused chat', 0, 'idle'); }
function overlayTrusted(event) {
  try { return !quitting && alive(overlay) && event.sender === overlay.webContents && event.senderFrame === overlay.webContents.mainFrame && event.senderFrame?.url === overlayURL; }
  catch { return false; } // A frame can be destroyed while its last IPC event is queued.
}
function toggle() {
  if (current) {
    if (current.phase === 'connecting') { cancel(); return; }
    if (current.phase === 'recording' && !current.released) {
      current.released = true; current.phase = 'processing'; command('stop', current.id);
      deadline(35000); bubble('Finishing', 'Transcribing locally…');
    }
    return;
  }
  if (alive(dashboard) && dashboard.isFocused()) { bubble('Focus your chat', 'Select the chat input, then click the microphone.', 5000, 'error'); return; }
  if (!rendererReady) { bubble('Not ready', 'Open QuillKey and check the speech connection.', 5000, 'error'); return; }
  current = { id: randomUUID(), phase: 'connecting', capturePending: true, released: false, inserting: false, toggle: true };
  deadline(5000); bubble('Connecting', 'Preparing your microphone…');
  if (nativeReady) sendNative({ type: 'capture', id: current.id });
  else startCaptured(false);
}
function startCaptured(target) {
  if (!current) return;
  current.capturePending = false; current.target = target || undefined; current.copyOnly = !target;
  deadline(32 * 60 * 1000); sendNative({ type: 'active', value: true }); command('start', current.id);
  if (!target) bubble('Connecting', 'Your transcript will copy — press Ctrl+V to paste.');
}
function finishInsertion(ok) {
  if (!current) return;
  clearTimeout(sessionTimer);
  let copied = false;
  if (!ok && current.text) {
    try { clipboard.writeText(current.text); copied = clipboard.readText() === current.text; } catch { log('clipboard-failed'); }
  }
  const message = ok ? 'Inserted' : copied ? 'Copied — press Ctrl+V' : 'Could not copy. Your transcript is available in QuillKey.';
  status({ type: 'insertion-result', sessionId: current.id, ok: ok || copied, message });
  bubble(ok ? 'Inserted' : copied ? 'Copied — press Ctrl+V' : 'Transcript ready', ok ? 'Ready for your next thought' : copied ? 'Paste into your chat when ready.' : 'Open QuillKey to copy your transcript.', 5000, ok || copied ? 'success' : 'error');
  current = null; sendNative({ type: 'active', value: false });
}
function nativeStopped() {
  nativeReady = false;
  if (current?.inserting && current.text) finishInsertion(false);
  else if (current?.capturePending) startCaptured(false);
  else if (current) { current.target = undefined; current.copyOnly = true; }
}
ipcMain.on('quillkey:overlay-action', (event, action) => {
  if (!overlayTrusted(event) || !['toggle', 'cancel', 'hover-enter', 'hover-leave'].includes(action)) return;
  if (action === 'toggle') toggle();
  if (action === 'cancel') cancel();
  if (action === 'hover-enter') { hovered = true; if (overlayPhase === 'idle') idle(); }
  if (action === 'hover-leave') {
    hovered = false;
    if (overlayPhase === 'idle') { clearTimeout(hideTimer); hideTimer = setTimeout(idle, 200); }
  }
});
function showDashboard() { if (!quitting && alive(dashboard)) { dashboard.show(); dashboard.focus(); } }
function trusted(event) {
  try { return !quitting && alive(dashboard) && event.sender === dashboard.webContents && event.senderFrame === dashboard.webContents.mainFrame && event.senderFrame?.url === origin + '/'; }
  catch { return false; }
}
function protect(win, allowed) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url !== allowed) event.preventDefault(); });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
}
async function start() {
  const resources = app.isPackaged ? process.resourcesPath : root;
  const runtime = app.isPackaged ? path.join(resources, 'runtime') : path.join(root, 'vendor/runtime');
  const logDir = path.join(app.getPath('userData'), 'logs'); mkdirSync(logDir, { recursive: true });
  log('launch', { version: app.getVersion(), packaged: app.isPackaged, electron: process.versions.electron });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === dashboard?.webContents && permission === 'media' && details.requestingUrl === origin + '/'));
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => contents === dashboard?.webContents && permission === 'media' && requestingOrigin === origin);
  const prefs = { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false };
  dashboard = new BrowserWindow({ width: 1120, height: 790, minWidth: 850, minHeight: 640, title: 'QuillKey', backgroundColor: '#171719', autoHideMenuBar: true, show: false, webPreferences: prefs });
  dashboard.on('closed', () => { dashboard = null; rendererReady = false; });
  protect(dashboard, origin + '/');
  dashboard.on('close', e => { if (!quitting) { e.preventDefault(); dashboard.hide(); } });
  dashboard.webContents.on('render-process-gone', () => { rendererReady = false; cancel(); log('renderer-gone'); });
  dashboard.webContents.on('did-start-loading', () => { rendererReady = false; cancel(); });
  dashboard.webContents.on('did-finish-load', () => { rendererReady = true; status({}); showDashboard(); if (smokeTest) runSmoke().catch(e => smokeFinish(false, e.message)); });
  overlay = new BrowserWindow({ width: 64, height: 48, show: false, frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, webPreferences: prefs });
  overlay.on('closed', () => { overlay = null; });
  protect(overlay, overlayURL);
  await overlay.loadFile(path.join(__dirname, 'overlay.html'));
  idle();
  const icon = nativeImage.createFromPath(path.join(root, 'assets/icon.png')).resize({ width: 32, height: 32 });
  tray = new Tray(icon); tray.setToolTip('QuillKey — Ctrl + Alt + Space'); tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Show QuillKey', click: showDashboard }, { type: 'separator' }, { label: 'Quit', click: () => app.quit() }])); tray.on('double-click', showDashboard);
  server = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: app.getPath('userData'), windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', QUILLKEY_DESKTOP: '1', QUILLKEY_PORT: '18765', QUILLKEY_ENGINE_PORT: '18766', QUILLKEY_RUNTIME_ROOT: runtime, QUILLKEY_MODEL_PATH: path.join(resources, 'models/nemotron-en-q8.gguf'), QUILLKEY_LOG_DIR: logDir } });
  server.stdin.on('error', () => log('server-input-closed'));
  server.on('error', e => { log('server-error', { code: e.code }); bubble('Startup failed', 'Could not start the speech service.', 8000); });
  server.on('exit', code => { log('server-exit', { code }); if (!quitting) { cancel(); bubble('Speech service stopped', 'Restart QuillKey to reconnect.', 8000); } });
  const helperPath = app.isPackaged ? path.join(resources, 'native/QuillKey.Native.exe') : path.join(root, 'native/QuillKey.Native.exe');
  helper = spawn(helperPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  helper.stdin.on('error', () => log('native-input-closed'));
  helper.on('error', e => { log('native-error', { code: e.code }); status({ message: 'Global shortcut unavailable. Use the dashboard.' }); });
  helper.on('exit', code => { nativeStopped(); status({ message: 'Global shortcut unavailable. Click the microphone to copy dictation.' }); log('native-exit', { code }); });
  createInterface({ input: helper.stdout }).on('line', line => { try { if (line.length < 8192) nativeEvent(JSON.parse(line)); } catch { log('native-invalid-message'); } });
  for (let attempt = 0; attempt < 100 && !quitting; attempt++) {
    try { const response = await fetch(origin + '/api/status', { signal: AbortSignal.timeout(500) }); if (response.ok) { await dashboard.loadURL(origin + '/'); return; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('The local speech service did not start. See the QuillKey logs.');
}
function cancel() { clearTimeout(sessionTimer); if (current) command('cancel', current.id); current = null; sendNative({ type: 'active', value: false }); idle(); }
function deadline(ms) { clearTimeout(sessionTimer); sessionTimer = setTimeout(async () => {
  if (current?.capturePending) { startCaptured(false); return; }
  if (current?.inserting && current.text) {
    const pending = current;
    // Await termination before copying: an in-flight native paste restores its clipboard.
    nativeReady = false;
    await killTree(helper);
    if (current === pending) finishInsertion(false);
    return;
  }
  cancel(); bubble('Dictation stopped', 'The operation timed out. Open QuillKey to try again.', 4000, 'error'); if (smokeTest) smokeFinish(false, 'session-timeout');
}, ms); }
async function runSmoke() {
  smokeTimer = setTimeout(() => smokeFinish(false, 'smoke-timeout'), 180000);
  for (let i = 0; i < 140; i++) {
    const state = await fetch(origin + '/api/status').then(r => r.json());
    if (state.ready) {
      // The UI polls engine readiness every ten seconds.
      await new Promise(r => setTimeout(r, 11000));
      current = { id: randomUUID(), released: false, inserting: false, smoke: true };
      command('start', current.id); deadline(45000); log('smoke-start'); return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  smokeFinish(false, 'engine-not-ready');
}
function smokeFinish(ok, reason) { clearTimeout(smokeTimer); log('smoke-result', { ok, reason }); process.stdout.write(JSON.stringify({ event: 'smoke-result', ok, reason }) + '\n'); process.exitCode = ok ? 0 : 1; app.quit(); }
function nativeEvent(value) {
  if (quitting) return;
  if (value.type === 'diagnostic') log('native-diagnostic', { code: value.code, reason: value.reason, stage: value.stage, processId: value.processId, windowClass: value.windowClass, focusClass: value.focusClass, automationControlType: value.automationControlType });
  if (value.type === 'ready') {
    nativeReady = value.ok === true;
    const handle = win => win.getNativeWindowHandle().readBigUInt64LE().toString();
    if (alive(overlay) && alive(dashboard)) sendNative({ type: 'own-windows', widget: handle(overlay), dashboard: handle(dashboard) });
    status({ message: nativeReady ? undefined : 'Global shortcut is already in use.' });
  }
  if (value.type === 'capture-result' && current?.capturePending && value.id === current.id) {
    log('capture-result', { ok: value.ok === true, reason: value.reason });
    startCaptured(value.ok && value.target && typeof value.target.token === 'string' && alive(dashboard) && !dashboard.isFocused() ? value.target : false);
  }
  if (value.type === 'press') {
    if (current || !rendererReady || !alive(dashboard) || dashboard.isFocused() || !value.target || typeof value.target.token !== 'string') { if (!current) sendNative({ type: 'active', value: false }); return; }
    current = { id: randomUUID(), target: value.target, phase: 'connecting', released: false, inserting: false };
    deadline(32 * 60 * 1000);
    sendNative({ type: 'active', value: true }); command('start', current.id); bubble('Listening', 'Release Ctrl + Alt + Space to insert');
  }
  if (value.type === 'release' && current && !current.toggle && !current.released) { current.released = true; current.phase = 'processing'; command('stop', current.id); bubble('Finishing', 'Transcribing locally…'); }
  if (value.type === 'cancel') cancel();
  if (value.type === 'insert-result' && current?.id === value.id && current.inserting) {
    log('insertion-result', { ok: value.ok === true, reason: value.reason });
    finishInsertion(value.ok === true);
  }
}
ipcMain.on('quillkey:state', (event, value) => {
  if (!trusted(event) || !value || value.sessionId !== current?.id || !['connecting','recording','processing','finishing','ready','error','cancelled'].includes(value.status)) return;
  if (['connecting', 'recording', 'processing', 'finishing'].includes(value.status)) {
    current.phase = ['processing', 'finishing'].includes(value.status) ? 'processing' : value.status;
    bubble(current.phase === 'recording' ? 'Listening' : current.phase === 'processing' ? 'Finishing' : 'Connecting', current.phase === 'recording' ? (typeof value.text === 'string' && value.text ? value.text.slice(-140) : current.copyOnly ? 'Click again to copy — then press Ctrl+V' : current.toggle ? 'Click again to paste into your chat' : 'Release Ctrl + Alt + Space to insert') : current.phase === 'processing' ? 'Transcribing locally…' : current.copyOnly ? 'Your transcript will copy — press Ctrl+V to paste.' : 'Preparing your microphone…');
  }
  if (value.status === 'recording' && current.smoke && !current.smokeRecording) { current.smokeRecording = true; setTimeout(() => { if (current?.smoke) { current.released = true; command('stop', current.id); } }, 8500); }
  if (value.status === 'processing') { current.released = true; deadline(35000); }
  if (smokeTest && ['error','cancelled'].includes(value.status)) { smokeFinish(false, value.status); return; }
  if (value.status === 'error' || value.status === 'cancelled') { cancel(); bubble('Dictation stopped', value.status === 'error' ? 'Open QuillKey to check the speech connection.' : 'Nothing inserted', 4000, value.status === 'error' ? 'error' : 'idle'); }
});
ipcMain.on('quillkey:final', (event, value) => {
  if (!trusted(event) || !value || value.sessionId !== current?.id || !current?.released || current.inserting || typeof value.text !== 'string' || value.text.length > 100000) return;
  if (!value.text.trim()) { cancel(); return; }
  if (current.smoke) { require('node:fs').writeFileSync(path.join(app.getPath('userData'), 'logs/desktop-smoke-result.json'), JSON.stringify({syntheticFixture:true,text:value.text}, null, 2)); const ok = /please send (?:a|the) draft tomorrow morning/i.test(value.text) && /keep the blue version/i.test(value.text); cancel(); smokeFinish(ok, ok ? 'expected-phrase-recognized' : 'phrase-mismatch'); return; }
  current.text = value.text;
  current.inserting = true;
  if (current.copyOnly || !nativeReady || !current.target) { finishInsertion(false); return; }
  deadline(10000);
  try { sendNative({ type: 'insert', id: current.id, target: current.target, text: current.text }); }
  catch { finishInsertion(false); }
});
function killTree(child) { return new Promise(resolve => {
  if (!child?.pid || child.exitCode !== null) return resolve();
  if (process.platform === 'win32') { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', resolve); killer.on('exit', resolve); }
  else { child.kill('SIGTERM'); resolve(); }
}); }
app.on('before-quit', event => {
  if (quitting) return; event.preventDefault(); quitting = true; clearTimeout(hideTimer); clearTimeout(smokeTimer); cancel(); sendNative({ type: 'quit' });
  server?.stdin.end('quit\n');
  setTimeout(() => Promise.all([killTree(server), killTree(helper)]).finally(() => { tray?.destroy(); app.exit(process.exitCode || 0); }), 1200);
});
app.on('window-all-closed', () => {});







