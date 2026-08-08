import type {
  EditOutcome,
  MediaRef,
  PlatformKind,
  PublishOutcome,
} from '@kanal/contracts';

/** Re-export the contract types the interface composes. */
export type { EditOutcome, MediaRef, PlatformKind, PublishOutcome } from '@kanal/contracts';

/**
 * KANAL platform abstraction layer — the interface (plan §10.2).
 *
 * The interface is capability-negotiated, not lowest-common-denominator
 * (§10.1). A caller never asks "can I post?"; it asks the adapter for its
 * `CapabilityDescriptor`, and the formatter, the UI, and the policy engine all
 * read that descriptor. A capability a platform lacks is absent from the
 * descriptor, and every call site handles absence explicitly — TypeScript
 * makes that a compile error, not a runtime surprise, because the optional
 * methods are `undefined` on the type when the capability flag is false.
 *
 * This package is Apache-2.0 (plan §19.1 carve-out) so third parties writing
 * adapters can depend on it without relicensing their own code.
 */

/** The capability vocabulary every adapter negotiates over (plan §10.2). */
export type Capability =
  | 'post.text'
  | 'post.media_single'
  | 'post.media_group'
  | 'post.poll'
  | 'post.edit_text'
  | 'post.edit_caption'
  | 'post.delete'
  | 'post.silent'
  | 'post.protect_content'
  | 'post.link_preview_control'
  | 'post.paid_broadcast'
  | 'markup.html'
  | 'markup.markdown_v2'
  | 'markup.entities'
  | 'markup.none'
  | 'read.member_count'
  | 'read.post_views'
  | 'read.growth_series'
  | 'read.traffic_sources'
  | 'update.long_poll'
  | 'update.webhook'
  | 'schedule.native';

/** Per-platform hard limits. The scheduler and the splitter read these. */
export interface PlatformLimits {
  textMaxChars: number;
  captionMaxChars: number;
  mediaGroupMax: number;
  /** seconds after publish during which delete is possible; null = never; -1 = unlimited */
  deleteWindowSeconds: number | null;
  /** -1 = unlimited */
  editWindowSeconds: number | null;
  globalSendPerSecond: number;
  perChatSendPerSecond: number;
  perGroupSendPerMinute: number | null;
  nativeScheduledMax: number | null;
}

/** The static negotiated description of a platform (plan §10.2, §10.3). */
export interface CapabilityDescriptor {
  platform: PlatformKind;
  capabilities: ReadonlySet<Capability>;
  limits: PlatformLimits;
  /** how the descriptor was obtained; drives UI trust indicators */
  provenance: 'static' | 'probed' | 'user_override';
  probedAt?: string;
  /** shown as tooltips in the UI */
  notes: Partial<Record<Capability, string>>;
}

/** Reference to a channel on a platform, as seen by the adapter layer. */
export interface ChannelRef {
  /** the platform's own id, e.g. "-1001234567890" */
  platformChannelId: string;
  /** e.g. "@nima_tech" */
  handle?: string;
  /** IANA content locale, e.g. "fa", "en" — drives Intl.Segmenter and numerals */
  contentLocale: string;
  /** 'latn' | 'arabext' — the org's numeral system (db `org.numeral_system`) */
  numeralSystem: 'latn' | 'arabext';
  /** whether the channel is a group/supergroup (drives per-group limiter) */
  isGroup?: boolean;
}

/** A credential the adapter verifies (a pointer into the secret store, never the token). */
export interface CredentialRef {
  id: string;
  platform: PlatformKind;
  /** URL or host the secret store resolves, e.g. "telegram" or a key id */
  location: string;
}

/** A message already published to the platform. */
export interface PublishedRef {
  channel: ChannelRef;
  platformMessageId: string;
}

/** Optional inputs a caller may pass to `render` to steer formatting. */
export interface RenderOptions {
  /** show the part marker `(۱/۳)` style; off for the last part / single part */
  partMarker?: boolean;
  /** force a link preview mode; 'auto' lets the platform decide */
  linkPreview?: RenderedPost['linkPreview'];
  /** media attached to this post; drives the caption-vs-follow-up split (§10.3) */
  media?: MediaRef[];
  /** IANA content locale, e.g. "fa", "en" — drives Intl.Segmenter */
  locale?: string;
  /** 'latn' | 'arabext' — numeral system for part markers (db `org.numeral_system`) */
  numeralSystem?: 'latn' | 'arabext';
  silent?: boolean;
  protectContent?: boolean;
}

/** The platform-native rendered post (plan §10.2). */
export interface RenderedPost {
  /** platform-native body, already escaped for `markupMode` */
  body: string;
  markupMode: 'html' | 'markdown_v2' | 'entities' | 'none';
  /** ordered parts when the body exceeded textMaxChars */
  parts: string[];
  media: MediaRef[];
  linkPreview: 'auto' | 'disabled' | { url: string; smallMedia: boolean };
  silent: boolean;
  protectContent: boolean;
}

/** A request to publish one post (plan §10.2, §10.5). */
export interface PublishRequest {
  channel: ChannelRef;
  rendered: RenderedPost;
  /** sha256(post_id || revision_id || channel_id || part_index); adapters must echo it into the attempt row */
  idempotencyKey: string;
  /** costs Telegram Stars; requires explicit per-post opt-in */
  paidBroadcast?: boolean;
}

/** A single metric sample, e.g. views for one post (plan §17.1). */
export interface MetricSample {
  /** platform message id this sample refers to */
  platformMessageId: string;
  /** ISO 8601 UTC */
  sampledAt: string;
  /** nullable: not available via Bot API, only via the MTProto sidecar */
  views: number | null;
  forwards: number | null;
  reactions: Record<string, number> | null;
}

/** A growth series — a time-ordered list of subscriber/engagement snapshots. */
export interface GrowthPoint {
  /** ISO 8601 UTC */
  at: string;
  subscribers: number | null;
  /** nullable: sidecar-only */
  views: number | null;
}

/** A time window used by readGrowthSeries. */
export interface DateRange {
  /** ISO 8601 UTC */
  from: string;
  /** ISO 8601 UTC */
  to: string;
}

/** Result of `verifyCredentials` (plan §10.2). */
export type VerifyOutcome =
  | { kind: 'ok'; botId: string; botUsername: string; grants: string[] }
  | { kind: 'invalid'; reason: string }
  | { kind: 'insufficient_rights'; missing: string[] };

/** Adapter-owned rate limiter; the scheduler calls this before every send (§10.4). */
export interface RateLimiter {
  /**
   * Atomically check-and-consume one send from all buckets relevant to the
   * channel. Resolves `true` when the send may proceed; `false` when the
   * caller must back off. `retryAfterMs` is populated when `false` so the
   * scheduler can sleep precisely (0 when the limiter only reports generic
   * saturation).
   */
  allow(channel: ChannelRef): Promise<{ allowed: boolean; retryAfterMs: number }>;
  /** Notify the limiter of a 429 so it can AIMD-adapt refill rates. */
  noteBackoff(scope: 'global' | 'chat' | 'group', channel: ChannelRef, retryAfterSeconds: number): void;
  /** Notify the limiter of a successful send (the 30s AIMD recovery window). */
  noteSuccess(channel: ChannelRef): void;
}

/** The adapter interface (plan §10.2). */
export interface PlatformAdapter {
  readonly kind: PlatformKind;
  describe(channel: ChannelRef): Promise<CapabilityDescriptor>;
  verifyCredentials(cred: CredentialRef): Promise<VerifyOutcome>;

  render(body: string, caps: CapabilityDescriptor, opts: RenderOptions): RenderedPost;
  publish(req: PublishRequest): Promise<PublishOutcome>;

  // Optional methods exist only when the corresponding capability is present.
  editText?(ref: PublishedRef, rendered: RenderedPost): Promise<EditOutcome>;
  editCaption?(ref: PublishedRef, caption: string): Promise<EditOutcome>;
  delete?(ref: PublishedRef): Promise<EditOutcome>;
  readMemberCount?(channel: ChannelRef): Promise<number>;
  readPostMetrics?(ref: PublishedRef): Promise<MetricSample>;
  readGrowthSeries?(channel: ChannelRef, window: DateRange): Promise<GrowthPoint[]>;

  /** Adapter-owned limiter; the scheduler calls this before every send. */
  readonly limiter: RateLimiter;
}
