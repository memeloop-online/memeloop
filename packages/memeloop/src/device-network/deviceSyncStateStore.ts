import type { VersionVector } from '../sync/protocol.js';

export interface DeviceSyncStateStore {
  loadVersionVector(): Promise<VersionVector>;
  saveVersionVector(versionVector: VersionVector): Promise<void>;
}

export class MemoryDeviceSyncStateStore implements DeviceSyncStateStore {
  private versionVector: VersionVector;

  constructor(initial: VersionVector = {}) {
    this.versionVector = { ...initial };
  }

  public async loadVersionVector(): Promise<VersionVector> {
    return { ...this.versionVector };
  }

  public async saveVersionVector(versionVector: VersionVector): Promise<void> {
    this.versionVector = { ...versionVector };
  }
}
