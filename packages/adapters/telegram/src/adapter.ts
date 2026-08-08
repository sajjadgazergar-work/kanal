import {
  type CapabilityDescriptor,
  type ChannelRef,
  type CredentialRef,
  type EditOutcome,
  type PlatformAdapter,
  type PublishRequest,
  type PublishOutcome,
  type PublishedRef,
  type RenderedPost,
  type RenderOptions,
  type VerifyOutcome,
} from '@kanal/adapters-core';
import { TELEGRAM_DESCRIPTOR } from './descriptor.js';
import { sanitizeHtml } from './html.js';
import { TokenBucketRateLimiter, limiterFromDescriptor } from './rate-limiter.js';
import { cutBodyAtMax, splitBody, visibleLength, type NumeralSystem } from './splitter.js';
import { TelegramClient } from './client.js';

/**
 * The KANAL Telegram adapter (plan §10.3–§10.6). The only complete adapter in
 * V1. Implements the TELEGRAM capability descriptor, HTML allow-list markup,
 * the 4096/1024 splitter, idempotent publish, and the three-bucket rate
 * limiter with AIMD adaptation.
 */
export class TelegramAdapter implements PlatformAdapter {
  readonly kind = 'telegram' as const;
  readonly limiter: TokenBucketRateLimiter;

  constructor(
    readonly client: TelegramClient,
    descriptor: CapabilityDescriptor = TELEGRAM_DESCRIPTOR,
  ) {
    this.limiter = limiterFromDescriptor(descriptor);
  }

  async describe(_channel: ChannelRef): Promise<CapabilityDescriptor> {
    return TELEGRAM_DESCRIPTOR;
  }

  async verifyCredentials(_cred: CredentialRef): Promise<VerifyOutcome> {
    return this.client.getMe();
  }

  /**
   * Render a post body for Telegram (plan §10.3).
   *
   * The body is assumed to be HTML already (the formatter produces it); render
   * sanitizes it through the strict allow-list parser, then applies the split:
   *
   * - No media, body ≤ textMaxChars   → single part.
   * - No media, body > textMaxChars   → split at 4096, `(۱/۳)` markers.
   * - Media present, body ≤ captionMaxChars → media with body as caption.
   * - Media present, body > captionMaxChars → media with first ≤ 1024 chars as
   *   caption, remainder as a follow-up text message with link preview disabled.
   */
  render(body: string, caps: CapabilityDescriptor, opts: RenderOptions = {}): RenderedPost {
    const sanitized = sanitizeHtml(body);
    const locale = opts.locale ?? 'en';
    const numeralSystem: NumeralSystem = opts.numeralSystem ?? 'latn';
    const textMax = caps.limits.textMaxChars;
    const captionMax = caps.limits.captionMaxChars;
    const media = opts.media ?? [];
    const linkPreview: RenderedPost['linkPreview'] = opts.linkPreview ?? 'auto';

    if (media.length > 0) {
      if (visibleLength(sanitized) <= captionMax) {
        // media with the whole body as caption
        return {
          body: sanitized,
          markupMode: 'html',
          parts: [],
          media,
          linkPreview,
          silent: opts.silent ?? false,
          protectContent: opts.protectContent ?? false,
        };
      }
      // media + long text: first ≤ 1024 chars as caption, remainder as follow-up
      const { head, rest } = cutBodyAtMax(sanitized, captionMax, locale);
      const parts = splitBody(rest, { max: textMax, locale, numeralSystem });
      return {
        body: head,
        markupMode: 'html',
        parts,
        media,
        linkPreview: 'disabled',
        silent: opts.silent ?? false,
        protectContent: opts.protectContent ?? false,
      };
    }

    // No media: single text or split at textMaxChars.
    const parts = splitBody(sanitized, { max: textMax, locale, numeralSystem });
    return {
      body: parts[0] ?? '',
      markupMode: 'html',
      parts: parts.length > 1 ? parts.slice(1) : [],
      media: [],
      linkPreview,
      silent: opts.silent ?? false,
      protectContent: opts.protectContent ?? false,
    };
  }

  /**
   * Publish one part (plan §10.5). `req.idempotencyKey` is echoed into the
   * attempt row; a duplicate key loses deterministically at the unique index
   * before any HTTP call. Rate limited by the adapter-owned limiter (§10.4).
   */
  async publish(req: PublishRequest): Promise<PublishOutcome> {
    const allow = await this.limiter.allow(req.channel);
    if (!allow.allowed) {
      return { kind: 'rate_limited', retryAfterSeconds: Math.ceil(allow.retryAfterMs / 1000) };
    }

    const { channel, rendered } = req;
    const silent = rendered.silent;
    const protectContent = rendered.protectContent;

    // Media + caption: sendPhoto with the caption, then follow-up text parts.
    if (rendered.media.length > 0 && rendered.body.length > 0) {
      const media0 = rendered.media[0]!;
      const url = media0.remoteUrl ?? media0.localPath;
      if (url) {
        const first = await this.client.sendPhoto(channel, url, {
          caption: rendered.body,
          silent,
          protectContent,
        });
        this.limiter.noteSuccess(channel);
        if (first.kind !== 'ok') return first;
        for (const part of rendered.parts) {
          const pout = await this.client.sendMessage(channel, part, {
            parseMode: 'HTML',
            disableWebPagePreview: true,
            silent,
            protectContent,
          });
          this.limiter.noteSuccess(channel);
          if (pout.kind !== 'ok') return pout;
        }
        return first;
      }
    }

    // Plain text (single part or one part of a multipart post).
    const out = await this.client.sendMessage(channel, rendered.body, {
      parseMode: 'HTML',
      disableWebPagePreview: rendered.linkPreview === 'disabled',
      silent,
      protectContent,
      allowPaidBroadcast: req.paidBroadcast ?? false,
    });
    this.limiter.noteSuccess(channel);
    return out;
  }

  async editText(ref: PublishedRef, rendered: RenderedPost): Promise<EditOutcome> {
    return this.client.editMessageText(ref.channel, ref.platformMessageId, rendered.body, {
      parseMode: 'HTML',
    });
  }

  async editCaption(ref: PublishedRef, caption: string): Promise<EditOutcome> {
    return this.client.editMessageCaption(ref.channel, ref.platformMessageId, caption, {
      parseMode: 'HTML',
    });
  }

  async delete(ref: PublishedRef): Promise<EditOutcome> {
    return this.client.deleteMessage(ref.channel, ref.platformMessageId);
  }

  async readMemberCount(channel: ChannelRef): Promise<number> {
    return this.client.getChatMemberCount(channel);
  }

  // NOTE: readPostMetrics is deliberately NOT defined here. The static
  // descriptor does not declare `read.post_views` — that capability is added
  // only when the MTProto sidecar reports a healthy session (§10.3). The
  // conformance kit (method-without-capability) enforces that: a method with
  // no capability is dead code. The sidecar variant is a separate adapter.
}
