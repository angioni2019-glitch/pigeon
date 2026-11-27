'use strict';
// Shared helpers that turn Telegram objects into the compact JSON the watch reads.
// Keys are short on purpose: every byte crosses Bluetooth and lands in watch RAM.

const { waveBars } = require('./audio');

// The six emoji the watch can draw (as vector icons) for reactions and quick emoji.
// Index order is shared with the watch app (Ui.mc: drawEmoji).
const EMOJI_SEND = ['\u{1F44D}', '❤️', '\u{1F601}', '\u{1F525}', '\u{1F622}', '\u{1F389}'];
const EMOJI_REACT = ['\u{1F44D}', '❤', '\u{1F601}', '\u{1F525}', '\u{1F622}', '\u{1F389}'];

function stripVs(s) {
  return String(s || '').replace(/️/g, '');
}

function emojiIndex(e) {
  const k = stripVs(e);
  return EMOJI_REACT.findIndex((x) => stripVs(x) === k);
}

function truncate(s, n) {
  const str = String(s ?? '');
  const chars = Array.from(str);
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : str;
}

function oneLine(s, n) {
  return truncate(String(s ?? '').replace(/\s+/g, ' ').trim(), n);
}

function initials(title) {
  const words = String(title || '')
    .split(/\s+/)
    .map((w) => (w.match(/[\p{L}\p{N}]/u) || [''])[0])
    .filter(Boolean);
  if (!words.length) return '?';
  return (words[0] + (words.length > 1 ? words[1] : '')).toUpperCase();
}

// Telegram's seven profile colors: red, orange, violet, green, cyan, blue, pink.
function colorIndex(idOrChat) {
  if (idOrChat && typeof idOrChat === 'object') {
    const a = idOrChat.accent_color_id;
    if (Number.isInteger(a) && a >= 0 && a < 7) return a;
    return colorIndex(idOrChat.id);
  }
  const n = Math.abs(Number(idOrChat) || 0);
  return n % 7;
}

function reactionList(interactionInfo) {
  if (!interactionInfo || !interactionInfo.reactions) return [];
  const r = interactionInfo.reactions;
  return Array.isArray(r) ? r : Array.isArray(r.reactions) ? r.reactions : [];
}

/** [[emojiIndex|-1, count, chosenByMe(0/1), rawEmojiIfUnknown?], ...] (max 4) */
function reactions(interactionInfo) {
  const out = [];
  for (const r of reactionList(interactionInfo)) {
    if (!r || !r.type || r.type._ !== 'reactionTypeEmoji') continue;
    const idx = emojiIndex(r.type.emoji);
    const entry = [idx, r.total_count || 1, r.is_chosen ? 1 : 0];
    if (idx < 0) entry.push(r.type.emoji);
    out.push(entry);
    if (out.length >= 4) break;
  }
  return out;
}

function captionOf(content) {
  return (content && content.caption && content.caption.text) || '';
}

function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof v.text === 'string') return v.text;
  return '';
}

const SERVICE = {
  messageChatAddMembers: 'joined the group',
  messageChatJoinByLink: 'joined via invite link',
  messageChatJoinByRequest: 'joined the group',
  messageChatDeleteMember: 'left the group',
  messageChatChangeTitle: 'changed the group name',
  messageChatChangePhoto: 'changed the group photo',
  messageChatDeletePhoto: 'removed the group photo',
  messagePinMessage: 'pinned a message',
  messageBasicGroupChatCreate: 'created the group',
  messageSupergroupChatCreate: 'created the group',
  messageContactRegistered: 'joined Telegram',
  messageScreenshotTaken: 'took a screenshot',
  messageChatSetMessageAutoDeleteTime: 'changed auto-delete timer',
  messageGiftedPremium: 'sent a gift',
  messageForumTopicCreated: 'created a topic',
};

/**
 * Describe message content for the watch.
 * @returns {{k:string, t?:string, d?:number, w?:string, tr?:string, nl?:number}}
 */
function describeContent(m) {
  const c = m.content || {};
  switch (c._) {
    case 'messageText':
      return withJumbo({ k: 'txt', t: textOf(c.text) });
    case 'messageVoiceNote': {
      const vn = c.voice_note || {};
      const out = { k: 'voice', d: vn.duration || 0, w: waveBars(vn.waveform, 24) };
      const cap = captionOf(c);
      if (cap) out.t = cap;
      const sr = vn.speech_recognition_result;
      if (sr) {
        if (sr._ === 'speechRecognitionResultText') out.tr = sr.text;
        else if (sr._ === 'speechRecognitionResultPending') out.tr = (sr.partial_text || '') + '…';
        else if (sr._ === 'speechRecognitionResultError') out.tr = '(transcription unavailable)';
      }
      if (!m.is_outgoing && c.is_listened === false) out.nl = 1;
      return out;
    }
    case 'messageAudio': {
      const a = c.audio || {};
      const title = [a.performer, a.title].filter(Boolean).join(' – ');
      return { k: 'audio', t: title || a.file_name || 'Audio', d: a.duration || 0, w: waveBars(null, 24) };
    }
    case 'messageVideoNote': {
      const out = { k: 'vnote', t: 'Video message', d: (c.video_note && c.video_note.duration) || 0, w: waveBars(c.video_note && c.video_note.waveform, 24) };
      if (!m.is_outgoing && c.is_viewed === false) out.nl = 1;
      return out;
    }
    case 'messagePhoto':
      return { k: 'photo', t: captionOf(c) || 'Photo' };
    case 'messageVideo':
      return { k: 'video', t: captionOf(c) || 'Video' };
    case 'messageAnimation':
      return { k: 'gif', t: captionOf(c) || 'GIF' };
    case 'messageSticker':
      return { k: 'sticker', t: `${(c.sticker && c.sticker.emoji) || ''} Sticker`.trim() };
    case 'messageAnimatedEmoji':
      return withJumbo({ k: 'txt', t: c.emoji || '' });
    case 'messageDice':
      return { k: 'txt', t: c.emoji || '' };
    case 'messageDocument':
      return { k: 'doc', t: (c.document && c.document.file_name) || captionOf(c) || 'File' };
    case 'messageLocation':
      return { k: 'loc', t: c.live_period ? 'Live location' : 'Location' };
    case 'messageVenue':
      return { k: 'loc', t: (c.venue && c.venue.title) || 'Location' };
    case 'messageContact': {
      const ct = c.contact || {};
      return { k: 'contact', t: [ct.first_name, ct.last_name].filter(Boolean).join(' ') || 'Contact' };
    }
    case 'messagePoll':
      return { k: 'poll', t: 'Poll: ' + textOf(c.poll && c.poll.question) };
    case 'messageCall':
      return { k: 'call', t: c.is_video ? 'Video call' : 'Call' };
    case 'messageStory':
      return { k: 'other', t: 'Story' };
    case 'messageGame':
      return { k: 'other', t: 'Game' };
    case 'messageInvoice':
      return { k: 'other', t: 'Invoice' };
    default:
      if (SERVICE[c._]) return { k: 'svc', t: SERVICE[c._] };
      return { k: 'other', t: 'Unsupported message' };
  }
}

// A message that is just one of the six watch emoji is drawn large (index in `e`).
function withJumbo(d) {
  const idx = emojiIndex(String(d.t || '').trim());
  if (idx >= 0) d.e = idx;
  return d;
}

function previewText(desc) {
  switch (desc.k) {
    case 'voice':
      return 'Voice message';
    case 'vnote':
      return 'Video message';
    default:
      return desc.t || '';
  }
}

module.exports = {
  EMOJI_SEND,
  EMOJI_REACT,
  stripVs,
  emojiIndex,
  truncate,
  oneLine,
  initials,
  colorIndex,
  reactions,
  reactionList,
  describeContent,
  previewText,
  textOf,
};
