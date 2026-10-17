import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DeviceCloudCommitFence, DeviceTrustStore, TrustedDeviceRecord } from 'memeloop';

/**
 * CLI host contract for a durable, generation-CAS Cloud directory snapshot.
 * Generic per-record async DeviceTrustStore methods cannot satisfy this.
 */
export interface CliCloudDirectorySnapshotTrustStore extends DeviceTrustStore {
  commitCloudAccountSnapshot(
    records: readonly TrustedDeviceRecord[],
    fence: DeviceCloudCommitFence,
  ): readonly TrustedDeviceRecord[] | undefined;
}

export function getDefaultDeviceTrustStorePath(): string {
  return path.join(os.homedir(), '.memeloop', 'trusted-devices.json');
}

function isTrustedDeviceRecord(value: unknown): value is TrustedDeviceRecord {
  const record = value as Record<string, unknown> | undefined;
  return Boolean(
    record &&
      typeof record.peerId === 'string' &&
      typeof record.publicKeyMultibase === 'string' &&
      typeof record.deviceName === 'string' &&
      typeof record.platform === 'string' &&
      typeof record.trustMode === 'string' &&
      typeof record.createdAt === 'number',
  );
}

function readTrustedDevices(filePath: string): TrustedDeviceRecord[] {
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isTrustedDeviceRecord);
}

function writeTrustedDevices(filePath: string, records: TrustedDeviceRecord[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

export class FileDeviceTrustStore implements CliCloudDirectorySnapshotTrustStore {
  constructor(private readonly filePath = getDefaultDeviceTrustStorePath()) {}

  public async loadTrustedDevices(): Promise<TrustedDeviceRecord[]> {
    return readTrustedDevices(this.filePath);
  }

  public async saveTrustedDevice(record: TrustedDeviceRecord): Promise<void> {
    const records = readTrustedDevices(this.filePath);
    const next = records.filter((current) => current.peerId !== record.peerId);
    next.push(record);
    writeTrustedDevices(this.filePath, next);
  }

  public async removeTrustedDevice(peerId: string): Promise<void> {
    const records = readTrustedDevices(this.filePath).filter((record) => record.peerId !== peerId);
    writeTrustedDevices(this.filePath, records);
  }

  public commitCloudAccountSnapshot(
    records: readonly TrustedDeviceRecord[],
    fence: DeviceCloudCommitFence,
  ): readonly TrustedDeviceRecord[] | undefined {
    assertCloudAccountSnapshot(records);
    let committed: TrustedDeviceRecord[] | undefined;
    fence.commitSynchronous(() => {
      const current = readTrustedDevices(this.filePath);
      const nextByPeerId = new Map(
        current
          .filter(record => record.trustMode !== 'cloud-account')
          .map(record => [record.peerId, record]),
      );
      for (const record of records) {
        // A concurrently paired device always wins over Cloud account trust.
        if (nextByPeerId.get(record.peerId)?.trustMode === 'local-pairing') continue;
        nextByPeerId.set(record.peerId, { ...record });
      }
      const next = [...nextByPeerId.values()].sort((left, right) => left.peerId < right.peerId ? -1 : left.peerId > right.peerId ? 1 : 0);
      writeTrustedDevices(this.filePath, next);
      committed = next;
    });
    return committed?.map(record => ({ ...record }));
  }
}

function assertCloudAccountSnapshot(records: readonly TrustedDeviceRecord[]): void {
  const peerIds = new Set<string>();
  for (const record of records) {
    if (record.trustMode !== 'cloud-account') {
      throw new TypeError('Cloud directory snapshot may only contain cloud-account records');
    }
    if (peerIds.has(record.peerId)) {
      throw new TypeError('Cloud directory snapshot contains a duplicate PeerId');
    }
    peerIds.add(record.peerId);
  }
}
