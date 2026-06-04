/**
 * Node connectivity: public IP detection, frp tunnel placeholder, hybrid route (LAN first, frp fallback).
 * Actual frp tunnel can be started via startFrpTunnel (caller provides frp client or uses frp-web/bridge).
 */

export interface ConnectivityState {
  /** Detected public IP if any */
  publicIP: string | null;
  /** Frp address (host:port) when tunnel is active */
  frpAddress: string | null;
  /** Local WS server port */
  localPort: number;
}

export interface FrpTunnelOptions {
  /** Frps server URL (e.g. frps.memeloop.com:7000) */
  serverAddr: string;
  /** Local port to expose (WS server) */
  localPort: number;
  /** Optional token for frps auth */
  token?: string;
}

export type FrpTunnelStop = () => Promise<void>;

/**
 * Detect public IP via external HTTP service.
 * Returns null if behind NAT or request fails.
 */
export async function detectPublicIP(): Promise<string | null> {
  const urls = [
    'https://api.ipify.org?format=text',
    'https://ifconfig.me/ip',
    'https://icanhazip.com',
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const ip = (await res.text()).trim();
        if (ip && /^[\d.]+$/.test(ip)) return ip;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Resolve the best connect address for a node: LAN first, then frp.
 */
export function resolveConnectAddress(
  node: { connectivity?: { lanAddress?: string; frpAddress?: string; publicIP?: string } },
  preferLan = true,
): string | null {
  if (!node?.connectivity) return null;
  const { lanAddress, frpAddress, publicIP } = node.connectivity;
  if (preferLan && lanAddress) return lanAddress;
  if (frpAddress) return frpAddress;
  if (publicIP) return publicIP;
  if (!preferLan && lanAddress) return lanAddress;
  return null;
}

/**
 * Connectivity manager: holds public IP, optional frp address, and local port.
 * Call detectPublicIP() on start; startFrpTunnel() is provided by caller (e.g. memeloop-cli).
 */
export class ConnectivityManager {
  private state: ConnectivityState = {
    publicIP: null,
    frpAddress: null,
    localPort: 0,
  };
  private frpStop: FrpTunnelStop | null = null;
  private probeInterval: ReturnType<typeof setInterval> | null = null;

  constructor(localPort: number) {
    this.state.localPort = localPort;
  }

  getState(): Readonly<ConnectivityState> {
    return this.state;
  }

  /** Call once at startup to detect public IP. */
  async detectPublicIP(): Promise<string | null> {
    const ip = await detectPublicIP();
    this.state.publicIP = ip;
    return ip;
  }

  /** Set frp address when tunnel is started (called by startFrpTunnel callback). */
  setFrpAddress(addr: string | null): void {
    this.state.frpAddress = addr;
  }

  /**
   * Start frp tunnel. startTunnelFn should be provided by the host (e.g. memeloop-cli)
   * and can use frp-web/bridge or spawn frpc. Returns stop function.
   */
  async startFrpTunnel(
    options: FrpTunnelOptions,
    startTunnelFunction: (options_: FrpTunnelOptions) => Promise<{ frpAddress: string; stop: FrpTunnelStop }>,
  ): Promise<FrpTunnelStop> {
    if (this.frpStop) {
      await this.frpStop();
      this.frpStop = null;
    }
    const { frpAddress, stop } = await startTunnelFunction(options);
    this.state.frpAddress = frpAddress;
    this.frpStop = stop;
    return async () => {
      await stop();
      this.frpStop = null;
      this.state.frpAddress = null;
    };
  }

  /**
   * Start periodic probe to re-detect public IP (e.g. every 5 min) and optionally
   * re-check LAN reachability. Callback can re-resolve routes.
   */
  startProbe(intervalMs: number, onProbe?: () => void | Promise<void>): void {
    if (this.probeInterval) return;
    this.probeInterval = setInterval(async () => {
      await this.detectPublicIP();
      await onProbe?.();
    }, intervalMs);
  }

  stopProbe(): void {
    if (this.probeInterval) {
      clearInterval(this.probeInterval);
      this.probeInterval = null;
    }
  }

  /** Get the best address this node can be reached at (for registering to cloud). */
  getAdvertisedAddress(): { type: 'publicIP' | 'frp'; address: string } | null {
    if (this.state.publicIP) {
      return { type: 'publicIP', address: `${this.state.publicIP}:${this.state.localPort}` };
    }
    if (this.state.frpAddress) {
      return { type: 'frp', address: this.state.frpAddress };
    }
    return null;
  }
}
