import type {
  CapabilityDescriptor,
  ChannelRef,
  CredentialRef,
  EditOutcome,
  MetricSample,
  PlatformAdapter,
  PublishRequest,
  PublishOutcome,
  PublishedRef,
  RenderedPost,
  RenderOptions,
  RateLimiter,
  VerifyOutcome,
} from './types.js';

/**
 * A stub adapter shared by the five not-yet-implemented platforms
 * (plan §10.8). Every method that would touch the platform returns
 * `{ kind: 'rejected', code: 'not_implemented' }` — the plan's signal that the
 * capability seam is compiled but the platform is not shipped. Compile-checked,
 * never network-bound, never stateful.
 *
 * The optional capability-backed methods (`editText`, `editCaption`, `delete`,
 * `readMemberCount`, `readPostMetrics`, `readGrowthSeries`) are defined
 * CONDITIONALLY, exactly when the descriptor declares the matching capability.
 * The conformance kit enforces method/capability symmetry (§10.8): a method
 * defined for a capability absent from the descriptor is dead code, so a shared
 * stub over five differently-capabled platforms must expose only what each
 * descriptor promises (e.g. X has no `post.edit_*` — delete + repost — so the
 * X stub must not implement `editText`).
 */

const NOT_IMPLEMENTED: PublishOutcome = {
  kind: 'rejected',
  code: 'not_implemented',
  description: 'This platform adapter is a stub in V1 (plan §10.8).',
  permanent: true,
};

const NOT_IMPLEMENTED_EDIT: EditOutcome = {
  kind: 'rejected',
  code: 'not_implemented',
  description: 'stub adapter (plan §10.8)',
};

class NoopLimiter implements RateLimiter {
  async allow(_channel: ChannelRef): Promise<{ allowed: boolean; retryAfterMs: number }> {
    return { allowed: false, retryAfterMs: 0 };
  }
  noteBackoff(): void {
    /* no-op */
  }
  noteSuccess(): void {
    /* no-op */
  }
}

export class NotImplementedAdapter implements PlatformAdapter {
  readonly limiter: RateLimiter = new NoopLimiter();

  // Optional methods are conditionally attached per capability (see header).
  editText?: PlatformAdapter['editText'];
  editCaption?: PlatformAdapter['editCaption'];
  delete?: PlatformAdapter['delete'];
  readMemberCount?: PlatformAdapter['readMemberCount'];
  readPostMetrics?: PlatformAdapter['readPostMetrics'];
  readGrowthSeries?: PlatformAdapter['readGrowthSeries'];

  constructor(
    readonly kind: PlatformAdapter['kind'],
    private readonly descriptor: CapabilityDescriptor,
  ) {
    if (descriptor.capabilities.has('post.edit_text')) {
      this.editText = async () => NOT_IMPLEMENTED_EDIT;
    }
    if (descriptor.capabilities.has('post.edit_caption')) {
      this.editCaption = async () => NOT_IMPLEMENTED_EDIT;
    }
    if (descriptor.capabilities.has('post.delete')) {
      this.delete = async () => NOT_IMPLEMENTED_EDIT;
    }
    if (descriptor.capabilities.has('read.member_count')) {
      this.readMemberCount = async () => 0;
    }
    if (descriptor.capabilities.has('read.post_views')) {
      this.readPostMetrics = async (ref: PublishedRef): Promise<MetricSample> => ({
        platformMessageId: ref.platformMessageId,
        sampledAt: new Date().toISOString(),
        views: null,
        forwards: null,
        reactions: null,
      });
    }
    if (descriptor.capabilities.has('read.growth_series')) {
      this.readGrowthSeries = async () => [];
    }
  }

  async describe(_channel: ChannelRef): Promise<CapabilityDescriptor> {
    return this.descriptor;
  }

  async verifyCredentials(_cred: CredentialRef): Promise<VerifyOutcome> {
    return { kind: 'invalid', reason: 'not_implemented' };
  }

  render(_body: string, _caps: CapabilityDescriptor, _opts: RenderOptions): RenderedPost {
    return {
      body: _body,
      markupMode: 'none',
      parts: [],
      media: [],
      linkPreview: 'auto',
      silent: false,
      protectContent: false,
    };
  }

  async publish(_req: PublishRequest): Promise<PublishOutcome> {
    return NOT_IMPLEMENTED;
  }
}
