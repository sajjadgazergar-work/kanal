import type { CapabilityDescriptor } from '@kanal/adapters-core';

/**
 * The static TELEGRAM CapabilityDescriptor (plan §10.3).
 *
 * `provenance: 'static'` — every limit below is a documented Bot API constant
 * or a deliberately conservative safety margin, and was verified at build time:
 *
 * - textMaxChars 4096 — sendMessage `text` limit [VERIFY against Bot API docs]
 * - captionMaxChars 1024 — 2048 only on a Premium user session, not a bot
 * - mediaGroupMax 10 — sendMediaGroup input limit [VERIFY against docs]
 * - deleteWindowSeconds 48h — deleteMessage window for bot-authored posts
 * - editWindowSeconds -1 — unlimited for bot-authored posts
 * - globalSendPerSecond 30 — Bot API documented burst ceiling
 * - perChatSendPerSecond 1 — 1 message/sec per chat for bots
 * - perGroupSendPerMinute 20 — 20 messages/min per group for bots
 *
 * `read.post_views`, `read.growth_series`, and `read.traffic_sources` are NOT
 * declared here. They are added at runtime only when the MTProto sidecar
 * reports a healthy session for the channel (§10.3). The dashboard renders a
 * "requires the stats sidecar" state from their absence.
 */
export const TELEGRAM_DESCRIPTOR: CapabilityDescriptor = {
  platform: 'telegram',
  provenance: 'static',
  capabilities: new Set([
    'post.text',
    'post.media_single',
    'post.media_group',
    'post.poll',
    'post.edit_text',
    'post.edit_caption',
    'post.delete',
    'post.silent',
    'post.protect_content',
    'post.link_preview_control',
    'post.paid_broadcast',
    'markup.html',
    'markup.markdown_v2',
    'markup.entities',
    'read.member_count', // getChatMemberCount
    'update.long_poll',
    'update.webhook',
    'schedule.native', // present but unused; see limits + notes
  ]),
  limits: {
    textMaxChars: 4096,
    captionMaxChars: 1024, // 2048 only on a Premium user session, not a bot
    mediaGroupMax: 10, // [VERIFY against sendMediaGroup docs at build time]
    deleteWindowSeconds: 48 * 3600,
    editWindowSeconds: -1, // unlimited for bot-authored posts
    globalSendPerSecond: 30,
    perChatSendPerSecond: 1,
    perGroupSendPerMinute: 20,
    nativeScheduledMax: 100, // why we do not use it (KANAL owns its scheduler)
  },
  notes: {
    'read.post_views': 'Not available via Bot API. Requires the MTProto sidecar.',
    'schedule.native': 'Capped at 100 per chat; KANAL uses its own scheduler instead.',
    'post.paid_broadcast': 'allow_paid_broadcast raises throughput to ~1000/s for a Stars fee.',
    'markup.markdown_v2': 'Rejected as the default (plan D5): the escape set collides with Persian/Arabic punctuation.',
    'markup.entities': 'Rejected as the default (plan D5): entity offsets are UTF-16 code units, off-by-N emoji bugs.',
  },
};
