/**
 * LAN zero-config discovery: register and browse _memeloop._tcp via bonjour (mDNS).
 * Node-only; requires optional peer bonjour-service.
 */

export const MEMELOOP_SERVICE_TYPE = '_memeloop._tcp';

export interface MemeloopServiceInfo {
  name: string;
  host: string;
  port: number;
  nodeId?: string;
  wsPath?: string;
  txt?: Record<string, string>;
}

export interface LanDiscoveryRegisterOptions {
  name: string;
  port: number;
  nodeId?: string;
  wsPath?: string;
  txt?: Record<string, string>;
}

export interface LanDiscoveryBrowseOptions {
  onServiceUp: (info: MemeloopServiceInfo) => void;
  onServiceDown?: (name: string) => void;
}

interface BonjourLike {
  publish(options: { name: string; type: string; port: number; txt?: Record<string, string> }): { stop: () => void };
  unpublishAll(callback: () => void): void;
  destroy(): void;
  find(options: { type: string }, callback: (svc: { name: string; host: string; port: number; txt?: Record<string, string> }) => void): { stop: () => void };
}

let testBonjourFactory: (() => (new() => BonjourLike) | null) | null = null;

function getBonjour(): (new() => BonjourLike) | null {
  if (testBonjourFactory) return testBonjourFactory();
  try {
    const m = require('bonjour-service') as { Bonjour?: new() => BonjourLike; default?: { Bonjour: new() => BonjourLike } };
    return m.Bonjour ?? m.default?.Bonjour ?? null;
  } catch {
    return null;
  }
}

/** Test-only seam: inject bonjour factory to avoid depending on real mDNS runtime. */
export function __setBonjourFactoryForTest(factory: (() => (new() => BonjourLike) | null) | null): void {
  testBonjourFactory = factory;
}

/**
 * Register this node as _memeloop._tcp so others can discover it.
 * Returns a stop function to unregister.
 */
export function register(options: LanDiscoveryRegisterOptions): () => void {
  const BonjourCtor = getBonjour();
  if (!BonjourCtor) {
    return () => {};
  }
  const bonjour = new BonjourCtor();
  const txt: Record<string, string> = { ...options.txt };
  if (options.nodeId) txt.nodeId = options.nodeId;
  if (options.wsPath) txt.wsPath = options.wsPath;

  bonjour.publish({
    name: options.name,
    type: 'memeloop',
    port: options.port,
    txt,
  });
  return () => {
    try {
      bonjour.unpublishAll(() => {
        bonjour.destroy();
      });
    } catch (_) {
      // ignore
    }
  };
}

/**
 * Browse for _memeloop._tcp services on the LAN.
 * Calls onServiceUp for each discovered service; optionally onServiceDown when it goes away.
 * Returns a stop function to stop browsing.
 */
export function browse(options: LanDiscoveryBrowseOptions): () => void {
  const Bonjour = getBonjour();
  if (!Bonjour) {
    return () => {};
  }
  const bonjour = new Bonjour();
  const browser = bonjour.find({ type: 'memeloop' }, (svc: { name: string; host: string; port: number; txt?: Record<string, string> }) => {
    const info: MemeloopServiceInfo = {
      name: svc.name,
      host: svc.host,
      port: svc.port,
      nodeId: svc.txt?.nodeId,
      wsPath: svc.txt?.wsPath,
      txt: svc.txt,
    };
    options.onServiceUp(info);
  });
  return () => {
    try {
      browser.stop();
      bonjour.destroy();
    } catch (_) {
      // ignore
    }
  };
}
