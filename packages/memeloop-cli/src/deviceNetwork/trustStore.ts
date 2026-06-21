import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DeviceTrustStore, TrustedDeviceRecord } from 'memeloop';

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
  fs.writeFileSync(filePath, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
}

export class FileDeviceTrustStore implements DeviceTrustStore {
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
}
