import {
  MEMELOOP_SERVICE_TYPE,
  type LanDiscoveryBrowseOptions,
  type LanDiscoveryRegisterOptions,
  type MemeloopServiceInfo,
} from "memeloop";

export { MEMELOOP_SERVICE_TYPE };
export type { LanDiscoveryBrowseOptions, LanDiscoveryRegisterOptions, MemeloopServiceInfo };

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
    const module = require("bonjour-service") as {
      Bonjour?: new() => BonjourLike;
      default?: { Bonjour: new() => BonjourLike };
    };
    return module.Bonjour ?? module.default?.Bonjour ?? null;
  } catch {
    return null;
  }
}

export function __setBonjourFactoryForTest(factory: (() => (new() => BonjourLike) | null) | null): void {
  testBonjourFactory = factory;
}

export function register(options: LanDiscoveryRegisterOptions): () => void {
  const BonjourCtor = getBonjour();
  if (!BonjourCtor) return () => {};

  const bonjour = new BonjourCtor();
  const txt: Record<string, string> = { ...options.txt };
  if (options.nodeId) txt.nodeId = options.nodeId;
  if (options.wsPath) txt.wsPath = options.wsPath;

  bonjour.publish({
    name: options.name,
    type: "memeloop",
    port: options.port,
    txt,
  });

  return () => {
    try {
      bonjour.unpublishAll(() => {
        bonjour.destroy();
      });
    } catch {
      // ignore cleanup errors
    }
  };
}

export function browse(options: LanDiscoveryBrowseOptions): () => void {
  const BonjourCtor = getBonjour();
  if (!BonjourCtor) return () => {};

  const bonjour = new BonjourCtor();
  const browser = bonjour.find({ type: "memeloop" }, (service) => {
    const info: MemeloopServiceInfo = {
      name: service.name,
      host: service.host,
      port: service.port,
      nodeId: service.txt?.nodeId,
      wsPath: service.txt?.wsPath,
      txt: service.txt,
    };
    options.onServiceUp(info);
  });

  return () => {
    try {
      browser.stop();
      bonjour.destroy();
    } catch {
      // ignore cleanup errors
    }
  };
}