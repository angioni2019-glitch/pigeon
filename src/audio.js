'use strict';
// Audio plumbing between Telegram and the watch.
//
//  Telegram -> watch: any voice/audio/video-note file -> Ogg/Opus, mono, 16 kHz,
//  16 kbit/s (Garmin's Audio.Output decodes Ogg/Opus; 16 kHz is in its list of
//  sampling rates and keeps the transfer over Bluetooth small). The file is then
//  split into parts on Ogg page boundaries so each part is a valid chunk of the
//  stream that the watch can append to its StreamingAudioSource.
//
//  watch -> Telegram: Audio.Capture gives Ogg/Opus (or WAV/LPCM as a fallback)
//  in windows. We concatenate them, decode to PCM to get the exact duration and
//  the 5-bit waveform Telegram shows, then encode a clean Ogg/Opus voice note.

const { spawn } = require('child_process');

let FFMPEG = 'ffmpeg';
function setFfmpeg(bin) {
  FFMPEG = bin || 'ffmpeg';
}

function run(args, input, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('ffmpeg timed out'));
    }, timeoutMs);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().trim().slice(0, 400)}`));
    });
    p.stdin.on('error', () => {}); // ffmpeg may close stdin early; errors surface via exit code
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

let encoderCache = null;
async function opusEncoder() {
  if (encoderCache) return encoderCache;
  try {
    const list = (await run(['-encoders'])).toString();
    encoderCache = /\blibopus\b/.test(list) ? ['-c:a', 'libopus'] : ['-c:a', 'opus', '-strict', '-2'];
  } catch {
    encoderCache = ['-c:a', 'libopus'];
  }
  return encoderCache;
}

/** Transcode any audio/video file into watch-friendly Ogg/Opus (16 kHz mono). */
async function toWatchOgg(srcPath, maxSec) {
  const enc = await opusEncoder();
  return run([
    '-i', srcPath,
    '-t', String(maxSec),
    '-vn', '-sn', '-dn',
    '-map_metadata', '-1',
    '-af', 'highpass=f=60,loudnorm=I=-16:TP=-1.5:LRA=11',
    '-ac', '1', '-ar', '16000',
    ...enc,
    '-b:a', '16k', '-application', 'voip', '-frame_duration', '20',
    '-page_duration', '500000',
    '-f', 'ogg', 'pipe:1',
  ]);
}

/** Decode input (buffer) to signed 16-bit mono PCM at `rate`. */
async function decodePcm(inputArgs, input, rate) {
  const buf = await run([...inputArgs, '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'], input);
  const n = Math.floor(buf.length / 2);
  // Copy into a fresh, aligned ArrayBuffer (pooled Buffers may sit at odd offsets).
  return new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 2));
}

/** Encode PCM (s16le mono) into a Telegram voice note (Ogg/Opus 48 kHz mono). */
async function pcmToVoiceNote(pcm, rate) {
  const enc = await opusEncoder();
  const input = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2);
  return run(
    [
      '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0',
      '-af', 'highpass=f=70,loudnorm=I=-18:TP=-2:LRA=11',
      '-ac', '1', '-ar', '48000',
      ...enc, '-b:a', '32k', '-application', 'voip',
      '-map_metadata', '-1',
      '-f', 'ogg', 'pipe:1',
    ],
    input,
  );
}

// ---------------------------------------------------------------------------
// Ogg pages

function oggPages(buf) {
  const pages = [];
  let off = 0;
  while (off + 27 <= buf.length) {
    if (buf.readUInt32BE(off) !== 0x4f676753) {
      // "OggS"
      throw new Error(`Not an Ogg page at offset ${off}`);
    }
    const segs = buf[off + 26];
    if (off + 27 + segs > buf.length) break;
    let len = 27 + segs;
    for (let i = 0; i < segs; i++) len += buf[off + 27 + i];
    if (off + len > buf.length) break;
    pages.push(buf.subarray(off, off + len));
    off += len;
  }
  return pages;
}

/** Group consecutive pages into parts of at most maxBytes (a lone oversized page gets its own part). */
function groupPages(pages, maxBytes) {
  const parts = [];
  let cur = [];
  let size = 0;
  for (const p of pages) {
    if (size > 0 && size + p.length > maxBytes) {
      parts.push(Buffer.concat(cur));
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += p.length;
  }
  if (cur.length) parts.push(Buffer.concat(cur));
  return parts;
}

// ---------------------------------------------------------------------------
// WAV windows from Audio.Capture: every window starts with its own RIFF header.

function stripWavHeader(buf) {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    let off = 12;
    let rate = null;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'fmt ' && off + 16 <= buf.length) rate = buf.readUInt32LE(off + 12);
      if (id === 'data') {
        // Some encoders write 0 / 0xFFFFFFFF as size while streaming: take the rest.
        const start = off + 8;
        const end = size > 0 && size !== 0xffffffff ? Math.min(buf.length, start + size) : buf.length;
        return { pcm: buf.subarray(start, end), rate };
      }
      off += 8 + size + (size & 1);
    }
    return { pcm: Buffer.alloc(0), rate };
  }
  return { pcm: buf, rate: null };
}

// ---------------------------------------------------------------------------
// Telegram waveform: 5-bit values packed little-endian, usually 100 samples.

function packWaveform(values) {
  const out = Buffer.alloc(Math.ceil((values.length * 5) / 8));
  values.forEach((v, i) => {
    const val = Math.max(0, Math.min(31, v | 0));
    const bit = i * 5;
    const byte = bit >> 3;
    const shift = bit & 7;
    const word = val << shift;
    out[byte] |= word & 0xff;
    if (byte + 1 < out.length) out[byte + 1] |= (word >> 8) & 0xff;
  });
  return out;
}

function unpackWaveform(buf) {
  const count = Math.floor((buf.length * 8) / 5);
  const vals = [];
  for (let i = 0; i < count; i++) {
    const bit = i * 5;
    const byte = bit >> 3;
    const shift = bit & 7;
    const word = buf[byte] | ((byte + 1 < buf.length ? buf[byte + 1] : 0) << 8);
    vals.push((word >> shift) & 31);
  }
  return vals;
}

/** Peak-per-bucket waveform from PCM, scaled to 0..31 like Telegram clients do. */
function waveformFromPcm(pcm, samples = 100) {
  const vals = new Array(samples).fill(0);
  if (!pcm.length) return vals;
  const per = pcm.length / samples;
  let max = 1;
  const peaks = vals.map((_, i) => {
    let peak = 0;
    const end = Math.min(pcm.length, Math.floor((i + 1) * per));
    for (let j = Math.floor(i * per); j < end; j++) {
      const a = Math.abs(pcm[j]);
      if (a > peak) peak = a;
    }
    if (peak > max) max = peak;
    return peak;
  });
  return peaks.map((p) => Math.round((p / max) * 31));
}

/** Bars for the watch: n digits 0..9 from a base64 Telegram waveform (or values). */
function waveBars(waveform, n = 24) {
  let vals;
  if (Array.isArray(waveform)) vals = waveform;
  else if (typeof waveform === 'string' && waveform.length) vals = unpackWaveform(Buffer.from(waveform, 'base64'));
  else if (Buffer.isBuffer(waveform)) vals = unpackWaveform(waveform);
  else vals = [];
  if (!vals.length) {
    // Flat placeholder so the bubble still looks like a voice message.
    return '3'.repeat(n);
  }
  let out = '';
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * vals.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * vals.length) / n));
    let m = 0;
    for (let j = a; j < b && j < vals.length; j++) m = Math.max(m, vals[j]);
    out += String(Math.min(9, Math.round((m / 31) * 9)));
  }
  return out;
}

/**
 * Turn the chunks uploaded by the watch into a Telegram voice note.
 * @param {Buffer[]} chunks in order
 * @param {string} fmt 'ogg' or 'wav' (optionally 'wav16000' / 'wav8000')
 */
async function voiceNoteFromWatch(chunks, fmt) {
  let pcm;
  let rate = 16000;
  if (fmt.startsWith('wav')) {
    const hinted = parseInt(fmt.slice(3), 10);
    if (hinted) rate = hinted;
    const parts = [];
    for (const c of chunks) {
      const s = stripWavHeader(c);
      if (s.rate) rate = s.rate;
      parts.push(s.pcm);
    }
    const raw = Buffer.concat(parts);
    const even = raw.subarray(0, raw.length - (raw.length % 2));
    pcm = new Int16Array(even.buffer.slice(even.byteOffset, even.byteOffset + even.length));
  } else {
    pcm = await decodePcm(['-f', 'ogg'], Buffer.concat(chunks), rate);
  }
  const durationSec = Math.max(1, Math.round(pcm.length / rate));
  const waveform = packWaveform(waveformFromPcm(pcm, 100));
  const ogg = await pcmToVoiceNote(pcm, rate);
  return { ogg, durationSec, waveform, samples: pcm.length, rate };
}

module.exports = {
  setFfmpeg,
  run,
  toWatchOgg,
  decodePcm,
  pcmToVoiceNote,
  oggPages,
  groupPages,
  stripWavHeader,
  packWaveform,
  unpackWaveform,
  waveformFromPcm,
  waveBars,
  voiceNoteFromWatch,
};
