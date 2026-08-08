import { describe, expect, it } from 'vitest';
import { filterAllowlist } from '../attributes.js';
import { sanitizeSpan, contentForMode } from '../processor.js';

describe('attribute allow-list (deny by default, §13.2)', () => {
  it('drops any attribute not on the explicit allow-list', () => {
    const span = {
      name: 'gen_ai.chat',
      attributes: {
        'gen_ai.operation.name': 'chat',
        'kanal.run.id': 'run-1',
        'gen_ai.usage.input_tokens': 10,
        'leaky.secret': 'draft-text',
        'kanal.prompt_pack.version': '1.2.0',
        'http.request.header.authorization': 'Bearer sk-...',
      },
    };
    const out = sanitizeSpan(span);
    expect(out.attributes['gen_ai.operation.name']).toBe('chat');
    expect(out.attributes['kanal.run.id']).toBe('run-1');
    expect(out.attributes['leaky.secret']).toBeUndefined();
    expect(out.attributes['http.request.header.authorization']).toBeUndefined();
    expect(out.droppedCount).toBeGreaterThanOrEqual(2);
  });

  it('keeps only keys on the allow-list (filterAllowlist)', () => {
    const out = filterAllowlist({
      'kanal.cost.usd': 0.0042,
      'gen_ai.response.finish_reasons': ['stop'],
      'kanal.nope': 1,
      'foo': 'bar',
    });
    expect(out).toEqual({
      'kanal.cost.usd': 0.0042,
      'gen_ai.response.finish_reasons': ['stop'],
    });
  });

  it('handles undefined attributes gracefully', () => {
    expect(sanitizeSpan({ name: 'x', attributes: {} })).toEqual({
      name: 'x',
      attributes: {},
      droppedCount: 0,
      storedContent: false,
    });
  });

  it('never lets content attributes through even if a caller attached them', () => {
    const span = {
      name: 'gen_ai.chat',
      attributes: {
        'kanal.content.full': 'the actual draft',
        'kanal.content.sha256': 'deadbeef',
        'kanal.run.id': 'run-1',
      },
    };
    const out = sanitizeSpan(span, { traceContentMode: 'redacted' });
    expect(out.attributes['kanal.content.full']).toBeUndefined();
    expect(out.attributes['kanal.content.sha256']).toBeUndefined();
    expect(out.attributes['kanal.run.id']).toBe('run-1');
  });
});

describe('content redaction (KANAL_TRACE_CONTENT, §13.2)', () => {
  it('redacted (default) stores a SHA-256 hash and token count, not content', () => {
    const attrs = contentForMode('redacted', 'private draft body', 12);
    expect(attrs['kanal.content.sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(attrs['kanal.content.tokens']).toBe(12);
    expect(attrs['kanal.content.full']).toBeUndefined();
  });

  it('hash is stable and content is not recoverable', () => {
    const a = contentForMode('redacted', 'same text', 3);
    const b = contentForMode('redacted', 'same text', 3);
    expect(a['kanal.content.sha256']).toBe(b['kanal.content.sha256']);
    expect(a['kanal.content.sha256']).not.toBe('same text');
  });

  it('full stores content for local debugging', () => {
    const attrs = contentForMode('full', 'the draft', 7);
    expect(attrs['kanal.content.full']).toBe('the draft');
    expect(attrs['kanal.content.tokens']).toBe(7);
  });

  it('off stores nothing', () => {
    expect(contentForMode('off', 'the draft', 7)).toEqual({});
  });

  it('unset/unknown modes default to redacted', () => {
    expect(contentForMode(undefined as unknown as string, 'x', 1)['kanal.content.sha256']).toBeDefined();
    expect(contentForMode('bogus', 'x', 1)['kanal.content.sha256']).toBeDefined();
  });
});
