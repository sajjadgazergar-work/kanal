import type { CapabilityDescriptor } from '@kanal/adapters-core';

/**
 * Eitaa stub descriptor (plan §10.8).
 *
 * Endpoint shape: `https://eitaayar.ir/api/{TOKEN}/{METHOD}`, `@sender` added
 * as channel admin. Write-mostly: no `update.*`, likely no `post.edit_*`,
 * likely no `read.*`. This is the adapter that proves capability negotiation is
 * real — the UI must hide edit, hide analytics, and disable any policy that
 * depends on reading back. Uncertain fields marked [VERIFY].
 */
export const EITAA_DESCRIPTOR: CapabilityDescriptor = {
  platform: 'eitaa',
  provenance: 'static',
  capabilities: new Set([
    'post.text',
    'post.media_single',
    'post.media_group', // [VERIFY]
    'post.poll', // [VERIFY]
    'post.edit_text', // likely no [VERIFY]
    'post.edit_caption', // likely no [VERIFY]
    'post.delete', // [VERIFY]
    'post.silent', // [VERIFY]
    'post.protect_content', // [VERIFY]
    'markup.none',
    'update.long_poll', // absent — write-mostly [VERIFY]
    'update.webhook', // absent — write-mostly [VERIFY]
  ]),
  limits: {
    textMaxChars: 4096, // [VERIFY]
    captionMaxChars: 1024, // [VERIFY]
    mediaGroupMax: 10, // [VERIFY]
    deleteWindowSeconds: null, // [VERIFY]
    editWindowSeconds: null, // likely no edit [VERIFY]
    globalSendPerSecond: 30, // [VERIFY]
    perChatSendPerSecond: 1, // [VERIFY]
    perGroupSendPerMinute: 20, // [VERIFY]
    nativeScheduledMax: null, // [VERIFY]
  },
  notes: {
    'update.long_poll': 'Write-mostly platform; no update stream. uncertain outcomes can only be resolved by a human (§10.9).',
  },
};
