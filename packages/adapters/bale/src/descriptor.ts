import type { CapabilityDescriptor } from '@kanal/adapters-core';

/**
 * Bale stub descriptor (plan §10.8).
 *
 * Bale is Telegram-shaped (same Bot API family) but a different platform, so
 * the descriptor starts as "Telegram minus paid broadcast" and every uncertain
 * field is marked [VERIFY] — the seam that a probe must resolve before M1.
 */
export const BALE_DESCRIPTOR: CapabilityDescriptor = {
  platform: 'bale',
  provenance: 'static',
  capabilities: new Set([
    'post.text',
    'post.media_single',
    'post.media_group',
    'post.poll',
    'post.edit_text', // expected yes [VERIFY]
    'post.edit_caption', // [VERIFY]
    'post.delete', // [VERIFY]
    'post.silent',
    'post.protect_content',
    'post.link_preview_control',
    'markup.html', // [VERIFY] Bale accepts HTML parse_mode
    'markup.none',
    'read.member_count', // [VERIFY]
    'update.long_poll', // expected similar to Telegram [VERIFY]
    'update.webhook', // [VERIFY]
  ]),
  limits: {
    textMaxChars: 4096, // [VERIFY] Telegram-shaped
    captionMaxChars: 1024, // [VERIFY]
    mediaGroupMax: 10, // [VERIFY]
    deleteWindowSeconds: 48 * 3600, // [VERIFY]
    editWindowSeconds: -1, // [VERIFY]
    globalSendPerSecond: 30, // [VERIFY]
    perChatSendPerSecond: 1, // [VERIFY]
    perGroupSendPerMinute: 20, // [VERIFY]
    nativeScheduledMax: null, // [VERIFY]
  },
  notes: {
    'post.paid_broadcast': 'Assumed absent on Bale; paid broadcast is a Telegram Stars concept.',
  },
};
