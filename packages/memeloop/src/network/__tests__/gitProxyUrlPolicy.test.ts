import { describe, expect, it } from 'vitest';

import { gitProxyTargetBlockReason } from '../gitProxyUrlPolicy.js';

describe('gitProxyTargetBlockReason', () => {
  it('allows public https hostnames', () => {
    expect(gitProxyTargetBlockReason(new URL('https://gitea.example.com/foo.git/info/refs'))).toBeNull();
  });

  it('blocks loopback and private IPs', () => {
    expect(gitProxyTargetBlockReason(new URL('http://127.0.0.1:3000/repo'))).toBe('loopback_ipv4');
    expect(gitProxyTargetBlockReason(new URL('http://192.168.1.1/x'))).toBe('private_ipv4');
    expect(gitProxyTargetBlockReason(new URL('http://10.0.0.1/x'))).toBe('private_ipv4');
    expect(gitProxyTargetBlockReason(new URL('http://localhost/x'))).toBe('loopback_or_wildcard');
  });

  it('blocks userinfo in URL', () => {
    expect(gitProxyTargetBlockReason(new URL('https://user:pass@gitea.example.com/r'))).toBe('credentials_in_url');
  });

  it('blocks non-http(s) protocols', () => {
    expect(gitProxyTargetBlockReason(new URL('file:///etc/passwd'))).toBe('unsupported_protocol');
  });
});
