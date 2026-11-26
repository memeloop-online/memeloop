import type { DeviceCapabilities, DeviceNetworkListenOptions } from 'memeloop/device-network/portable';

export const emptyCapabilities: DeviceCapabilities = {
  tools: [],
  mcpServers: [],
  hasWiki: false,
  agentLoop: false,
  imChannels: [],
  wikis: [],
};

export const defaultListen: DeviceNetworkListenOptions = {
  addresses: ['/ip4/0.0.0.0/tcp/0', '/ip4/0.0.0.0/tcp/0/ws'],
};
