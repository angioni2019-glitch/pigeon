'use strict';
// Pigeon bridge: a small HTTPS/JSON API for the Garmin watch app, backed by TDLib.
// Run behind a TLS-terminating reverse proxy (Connect IQ requires HTTPS).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./http');
const qr = require('./qr');
const audio = require('./audio');
const pages = require('./pages');
const F = require('./format');
const { SessionStore } = require('./sessions');
const { Uploads } = require('./uploads');
const { MediaCache } = require('./media');

const intParam = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

function createServer(cfg, log) {
  audio.setFfmpeg(cfg.ffmpeg);
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const tmpDir = path.join(cfg.dataDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

  const store = new SessionStore(cfg, log);
  const uploads = new Uploads();
  const media = new MediaCache(cfg, log);
  const pwCodes = new Map(); // one-time 2FA page codes: code -> { sid, exp }
  const linkLimiter = new H.RateLimiter(10, 10 * 60 * 1000);
  const pwLimiter = new H.RateLimiter(20, 10 * 60 * 1000);
  const router = new H.Router();

  const clientIp = (req) =>
    (cfg.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || '?';

  const baseUrl = (req) => {
    if (cfg.publicUrl) return cfg.publicUrl;
    const proto = (cfg.trustProxy && req.headers['x-forwarded-proto']) || (req.socket.encrypted ? 'https' : 'http');
    const host = (cfg.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || `localhost:${cfg.port}`;
    return `${String(proto).split(',')[0].trim()}://${String(host).split(',')[0].trim()}`;
  };

  function auth(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    const token = m && m[1];
    const rec = token ? store.findByToken(token) : null;
    if (!rec) throw new H.HttpError(401, 'Unknown session');
    return { rec, token, acct: store.account(rec, token) };
  }

  async function ready(req) {
    const ctx = auth(req);
    try {
      await ctx.acct.ready();
    } catch (e) {
      if (e.status === 401 && ctx.rec.linked) {
        // Logged out from the phone (Settings > Devices): forget this watch.
        media.dropSession(ctx.rec.sid);
        await store.remove(ctx.rec.sid);
      }
      throw e;
    }
    return ctx;
  }

  function pwCodeFor(sid) {
    for (const [code, v] of pwCodes) if (v.sid === sid && v.exp > Date.now()) return code;
    const code = crypto.randomBytes(9).toString('base64url');
    pwCodes.set(code, { sid, exp: Date.now() + 15 * 60 * 1000 });
    return code;
  }

  // ---- linking ---------------------------------------------------------------

  router.add('GET', '/', async (req, res) => {
    H.html(res, 200, '<!doctype html><meta charset="utf-8"><title>Pigeon bridge</title><p>Pigeon bridge is running.</p>');
  });

  router.add('GET', '/healthz', async (req, res) => {
    H.json(res, 200, { ok: 1, v: cfg.version, demo: cfg.demo ? 1 : 0 });
  });

  router.add('POST', '/v1/link', async (req, res) => {
    if (!linkLimiter.check(clientIp(req))) throw new H.HttpError(429, 'Too many link attempts, try later');
    const body = await H.readJson(req);
    if (cfg.pairingKey) {
      const given = Buffer.from(String(body.k || req.headers['x-pairing-key'] || ''));
      const want = Buffer.from(cfg.pairingKey);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new H.HttpError(403, 'Wrong pairing key');
    }
    if (store.count() >= cfg.maxSessions) throw new H.HttpError(429, 'This bridge has no free slots');
    const { rec, token } = store.create();
    store.account(rec, token).requestLogin();
    log.info(`[${rec.sid}] link started`);
    H.json(res, 200, { tk: token, sid: rec.sid });
  });

  router.add('GET', '/v1/auth', async (req, res) => {
    const { rec, acct } = auth(req);
    if (!rec.linked) acct.requestLogin();
    const info = acct.authInfo();
    if (info.st === 'closed' && rec.linked) {
      media.dropSession(rec.sid);
      await store.remove(rec.sid);
      throw new H.HttpError(401, 'Session ended');
    }
    const out = { st: info.st };
    if (info.st === 'qr' && info.link) out.qr = qr.encodeForWatch(info.link, { level: 'L' });
    if (info.st === 'pwd') {
      const url = `${baseUrl(req)}/p/${pwCodeFor(rec.sid)}`;
      out.hint = F.truncate(info.hint || '', 40);
      out.url = url.replace(/^https?:\/\//, '');
      out.qr = qr.encodeForWatch(url, { level: 'L' });
    }
    if (info.st === 'ready') out.me = info.me;
    if (info.st === 'error') out.err = info.err;
    H.json(res, 200, out);
  });

  router.add('POST', '/v1/auth/password', async (req, res) => {
    const { acct } = auth(req);
    const body = await H.readJson(req);
    await acct.checkPassword(String(body.pw || ''));
    H.json(res, 200, { ok: 1 });
  });

  router.add('POST', '/v1/logout', async (req, res) => {
    const { rec, acct } = auth(req);
    await acct.logout().catch(() => {});
    media.dropSession(rec.sid);
    await store.remove(rec.sid);
    log.info(`[${rec.sid}] logged out`);
    H.json(res, 200, { ok: 1 });
  });

  // 2-step verification page (opened on the phone from the QR the watch shows).
  router.add('GET', '/p/:code', async (req, res, p) => {
    const entry = pwCodes.get(p.code);
    const acct = entry && entry.exp > Date.now() ? store.liveAccount(entry.sid) : null;
    if (!acct) return H.html(res, 410, pages.gone());
    const info = acct.authInfo();
    if (info.st === 'ready') return H.html(res, 200, pages.done());
    if (info.st !== 'pwd') return H.html(res, 410, pages.gone());
    return H.html(res, 200, pages.passwordForm({ hint: info.hint }));
  });

  router.add('POST', '/p/:code', async (req, res, p) => {
    if (!pwLimiter.check(clientIp(req))) return H.html(res, 429, pages.passwordForm({ error: 'Too many attempts. Wait a few minutes.' }));
    const entry = pwCodes.get(p.code);
    const acct = entry && entry.exp > Date.now() ? store.liveAccount(entry.sid) : null;
    if (!acct) return H.html(res, 410, pages.gone());
    const form = await H.readForm(req);
    const hint = (acct.authInfo() || {}).hint;
    try {
      await acct.checkPassword(form.get('password') || '');
      pwCodes.delete(p.code);
      return H.html(res, 200, pages.done());
    } catch (e) {
      if (e.status === 409 && acct.authInfo().st === 'ready') return H.html(res, 200, pages.done());
      return H.html(res, e.status === 403 ? 200 : 400, pages.passwordForm({ hint, error: e.message || 'Something went wrong' }));
    }
  });

  if (cfg.demo) {
    router.add('POST', '/demo/advance', async (req, res) => {
      const { acct } = auth(req);
      acct.advance();
      H.json(res, 200, { ok: 1, st: acct.authInfo().st });
    });
  }

  // ---- chats -----------------------------------------------------------------

  router.add('GET', '/v1/sync', async (req, res, p, url) => {
    const { acct } = auth(req);
    try {
      await acct.ready(4000);
    } catch (e) {
      if (e.status === 503) return H.json(res, 200, { v: -1, cv: -1, u: 0 });
      throw e;
    }
    H.json(res, 200, acct.versions(url.searchParams.get('c')));
  });

  router.add('GET', '/v1/chats', async (req, res, p, url) => {
    const { acct } = await ready(req);
    const chats = await acct.listChats(intParam(url.searchParams.get('n'), 20));
    H.json(res, 200, { chats, ...acct.versions() });
  });

  router.add('GET', '/v1/chats/:cid/msgs', async (req, res, p, url) => {
    const { acct } = await ready(req);
    const q = url.searchParams;
    const h = await acct.history(p.cid, intParam(q.get('n'), 12), q.get('before') || null, q.get('read') === '1');
    H.json(res, 200, { ...h, cv: acct.versions(p.cid).cv });
  });

  router.add('GET', '/v1/chats/:cid/m/:mid', async (req, res, p) => {
    const { acct } = await ready(req);
    H.json(res, 200, await acct.messageInfo(p.cid, p.mid));
  });

  router.add('POST', '/v1/chats/:cid/text', async (req, res, p) => {
    const { acct } = await ready(req);
    const body = await H.readJson(req);
    H.json(res, 200, await acct.sendText(p.cid, body.t));
  });

  router.add('POST', '/v1/chats/:cid/emoji', async (req, res, p) => {
    const { acct } = await ready(req);
    const body = await H.readJson(req);
    H.json(res, 200, await acct.sendEmoji(p.cid, intParam(body.e, -1)));
  });

  router.add('POST', '/v1/chats/:cid/react', async (req, res, p) => {
    const { acct } = await ready(req);
    const body = await H.readJson(req);
    H.json(res, 200, await acct.toggleReaction(p.cid, String(body.m || ''), intParam(body.e, -1)));
  });

  router.add('POST', '/v1/chats/:cid/transcribe', async (req, res, p) => {
    const { acct } = await ready(req);
    const body = await H.readJson(req);
    H.json(res, 200, await acct.transcribe(p.cid, String(body.m || '')));
  });

  // ---- playback: prepare, then fetch Ogg-page-aligned parts --------------------

  router.add('GET', '/v1/chats/:cid/media/:mid', async (req, res, p) => {
    const { rec, acct } = await ready(req);
    const item = await media.get(rec.sid, acct, p.cid, p.mid);
    H.json(res, 200, { n: item.parts.length, d: item.durMs, b: item.bytes });
  });

  router.add('GET', '/v1/chats/:cid/media/:mid/:part', async (req, res, p) => {
    const { rec, acct } = await ready(req);
    const item = media.peek(rec.sid, p.cid, p.mid) || (await media.get(rec.sid, acct, p.cid, p.mid));
    const i = intParam(p.part, -1);
    if (i < 0 || i >= item.parts.length) throw new H.HttpError(404, 'No such part');
    H.binary(res, item.parts[i]);
  });

  // ---- voice messages from the watch -----------------------------------------------

  const lastAction = new Map(); // upload id -> time of last "recording" chat action

  router.add('POST', '/v1/voice', async (req, res) => {
    const { rec, acct } = await ready(req);
    const body = await H.readJson(req);
    if (!body.c) throw new H.HttpError(400, 'Missing chat');
    const u = uploads.create(rec.sid, body.c, body.f);
    acct.chatAction(body.c, 'voice');
    lastAction.set(u, Date.now());
    H.json(res, 200, { u });
  });

  router.add('POST', '/v1/voice/:uid/c', async (req, res, p, url) => {
    const { rec, acct } = auth(req);
    const buf = await H.readBody(req, 64 * 1024 + 1);
    const out = uploads.addChunk(p.uid, rec.sid, intParam(url.searchParams.get('s'), -1), buf);
    // Telegram shows a chat action for about 5 seconds; refresh it while recording.
    if (Date.now() - (lastAction.get(p.uid) || 0) > 4000) {
      lastAction.set(p.uid, Date.now());
      const chatId = uploads.chatOf(p.uid);
      if (chatId) acct.chatAction(chatId, 'voice');
    }
    H.json(res, 200, out);
  });

  router.add('POST', '/v1/voice/:uid/send', async (req, res, p) => {
    const { rec, acct } = await ready(req);
    const body = await H.readJson(req);
    const up = uploads.take(p.uid, rec.sid, intParam(body.n, 0));
    lastAction.delete(p.uid);
    let note;
    try {
      note = await audio.voiceNoteFromWatch(up.chunks, up.fmt);
    } catch (e) {
      log.warn(`[${rec.sid}] voice decode failed`, e.message);
      throw new H.HttpError(422, 'Could not read the recording');
    }
    if (note.samples < note.rate / 2) throw new H.HttpError(400, 'Recording too short');
    if (note.durationSec > cfg.voiceMaxSec) throw new H.HttpError(413, 'Recording too long');
    const file = path.join(tmpDir, `voice-${rec.sid}-${crypto.randomBytes(6).toString('hex')}.ogg`);
    fs.writeFileSync(file, note.ogg, { mode: 0o600 });
    try {
      const sent = await acct.sendVoice(up.chatId, file, note.durationSec, note.waveform);
      H.json(res, 200, { ...sent, d: note.durationSec });
    } catch (e) {
      fs.rm(file, { force: true }, () => {});
      throw e;
    }
  });

  router.add('POST', '/v1/voice/:uid/cancel', async (req, res, p) => {
    const { rec, acct } = auth(req);
    const chatId = uploads.chatOf(p.uid);
    uploads.cancel(p.uid, rec.sid);
    lastAction.delete(p.uid);
    if (chatId) acct.chatAction(chatId, 'cancel');
    H.json(res, 200, { ok: 1 });
  });

  // ---- server ----------------------------------------------------------------------

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, 'http://bridge.local');
    } catch {
      H.json(res, 400, { err: 'Bad URL' });
      return;
    }
    try {
      const m = router.match(req.method, url.pathname);
      if (!m) throw new H.HttpError(404, 'Not found');
      if (m.notAllowed) throw new H.HttpError(405, 'Method not allowed');
      await m.handler(req, res, m.params, url);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) log.warn(`${req.method} ${url.pathname} -> ${status}: ${e.message}`);
      if (!res.headersSent) H.json(res, status, { err: e.status ? e.message : 'Internal error', ...(e.extra || {}) });
    } finally {
      // Never log query strings or bodies: they can hold message text.
      log.debug(`${req.method} ${url.pathname.replace(/\/p\/[^/]+/, '/p/*')} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  const sweeper = setInterval(() => {
    store.sweep().catch((e) => log.warn('sweep failed', e.message));
    uploads.sweep();
    media.sweep();
    for (const id of lastAction.keys()) if (!uploads.chatOf(id)) lastAction.delete(id);
    const now = Date.now();
    for (const [code, v] of pwCodes) if (v.exp < now) pwCodes.delete(code);
    fs.readdir(tmpDir, (err, files) => {
      if (err) return;
      for (const f of files) {
        const fp = path.join(tmpDir, f);
        fs.stat(fp, (e, st) => {
          if (!e && now - st.mtimeMs > 3600 * 1000) fs.rm(fp, { force: true }, () => {});
        });
      }
    });
  }, 60 * 1000);
  sweeper.unref();

  async function shutdown() {
    clearInterval(sweeper);
    await new Promise((r) => server.close(() => r()));
    await store.closeAll();
  }

  return { server, store, uploads, media, shutdown };
}

module.exports = { createServer };

if (require.main === module) {
  // eslint-disable-next-line global-require
  const cfg = require('./config').load();
  // eslint-disable-next-line global-require
  const log = require('./log').create(cfg.logLevel);
  const { server, shutdown } = createServer(cfg, log);
  server.listen(cfg.port, cfg.host, () => {
    log.info(`Pigeon bridge ${cfg.version} listening on ${cfg.host}:${cfg.port}${cfg.demo ? ' (DEMO mode, no Telegram)' : ''}`);
  });
  let stopping = false;
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig}: closing Telegram clients...`);
    shutdown()
      .catch((e) => log.error(e))
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 15000).unref();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}
