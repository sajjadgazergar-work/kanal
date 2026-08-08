import { fetch as undiciFetch } from 'undici';
import type {
  ChannelRef,
  EditOutcome,
  PublishOutcome,
  VerifyOutcome,
} from '@kanal/adapters-core';

/**
 * Thin Telegram Bot API client over `undici` (plan §10.3).
 *
 * Methods used in V1: sendMessage, sendPhoto, sendMediaGroup, editMessageText,
 * editMessageCaption, deleteMessage, getChatMemberCount, getMe, getChat.
 * (getChatAdministrators is listed in the plan but unused in V1.)
 *
 * Outcome mapping (§10.2):
 *   - 2xx + `ok:true`                       → ok / per-method success
 *   - 429 + `parameters.retry_after`        → rate_limited
 *   - 400/403 with a known error code       → rejected (permanent) / unauthorized
 *   - 400 "message is not modified"         → not_modified (edit only)
 *   - timeout / connection reset / proxy    → uncertain (NEVER auto-retried, plan D4/§10.6)
 *
 * The request body is JSON; no network test ever runs (all tests use a mocked
 * fetch via nock-style injection).
 */

export interface TelegramClientOptions {
  botToken: string;
  /** overridable for tests; defaults to the real Bot API */
  baseUrl?: string;
  /** HTTP timeout, default 30 s (plan §10.5 step 3) */
  timeoutMs?: number;
  /** injectable fetch for tests */
  fetchImpl?: typeof fetch;
}

export class TelegramClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(readonly opts: TelegramClientOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.telegram.org/bot').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? (undiciFetch as typeof fetch);
  }

  private url(method: string): string {
    return `${this.baseUrl}/${this.opts.botToken}/${method}`;
  }

  private async post<T>(method: string, body: Record<string, unknown>): Promise<TelegramResponse<T>> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { kind: 'transport', reason: 'timeout' };
      }
      if (err instanceof TypeError || (err instanceof Error && /socket|fetch|network|ECONN|ETIMEDOUT/i.test(err.message))) {
        return { kind: 'transport', reason: 'connection_reset' };
      }
      return { kind: 'transport', reason: 'connection_reset' };
    }
    return this.parseResponse(res);
  }

  private async parseResponse<T>(res: Response): Promise<TelegramResponse<T>> {
    // A 5xx means the request may have been received and acted on; treat as
    // uncertain (never auto-retried, plan D4/§10.6).
    if (res.status >= 500) {
      return { kind: 'transport', reason: 'connection_reset', status: res.status };
    }

    // The Bot API returns HTTP 200 with ok:false + error_code for most errors,
    // but proxies can surface the HTTP status directly. Read the JSON body in
    // either case and classify on the Telegram error_code when present.
    let data: TelegramApiResponse<T> | null = null;
    try {
      data = (await res.json()) as TelegramApiResponse<T>;
    } catch {
      data = null;
    }

    if (data && data.ok && res.status >= 200 && res.status < 300) {
      return { kind: 'ok', result: data.result as T };
    }

    const code = data?.error_code ?? res.status;
    const description = data?.description ?? `HTTP ${res.status}`;
    if (res.status === 429 || code === 429) {
      const retryAfter = data?.parameters?.retry_after ?? 0;
      return { kind: 'rate_limited', retryAfterSeconds: retryAfter, httpStatus: res.status };
    }
    if (code === 403 || /forbidden|unauthorized/i.test(description)) {
      return { kind: 'unauthorized', description };
    }
    if (code === 400 && /not modified/i.test(description)) {
      return { kind: 'not_modified' };
    }
    if (code === 404 || /not found/i.test(description)) {
      return { kind: 'not_found', description };
    }
    return { kind: 'rejected', code: String(code), description, permanent: true };
  }

  async getMe(): Promise<VerifyOutcome> {
    const r = await this.post<{ id: number; username?: string }>('getMe', {});
    if (r.kind === 'ok') {
      return { kind: 'ok', botId: String(r.result.id), botUsername: r.result.username ?? '', grants: [] };
    }
    if (r.kind === 'unauthorized') return { kind: 'invalid', reason: r.description };
    if (r.kind === 'rate_limited') return { kind: 'invalid', reason: `rate limited (${r.retryAfterSeconds}s)` };
    if (r.kind === 'transport') return { kind: 'invalid', reason: r.reason };
    if (r.kind === 'rejected') return { kind: 'invalid', reason: r.description };
    return { kind: 'invalid', reason: 'unexpected response' };
  }

  async sendMessage(
    channel: ChannelRef,
    text: string,
    opts: {
      parseMode?: 'HTML';
      disableWebPagePreview?: boolean;
      silent?: boolean;
      protectContent?: boolean;
      allowPaidBroadcast?: boolean;
      replyParameters?: { message_id: number };
    } = {},
  ): Promise<PublishOutcome> {
    const r = await this.post<{ message_id: number }>('sendMessage', {
      chat_id: channel.platformChannelId,
      text,
      ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
      ...(opts.disableWebPagePreview ? { link_preview_options: { is_disabled: true } } : {}),
      ...(opts.silent ? { disable_notification: true } : {}),
      ...(opts.protectContent ? { protect_content: true } : {}),
      ...(opts.allowPaidBroadcast ? { allow_paid_broadcast: true } : {}),
      ...(opts.replyParameters ? { reply_parameters: opts.replyParameters } : {}),
    });
    return this.toPublishOutcome(r);
  }

  async sendPhoto(
    channel: ChannelRef,
    photo: string,
    opts: { caption?: string; parseMode?: 'HTML'; silent?: boolean; protectContent?: boolean } = {},
  ): Promise<PublishOutcome> {
    const r = await this.post<{ message_id: number }>('sendPhoto', {
      chat_id: channel.platformChannelId,
      photo,
      ...(opts.caption ? { caption: opts.caption, parse_mode: opts.parseMode ?? 'HTML' } : {}),
      ...(opts.silent ? { disable_notification: true } : {}),
      ...(opts.protectContent ? { protect_content: true } : {}),
    });
    return this.toPublishOutcome(r);
  }

  async sendMediaGroup(
    channel: ChannelRef,
    media: Array<{ type: 'photo' | 'video'; media: string; caption?: string }>,
    opts: { silent?: boolean; protectContent?: boolean } = {},
  ): Promise<PublishOutcome> {
    const r = await this.post<Array<{ message_id: number }>>('sendMediaGroup', {
      chat_id: channel.platformChannelId,
      media: media.map((m) => ({ ...m, parse_mode: 'HTML' as const })),
      ...(opts.silent ? { disable_notification: true } : {}),
      ...(opts.protectContent ? { protect_content: true } : {}),
    });
    if (r.kind === 'ok') {
      const first = r.result[0];
      return {
        kind: 'ok',
        platformMessageId: String(first?.message_id ?? ''),
        respondedAt: new Date().toISOString(),
        deletableUntil: null,
        editable: false,
      };
    }
    return this.toPublishOutcome(r);
  }

  async editMessageText(
    channel: ChannelRef,
    messageId: string,
    text: string,
    opts: { parseMode?: 'HTML' } = {},
  ): Promise<EditOutcome> {
    const r = await this.post<{ message_id: number }>('editMessageText', {
      chat_id: channel.platformChannelId,
      message_id: Number(messageId),
      text,
      ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
    });
    return this.toEditOutcome(r);
  }

  async editMessageCaption(
    channel: ChannelRef,
    messageId: string,
    caption: string,
    opts: { parseMode?: 'HTML' } = {},
  ): Promise<EditOutcome> {
    const r = await this.post<{ message_id: number }>('editMessageCaption', {
      chat_id: channel.platformChannelId,
      message_id: Number(messageId),
      caption,
      ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
    });
    return this.toEditOutcome(r);
  }

  async deleteMessage(channel: ChannelRef, messageId: string): Promise<EditOutcome> {
    const r = await this.post<true>('deleteMessage', {
      chat_id: channel.platformChannelId,
      message_id: Number(messageId),
    });
    if (r.kind === 'ok') return { kind: 'ok', editedAt: new Date().toISOString() };
    if (r.kind === 'not_found') return { kind: 'window_expired' };
    if (r.kind === 'rate_limited') return { kind: 'rate_limited', retryAfterSeconds: r.retryAfterSeconds };
    if (r.kind === 'rejected') return { kind: 'rejected', code: r.code, description: r.description };
    if (r.kind === 'unauthorized') return { kind: 'rejected', code: 'unauthorized', description: r.description };
    if (r.kind === 'transport') return { kind: 'rejected', code: 'uncertain', description: r.reason };
    return { kind: 'rejected', code: 'not_modified', description: 'unexpected response' };
  }

  async getChatMemberCount(channel: ChannelRef): Promise<number> {
    const r = await this.post<{ count: number }>('getChatMemberCount', { chat_id: channel.platformChannelId });
    if (r.kind === 'ok') return r.result.count;
    return 0;
  }

  async getChat(channel: ChannelRef): Promise<{ id: string; type: string; title?: string } | null> {
    const r = await this.post<{ id: number; type: string; title?: string }>('getChat', {
      chat_id: channel.platformChannelId,
    });
    if (r.kind === 'ok') return { ...r.result, id: String(r.result.id) };
    return null;
  }

  private toPublishOutcome(r: TelegramResponse<{ message_id: number }>): PublishOutcome {
    if (r.kind === 'ok') {
      return {
        kind: 'ok',
        platformMessageId: String(r.result.message_id),
        respondedAt: new Date().toISOString(),
        deletableUntil: null, // set by the attempt row in §10.5 step 4
        editable: true,
      };
    }
    if (r.kind === 'rate_limited') return { kind: 'rate_limited', retryAfterSeconds: r.retryAfterSeconds };
    if (r.kind === 'unauthorized') return { kind: 'unauthorized', description: r.description };
    if (r.kind === 'not_found') return { kind: 'not_found', description: r.description };
    if (r.kind === 'transport') return { kind: 'uncertain', reason: r.reason };
    if (r.kind === 'rejected') {
      return { kind: 'rejected', code: r.code, description: r.description, permanent: true };
    }
    return { kind: 'rejected', code: 'unmapped', description: 'unmapped response', permanent: true };
  }

  private toEditOutcome(r: TelegramResponse<{ message_id: number }>): EditOutcome {
    if (r.kind === 'ok') return { kind: 'ok', editedAt: new Date().toISOString() };
    if (r.kind === 'not_modified') return { kind: 'not_modified' };
    if (r.kind === 'rate_limited') return { kind: 'rate_limited', retryAfterSeconds: r.retryAfterSeconds };
    if (r.kind === 'rejected') return { kind: 'rejected', code: r.code, description: r.description };
    if (r.kind === 'unauthorized') return { kind: 'rejected', code: 'unauthorized', description: r.description };
    if (r.kind === 'transport') return { kind: 'rejected', code: 'uncertain', description: r.reason };
    return { kind: 'rejected', code: 'not_found', description: r.description };
  }
}

// ---- response plumbing ----------------------------------------------------

type TelegramResponse<T> =
  | { kind: 'ok'; result: T }
  | { kind: 'rate_limited'; retryAfterSeconds: number; httpStatus: number }
  | { kind: 'unauthorized'; description: string }
  | { kind: 'not_found'; description: string }
  | { kind: 'rejected'; code: string; description: string; permanent: true }
  | { kind: 'not_modified' }
  | { kind: 'transport'; reason: 'timeout' | 'connection_reset'; status?: number };

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}
