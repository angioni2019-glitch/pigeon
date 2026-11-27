'use strict';
const path = require('path');

function bool(v, def = false) {
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function load(env = process.env) {
  const demo = bool(env.DEMO);
  const cfg = {
    version: '0.1.0',
    host: env.HOST || '0.0.0.0',
    port: int(env.PORT, 8080),
    // Public base URL of this bridge, e.g. https://tg.example.com. Used for the
    // 2-step-verification page link shown on the watch. If unset, it is derived
    // from the request (Host / X-Forwarded-* when TRUST_PROXY=1).
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    trustProxy: bool(env.TRUST_PROXY, true),
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    demo,
    demo2fa: bool(env.DEMO_2FA),
    demoAutoLoginSec: int(env.DEMO_AUTO_LOGIN_SEC, 10),
    apiId: int(env.TG_API_ID, 0),
    apiHash: env.TG_API_HASH || '',
    tdjsonPath: env.TDJSON_PATH || '',
    tdlibVerbosity: int(env.TDLIB_VERBOSITY, 1),
    // Optional shared secret the watch must send when linking (app setting "Pairing key").
    pairingKey: env.PAIRING_KEY || '',
    // Optional comma-separated Telegram user ids allowed to use this bridge.
    allowedUserIds: new Set(
      String(env.ALLOWED_USER_IDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number),
    ),
    maxSessions: int(env.MAX_SESSIONS, 50),
    idleCloseMin: int(env.IDLE_CLOSE_MIN, 20),
    pendingLinkMin: int(env.PENDING_LINK_MIN, 15),
    staleSessionDays: int(env.STALE_SESSION_DAYS, 120),
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    voiceMaxSec: int(env.VOICE_MAX_SECONDS, 180),
    playbackMaxSec: int(env.PLAYBACK_MAX_SECONDS, 600),
    // Size of one binary audio part sent to the watch. Parts are cut on Ogg page
    // boundaries, so a part is never larger than this unless a single page is.
    partBytes: int(env.PART_BYTES, 6144),
    logLevel: env.LOG_LEVEL || 'info',
  };
  if (!demo && (!cfg.apiId || !cfg.apiHash)) {
    throw new Error('TG_API_ID and TG_API_HASH are required (get them at https://my.telegram.org). Set DEMO=1 to run without Telegram.');
  }
  return cfg;
}

module.exports = { load };
