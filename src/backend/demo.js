'use strict';
// A fake Telegram account with the same interface as TelegramAccount.
// Lets you run the watch app in the Connect IQ simulator (or on a watch)
// without Telegram credentials: DEMO=1 npm start
//
// Login: the QR screen shows a rotating fake tg://login link and advances by
// itself after DEMO_AUTO_LOGIN_SEC (or POST /demo/advance). With DEMO_2FA=1 it
// asks for a password first; the password is "demo".

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const F = require('../format');
const audio = require('../audio');
const { HttpError } = require('../http');

const now = () => Math.floor(Date.now() / 1000);

function seedChats() {
  const t = now();
  const mk = (id, title, group, extra = {}) => ({ id, title, group, unread: 0, muted: false, lastReadOut: 0, msgs: [], ...extra });
  const chats = [
    mk(1001, 'Anna Kowalska', false),
    mk(-2001, 'Trail Runners', true),
    mk(1002, 'Leo Martin', false),
    mk(-2002, 'Family', true, { muted: true }),
    mk(1003, 'Sofia', false),
    mk(1004, 'Bike Shop', false),
  ];
  let id = 100;
  const add = (chat, m) => {
    id += 1;
    chat.msgs.push({ id: id * 1048576, ...m });
  };
  const [anna, runners, leo, family, sofia, shop] = chats;
  add(anna, { o: 0, ts: t - 3600 * 3, k: 'txt', t: 'Are we still on for the long run on Saturday?' });
  add(anna, { o: 1, ts: t - 3600 * 3 + 120, k: 'txt', t: 'Yes! 7:30 at the park entrance', r: [[0, 1, 0]] });
  add(anna, { o: 0, ts: t - 1800, k: 'txt', t: 'Perfect. I will bring gels for both of us' });
  add(anna, { o: 0, ts: t - 420, k: 'voice', d: 9, voice: 'a', nl: 1, w: '245798643578975326785432' });
  add(anna, { o: 0, ts: t - 300, k: 'txt', t: 'Listen to this when you can \u{1F642}' });
  anna.unread = 2;

  add(runners, { o: 0, ts: t - 7200, k: 'txt', t: 'New route posted for Sunday, 18 km with 400 m of climbing', s: 'Marek', sc: 2 });
  add(runners, { o: 0, ts: t - 7000, k: 'photo', t: 'Route map', s: 'Marek', sc: 2 });
  add(runners, { o: 0, ts: t - 6500, k: 'txt', t: 'Count me in', s: 'Julia', sc: 4, r: [[1, 3, 1], [0, 2, 0]] });
  add(runners, { o: 1, ts: t - 6000, k: 'voice', d: 6, voice: 'b', w: '357986543357986543246897' });
  add(runners, { o: 0, ts: t - 900, k: 'txt', t: 'Bring a headlamp, we start before sunrise', s: 'Marek', sc: 2 });
  runners.unread = 1;

  add(leo, { o: 1, ts: t - 86400, k: 'txt', t: 'Thanks for the tip about the trail shoes' });
  add(leo, { o: 0, ts: t - 86000, k: 'txt', t: 'Anytime. How did the race go?' });
  add(leo, { o: 1, ts: t - 85000, k: 'txt', t: 'PR by 4 minutes!', r: [[3, 1, 0]] });
  leo.lastReadOut = Infinity;

  add(family, { o: 0, ts: t - 172800, k: 'txt', t: 'Dinner at 7 on Sunday', s: 'Mom', sc: 6 });
  add(family, { o: 0, ts: t - 172000, k: 'sticker', t: '\u{1F44D} Sticker', s: 'Dad', sc: 5 });

  add(sofia, { o: 0, ts: t - 259200, k: 'txt', t: 'Can you send me the playlist?' });
  add(sofia, { o: 1, ts: t - 259000, k: 'doc', t: 'running-mix.m3u' });

  add(shop, { o: 0, ts: t - 400000, k: 'txt', t: 'Your bike is ready for pickup. Open until 6 pm.' });
  return chats;
}

class DemoAccount extends EventEmitter {
  constructor({ sid, cfg, log, linked }) {
    super();
    this.sid = sid;
    this.cfg = cfg;
    this.log = log;
    this.state = linked ? 'ready' : 'idle';
    this.loginStarted = 0;
    this.token = crypto.randomBytes(24).toString('base64url');
    this.tokenAt = Date.now();
    this.chats = seedChats();
    this.version = 1;
    this.chatVersions = new Map();
    this.nextId = 5000;
    this.voiceDir = path.join(cfg.dataDir, 'demo');
    this.timers = new Set();
    this.closed = false;
  }

  start() {}

  _later(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.closed) fn();
    }, ms);
    this.timers.add(t);
  }

  _bump(chatId) {
    this.version++;
    if (chatId != null) this.chatVersions.set(String(chatId), this.version);
  }

  requestLogin() {
    if (this.state === 'idle') {
      this.state = 'qr';
      this.loginStarted = Date.now();
    }
  }

  advance() {
    if (this.state === 'qr') this.state = this.cfg.demo2fa ? 'pwd' : 'ready';
    else if (this.state === 'pwd') this.state = 'ready';
    if (this.state === 'ready') this.emit('ready', { id: 1, name: 'Demo User' });
  }

  authInfo() {
    if (this.state === 'qr') {
      if (Date.now() - this.loginStarted > this.cfg.demoAutoLoginSec * 1000) this.advance();
      else if (Date.now() - this.tokenAt > 25000) {
        this.token = crypto.randomBytes(24).toString('base64url');
        this.tokenAt = Date.now();
      }
    }
    switch (this.state) {
      case 'qr':
        return { st: 'qr', link: `tg://login?token=${this.token}` };
      case 'pwd':
        return { st: 'pwd', hint: 'the word "demo"' };
      case 'ready':
        return { st: 'ready', me: 'Demo User' };
      case 'closed':
        return { st: 'closed' };
      default:
        return { st: 'wait' };
    }
  }

  ready() {
    if (this.state === 'ready') return Promise.resolve();
    if (this.state === 'closed') return Promise.reject(new HttpError(401, 'Not logged in'));
    return Promise.reject(new HttpError(409, 'Not linked yet'));
  }

  async checkPassword(pw) {
    if (this.state !== 'pwd') throw new HttpError(409, 'No password requested');
    if (pw !== 'demo') throw new HttpError(403, 'Wrong password');
    this.advance();
  }

  async logout() {
    this.state = 'closed';
    this.emit('loggedOut');
  }

  async close() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  versions(chatId) {
    return {
      v: this.version,
      cv: chatId ? this.chatVersions.get(String(chatId)) || 0 : 0,
      u: this.chats.filter((c) => c.unread > 0 && !c.muted).length,
    };
  }

  _chat(chatId) {
    const c = this.chats.find((x) => String(x.id) === String(chatId));
    if (!c) throw new HttpError(404, 'Chat not found');
    return c;
  }

  _status(chat, m) {
    if (!m.o) return undefined;
    if (m.st === 0 || m.st === -1) return m.st;
    return m.id <= chat.lastReadOut ? 2 : 1;
  }

  async listChats(limit) {
    const sorted = [...this.chats].sort((a, b) => b.msgs[b.msgs.length - 1].ts - a.msgs[a.msgs.length - 1].ts);
    return sorted.slice(0, limit || 20).map((c) => {
      const lm = c.msgs[c.msgs.length - 1];
      let t = F.previewText(lm);
      if (c.group && !lm.o && lm.s) t = `${lm.s}: ${t}`;
      const m = { t: F.oneLine(t, 80), k: lm.k, o: lm.o, ts: lm.ts };
      if (lm.o) m.st = this._status(c, lm);
      return { id: String(c.id), t: c.title, i: F.initials(c.title), c: F.colorIndex(c.id), u: c.unread, mu: c.muted ? 1 : 0, g: c.group ? 1 : 0, m };
    });
  }

  _format(chat, m) {
    const r = { id: String(m.id), o: m.o, ts: m.ts, k: m.k };
    for (const key of ['t', 'd', 'w', 'tr', 'nl', 's', 'sc', 'r']) if (m[key] !== undefined && m[key] !== null) r[key] = m[key];
    if (m.k === 'txt') {
      const e = F.emojiIndex(String(m.t || '').trim());
      if (e >= 0) r.e = e;
    }
    if (m.o) r.st = this._status(chat, m);
    return r;
  }

  async history(chatId, limit, beforeId, markRead) {
    const chat = this._chat(chatId);
    let list = chat.msgs;
    if (beforeId) list = list.filter((m) => m.id < Number(beforeId));
    const page = list.slice(-(limit || 12));
    if (markRead && chat.unread) {
      chat.unread = 0;
      this._bump(chat.id);
    }
    return { t: chat.title, g: chat.group ? 1 : 0, more: list.length > page.length ? 1 : 0, msgs: page.map((m) => this._format(chat, m)) };
  }

  async messageInfo(chatId, msgId) {
    const chat = this._chat(chatId);
    const m = chat.msgs.find((x) => String(x.id) === String(msgId));
    if (!m) throw new HttpError(404, 'Message not found');
    return this._format(chat, m);
  }

  _push(chat, m) {
    this.nextId += 1;
    const msg = { id: this.nextId * 1048576, ts: now(), ...m };
    chat.msgs.push(msg);
    this._bump(chat.id);
    return msg;
  }

  _deliver(chat, msg) {
    // Simulate: pending -> sent -> read, then an auto-reply.
    this._later(700, () => {
      msg.st = undefined;
      this._bump(chat.id);
    });
    this._later(2500, () => {
      chat.lastReadOut = msg.id;
      this._bump(chat.id);
    });
    this._later(4000, () => {
      const replies = ['Got it \u{1F44D}', 'Sounds good!', 'Haha, nice', 'On it.', 'See you there'];
      const text = replies[Math.floor(Math.random() * replies.length)];
      const reply = { o: 0, k: 'txt', t: text };
      if (chat.group) Object.assign(reply, { s: 'Julia', sc: 4 });
      this._push(chat, reply);
    });
  }

  async sendText(chatId, text) {
    const chat = this._chat(chatId);
    const t = String(text || '').trim();
    if (!t) throw new HttpError(400, 'Empty message');
    const msg = this._push(chat, { o: 1, k: 'txt', t: t.slice(0, 4096), st: 0 });
    this._deliver(chat, msg);
    return { id: String(msg.id) };
  }

  async sendEmoji(chatId, idx) {
    if (!F.EMOJI_SEND[idx]) throw new HttpError(400, 'Unknown emoji');
    return this.sendText(chatId, F.EMOJI_SEND[idx]);
  }

  async toggleReaction(chatId, msgId, idx) {
    const chat = this._chat(chatId);
    const m = chat.msgs.find((x) => String(x.id) === String(msgId));
    if (!m) throw new HttpError(404, 'Message not found');
    if (!F.EMOJI_REACT[idx]) throw new HttpError(400, 'Unknown reaction');
    m.r = m.r || [];
    const cur = m.r.find((x) => x[0] === idx);
    let on;
    if (cur && cur[2]) {
      cur[1] -= 1;
      cur[2] = 0;
      if (cur[1] <= 0) m.r = m.r.filter((x) => x !== cur);
      on = 0;
    } else {
      for (const x of m.r) {
        if (x[2]) {
          x[1] -= 1;
          x[2] = 0;
        }
      }
      m.r = m.r.filter((x) => x[1] > 0);
      const again = m.r.find((x) => x[0] === idx);
      if (again) {
        again[1] += 1;
        again[2] = 1;
      } else m.r.push([idx, 1, 1]);
      on = 1;
    }
    if (!m.r.length) delete m.r;
    this._bump(chat.id);
    return { on };
  }

  chatAction() {}

  async transcribe(chatId, msgId) {
    const chat = this._chat(chatId);
    const m = chat.msgs.find((x) => String(x.id) === String(msgId));
    if (!m || m.k !== 'voice') throw new HttpError(404, 'Not a voice message');
    m.tr = 'Transcribing…';
    this._bump(chat.id);
    this._later(2000, () => {
      m.tr = m.o ? 'This is a demo transcript of your own voice message.' : 'Hey, just checking the route for Saturday. Call me if anything changes!';
      this._bump(chat.id);
    });
    return { ok: 1 };
  }

  async _sample(name) {
    fs.mkdirSync(this.voiceDir, { recursive: true });
    const file = path.join(this.voiceDir, `sample-${name}.wav`);
    if (!fs.existsSync(file)) {
      // A short, speech-like rhythm of tones (there is no real speech in demo mode).
      const f0 = name === 'a' ? 300 : 220;
      const expr = `0.35*sin(2*PI*(${f0}+60*sin(2*PI*0.7*t))*t)*(0.55+0.45*sin(2*PI*3.1*t))*lt(mod(t,1.6),1.25)`;
      const wav = await audio.run(['-f', 'lavfi', '-i', `aevalsrc=exprs='${expr}':s=16000:d=${name === 'a' ? 9 : 6}`, '-ac', '1', '-f', 'wav', 'pipe:1']);
      fs.writeFileSync(file, wav);
    }
    return file;
  }

  async mediaFile(chatId, msgId) {
    const chat = this._chat(chatId);
    const m = chat.msgs.find((x) => String(x.id) === String(msgId));
    if (!m || (m.k !== 'voice' && m.k !== 'audio')) throw new HttpError(404, 'This message has no audio');
    const p = m.file || (await this._sample(m.voice || 'a'));
    if (m.nl) {
      delete m.nl;
      this._bump(chat.id);
    }
    return { path: p, duration: m.d, cleanup: () => {} };
  }

  async sendVoice(chatId, oggPath, durationSec, waveform) {
    const chat = this._chat(chatId);
    const keep = path.join(this.voiceDir, `sent-${Date.now()}.ogg`);
    fs.mkdirSync(this.voiceDir, { recursive: true });
    fs.copyFileSync(oggPath, keep);
    fs.rm(oggPath, { force: true }, () => {});
    const msg = this._push(chat, { o: 1, k: 'voice', d: durationSec, w: audio.waveBars(waveform, 24), file: keep, st: 0 });
    this._deliver(chat, msg);
    return { id: String(msg.id) };
  }
}

module.exports = { DemoAccount };
