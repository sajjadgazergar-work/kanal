import { describe, it, expect } from 'vitest';
import { loadConfig, workerId } from '../src/config.js';

describe('loadConfig (plan §12.7)', () => {
  it('defaults to all four roles', () => {
    const cfg = loadConfig({ KANAL_PUBLISH: 'on' });
    expect(cfg.roles).toEqual(['pipeline', 'ingest', 'publish', 'metrics']);
    expect(cfg.pipelineConcurrency).toBe(4);
    expect(cfg.ingestConcurrency).toBe(8);
    expect(cfg.publishConcurrency).toBe(1);
  });

  it('parses a comma-separated role subset', () => {
    const cfg = loadConfig({ KANAL_WORKER_ROLES: 'pipeline,ingest' });
    expect(cfg.roles).toEqual(['pipeline', 'ingest']);
  });

  it('accepts the literal "all"', () => {
    const cfg = loadConfig({ KANAL_WORKER_ROLES: 'all', KANAL_PUBLISH: 'on' });
    expect(cfg.roles).toHaveLength(4);
  });

  it('rejects unknown roles', () => {
    expect(() => loadConfig({ KANAL_WORKER_ROLES: 'pipeline,teleport' })).toThrow(/unknown role/);
  });

  it('rejects an empty role list', () => {
    expect(() => loadConfig({ KANAL_WORKER_ROLES: ' , ' })).toThrow(/empty/);
  });

  it('rejects a non-integer concurrency', () => {
    expect(() =>
      loadConfig({ KANAL_WORKER_ROLES: 'pipeline', KANAL_PIPELINE_CONCURRENCY: 'lots' }),
    ).toThrow(/positive integer/);
  });

  it('refuses to run the publisher when KANAL_PUBLISH=off (default)', () => {
    expect(() => loadConfig({ KANAL_WORKER_ROLES: 'publish' })).toThrow(/KANAL_PUBLISH/);
    expect(() => loadConfig({ KANAL_WORKER_ROLES: 'all' })).toThrow(/KANAL_PUBLISH/);
  });

  it('allows publish when KANAL_PUBLISH=on', () => {
    const cfg = loadConfig({ KANAL_WORKER_ROLES: 'publish', KANAL_PUBLISH: 'on' });
    expect(cfg.roles).toEqual(['publish']);
    expect(cfg.publishEnabled).toBe(true);
  });

  it('does not require KANAL_PUBLISH for non-publish roles', () => {
    const cfg = loadConfig({ KANAL_WORKER_ROLES: 'pipeline,metrics' });
    expect(cfg.publishEnabled).toBe(false);
  });
});

describe('workerId', () => {
  it('combines hostname and pid', () => {
    const id = workerId();
    expect(id).toMatch(/:/);
    expect(id.endsWith(String(process.pid))).toBe(true);
  });
});
