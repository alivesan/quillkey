import { readFile } from 'node:fs/promises';

export function parseWav(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected RIFF/WAVE file');
  const end = b.readUInt32LE(4) + 8;
  if (end > b.length || end < 12) throw new Error('Truncated or invalid RIFF length');
  let fmt;
  const data = [];
  for (let p = 12; p < end;) {
    if (p + 8 > end) throw new Error('Truncated chunk header');
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    const start = p + 8;
    if (start + size + (size & 1) > end) throw new Error('Truncated chunk or missing padding');
    if (id === 'fmt ') {
      if (size < 16) throw new Error('Invalid fmt chunk');
      if (fmt) throw new Error('Duplicate fmt chunk');
      fmt = { format: b.readUInt16LE(start), channels: b.readUInt16LE(start + 2), sampleRate: b.readUInt32LE(start + 4), byteRate: b.readUInt32LE(start + 8), blockAlign: b.readUInt16LE(start + 12), bits: b.readUInt16LE(start + 14) };
    }
    if (id === 'data') data.push(b.subarray(start, start + size));
    p = start + size + (size & 1);
  }
  if (!fmt || !data.length) throw new Error('Missing fmt or data chunk');
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16) throw new Error('Requires PCM16 mono WAV');
  if (!fmt.sampleRate || fmt.blockAlign !== 2 || fmt.byteRate !== fmt.sampleRate * 2) throw new Error('Invalid PCM format rates');
  const pcm = Buffer.concat(data);
  if (!pcm.length || pcm.length % 2) throw new Error('Empty or unaligned PCM data');
  return { sampleRate: fmt.sampleRate, pcm, durationSeconds: pcm.length / fmt.byteRate };
}

export async function readWav(path) { return parseWav(await readFile(path)); }
