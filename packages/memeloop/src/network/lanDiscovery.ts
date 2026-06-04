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
