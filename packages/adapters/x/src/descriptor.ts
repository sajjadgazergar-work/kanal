import type { CapabilityDescriptor } from '@kanal/adapters-core';

/**
 * X (Twitter) stub descriptor (plan §10.8).
 *
 * Official API tiers. Hard per-tier posting quotas dominate the design;
 * `post.edit_text` is absent (delete + repost instead). Requires OAuth, which
 * is a new secret lifecycle KANAL does not have in V1 (§16.4 Platform #5).
 * Uncertain fields marked [VERIFY].
 */
export const X_DESCRIPTOR: CapabilityDescriptor = {
  platform: 'x',
  provenance: 'static',
  capabilities: new Set([
    'post.text',
    'post.media_single',
    'post.media_group', // [VERIFY] X allows up to 4 images
    'post.poll', // [VERIFY]
    'post.delete', // yes — delete + repost replaces edit (§10.7)
    'post.silent', // [VERIFY]
    'post.protect_content', // [VERIFY]
    'markup.none',
    'read.member_count', // [VERIFY] follower count via API
    'read.post_views', // [VERIFY] impressions via API
    'update.long_poll', // [VERIFY] streaming/API tiers
    'update.webhook', // [VERIFY]
  ]),
  limits: {
    textMaxChars: 280, // standard tier; 10k on Premium+ [VERIFY]
    captionMaxChars: 0, // no caption concept on X
    mediaGroupMax: 4, // [VERIFY]
    deleteWindowSeconds: -1, // [VERIFY]
    editWindowSeconds: null, // no edit — delete + repost (§10.7)
    globalSendPerSecond: 1, // [VERIFY] hard per-tier posting quotas
    perChatSendPerSecond: 1, // [VERIFY]
    perGroupSendPerMinute: null, // [VERIFY]
    nativeScheduledMax: null, // [VERIFY]
  },
  notes: {
    'post.edit_text': 'Absent on X; edit is delete + repost with a fresh revision (§10.7).',
    'markup.none': 'X is plain text; no markup modes.',
  },
};
