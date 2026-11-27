'use strict';
// Voice uploads from the watch. The watch starts an upload when recording
// starts and sends each captured window as soon as it arrives, so most of the
// audio is already here when the user taps send.

const crypto = require('crypto');
const { HttpError } = require('./http');

const MAX_CHUNK = 64 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024;
const MAX_CHUNKS = 2000;
const TTL_MS = 15 * 60 * 1000;

class Uploads {
  constructor() {
    this.items = new Map();
  }

  create(sid, chatId, fmt) {
    const f = String(fmt || 'ogg').toLowerCase();
    if (!/^(ogg|wav(8000|11025|12000|16000|22050|24000|32000|44100)?)$/.test(f)) throw new HttpError(400, 'Unsupported format');
    const id = crypto.randomBytes(9).toString('base64url');
    this.items.set(id, { id, sid, chatId: String(chatId), fmt: f, chunks: new Map(), bytes: 0, at: Date.now() });
    return id;
  }

  _get(id, sid) {
    const u = this.items.get(id);
    if (!u || u.sid !== sid) throw new HttpError(404, 'Upload not found');
    u.at = Date.now();
    return u;
  }

  addChunk(id, sid, seq, buf) {
    const u = this._get(id, sid);
    if (!Number.isInteger(seq) || seq < 0 || seq >= MAX_CHUNKS) throw new HttpError(400, 'Bad chunk number');
    if (!buf.length) throw new HttpError(400, 'Empty chunk');
    if (buf.length > MAX_CHUNK) throw new HttpError(413, 'Chunk too large');
    const prev = u.chunks.get(seq);
    if (prev) u.bytes -= prev.length; // retry of the same chunk
    if (u.bytes + buf.length > MAX_TOTAL) throw new HttpError(413, 'Recording too large');
    u.chunks.set(seq, buf);
    u.bytes += buf.length;
    return { s: seq, n: u.chunks.size };
  }

  take(id, sid, count) {
    const u = this._get(id, sid);
    const n = Number.isInteger(count) && count > 0 ? count : u.chunks.size;
    const missing = [];
    for (let i = 0; i < n; i++) if (!u.chunks.has(i)) missing.push(i);
    if (missing.length) throw new HttpError(409, 'Missing chunks', { missing: missing.slice(0, 20) });
    this.items.delete(id);
    const ordered = [];
    for (let i = 0; i < n; i++) ordered.push(u.chunks.get(i));
    return { chatId: u.chatId, fmt: u.fmt, chunks: ordered };
  }

  chatOf(id) {
    const u = this.items.get(id);
    return u ? u.chatId : null;
  }

  cancel(id, sid) {
    const u = this.items.get(id);
    if (u && u.sid === sid) this.items.delete(id);
  }

  sweep() {
    const now = Date.now();
    for (const [id, u] of this.items) if (now - u.at > TTL_MS) this.items.delete(id);
  }
}

module.exports = { Uploads };
