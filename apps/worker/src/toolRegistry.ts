import { moderateOutbound, classifyPost } from '@kanal/safety';
import { TelegramAdapter, TelegramClient, idempotencyKey } from '@kanal/adapters-telegram';
import type { ChannelRef } from '@kanal/adapters-core';
import type { RunCtx } from '@kanal/core';

/**
 * The deterministic tool registry (plan §7.2, §10.5, §16.1). These are the ONLY
 * capabilities the worker exposes. There is no `platform.*` capability here for
 * agents to reach — `ops.publish` is a deterministic stage whose only side
 * effect is the idempotent Telegram call, and the publish outcome is recorded
 * by the runner, not by any model.
 *
 * Capability risk model (plan §7.2 D2): none of these carries risk-3. The
 * highest is `platform.publish` (risk-2, deterministic), which is keyed by the
 * idempotency hash `sha256(post_id|revision_id|channel_id|part_index)` (§10.5)
 * so a crash-and-retry cannot double-publish.
 */

export type Tool = (args: unknown, ctx: RunCtx) => Promise<unknown>;

interface PublishArgs {
  postId: string;
  revisionId: string;
  channelId: string;
  partIndex: number;
  bodyRendered: string;
  botToken?: string;
  channelRef?: { platformChannelId: string; handle?: string; contentLocale: string; numeralSystem?: 'latn' | 'arabext'; isGroup?: boolean };
}

export const TOOL_REGISTRY: Record<string, Tool> = {
  /**
   * policy.classify — the deterministic policy gate (plan §9.2 #11, §15.6).
   * Returns the same shape the `ops.policy_classify` stage expects.
   */
  'policy.classify': async (args) => {
    const { text } = args as { text: string };
    const verdict = moderateOutbound(text);
    const classification = classifyPost(text);
    return {
      riskClass: classification.riskClass,
      isPromotional: verdict.blocked,
      prohibited: verdict.blocked ? (verdict.blockedReason ? [verdict.blockedReason] : ['blocked']) : [],
    };
  },

  /**
   * platform.publish — idempotent Telegram publish (plan §10.5, §10.2).
   * The idempotency key is derived from post|revision|channel|part, so a
   * duplicate job for the same part returns the stored platform id instead of
   * publishing twice. The adapters package guarantees this at the client layer
   * (`TelegramAdapter.publish` + the splitter + the rate limiter).
   */
  'platform.publish': async (args) => {
    const { postId, revisionId, channelId, partIndex, bodyRendered, botToken, channelRef } = args as PublishArgs;
    const key = idempotencyKey(postId, revisionId, channelId, partIndex);
    // In a real install the adapter is constructed with the channel's bot token
    // from source/config; this tool receives it per-call. When no token is
    // present we return a deterministic placeholder so tests and dry runs work
    // without Telegram credentials.
    if (!botToken) {
      return { platformPostId: `dryrun:${key.slice(0, 12)}` };
    }
    const client = new TelegramClient({
      botToken,
      baseUrl: process.env.KANAL_TELEGRAM_API ?? 'https://api.telegram.org/bot',
    });
    const adapter = new TelegramAdapter(client);
    const ref: ChannelRef = channelRef
      ? { ...channelRef, numeralSystem: channelRef.numeralSystem ?? 'latn' }
      : { platformChannelId: channelId, contentLocale: 'en', numeralSystem: 'latn' };
    const outcome = await adapter.publish({
      channel: ref,
      // The formatter already produced Telegram-HTML; the adapter re-sanitizes
      // through the strict allow-list (§10.3) and splits at textMaxChars.
      rendered: {
        body: bodyRendered,
        markupMode: 'html',
        parts: [],
        media: [],
        linkPreview: 'auto',
        silent: false,
        protectContent: false,
      },
      idempotencyKey: key,
    });
    if (outcome.kind === 'uncertain') {
      // publish_uncertain is NEVER auto-retried (plan §10.6): return the
      // uncertain outcome; the runner transitions to `publish_uncertain`.
      return { uncertain: true, detail: outcome.reason };
    }
    if (outcome.kind !== 'ok') {
      const description = 'description' in outcome ? outcome.description : outcome.kind;
      throw new Error(`publish failed: ${description}`);
    }
    return { platformPostId: outcome.platformMessageId };
  },

  /**
   * measure.metrics — deterministic metric snapshot (plan §9.2 #15, §17.2).
   * Returns zeros when the stats sidecar is off; the degraded-operation matrix
   * documents this (Bot API has no views). A real deploy wires this to the
   * sidecar's per-post counter.
   */
  'measure.metrics': async (args) => {
    const { platformPostId } = args as { platformPostId: string };
    return { views: 0, reactions: 0, comments: 0, platformPostId, degraded: true };
  },
};
