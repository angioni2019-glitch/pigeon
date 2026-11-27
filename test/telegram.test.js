'use strict';
// TelegramAccount against a scripted fake of TDLib's JSON interface.
// Checks the QR/2FA state machine and how TDLib objects become watch JSON.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tg = require('../src/backend/telegram');

const ME = 77;
const chats = {
  10: { id: 10, title: 'Anna', type: { _: 'chatTypePrivate', user_id: 10 }, unread_count: 2, accent_color_id: 3, last_read_outbox_message_id: 3 << 20, notification_settings: { use_default_mute_for: true, mute_for: 0 } },
  [-20]: { id: -20, title: 'Runners', type: { _: 'chatTypeSupergroup', supergroup_id: 20, is_channel: false }, unread_count: 0, notification_settings: { use_default_mute_for: false, mute_for: 3600 } },
  [-30]: { id: -30, title: 'News channel', type: { _: 'chatTypeSupergroup', supergroup_id: 30, is_channel: true }, unread_count: 9 },
  40: { id: 40, title: 'Secret', type: { _: 'chatTypeSecret', secret_chat_id: 1, user_id: 10 } },
  [ME]: { id: ME, title: 'Me Myself', type: { _: 'chatTypePrivate', user_id: ME } },
};
const users = { 10: { id: 10, first_name: 'Anna', last_name: 'K' }, 11: { id: 11, first_name: 'Marek' }, [ME]: { id: ME, first_name: 'Me', last_name: 'Myself' } };
const msg = (chatId, n, extra) => ({ id: n << 20, chat_id: chatId, date: 1700000000 + n, is_outgoing: false, sender_id: { _: 'messageSenderUser', user_id: 10 }, content: { _: 'messageText', text: { _: 'formattedText', text: `m${n}` } }, ...extra });
const history = {
  10: [
    msg(10, 1),
    msg(10, 2, { is_outgoing: true, sender_id: { _: 'messageSenderUser', user_id: ME } }),
    msg(10, 3, { is_outgoing: true, sender_id: { _: 'messageSenderUser', user_id: ME }, interaction_info: { reactions: { reactions: [{ type: { _: 'reactionTypeEmoji', emoji: '❤' }, total_count: 1, is_chosen: true }] } } }),
    msg(10, 4, { content: { _: 'messageVoiceNote', is_listened: false, voice_note: { duration: 5, waveform: Buffer.alloc(63, 0xff).toString('base64'), voice: { id: 555, size: 1000 } } } }),
    msg(10, 5, { content: { _: 'messagePhoto', caption: { text: '' } } }),
  ],
  [-20]: [msg(-20, 1, { sender_id: { _: 'messageSenderUser', user_id: 11 } })],
};
for (const id of Object.keys(chats)) chats[id].last_message = (history[id] || []).slice(-1)[0];

function makeFakeTdl(calls) {
  return {
    configure() {},
    createClient() {
      const c = new EventEmitter();
      const emitAuth = (s) => setImmediate(() => c.emit('update', { _: 'updateAuthorizationState', authorization_state: s }));
      c.invoke = async (q) => {
        calls.push(q);
        switch (q._) {
          case 'requestQrCodeAuthentication':
            emitAuth({ _: 'authorizationStateWaitOtherDeviceConfirmation', link: 'tg://login?token=abc' });
            return { _: 'ok' };
          case 'checkAuthenticationPassword':
            if (q.password !== 'secret') {
              const e = new Error('PASSWORD_HASH_INVALID');
              e.code = 400;
              throw e;
            }
            emitAuth({ _: 'authorizationStateReady' });
            return { _: 'ok' };
          case 'getMe':
            return users[ME];
          case 'getChats':
            return { chat_ids: [10, -30, -20, 40, ME] };
          case 'getChat':
            return chats[q.chat_id];
          case 'getUser':
            return users[q.user_id];
          case 'getChatHistory': {
            // TDLib semantics: newest first, starting at from_message_id (inclusive) or the last message.
            const all = [...(history[q.chat_id] || [])].reverse();
            const start = q.from_message_id ? all.findIndex((m) => m.id <= q.from_message_id) : 0;
            // Return at most 2 per call to exercise the accumulation loop.
            return { messages: start < 0 ? [] : all.slice(start, start + Math.min(2, q.limit)) };
          }
          case 'getMessage':
            return history[q.chat_id].find((m) => m.id === q.message_id);
          case 'sendMessage':
            return { id: 999 << 20, chat_id: q.chat_id };
          case 'downloadFile':
            return { id: q.file_id, local: { path: '/tmp/voice.oga', is_downloading_completed: true } };
          case 'logOut':
            emitAuth({ _: 'authorizationStateLoggingOut' });
            emitAuth({ _: 'authorizationStateClosed' });
            return { _: 'ok' };
          default:
            return { _: 'ok' };
        }
      };
      c.close = async () => c.emit('close');
      emitAuth({ _: 'authorizationStateWaitPhoneNumber' });
      return c;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('QR login, 2FA, ready, chat list, history, actions, logout', async () => {
  const calls = [];
  tg.__setTdlForTests(makeFakeTdl(calls));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigeon-tg-'));
  const cfg = { apiId: 1, apiHash: 'x', version: 't', tdlibVerbosity: 0, allowedUserIds: new Set() };
  const log = { info() {}, warn() {}, debug() {}, error() {} };
  const acct = new tg.TelegramAccount({ sid: 's1', dir, dbKey: 'a2V5', cfg, log });
  acct.start();
  await tick();
  assert.deepStrictEqual(acct.authInfo(), { st: 'closed' }, 'not linking until asked');
  acct.requestLogin();
  await tick();
  assert.deepStrictEqual(acct.authInfo(), { st: 'qr', link: 'tg://login?token=abc' });
  await assert.rejects(acct.ready(50), (e) => e.status === 409);

  // Phone scanned the QR; account has a cloud password.
  acct.client.emit('update', { _: 'updateAuthorizationState', authorization_state: { _: 'authorizationStateWaitPassword', password_hint: 'pet' } });
  assert.deepStrictEqual(acct.authInfo(), { st: 'pwd', hint: 'pet' });
  await assert.rejects(acct.checkPassword('wrong'), (e) => e.status === 403);
  await acct.checkPassword('secret');
  await tick(); // TDLib reports authorizationStateReady asynchronously
  await acct.ready(500);
  assert.deepStrictEqual(acct.authInfo(), { st: 'ready', me: 'Me Myself' });

  const list = await acct.listChats(20);
  assert.deepStrictEqual(list.map((c) => c.t), ['Anna', 'Runners', 'Saved Messages'], 'channel and secret chat skipped');
  const anna = list[0];
  assert.strictEqual(anna.id, '10');
  assert.strictEqual(anna.c, 3);
  assert.strictEqual(anna.u, 2);
  assert.strictEqual(anna.m.t, 'Photo');
  assert.strictEqual(list[1].mu, 1);
  assert.strictEqual(list[1].m.t, 'Marek: m1');

  const h = await acct.history('10', 4, null, true);
  assert.deepStrictEqual(h.msgs.map((m) => m.id), [2, 3, 4, 5].map((n) => String(n << 20)));
  assert.strictEqual(h.more, 1);
  const [m2, m3, m4] = h.msgs;
  assert.strictEqual(m2.st, 2, 'read by the other side (id <= last_read_outbox)');
  assert.deepStrictEqual(m3.r, [[1, 1, 1]]);
  assert.strictEqual(m4.k, 'voice');
  assert.strictEqual(m4.w, '999999999999999999999999');
  assert.strictEqual(m4.nl, 1);
  const viewed = calls.find((q) => q._ === 'viewMessages');
  assert.ok(viewed && viewed.force_read && viewed.message_ids.length === 4 && viewed.source._ === 'messageSourceChatHistory');
  assert.ok(calls.some((q) => q._ === 'openChat' && q.chat_id === 10));

  const older = await acct.history('10', 10, String(2 << 20), false);
  assert.deepStrictEqual(older.msgs.map((m) => m.id), [String(1 << 20)]);

  // Reaction toggling: heart is already mine -> remove; thumbs up -> add.
  await acct.toggleReaction('10', String(3 << 20), 1);
  assert.strictEqual(calls[calls.length - 1]._, 'removeMessageReaction');
  await acct.toggleReaction('10', String(3 << 20), 0);
  const add = calls[calls.length - 1];
  assert.strictEqual(add._, 'addMessageReaction');
  assert.deepStrictEqual(add.reaction_type, { _: 'reactionTypeEmoji', emoji: '\u{1F44D}' });

  const sent = await acct.sendText('10', 'hi');
  assert.strictEqual(sent.id, String(999 << 20));
  const sm = calls.find((q) => q._ === 'sendMessage');
  assert.deepStrictEqual(sm.input_message_content, { _: 'inputMessageText', text: { _: 'formattedText', text: 'hi' } });

  const media = await acct.mediaFile('10', String(4 << 20));
  assert.strictEqual(media.path, '/tmp/voice.oga');
  await tick();
  assert.ok(calls.some((q) => q._ === 'openMessageContent'), 'voice marked as listened');
  media.cleanup();
  await tick();
  assert.ok(calls.some((q) => q._ === 'deleteFile' && q.file_id === 555));
  await assert.rejects(acct.mediaFile('10', String(1 << 20)), (e) => e.status === 404);

  const voice = await acct.sendVoice('10', '/tmp/x.ogg', 4, Buffer.alloc(63, 1));
  const vm = calls.filter((q) => q._ === 'sendMessage').pop();
  assert.strictEqual(vm.input_message_content._, 'inputMessageVoiceNote');
  assert.strictEqual(vm.input_message_content.duration, 4);
  assert.strictEqual(vm.input_message_content.waveform, Buffer.alloc(63, 1).toString('base64'));
  assert.ok(voice.id);

  acct.chatAction('10', 'voice');
  await tick();
  const ca = calls.filter((q) => q._ === 'sendChatAction').pop();
  assert.deepStrictEqual(ca.action, { _: 'chatActionRecordingVoiceNote' });

  const v0 = acct.versions('10');
  acct.client.emit('update', { _: 'updateNewMessage', message: { chat_id: 10, id: 1 } });
  const v1 = acct.versions('10');
  assert.ok(v1.v > v0.v && v1.cv > v0.cv);

  await acct.logout();
  await tick();
  assert.deepStrictEqual(acct.authInfo(), { st: 'closed' });
  await assert.rejects(acct.ready(50), (e) => e.status === 401);
  await acct.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('allow list rejects other accounts', async () => {
  const calls = [];
  tg.__setTdlForTests(makeFakeTdl(calls));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigeon-tg-'));
  const cfg = { apiId: 1, apiHash: 'x', version: 't', tdlibVerbosity: 0, allowedUserIds: new Set([123]) };
  const acct = new tg.TelegramAccount({ sid: 's2', dir, dbKey: 'a2V5', cfg, log: { info() {}, warn() {}, debug() {}, error() {} } });
  acct.start();
  acct.requestLogin();
  await tick();
  acct.client.emit('update', { _: 'updateAuthorizationState', authorization_state: { _: 'authorizationStateReady' } });
  await tick();
  await tick();
  assert.strictEqual(acct.authInfo().st, 'error');
  assert.ok(calls.some((q) => q._ === 'logOut'));
  await acct.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
