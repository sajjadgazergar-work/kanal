import type { CapabilityDescriptor } from '@kanal/adapters-core';

/**
 * Rubika stub descriptor (plan §10.8).
 *
 * Endpoint shape: `https://botapi.rubika.ir/v3/{token}/{method}`. Capability
 * set unknown — probe before declaring (plan §10.8 marks the whole row
 * "probe before declaring"; every uncertain field is [VERIFY]).
 */
export const RUBIKA_DESCRIPTOR: CapabilityDescriptor = {
  platform: 'rubika',
  provenance: 'static',
  capabilities: new Set([
    'post.text', // [VERIFY]
    'post.media_single', // [VERIFY]
    'post.media_group', // [VERIFY]
    'post.poll', // [VERIFY]
    'post.edit_text', // [VERIFY]
    'post.edit_caption', // [VERIFY]
    'post.delete', // [VERIFY]
    'post.silent', // [VERIFY]
    'post.link_preview_control', // [VERIFY]
    'markup.html', // [VERIFY]
    'markup.none',
    'update.long_poll', // [VERIFY]
    'update.webhook', // [VERIFY]
  ]),
  limits: {
    textMaxChars: 4096, // [VERIFY]
    captionMaxChars: 1024, // [VERIFY]
    mediaGroupMax: 10, // [VERIFY]
    deleteWindowSeconds: 48 * 3600, // [VERIFY]
    editWindowSeconds: -1, // [VERIFY]
    globalSendPerSecond: 30, // [VERIFY]
    perChatSendPerSecond: 1, // [VERIFY]
    perGroupSendPerMinute: 20, // [VERIFY]
    nativeScheduledMax: null, // [VERIFY]
  },
  notes: {},
};
