'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const audio = require('../src/audio');
const F = require('../src/format');

test('waveform pack/unpack round trip (5-bit, little-endian)', () => {
  const vals = Array.from({ length: 100 }, (_, i) => (i * 7) % 32);
  const packed = audio.packWaveform(vals);
  assert.strictEqual(packed.length, 63);
  assert.deepStrictEqual(audio.unpackWaveform(packed).slice(0, 100), vals);
});

test('waveBars gives n digits', () => {
  const b64 = audio.packWaveform(Array.from({ length: 100 }, (_, i) => (i < 50 ? 31 : 0))).toString('base64');
  const bars = audio.waveBars(b64, 24);
  assert.match(bars, /^[0-9]{24}$/);
  assert.strictEqual(bars[0], '9');
  assert.strictEqual(bars[23], '0');
  assert.strictEqual(audio.waveBars(null, 10), '3333333333');
});

test('groupPages respects the size limit and keeps order', () => {
  const page = (n) => {
    const b = Buffer.alloc(27 + 1 + n);
    b.write('OggS', 0, 'ascii');
    b[26] = 1;
    b[27] = n;
    return b;
  };
  const pages = [page(100), page(200), page(250), page(10)];
  const parts = audio.groupPages(pages, 330);
  assert.deepStrictEqual(parts.map((p) => audio.oggPages(p).length), [1, 1, 2]);
  assert.ok(parts.every((p) => p.length <= 330 || audio.oggPages(p).length === 1));
});

test('stripWavHeader finds the data chunk and sample rate', () => {
  const pcm = Buffer.alloc(320, 1);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcm.length, 40);
  const s = audio.stripWavHeader(Buffer.concat([h, pcm]));
  assert.strictEqual(s.rate, 8000);
  assert.strictEqual(s.pcm.length, 320);
});

test('format helpers', () => {
  assert.strictEqual(F.initials('anna kowalska'), 'AK');
  assert.strictEqual(F.initials('\u{1F3C3} Trail Runners'), 'TR');
  assert.strictEqual(F.initials(''), '?');
  assert.strictEqual(F.emojiIndex('❤️'), 1);
  assert.strictEqual(F.emojiIndex('❤'), 1);
  assert.strictEqual(F.emojiIndex('\u{1F921}'), -1);
  assert.strictEqual(F.truncate('abcdef', 4), 'abc…');
  const rx = F.reactions({ reactions: { reactions: [{ type: { _: 'reactionTypeEmoji', emoji: '\u{1F44D}' }, total_count: 3, is_chosen: true }, { type: { _: 'reactionTypeCustomEmoji' }, total_count: 1 }] } });
  assert.deepStrictEqual(rx, [[0, 3, 1]]);
  const d = F.describeContent({ is_outgoing: false, content: { _: 'messageVoiceNote', is_listened: false, voice_note: { duration: 7, waveform: '' } } });
  assert.strictEqual(d.k, 'voice');
  assert.strictEqual(d.nl, 1);
  assert.strictEqual(F.describeContent({ content: { _: 'messagePoll', poll: { question: { text: 'Pizza?' } } } }).t, 'Poll: Pizza?');
});

test('single watch emoji is flagged for jumbo display', () => {
  assert.strictEqual(F.describeContent({ content: { _: 'messageText', text: { text: '❤️' } } }).e, 1);
  assert.strictEqual(F.describeContent({ content: { _: 'messageAnimatedEmoji', emoji: '\u{1F525}' } }).e, 3);
  assert.strictEqual(F.describeContent({ content: { _: 'messageText', text: { text: 'hi ❤' } } }).e, undefined);
});
