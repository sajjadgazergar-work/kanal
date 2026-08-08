import type { CapabilityDescriptor } from '@kanal/adapters-core';

/**
 * Reddit stub descriptor (plan §10.8).
 *
 * Official API. Subreddit rules become a second policy layer above our own ToS
 * engine. Requires OAuth (§16.4 Platform #5). Uncertain fields marked [VERIFY].
 */
export const REDDIT_DESCRIPTOR: CapabilityDescriptor = {
  platform: 'reddit',
  provenance: 'static',
  capabilities: new Set([
    'post.text',
    'post.media_single', // [VERIFY] link/image posts
    'post.edit_text', // yes — self posts (§10.7)
    'post.edit_caption', // n/a — self posts only
    'post.delete', // yes (§10.7)
    'post.silent', // [VERIFY]
    'markup.none', // markdown is Reddit-native, but rendered by the platform
    'read.member_count', // [VERIFY] subscriber count via API
    'read.post_views', // [VERIFY]
    'update.long_poll', // [VERIFY] API
    'update.webhook', // [VERIFY]
  ]),
  limits: {
    textMaxChars: 40000, // [VERIFY] self-post body limit
    captionMaxChars: 0, // no separate caption concept
    mediaGroupMax: 1, // [VERIFY]
    deleteWindowSeconds: -1, // [VERIFY]
    editWindowSeconds: -1, // [VERIFY] self posts editable
    globalSendPerSecond: 1, // [VERIFY] API rate limit
    perChatSendPerSecond: 1, // [VERIFY]
    perGroupSendPerMinute: null, // [VERIFY]
    nativeScheduledMax: null, // [VERIFY]
  },
  notes: {
    'post.edit_caption': 'No separate caption on Reddit; text and link posts only.',
  },
};
