import { describe, expect, it } from 'vitest';
import { transition, FAILURE_STATE_CODE, VALIDATION_SEQUENCE } from '../validate/stateMachine.js';
import { FAILURE_CODES } from '../failures.js';

describe('validation state machine (plan §11.2)', () => {
  it('walks unconfigured → dns → tcp → tls → http → parse → probing → healthy', () => {
    let s = transition('unconfigured', 'success');
    expect(s.state).toBe('dns');
    s = transition(s.state as 'dns', 'success');
    expect(s.state).toBe('tcp');
    s = transition(s.state as 'tcp', 'success');
    expect(s.state).toBe('tls');
    s = transition(s.state as 'tls', 'success');
    expect(s.state).toBe('http');
    s = transition(s.state as 'http', 'success');
    expect(s.state).toBe('parse');
    s = transition(s.state as 'parse', 'success');
    expect(s.state).toBe('probing');
    s = transition(s.state as 'probing', 'probe_pass');
    expect(s.state).toBe('healthy');
  });

  it('mapping: FAILURE_STATE_CODE covers every failure state', () => {
    expect(Object.keys(FAILURE_STATE_CODE).sort()).toEqual([
      'fail_auth',
      'fail_body',
      'fail_dns',
      'fail_empty',
      'fail_path',
      'fail_probe',
      'fail_tcp',
      'fail_throttled',
      'fail_tls',
      'fail_upstream',
    ]);
  });

  it('dns failure → fail_dns with dns_nxdomain code', () => {
    const r = transition('dns', 'fail');
    expect(r.state).toBe('fail_dns');
    expect(r.code).toBe('dns_nxdomain');
  });

  it('dns timeout → fail_dns with dns_timeout code', () => {
    const r = transition('dns', 'timeout');
    expect(r.state).toBe('fail_dns');
    expect(r.code).toBe('dns_timeout');
  });

  it('tcp refused → fail_tcp with tcp_refused; tcp timeout → tcp_timeout', () => {
    expect(transition('tcp', 'refused')).toMatchObject({ state: 'fail_tcp', code: 'tcp_refused' });
    expect(transition('tcp', 'timeout')).toMatchObject({ state: 'fail_tcp', code: 'tcp_timeout' });
  });

  it('tls cert invalid → tls_cert_invalid; protocol → tls_protocol', () => {
    expect(transition('tls', 'cert_invalid')).toMatchObject({ state: 'fail_tls', code: 'tls_cert_invalid' });
    expect(transition('tls', 'protocol')).toMatchObject({ state: 'fail_tls', code: 'tls_protocol' });
  });

  it('http 401/403/404/429/5xx map to the exact §11.3 codes', () => {
    expect(transition('http', 'unauthorized')).toMatchObject({ state: 'fail_auth', code: 'http_401' });
    expect(transition('http', 'forbidden_region')).toMatchObject({ state: 'fail_auth', code: 'http_403_region' });
    expect(transition('http', 'forbidden_other')).toMatchObject({ state: 'fail_auth', code: 'http_403_other' });
    expect(transition('http', 'not_found')).toMatchObject({ state: 'fail_path', code: 'http_404' });
    expect(transition('http', 'throttled')).toMatchObject({ state: 'fail_throttled', code: 'http_429' });
    expect(transition('http', 'upstream')).toMatchObject({ state: 'fail_upstream', code: 'http_5xx' });
  });

  it('parse failures: non-json → body_not_json, unexpected shape → body_unexpected_shape, empty → models_empty', () => {
    expect(transition('parse', 'not_json')).toMatchObject({ state: 'fail_body', code: 'body_not_json' });
    expect(transition('parse', 'unexpected_shape')).toMatchObject({ state: 'fail_body', code: 'body_unexpected_shape' });
    expect(transition('parse', 'empty')).toMatchObject({ state: 'fail_empty', code: 'models_empty' });
  });

  it('probing: partial fail → degraded, all fail → fail_probe, pass → healthy', () => {
    expect(transition('probing', 'probe_partial')).toMatchObject({ state: 'degraded' });
    expect(transition('probing', 'probe_all_fail')).toMatchObject({ state: 'fail_probe' });
    expect(transition('probing', 'probe_pass')).toMatchObject({ state: 'healthy' });
  });

  it('healthy → degraded on drift, degraded → healthy on reprobe', () => {
    expect(transition('healthy', 'fail')).toMatchObject({ state: 'degraded' });
    expect(transition('degraded', 'success')).toMatchObject({ state: 'healthy' });
  });

  it('every failure state yields a valid §11.3 failure code', () => {
    // Each failure state must be reachable from its parent stage and map to a
    // known §11.3 code.
    expect(FAILURE_STATE_CODE.fail_dns).toBe('dns_nxdomain');
    expect(FAILURE_STATE_CODE.fail_tcp).toBe('tcp_refused');
    expect(FAILURE_STATE_CODE.fail_tls).toBe('tls_cert_invalid');
    expect(FAILURE_STATE_CODE.fail_auth).toBe('http_401');
    expect(FAILURE_STATE_CODE.fail_path).toBe('http_404');
    expect(FAILURE_STATE_CODE.fail_throttled).toBe('http_429');
    expect(FAILURE_STATE_CODE.fail_upstream).toBe('http_5xx');
    expect(FAILURE_STATE_CODE.fail_body).toBe('body_not_json');
    expect(FAILURE_STATE_CODE.fail_empty).toBe('models_empty');
    expect(FAILURE_STATE_CODE.fail_probe).toBe('probe_no_tool_calling');
    for (const code of Object.values(FAILURE_STATE_CODE)) {
      expect(code).toBeTruthy();
      expect(FAILURE_CODES).toContain(code);
    }
  });

  it('VALIDATION_SEQUENCE is ordered per §11.2', () => {
    expect(VALIDATION_SEQUENCE).toEqual([
      'unconfigured',
      'dns',
      'tcp',
      'tls',
      'http',
      'parse',
      'probing',
      'healthy',
      'degraded',
    ]);
  });
});
