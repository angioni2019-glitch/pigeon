'use strict';
// End-to-end test of every endpoint the watch uses, against the demo backend,
// with real ffmpeg transcoding. Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const audio = require('../src/audio');
const { oggDurationMs } = require('../src/media');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigeon-test-'));
const cfg = {
  ...require('../src/config').load({ DEMO: '1', DATA_DIR: dataDir, DEMO_AUTO_LOGIN_SEC: '60', LOG_LEVEL: 'silent' }),
};
const log = require('../src/log').create('silent');
let srv;
let base;
let token;

async function call(method, p, { body, raw, bin, tk = token } = {}) {
  const headers = {};
  if (tk) headers.Authorization = `Bearer ${tk}`;
  let payload;
  if (raw) {
    headers['Content-Type'] = 'application/octet-stream';
    payload = raw;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + p, { method, headers, body: payload });
  const ct = res.headers.get('content-type');
  if (bin) return { status: res.status, ct, buf: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, ct, data };
}

before(async () => {
  srv = createServer(cfg, log);
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});

after(async () => {
  await srv.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('unauthenticated requests get 401', async () => {
  const r = await call('GET', '/v1/chats', { tk: 'nope-nope-nope-nope-nope-nope' });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.ct, 'application/json');
});

test('link flow: QR, then 2FA-less ready', async () => {
  const r = await call('POST', '/v1/link', { body: {}, tk: null });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.tk && r.data.tk.length >= 40);
  token = r.data.tk;

  const a = await call('GET', '/v1/auth');
  assert.strictEqual(a.data.st, 'qr');
  assert.ok(a.data.qr.n >= 21 && a.data.qr.r.length === a.data.qr.n);
  assert.ok(a.data.qr.r.every((row) => row.length === Math.ceil(a.data.qr.n / 4) && /^[0-9a-f]+$/.test(row)));

  // Data endpoints refuse until linked.
  const early = await call('GET', '/v1/chats');
  assert.strictEqual(early.status, 409);

  await call('POST', '/demo/advance', { body: {} });
  const b = await call('GET', '/v1/auth');
  assert.deepStrictEqual(b.data, { st: 'ready', me: 'Demo User' });
});

test('chat list is compact and sorted, channels excluded', async () => {
  const r = await call('GET', '/v1/chats?n=20');
  assert.strictEqual(r.status, 200);
  const { chats } = r.data;
  assert.ok(chats.length >= 5);
  for (const c of chats) {
    assert.strictEqual(typeof c.id, 'string', 'ids are strings (64-bit safe on the watch)');
    assert.ok(c.t && c.i && typeof c.c === 'number');
    assert.ok(c.m && typeof c.m.ts === 'number');
  }
  const ts = chats.map((c) => c.m.ts);
  assert.deepStrictEqual(ts, [...ts].sort((x, y) => y - x));
  assert.ok(typeof r.data.v === 'number');
});

test('history: oldest first, read marks chat read, paging', async () => {
  const r = await call('GET', '/v1/chats/1001/msgs?n=3&read=1');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.t, 'Anna Kowalska');
  assert.strictEqual(r.data.msgs.length, 3);
  const ids = r.data.msgs.map((m) => Number(m.id));
  assert.deepStrictEqual(ids, [...ids].sort((a, b) => a - b));
  assert.strictEqual(r.data.more, 1);
  const older = await call('GET', `/v1/chats/1001/msgs?n=10&before=${r.data.msgs[0].id}`);
  assert.ok(older.data.msgs.every((m) => Number(m.id) < ids[0]));
  const chats = await call('GET', '/v1/chats');
  assert.strictEqual(chats.data.chats.find((c) => c.id === '1001').u, 0);
  const voice = r.data.msgs.find((m) => m.k === 'voice');
  assert.ok(voice && /^[0-9]{24}$/.test(voice.w) && voice.d > 0);
});

test('group messages carry sender names and colors', async () => {
  const r = await call('GET', '/v1/chats/-2001/msgs?n=10');
  const incoming = r.data.msgs.filter((m) => !m.o);
  assert.ok(incoming.length && incoming.every((m) => m.s && typeof m.sc === 'number'));
  assert.strictEqual(r.data.g, 1);
});

test('send text, emoji, reactions; sync versions move', async () => {
  const s0 = (await call('GET', '/v1/sync?c=1002')).data;
  const sent = await call('POST', '/v1/chats/1002/text', { body: { t: 'Hello from the watch' } });
  assert.strictEqual(sent.status, 200);
  assert.ok(sent.data.id);
  const s1 = (await call('GET', '/v1/sync?c=1002')).data;
  assert.ok(s1.v > s0.v && s1.cv > s0.cv);

  const emoji = await call('POST', '/v1/chats/1002/emoji', { body: { e: 1 } });
  assert.strictEqual(emoji.status, 200);
  const bad = await call('POST', '/v1/chats/1002/emoji', { body: { e: 9 } });
  assert.strictEqual(bad.status, 400);

  const msgs = (await call('GET', '/v1/chats/1002/msgs?n=5')).data.msgs;
  const mine = msgs.find((m) => m.t === 'Hello from the watch');
  assert.ok(mine && mine.o === 1 && [0, 1, 2].includes(mine.st));
  assert.strictEqual(msgs[msgs.length - 1].t, '❤️');

  const on = await call('POST', '/v1/chats/1002/react', { body: { m: mine.id, e: 0 } });
  assert.strictEqual(on.data.on, 1);
  let m = (await call('GET', `/v1/chats/1002/m/${mine.id}`)).data;
  assert.deepStrictEqual(m.r, [[0, 1, 1]]);
  const off = await call('POST', '/v1/chats/1002/react', { body: { m: mine.id, e: 0 } });
  assert.strictEqual(off.data.on, 0);
  m = (await call('GET', `/v1/chats/1002/m/${mine.id}`)).data;
  assert.strictEqual(m.r, undefined);
});

test('playback: voice transcoded to 16 kHz Ogg/Opus in page-aligned parts', async () => {
  const msgs = (await call('GET', '/v1/chats/1001/msgs?n=10')).data.msgs;
  const voice = msgs.find((x) => x.k === 'voice');
  const meta = await call('GET', `/v1/chats/1001/media/${voice.id}`);
  assert.strictEqual(meta.status, 200, JSON.stringify(meta.data));
  assert.ok(meta.data.n >= 1);
  assert.ok(Math.abs(meta.data.d - 9000) < 600, `duration ${meta.data.d}`);
  const parts = [];
  for (let i = 0; i < meta.data.n; i++) {
    const p = await call('GET', `/v1/chats/1001/media/${voice.id}/${i}`, { bin: true });
    assert.strictEqual(p.status, 200);
    assert.strictEqual(p.ct, 'application/octet-stream');
    assert.ok(p.buf.length <= cfg.partBytes || audio.oggPages(p.buf).length === 1);
    // Each part must start on an Ogg page and contain only whole pages.
    assert.strictEqual(p.buf.toString('ascii', 0, 4), 'OggS');
    const pages = audio.oggPages(p.buf);
    assert.strictEqual(pages.reduce((s, pg) => s + pg.length, 0), p.buf.length);
    parts.push(p.buf);
  }
  const whole = Buffer.concat(parts);
  const pages = audio.oggPages(whole);
  const head = pages[0].subarray(27 + pages[0][26]);
  assert.strictEqual(head.toString('ascii', 0, 8), 'OpusHead');
  assert.strictEqual(head[9], 1, 'mono');
  assert.strictEqual(head.readUInt32LE(12), 16000, 'input rate 16 kHz');
  assert.ok(oggDurationMs(pages) > 8000);
  // Decodes cleanly.
  const pcm = await audio.decodePcm(['-f', 'ogg'], whole, 16000);
  assert.ok(pcm.length > 16000 * 8);
  const missing = await call('GET', `/v1/chats/1001/media/${voice.id}/${meta.data.n}`, { bin: true });
  assert.strictEqual(missing.status, 404);
});

async function makeCaptureLikeOgg(seconds) {
  // What Audio.Capture is asked for: Ogg/Opus, 16 kHz, mono.
  return audio.run([
    '-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=16000:duration=${seconds}`,
    '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', '-f', 'ogg', 'pipe:1',
  ]);
}

function splitEvery(buf, n) {
  const out = [];
  for (let i = 0; i < buf.length; i += n) out.push(buf.subarray(i, i + n));
  return out;
}

test('voice upload (Ogg windows, arbitrary boundaries) becomes a voice note', async () => {
  const ogg = await makeCaptureLikeOgg(4);
  const chunks = splitEvery(ogg, 3000); // windows don't line up with Ogg pages
  const start = await call('POST', '/v1/voice', { body: { c: '1003', f: 'ogg' } });
  assert.strictEqual(start.status, 200);
  const u = start.data.u;
  // Send out of order with one duplicate, like retries over a flaky link.
  const order = chunks.map((_, i) => i).reverse();
  order.push(0);
  for (const i of order) {
    const r = await call('POST', `/v1/voice/${u}/c?s=${i}`, { raw: chunks[i] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  }
  const sent = await call('POST', `/v1/voice/${u}/send`, { body: { n: chunks.length, d: 4000 } });
  assert.strictEqual(sent.status, 200, JSON.stringify(sent.data));
  assert.ok(Math.abs(sent.data.d - 4) <= 1);
  const msgs = (await call('GET', '/v1/chats/1003/msgs?n=3')).data.msgs;
  const v = msgs.find((m) => m.id === sent.data.id);
  assert.ok(v && v.k === 'voice' && v.o === 1 && /^[0-9]{24}$/.test(v.w));
  // The sent note can be played back too.
  const meta = await call('GET', `/v1/chats/1003/media/${v.id}`);
  assert.strictEqual(meta.status, 200);
});

test('voice upload with missing chunk is rejected with the list', async () => {
  const ogg = await makeCaptureLikeOgg(2);
  const chunks = splitEvery(ogg, 2000);
  const u = (await call('POST', '/v1/voice', { body: { c: '1003', f: 'ogg' } })).data.u;
  for (let i = 0; i < chunks.length; i++) if (i !== 1) await call('POST', `/v1/voice/${u}/c?s=${i}`, { raw: chunks[i] });
  const r = await call('POST', `/v1/voice/${u}/send`, { body: { n: chunks.length } });
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(r.data.missing, [1]);
});

test('voice upload from WAV windows (each with its own header)', async () => {
  const wav = await audio.run(['-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=16000:duration=3', '-ac', '1', '-f', 'wav', 'pipe:1']);
  const { pcm } = audio.stripWavHeader(wav);
  const header = wav.subarray(0, wav.length - pcm.length);
  const windows = splitEvery(pcm, 16000).map((p) => Buffer.concat([header, p]));
  const u = (await call('POST', '/v1/voice', { body: { c: '1004', f: 'wav16000' } })).data.u;
  for (let i = 0; i < windows.length; i++) await call('POST', `/v1/voice/${u}/c?s=${i}`, { raw: windows[i] });
  const sent = await call('POST', `/v1/voice/${u}/send`, { body: { n: windows.length } });
  assert.strictEqual(sent.status, 200, JSON.stringify(sent.data));
  assert.strictEqual(sent.data.d, 3);
});

test('cancel and bad uploads', async () => {
  const u = (await call('POST', '/v1/voice', { body: { c: '1003', f: 'ogg' } })).data.u;
  assert.strictEqual((await call('POST', `/v1/voice/${u}/cancel`, { body: {} })).status, 200);
  assert.strictEqual((await call('POST', `/v1/voice/${u}/c?s=0`, { raw: Buffer.from('x') })).status, 404);
  assert.strictEqual((await call('POST', '/v1/voice', { body: { c: '1003', f: 'mp3' } })).status, 400);
});

test('transcription request updates the message', async () => {
  const msgs = (await call('GET', '/v1/chats/1001/msgs?n=10')).data.msgs;
  const voice = msgs.find((x) => x.k === 'voice');
  const r = await call('POST', '/v1/chats/1001/transcribe', { body: { m: voice.id } });
  assert.strictEqual(r.status, 200);
  await new Promise((res) => setTimeout(res, 2300));
  const m = (await call('GET', `/v1/chats/1001/m/${voice.id}`)).data;
  assert.ok(m.tr && m.tr.length > 10);
});

test('2FA page flow (demo password is "demo")', async () => {
  const demo2 = createServer({ ...cfg, demo2fa: true, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pigeon-2fa-')) }, log);
  await new Promise((r) => demo2.server.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${demo2.server.address().port}`;
  try {
    const link = await (await fetch(`${b2}/v1/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    const H = { Authorization: `Bearer ${link.tk}` };
    await fetch(`${b2}/demo/advance`, { method: 'POST', headers: H });
    const a = await (await fetch(`${b2}/v1/auth`, { headers: H })).json();
    assert.strictEqual(a.st, 'pwd');
    assert.ok(a.url && a.qr && a.qr.n >= 21);
    const pageUrl = `http://${a.url}`;
    const page = await fetch(pageUrl);
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /Two-step verification/);
    const wrong = await fetch(pageUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=nope' });
    assert.match(await wrong.text(), /Wrong password/);
    const ok = await fetch(pageUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=demo' });
    assert.match(await ok.text(), /now linked/);
    const done = await (await fetch(`${b2}/v1/auth`, { headers: H })).json();
    assert.strictEqual(done.st, 'ready');
    // The one-time code is spent.
    assert.strictEqual((await fetch(pageUrl)).status, 410);
  } finally {
    await demo2.shutdown();
  }
});

test('logout ends the session', async () => {
  const r = await call('POST', '/v1/logout', { body: {} });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await call('GET', '/v1/chats')).status, 401);
  assert.strictEqual((await call('GET', '/v1/auth')).status, 401);
});
