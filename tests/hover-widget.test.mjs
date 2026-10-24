import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../desktop/overlay.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../desktop/overlay.html', import.meta.url), 'utf8');

// A minimal DOM event model keeps these renderer tests independent of Electron.
function widget() {
  const actions = [], nodes = new Map();
  let status;
  for (const id of ['widget', 'toggle', 'cancel', 'title', 'detail']) {
    const classes = new Set(), listeners = new Map(), attributes = new Map();
    nodes.set(id, {
      dataset: {}, disabled: id === 'cancel', textContent: '',
      classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }, contains: name => classes.has(name) },
      addEventListener(name, callback) { listeners.set(name, callback); },
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute: name => attributes.get(name),
      emit(name) { let stopped = false; listeners.get(name)?.({ stopPropagation() { stopped = true; } }); return stopped; }
    });
  }
  vm.runInNewContext(source, {
    document: { getElementById: id => nodes.get(id) },
    window: { quillkey: { overlayAction: value => actions.push(value), onStatus: callback => status = callback } }
  });
  return { actions, status: value => status(value), node: id => nodes.get(id) };
}

test('hover uses the bridge and host status controls expansion', () => {
  const h = widget(), root = h.node('widget');
  root.emit('mouseenter');
  assert.deepEqual(h.actions, ['hover-enter']);
  h.status({ phase: 'idle', expanded: true });
  assert.equal(root.classList.contains('expanded'), true);
  root.emit('mouseleave');
  assert.deepEqual(h.actions, ['hover-enter', 'hover-leave']);
  h.status({ phase: 'idle', expanded: false });
  assert.equal(root.classList.contains('expanded'), false);
});

test('connecting and processing cannot toggle, but expose a working Cancel', () => {
  for (const phase of ['connecting', 'processing']) {
    const h = widget();
    h.status({ phase, expanded: false });
    assert.equal(h.node('widget').classList.contains('expanded'), true);
    assert.equal(h.node('toggle').disabled, true);
    assert.equal(h.node('toggle').getAttribute('aria-busy'), 'true');
    h.node('toggle').emit('click');
    assert.deepEqual(h.actions, []);
    assert.equal(h.node('cancel').classList.contains('available'), true);
    assert.equal(h.node('cancel').emit('click'), true);
    assert.deepEqual(h.actions, ['cancel']);
  }
});

test('recording click finishes; idle and terminal states can start again', () => {
  const h = widget();
  h.status({ phase: 'recording' });
  assert.equal(h.node('toggle').getAttribute('aria-label'), 'Finish dictation and paste');
  h.node('toggle').emit('click');
  for (const phase of ['idle', 'success', 'error']) {
    h.status({ phase });
    assert.equal(h.node('toggle').disabled, false);
    assert.equal(h.node('cancel').disabled, true);
    h.node('cancel').emit('click');
    h.node('toggle').emit('click');
  }
  assert.deepEqual(h.actions, ['toggle', 'toggle', 'toggle', 'toggle']);
});

test('status uses safe text, supplies defaults, and tolerates invalid payloads', () => {
  const h = widget();
  h.status({ phase: 'error', title: '<img onerror=alert(1)>', message: 'Microphone unavailable', expanded: true });
  assert.equal(h.node('title').textContent, '<img onerror=alert(1)>');
  assert.equal(h.node('detail').textContent, 'Microphone unavailable');
  for (const value of [null, undefined, 'bad']) h.status(value);
  assert.equal(h.node('widget').dataset.phase, 'error');
  h.status({ phase: 'unknown', title: 12, message: '' });
  assert.equal(h.node('widget').dataset.phase, 'idle');
  assert.equal(h.node('title').textContent, 'QuillKey');
  assert.equal(h.node('detail').textContent, 'Click to dictate');
});

test('expanded surface contains the compact hover surface at a shared bottom center', () => {
  // Match the CSS dimensions; the host windows add four pixels on every edge.
  const compact = html.match(/\.widget\{[^}]*width:(\d+)px;height:(\d+)px/);
  const expanded = html.match(/\.widget\.expanded\{width:(\d+)px;height:(\d+)px/);
  assert.deepEqual(compact.slice(1).map(Number), [56, 40]);
  assert.deepEqual(expanded.slice(1).map(Number), [312, 88]);
  assert.match(html, /align-items:flex-end;justify-content:center;padding:4px/);
  const [cw, ch] = compact.slice(1).map(Number), [ew, eh] = expanded.slice(1).map(Number);
  assert.ok(-ew / 2 <= -cw / 2 && ew / 2 >= cw / 2 && -eh <= -ch);
  assert.match(html, /id="cancel"[^>]* disabled/);
  assert.doesNotMatch(source, /\.focus\(/);
});
