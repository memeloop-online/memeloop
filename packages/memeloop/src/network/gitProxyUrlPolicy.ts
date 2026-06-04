/**
 * Git HTTP 反向代理目标校验：降低 SSRF 风险（内网/metadata 等）。
 * 仍依赖 getBackendUrl 返回可信基础 URL；此处拦截明显危险的解析结果。
 */

function ipv4Parts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  return m.slice(1, 5).map((x) => Number(x));
}

function isPrivateOrLoopbackIpv4(host: string): boolean {
  const p = ipv4Parts(host);
  if (!p || p.some((n) => n > 255)) return false;
  const [a, b] = p;
  if (a === 127 || a === 0) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** 若目标 URL 不允许作为 Git 代理上游，返回简短原因；否则 null。 */
export function gitProxyTargetBlockReason(url: URL): string | null {
  if (url.username || url.password) {
    return 'credentials_in_url';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'unsupported_protocol';
  }
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '[::]' ||
    host === '::'
  ) {
    return 'loopback_or_wildcard';
  }
  if (host.startsWith('127.')) {
    return 'loopback_ipv4';
  }
  if (isPrivateOrLoopbackIpv4(host)) {
    return 'private_ipv4';
  }
  if (host.includes(':') && !host.startsWith('[')) {
    const lower = host.toLowerCase();
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
      return 'private_ipv6';
    }
    if (lower === '::1') {
      return 'loopback_ipv6';
    }
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1).toLowerCase();
    if (inner === '::1' || inner.startsWith('fe80:') || inner.startsWith('fc') || inner.startsWith('fd')) {
      return 'blocked_ipv6_literal';
    }
  }
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'metadata.google.internal' || h.endsWith('.internal')) {
    return 'internal_hostname';
  }
  return null;
}
