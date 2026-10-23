import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWav } from './wav.mjs';

function chunk(id, data) {
  const header = Buffer.alloc(8); header.write(id); header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length & 1)]);
}
function fixture({ format = 1, channels = 1, bits = 16, extras = [], dataFirst = false } = {}) {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(format); fmt.writeUInt16LE(channels, 2); fmt.writeUInt32LE(16000, 4);
  fmt.writeUInt32LE(32000, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(bits, 14);
  const chunks = [chunk('fmt ', fmt), ...extras, chunk('data', Buffer.from([1, 0, 2, 0]))];
  if (dataFirst) chunks.reverse();
  const body = Buffer.concat([Buffer.from('WAVE'), ...chunks]);
  const header = Buffer.alloc(8); header.write('RIFF'); header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
test('parses PCM16 mono and exact duration', () => {
  const wav = parseWav(fixture());
  assert.equal(wav.sampleRate, 16000);
  assert.equal(wav.durationSeconds, 2 / 16000);
  assert.deepEqual(wav.pcm, Buffer.from([1, 0, 2, 0]));
});
test('skips odd unknown chunks including padding', () => {
  assert.equal(parseWav(fixture({ extras: [chunk('JUNK', Buffer.from([99, 98, 97]))] })).pcm.length, 4);
});
test('accepts data before format', () => { assert.equal(parseWav(fixture({ dataFirst: true })).sampleRate, 16000); });
for (const options of [{ format: 3 }, { channels: 2 }, { bits: 8 }]) {
  test(`rejects unsupported format ${JSON.stringify(options)}`, () => assert.throws(() => parseWav(fixture(options)), /PCM16 mono/));
}
test('rejects truncated RIFF', () => assert.throws(() => parseWav(fixture().subarray(0, 20)), /Truncated/));
test('rejects missing odd chunk padding', () => {
  const b = fixture({ extras: [chunk('JUNK', Buffer.from([1]))] });
  const damaged = Buffer.concat([b.subarray(0, 45), b.subarray(46)]);
  damaged.writeUInt32LE(damaged.length - 8, 4);
  assert.throws(() => parseWav(damaged), /Truncated/);
});
test('rejects non-WAVE input', () => assert.throws(() => parseWav(Buffer.alloc(16)), /RIFF/));
