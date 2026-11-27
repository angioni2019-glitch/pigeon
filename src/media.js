'use strict';
// Playback cache: Telegram audio transcoded for the watch and split into
// Ogg-page-aligned parts. Kept in memory only (never written to disk) and
// evicted after a while.

const audio = require('./audio');

function oggDurationMs(pages) {
  if (!pages.length) return 0;
  let preSkip = 0;
  const head = pages[0];
  const segs = head[26];
  const body = head.subarray(27 + segs);
  if (body.length >= 19 && body.toString('ascii', 0, 8) === 'OpusHead') preSkip = body.readUInt16LE(10);
  for (let i = pages.length - 1; i >= 0; i--) {
    const g = pages[i].readBigInt64LE(6);
    if (g > 0n) return Math.max(0, Math.round((Number(g) - preSkip) / 48));
  }
  return 0;
}

class MediaCache {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.items = new Map(); // key -> { parts, durMs, at }
    this.pending = new Map(); // key -> Promise
    this.maxItems = 24;
    this.ttlMs = 30 * 60 * 1000;
  }

  async get(sid, account, chatId, msgId) {
    const key = `${sid}:${chatId}:${msgId}`;
    const hit = this.items.get(key);
    if (hit) {
      hit.at = Date.now();
      return hit;
    }
    if (this.pending.has(key)) return this.pending.get(key);
    const p = (async () => {
      const file = await account.mediaFile(chatId, msgId);
      let ogg;
      try {
        ogg = await audio.toWatchOgg(file.path, this.cfg.playbackMaxSec);
      } finally {
        file.cleanup();
      }
      const pages = audio.oggPages(ogg);
      const parts = audio.groupPages(pages, this.cfg.partBytes);
      const durMs = oggDurationMs(pages) || (file.duration || 0) * 1000;
      const item = { parts, durMs, bytes: ogg.length, at: Date.now() };
      this.items.set(key, item);
      this._evict();
      return item;
    })();
    this.pending.set(key, p);
    try {
      return await p;
    } finally {
      this.pending.delete(key);
    }
  }

  peek(sid, chatId, msgId) {
    return this.items.get(`${sid}:${chatId}:${msgId}`) || null;
  }

  dropSession(sid) {
    for (const k of this.items.keys()) if (k.startsWith(`${sid}:`)) this.items.delete(k);
  }

  _evict() {
    const now = Date.now();
    for (const [k, v] of this.items) if (now - v.at > this.ttlMs) this.items.delete(k);
    while (this.items.size > this.maxItems) {
      let oldest = null;
      for (const [k, v] of this.items) if (!oldest || v.at < oldest[1].at) oldest = [k, v];
      this.items.delete(oldest[0]);
    }
  }

  sweep() {
    this._evict();
  }
}

module.exports = { MediaCache, oggDurationMs };
