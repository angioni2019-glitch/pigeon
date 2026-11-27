'use strict';
// Watch sessions. Each linked watch holds a random token; the bridge keeps only
// sha256(token). The TDLib database key is derived from the token with HKDF,
// so a session can only be opened while its watch is talking to the bridge.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TelegramAccount } = require('./backend/telegram');
const { DemoAccount } = require('./backend/demo');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

class SessionStore {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.dir = path.join(cfg.dataDir, 'sessions');
    this.file = path.join(cfg.dataDir, 'sessions.json');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.records = this._load();
    this.byHash = new Map(Object.values(this.records).map((r) => [r.tokenHash, r]));
    this.live = new Map(); // sid -> { account, lastUsed }
    this._saveTimer = null;
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return data && data.sessions ? data.sessions : {};
    } catch {
      return {};
    }
  }

  _save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, 500);
  }

  saveNow() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sessions: this.records }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  count() {
    return Object.keys(this.records).length;
  }

  create() {
    const sid = crypto.randomBytes(8).toString('hex');
    const token = crypto.randomBytes(32).toString('base64url');
    const rec = { sid, tokenHash: sha256(token), created: Date.now(), lastSeen: Date.now(), linked: false };
    this.records[sid] = rec;
    this.byHash.set(rec.tokenHash, rec);
    this._save();
    return { rec, token };
  }

  findByToken(token) {
    if (!token || typeof token !== 'string' || token.length < 20) return null;
    return this.byHash.get(sha256(token)) || null;
  }

  dbKey(token, sid) {
    return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(token), Buffer.from(sid), Buffer.from('pigeon-tdlib-db-v1'), 32)).toString('base64');
  }

  /** Get (opening if needed) the account for a session. */
  account(rec, token) {
    let entry = this.live.get(rec.sid);
    if (!entry || entry.account.closed) {
      const dir = path.join(this.dir, rec.sid);
      const account = this.cfg.demo
        ? new DemoAccount({ sid: rec.sid, cfg: this.cfg, log: this.log, linked: rec.linked })
        : new TelegramAccount({ sid: rec.sid, dir, dbKey: this.dbKey(token, rec.sid), cfg: this.cfg, log: this.log });
      account.on('ready', (me) => {
        rec.linked = true;
        rec.userId = me && me.id;
        this._save();
      });
      account.on('closed', () => {
        const cur = this.live.get(rec.sid);
        if (cur && cur.account === account) this.live.delete(rec.sid);
      });
      account.start();
      entry = { account, lastUsed: Date.now() };
      this.live.set(rec.sid, entry);
    }
    entry.lastUsed = Date.now();
    if (Date.now() - rec.lastSeen > 60 * 1000) {
      rec.lastSeen = Date.now();
      this._save();
    }
    return entry.account;
  }

  liveAccount(sid) {
    const e = this.live.get(sid);
    return e && !e.account.closed ? e.account : null;
  }

  async remove(sid) {
    const e = this.live.get(sid);
    this.live.delete(sid);
    if (e) await e.account.close().catch(() => {});
    const rec = this.records[sid];
    if (rec) {
      this.byHash.delete(rec.tokenHash);
      delete this.records[sid];
      this._save();
    }
    fs.rm(path.join(this.dir, sid), { recursive: true, force: true }, () => {});
  }

  /** Periodic cleanup: close idle TDLib clients, drop abandoned and stale sessions. */
  async sweep() {
    const now = Date.now();
    for (const [sid, e] of this.live) {
      if (now - e.lastUsed > this.cfg.idleCloseMin * 60 * 1000) {
        this.live.delete(sid);
        this.log.info(`[${sid}] idle, closing Telegram client`);
        await e.account.close().catch(() => {});
      }
    }
    for (const rec of Object.values(this.records)) {
      const pendingTooLong = !rec.linked && now - rec.created > this.cfg.pendingLinkMin * 60 * 1000;
      const stale = now - rec.lastSeen > this.cfg.staleSessionDays * 24 * 3600 * 1000;
      if (pendingTooLong || stale) {
        this.log.info(`[${rec.sid}] removing ${pendingTooLong ? 'unfinished link' : 'stale session'}`);
        await this.remove(rec.sid);
      }
    }
  }

  async closeAll() {
    await Promise.all([...this.live.values()].map((e) => e.account.close().catch(() => {})));
    this.live.clear();
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this.saveNow();
  }
}

module.exports = { SessionStore };
