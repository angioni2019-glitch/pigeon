'use strict';
// One Telegram account (one linked watch) backed by a TDLib client via `tdl`.
//
// Login uses Telegram's QR flow: requestQrCodeAuthentication -> TDLib gives a
// tg://login?token=... link (refreshed about every 30 s) that the user scans in
// Telegram on the phone (Settings > Devices > Link Desktop Device). If the
// account has 2-step verification, TDLib then waits for the cloud password.
//
// The TDLib database is encrypted with a key derived from the watch's token,
// which the bridge never stores. A copied disk alone can't open the session.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const F = require('../format');
const { HttpError } = require('../http');

let tdl = null;
function loadTdl(cfg) {
  if (tdl) return tdl;
  // eslint-disable-next-line global-require
  tdl = require('tdl');
  let tdjson = cfg.tdjsonPath;
  if (!tdjson) {
    try {
      // eslint-disable-next-line global-require
      tdjson = require('prebuilt-tdlib').getTdjson();
    } catch {
      tdjson = ''; // fall back to a system-wide libtdjson
    }
  }
  const conf = { verbosityLevel: cfg.tdlibVerbosity };
  if (tdjson) conf.tdjson = tdjson;
  tdl.configure(conf);
  return tdl;
}

// Updates that change what the watch shows for one chat.
const CHAT_UPDATES = new Set([
  'updateNewMessage',
  'updateMessageSendSucceeded',
  'updateMessageSendFailed',
  'updateMessageContent',
  'updateMessageEdited',
  'updateMessageInteractionInfo',
  'updateMessageContentOpened',
  'updateDeleteMessages',
  'updateChatReadInbox',
  'updateChatReadOutbox',
  'updateChatLastMessage',
  'updateChatPosition',
  'updateChatTitle',
  'updateChatNotificationSettings',
  'updateChatUnreadReactionCount',
]);

class TelegramAccount extends EventEmitter {
  constructor({ sid, dir, dbKey, cfg, log }) {
    super();
    this.sid = sid;
    this.dir = dir;
    this.dbKey = dbKey;
    this.cfg = cfg;
    this.log = log;
    this.client = null;
    this.authState = 'starting';
    this.authError = null;
    this.qrLink = null;
    this.pwHint = '';
    this.me = null;
    this.loginRequested = false;
    this.version = 1;
    this.chatVersions = new Map();
    this.unreadChats = 0;
    this.openChats = new Map(); // chatId -> close timer
    this.outgoingFiles = new Map(); // temp message id -> local file to delete after upload
    this.waiters = [];
    this.closed = false;
  }

  start() {
    const t = loadTdl(this.cfg);
    fs.mkdirSync(this.dir, { recursive: true });
    const databaseDirectory = path.join(this.dir, 'db');
    const filesDirectory = path.join(this.dir, 'files');
    const params = {
      use_message_database: true,
      use_chat_info_database: true,
      use_file_database: true,
      use_secret_chats: false,
      system_language_code: 'en',
      application_version: `Pigeon ${this.cfg.version}`,
      device_model: 'Garmin watch',
      system_version: 'Connect IQ',
      // Repeated here in case the tdl version in use doesn't merge them in.
      api_id: this.cfg.apiId,
      api_hash: this.cfg.apiHash,
      database_directory: databaseDirectory,
      files_directory: filesDirectory,
      database_encryption_key: this.dbKey,
      use_test_dc: false,
    };
    this.client = t.createClient({
      apiId: this.cfg.apiId,
      apiHash: this.cfg.apiHash,
      databaseDirectory,
      filesDirectory,
      databaseEncryptionKey: this.dbKey,
      tdlibParameters: params,
    });
    this.client.on('update', (u) => {
      try {
        this._onUpdate(u);
      } catch (e) {
        this.log.warn(`[${this.sid}] update handler failed`, e);
      }
    });
    this.client.on('error', (e) => this.log.warn(`[${this.sid}] tdl error`, e));
    this.client.on('close', () => {
      this.closed = true;
      this._wake();
      this.emit('closed');
    });
  }

  invoke(q) {
    if (!this.client || this.closed) return Promise.reject(new HttpError(503, 'Session closed'));
    return this.client.invoke(q).catch((e) => {
      const code = e && typeof e.code === 'number' ? e.code : 500;
      const msg = (e && e.message) || 'Telegram error';
      if (code === 401) throw new HttpError(401, 'Telegram session ended');
      if (code === 429 || /FLOOD/.test(msg)) throw new HttpError(429, 'Too many requests, try again later');
      if (code === 400 || code === 403 || code === 404) throw new HttpError(code === 404 ? 404 : 400, msg);
      throw new HttpError(502, msg);
    });
  }

  // ---- auth ---------------------------------------------------------------

  requestLogin() {
    this.loginRequested = true;
    if (this.authState === 'authorizationStateWaitPhoneNumber') this._requestQr();
  }

  _requestQr() {
    this.client
      .invoke({ _: 'requestQrCodeAuthentication', other_user_ids: [] })
      .catch((e) => {
        this.authError = `Could not start QR login: ${e.message}`;
        this.log.warn(`[${this.sid}] requestQrCodeAuthentication failed`, e.message);
      });
  }

  _onAuth(s) {
    this.authState = s._;
    switch (s._) {
      case 'authorizationStateWaitPhoneNumber':
        this.qrLink = null;
        if (this.loginRequested) this._requestQr();
        break;
      case 'authorizationStateWaitOtherDeviceConfirmation':
        this.qrLink = s.link;
        break;
      case 'authorizationStateWaitPassword':
        this.qrLink = null;
        this.pwHint = s.password_hint || '';
        break;
      case 'authorizationStateReady':
        this.qrLink = null;
        this._onReady();
        break;
      case 'authorizationStateWaitCode':
      case 'authorizationStateWaitEmailAddress':
      case 'authorizationStateWaitEmailCode':
      case 'authorizationStateWaitRegistration':
        this.authError = 'This account needs a sign-in step the watch cannot do. Sign in to Telegram on your phone first.';
        break;
      case 'authorizationStateLoggingOut':
      case 'authorizationStateClosing':
      case 'authorizationStateClosed':
        this.me = null;
        this.emit('loggedOut');
        break;
      default:
        break;
    }
    this._wake();
  }

  async _onReady() {
    try {
      const me = await this.client.invoke({ _: 'getMe' });
      const name = [me.first_name, me.last_name].filter(Boolean).join(' ') || 'Telegram user';
      if (this.cfg.allowedUserIds.size && !this.cfg.allowedUserIds.has(Number(me.id))) {
        this.authError = 'This bridge is private and your account is not on its allow list.';
        this.log.warn(`[${this.sid}] user ${me.id} not in ALLOWED_USER_IDS, logging out`);
        await this.client.invoke({ _: 'logOut' }).catch(() => {});
        return;
      }
      this.me = { id: me.id, name };
      this.emit('ready', this.me);
    } catch (e) {
      this.log.warn(`[${this.sid}] getMe failed`, e.message);
    }
    this._wake();
  }

  _wake() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((fn) => fn());
  }

  /** Resolve when logged in and ready; reject with 503 on timeout, 401 when logged out. */
  ready(timeoutMs = 20000) {
    const check = () => {
      if (this.me && this.authState === 'authorizationStateReady') return true;
      if (this.closed || /LoggingOut|Closing|Closed/.test(this.authState)) throw new HttpError(401, 'Not logged in');
      if (this.authState === 'authorizationStateWaitPhoneNumber' || this.authState === 'authorizationStateWaitOtherDeviceConfirmation' || this.authState === 'authorizationStateWaitPassword') {
        throw new HttpError(409, 'Not linked yet');
      }
      return false;
    };
    try {
      if (check()) return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new HttpError(503, 'Telegram is still starting')), timeoutMs);
      const loop = () => {
        try {
          if (check()) {
            clearTimeout(timer);
            resolve();
          } else this.waiters.push(loop);
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      };
      this.waiters.push(loop);
    });
  }

  authInfo() {
    if (this.authError) return { st: 'error', err: this.authError };
    switch (this.authState) {
      case 'authorizationStateWaitOtherDeviceConfirmation':
        return this.qrLink ? { st: 'qr', link: this.qrLink } : { st: 'wait' };
      case 'authorizationStateWaitPassword':
        return { st: 'pwd', hint: this.pwHint };
      case 'authorizationStateReady':
        return this.me ? { st: 'ready', me: this.me.name } : { st: 'wait' };
      case 'authorizationStateLoggingOut':
      case 'authorizationStateClosing':
      case 'authorizationStateClosed':
        return { st: 'closed' };
      case 'authorizationStateWaitPhoneNumber':
        if (!this.loginRequested) return { st: 'closed' };
        return { st: 'wait' };
      default:
        return { st: 'wait' };
    }
  }

  async checkPassword(password) {
    if (this.authState !== 'authorizationStateWaitPassword') throw new HttpError(409, 'No password requested');
    try {
      await this.client.invoke({ _: 'checkAuthenticationPassword', password: String(password) });
    } catch (e) {
      const msg = e && e.message ? e.message : '';
      if (/PASSWORD_HASH_INVALID/i.test(msg)) throw new HttpError(403, 'Wrong password');
      if (/FLOOD/i.test(msg)) throw new HttpError(429, 'Too many attempts, wait a bit');
      throw new HttpError(400, msg || 'Password check failed');
    }
  }

  async logout() {
    if (!this.client || this.closed) return;
    await this.client.invoke({ _: 'logOut' }).catch(() => {});
  }

  async close() {
    for (const t of this.openChats.values()) clearTimeout(t);
    this.openChats.clear();
    if (this.client && !this.closed) await this.client.close().catch(() => {});
  }

  // ---- change tracking -----------------------------------------------------

  _bump(chatId) {
    this.version++;
    if (chatId != null) this.chatVersions.set(String(chatId), this.version);
  }

  _onUpdate(u) {
    switch (u._) {
      case 'updateAuthorizationState':
        this._onAuth(u.authorization_state);
        return;
      case 'updateUnreadChatCount':
        if (u.chat_list && u.chat_list._ === 'chatListMain') {
          this.unreadChats = u.unread_unmuted_count ?? u.unread_count ?? 0;
          this.version++;
        }
        return;
      case 'updateMessageSendSucceeded':
      case 'updateMessageSendFailed': {
        const f = this.outgoingFiles.get(u.old_message_id);
        if (f) {
          this.outgoingFiles.delete(u.old_message_id);
          fs.rm(f, { force: true }, () => {});
        }
        break;
      }
      default:
        break;
    }
    if (CHAT_UPDATES.has(u._)) {
      const chatId = u.chat_id ?? (u.message && u.message.chat_id);
      this._bump(chatId);
    }
  }

  versions(chatId) {
    return {
      v: this.version,
      cv: chatId ? this.chatVersions.get(String(chatId)) || 0 : 0,
      u: this.unreadChats,
    };
  }

  // ---- reading -------------------------------------------------------------

  static isBroadcastChannel(chat) {
    return chat.type && chat.type._ === 'chatTypeSupergroup' && chat.type.is_channel;
  }

  static isGroup(chat) {
    return chat.type && (chat.type._ === 'chatTypeBasicGroup' || chat.type._ === 'chatTypeSupergroup');
  }

  _chatTitle(chat) {
    if (chat.type && chat.type._ === 'chatTypePrivate' && this.me && chat.type.user_id === this.me.id) return 'Saved Messages';
    return chat.title || 'Deleted account';
  }

  async _senderName(senderId) {
    if (!senderId) return '';
    try {
      if (senderId._ === 'messageSenderUser') {
        const u = await this.invoke({ _: 'getUser', user_id: senderId.user_id });
        return u.first_name || u.last_name || 'User';
      }
      if (senderId._ === 'messageSenderChat') {
        const c = await this.invoke({ _: 'getChat', chat_id: senderId.chat_id });
        return c.title || '';
      }
    } catch {
      /* ignore */
    }
    return '';
  }

  static senderKey(senderId) {
    if (!senderId) return 0;
    return senderId.user_id ?? senderId.chat_id ?? 0;
  }

  static status(m, chat) {
    if (m.sending_state) return m.sending_state._ === 'messageSendingStateFailed' ? -1 : 0;
    return chat && m.id <= (chat.last_read_outbox_message_id || 0) ? 2 : 1;
  }

  static isMuted(chat) {
    const ns = chat.notification_settings;
    return !!(ns && !ns.use_default_mute_for && ns.mute_for > 0);
  }

  async listChats(limit) {
    const want = Math.max(1, Math.min(25, limit || 20));
    const res = await this.invoke({ _: 'getChats', chat_list: { _: 'chatListMain' }, limit: want + 15 });
    const chats = await Promise.all((res.chat_ids || []).map((id) => this.invoke({ _: 'getChat', chat_id: id }).catch(() => null)));
    const out = [];
    for (const chat of chats) {
      if (!chat) continue;
      // Broadcast channels are left out on purpose: Telegram's API terms require
      // clients that show channel posts to show sponsored messages too.
      if (TelegramAccount.isBroadcastChannel(chat)) continue;
      if (chat.type && chat.type._ === 'chatTypeSecret') continue;
      out.push(await this._formatChat(chat));
      if (out.length >= want) break;
    }
    return out;
  }

  async _formatChat(chat) {
    const group = TelegramAccount.isGroup(chat);
    const title = this._chatTitle(chat);
    const lm = chat.last_message;
    let m = null;
    if (lm) {
      const d = F.describeContent(lm);
      let t = F.previewText(d);
      if (group && !lm.is_outgoing) {
        const who = await this._senderName(lm.sender_id);
        if (who) t = `${who}: ${t}`;
      }
      m = { t: F.oneLine(t, 80), k: d.k, o: lm.is_outgoing ? 1 : 0, ts: lm.date };
      if (lm.is_outgoing) m.st = TelegramAccount.status(lm, chat);
    }
    return {
      id: String(chat.id),
      t: F.truncate(title, 48),
      i: F.initials(title),
      c: F.colorIndex(chat),
      u: chat.unread_count || 0,
      mu: TelegramAccount.isMuted(chat) ? 1 : 0,
      g: group ? 1 : 0,
      m,
    };
  }

  _keepOpen(chatId) {
    const key = String(chatId);
    const prev = this.openChats.get(key);
    if (prev) clearTimeout(prev);
    else this.invoke({ _: 'openChat', chat_id: Number(chatId) }).catch(() => {});
    this.openChats.set(
      key,
      setTimeout(() => {
        this.openChats.delete(key);
        this.invoke({ _: 'closeChat', chat_id: Number(chatId) }).catch(() => {});
      }, 90 * 1000),
    );
  }

  async history(chatId, limit, beforeId, markRead) {
    const chat_id = Number(chatId);
    const n = Math.max(1, Math.min(20, limit || 12));
    const chat = await this.invoke({ _: 'getChat', chat_id });
    if (TelegramAccount.isBroadcastChannel(chat)) throw new HttpError(404, 'Channels are not supported');
    if (markRead) this._keepOpen(chat_id);
    const before = beforeId ? Number(beforeId) : 0;
    const seen = new Set();
    const msgs = [];
    let from = before;
    for (let attempt = 0; attempt < 5 && msgs.length < n; attempt++) {
      // TDLib may return fewer messages than asked (only what's cached), so loop.
      const res = await this.invoke({ _: 'getChatHistory', chat_id, from_message_id: from, offset: 0, limit: Math.min(50, n - msgs.length + 1), only_local: false });
      const list = (res && res.messages) || [];
      let added = 0;
      for (const m of list) {
        if (!m || seen.has(m.id) || (before && m.id >= before)) continue;
        seen.add(m.id);
        msgs.push(m);
        added++;
      }
      if (!list.length) break;
      from = list[list.length - 1].id;
      if (!added && list.length <= 1) break;
    }
    msgs.sort((a, b) => (a.date - b.date) || (a.id - b.id));
    const page = msgs.slice(-n);
    const group = TelegramAccount.isGroup(chat);
    const out = [];
    for (const m of page) out.push(await this._formatMessage(m, chat, group));
    if (markRead && page.length) {
      this.invoke({
        _: 'viewMessages',
        chat_id,
        message_ids: page.map((m) => m.id),
        source: { _: 'messageSourceChatHistory' },
        force_read: true,
      }).catch(() => {});
    }
    return { t: F.truncate(this._chatTitle(chat), 48), g: group ? 1 : 0, more: msgs.length >= n ? 1 : 0, msgs: out };
  }

  async _formatMessage(m, chat, group) {
    const d = F.describeContent(m);
    const r = { id: String(m.id), o: m.is_outgoing ? 1 : 0, ts: m.date, k: d.k };
    if (d.t) r.t = F.truncate(d.t, 700);
    if (d.e != null) r.e = d.e;
    if (d.d != null) r.d = d.d;
    if (d.w) r.w = d.w;
    if (d.tr) r.tr = F.truncate(d.tr, 500);
    if (d.nl) r.nl = 1;
    if (group && !m.is_outgoing) {
      r.s = F.truncate(await this._senderName(m.sender_id), 24);
      r.sc = F.colorIndex(TelegramAccount.senderKey(m.sender_id));
    }
    if (m.is_outgoing) r.st = TelegramAccount.status(m, chat);
    const rx = F.reactions(m.interaction_info);
    if (rx.length) r.r = rx;
    return r;
  }

  async messageInfo(chatId, msgId) {
    const chat = await this.invoke({ _: 'getChat', chat_id: Number(chatId) });
    const m = await this.invoke({ _: 'getMessage', chat_id: Number(chatId), message_id: Number(msgId) });
    return this._formatMessage(m, chat, TelegramAccount.isGroup(chat));
  }

  // ---- writing ---------------------------------------------------------------

  async sendText(chatId, text) {
    const t = String(text || '').slice(0, 4096);
    if (!t.trim()) throw new HttpError(400, 'Empty message');
    const msg = await this.invoke({
      _: 'sendMessage',
      chat_id: Number(chatId),
      input_message_content: { _: 'inputMessageText', text: { _: 'formattedText', text: t } },
    });
    return { id: String(msg.id) };
  }

  async sendEmoji(chatId, idx) {
    const e = F.EMOJI_SEND[idx];
    if (!e) throw new HttpError(400, 'Unknown emoji');
    return this.sendText(chatId, e);
  }

  async toggleReaction(chatId, msgId, idx) {
    const emoji = F.EMOJI_REACT[idx];
    if (!emoji) throw new HttpError(400, 'Unknown reaction');
    const chat_id = Number(chatId);
    const message_id = Number(msgId);
    const m = await this.invoke({ _: 'getMessage', chat_id, message_id });
    const mine = F.reactionList(m.interaction_info).some(
      (r) => r && r.is_chosen && r.type && r.type._ === 'reactionTypeEmoji' && F.stripVs(r.type.emoji) === F.stripVs(emoji),
    );
    const reaction_type = { _: 'reactionTypeEmoji', emoji };
    if (mine) await this.invoke({ _: 'removeMessageReaction', chat_id, message_id, reaction_type });
    else await this.invoke({ _: 'addMessageReaction', chat_id, message_id, reaction_type, is_big: false, update_recent_reactions: true });
    return { on: mine ? 0 : 1 };
  }

  // Shows "recording voice message..." to the other side, like official apps.
  chatAction(chatId, kind) {
    const action = kind === 'voice' ? { _: 'chatActionRecordingVoiceNote' } : kind === 'upload' ? { _: 'chatActionUploadingVoiceNote', progress: 0 } : { _: 'chatActionCancel' };
    this.invoke({ _: 'sendChatAction', chat_id: Number(chatId), message_thread_id: 0, action }).catch(() => {});
  }

  async transcribe(chatId, msgId) {
    // Telegram's own speech recognition (Premium, or a few free trials a week).
    await this.invoke({ _: 'recognizeSpeech', chat_id: Number(chatId), message_id: Number(msgId) });
    return { ok: 1 };
  }

  /** Download a playable message (voice, audio, video message); returns a local path. */
  async mediaFile(chatId, msgId) {
    const chat_id = Number(chatId);
    const message_id = Number(msgId);
    const m = await this.invoke({ _: 'getMessage', chat_id, message_id });
    const c = m.content || {};
    let file;
    let duration = 0;
    if (c._ === 'messageVoiceNote') {
      file = c.voice_note.voice;
      duration = c.voice_note.duration;
    } else if (c._ === 'messageAudio') {
      file = c.audio.audio;
      duration = c.audio.duration;
    } else if (c._ === 'messageVideoNote') {
      file = c.video_note.video;
      duration = c.video_note.duration;
    } else {
      throw new HttpError(404, 'This message has no audio');
    }
    if (file.size && file.size > 40 * 1024 * 1024) throw new HttpError(413, 'File too large for the watch');
    const f = await this.invoke({ _: 'downloadFile', file_id: file.id, priority: 32, offset: 0, limit: 0, synchronous: true });
    if (!f.local || !f.local.is_downloading_completed || !f.local.path) throw new HttpError(502, 'Download failed');
    // Mark as listened/viewed, exactly like opening it in a Telegram app would.
    this.invoke({ _: 'openMessageContent', chat_id, message_id }).catch(() => {});
    return {
      path: f.local.path,
      duration,
      // Called after transcoding: drop TDLib's plaintext copy from disk.
      cleanup: () => this.invoke({ _: 'deleteFile', file_id: file.id }).catch(() => {}),
    };
  }

  async sendVoice(chatId, oggPath, durationSec, waveform) {
    const msg = await this.invoke({
      _: 'sendMessage',
      chat_id: Number(chatId),
      input_message_content: {
        _: 'inputMessageVoiceNote',
        voice_note: { _: 'inputFileLocal', path: oggPath },
        duration: durationSec,
        waveform: waveform.toString('base64'),
      },
    });
    this.outgoingFiles.set(msg.id, oggPath);
    return { id: String(msg.id) };
  }
}

module.exports = {
  TelegramAccount,
  // Tests inject a fake `tdl` module (the real one needs the TDLib binary).
  __setTdlForTests: (fake) => {
    tdl = fake;
  },
};
