const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, session, screen, dialog } = require('electron');
const { spawn } = require('node:child_process');
const { mkdirSync, appendFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const origin = 'http://127.0.0.1:18765';
let dashboard, overlay, tray, server, helper, current, nativeReady = false, rendererReady = false, quitting = false;
let hideTimer, sessionTimer, smokeTimer;
const smokeTest = process.argv.includes('--smoke-test');
if (smokeTest) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', path.join(app.isPackaged ? process.resourcesPath : root, 'tests/fixtures/synthetic-english.wav'));
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  app.on('second-instance', () => showDashboard());
  app.whenReady().then(start).catch(e => { log('startup-error', { message: e.message }); dialog.showErrorBox('QuillKey could not start', e.message); app.quit(); });
}
function log(event, data = {}) {
  try { const dir = path.join(app.getPath('userData'), 'logs'); mkdirSync(dir, { recursive: true }); appendFileSync(path.join(dir, 'desktop.log'), JSON.stringify({ time: new Date().toISOString(), event, ...data }) + '\n'); } catch {}
}
function sendNative(value) { if (helper?.stdin.writable) helper.stdin.write(JSON.stringify(value) + '\n'); }
function command(type, id) { dashboard?.webContents.send('quillkey:command', { type, sessionId: id }); }
function status(value) { dashboard?.webContents.send('quillkey:status', { nativeReady, ...value }); }
function bubble(title, message, timeout = 0) {
  clearTimeout(hideTimer);
  if (!overlay || overlay.isDestroyed()) return;
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  overlay.setPosition(Math.round(area.x + (area.width - 390) / 2), area.y + area.height - 130);
  overlay.webContents.send('quillkey:status', { title, message }); overlay.showInactive();
  if (timeout) hideTimer = setTimeout(() => overlay?.hide(), timeout);
}
function showDashboard() { if (dashboard) { dashboard.show(); dashboard.focus(); } }
function trusted(event) {
  return dashboard && event.sender === dashboard.webContents && event.senderFrame === dashboard.webContents.mainFrame && event.senderFrame.url === origin + '/';
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
  dashboard = new BrowserWindow({ width: 1120, height: 790, minWidth: 850, minHeight: 640, title: 'QuillKey', show: false, webPreferences: prefs });
  protect(dashboard, origin + '/');
  dashboard.on('close', e => { if (!quitting) { e.preventDefault(); dashboard.hide(); } });
  dashboard.webContents.on('render-process-gone', () => { rendererReady = false; cancel(); log('renderer-gone'); });
  dashboard.webContents.on('did-start-loading', () => { rendererReady = false; cancel(); });
  dashboard.webContents.on('did-finish-load', () => { rendererReady = true; status({}); showDashboard(); if (smokeTest) runSmoke().catch(e => smokeFinish(false, e.message)); });
  overlay = new BrowserWindow({ width: 390, height: 108, show: false, frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, webPreferences: prefs });
  overlay.setIgnoreMouseEvents(true); protect(overlay, pathToFileURL(path.join(__dirname, 'overlay.html')).href);
  await overlay.loadFile(path.join(__dirname, 'overlay.html'));
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
  helper.on('exit', code => { nativeReady = false; cancel(); status({ message: 'Global shortcut unavailable. Restart QuillKey.' }); log('native-exit', { code }); });
  createInterface({ input: helper.stdout }).on('line', line => { try { if (line.length < 8192) nativeEvent(JSON.parse(line)); } catch { log('native-invalid-message'); } });
  for (let attempt = 0; attempt < 100 && !quitting; attempt++) {
    try { const response = await fetch(origin + '/api/status', { signal: AbortSignal.timeout(500) }); if (response.ok) { await dashboard.loadURL(origin + '/'); return; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('The local speech service did not start. See the QuillKey logs.');
}
function cancel() { clearTimeout(sessionTimer); if (current) command('cancel', current.id); current = null; sendNative({ type: 'active', value: false }); overlay?.hide(); }
function deadline(ms) { clearTimeout(sessionTimer); sessionTimer = setTimeout(() => { cancel(); bubble('Dictation stopped', 'The operation timed out. Open QuillKey to try again.', 4000); if (smokeTest) smokeFinish(false, 'session-timeout'); }, ms); }
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
  if (value.type === 'ready') { nativeReady = value.ok === true; status({ message: nativeReady ? undefined : 'Global shortcut is already in use.' }); }
  if (value.type === 'press') {
    if (current || !rendererReady || dashboard.isFocused() || !value.target || typeof value.target.token !== 'string') { if (!current) sendNative({ type: 'active', value: false }); return; }
    current = { id: randomUUID(), target: value.target, released: false, inserting: false };
    deadline(140000);
    sendNative({ type: 'active', value: true }); command('start', current.id); bubble('Listening', 'Release Ctrl + Alt + Space to insert');
  }
  if (value.type === 'release' && current && !current.released) { current.released = true; command('stop', current.id); bubble('Finishing', 'Transcribing locally…'); }
  if (value.type === 'cancel') cancel();
  if (value.type === 'insert-result' && current?.id === value.id && current.inserting) {
    clearTimeout(sessionTimer);
    status({ type: 'insertion-result', sessionId: current.id, ok: value.ok === true, message: value.ok ? 'Inserted' : 'Could not insert. Your transcript is available in QuillKey.' });
    bubble(value.ok ? 'Inserted' : 'Transcript ready', value.ok ? 'Ready for your next thought' : 'Open QuillKey to copy your transcript.', 3500); current = null; sendNative({ type: 'active', value: false });
  }
}
ipcMain.on('quillkey:state', (event, value) => {
  if (!trusted(event) || !value || value.sessionId !== current?.id || !['connecting','recording','processing','finishing','ready','error','cancelled'].includes(value.status)) return;
  if (value.status === 'recording' && typeof value.text === 'string') bubble('Listening', value.text.slice(-140));
  if (value.status === 'recording' && current.smoke && !current.smokeRecording) { current.smokeRecording = true; setTimeout(() => { if (current?.smoke) { current.released = true; command('stop', current.id); } }, 8500); }
  if (value.status === 'processing') deadline(35000);
  if (smokeTest && ['error','cancelled'].includes(value.status)) { smokeFinish(false, value.status); return; }
  if (value.status === 'error' || value.status === 'cancelled') { cancel(); bubble('Dictation stopped', value.status === 'error' ? 'Open QuillKey to check the speech connection.' : 'Nothing inserted', 4000); }
});
ipcMain.on('quillkey:final', (event, value) => {
  if (!trusted(event) || !value || value.sessionId !== current?.id || !current?.released || current.inserting || typeof value.text !== 'string' || value.text.length > 100000) return;
  if (!value.text.trim()) { cancel(); return; }
  if (current.smoke) { require('node:fs').writeFileSync(path.join(app.getPath('userData'), 'logs/desktop-smoke-result.json'), JSON.stringify({syntheticFixture:true,text:value.text}, null, 2)); const ok = /please send (?:a|the) draft tomorrow morning/i.test(value.text) && /keep the blue version/i.test(value.text); cancel(); smokeFinish(ok, ok ? 'expected-phrase-recognized' : 'phrase-mismatch'); return; }
  deadline(10000);
  current.inserting = true; sendNative({ type: 'insert', id: current.id, target: current.target, text: value.text });
});
function killTree(child) { return new Promise(resolve => {
  if (!child?.pid || child.exitCode !== null) return resolve();
  if (process.platform === 'win32') { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', resolve); killer.on('exit', resolve); }
  else { child.kill('SIGTERM'); resolve(); }
}); }
app.on('before-quit', event => {
  if (quitting) return; event.preventDefault(); quitting = true; cancel(); sendNative({ type: 'quit' });
  server?.stdin.end('quit\n');
  setTimeout(() => Promise.all([killTree(server), killTree(helper)]).finally(() => { tray?.destroy(); app.exit(process.exitCode || 0); }), 1200);
});
app.on('window-all-closed', () => {});







