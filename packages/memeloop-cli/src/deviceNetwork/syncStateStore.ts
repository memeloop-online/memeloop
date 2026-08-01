import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { DeviceSyncStateStore, VersionVector } from 'memeloop';

export class FileDeviceSyncStateStore implements DeviceSyncStateStore {
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly filename: string) {}

  public async loadVersionVector(): Promise<VersionVector> {
    await this.mutation;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filename, 'utf8'));
      return parseVersionVector(parsed);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return {};
      throw error;
    }
  }

  public async saveVersionVector(versionVector: VersionVector): Promise<void> {
    const snapshot = parseVersionVector(versionVector);
    const operation = this.mutation.then(() => this.writeAtomically(snapshot));
    this.mutation = operation.catch(() => undefined);
    await operation;
  }

  private async writeAtomically(versionVector: VersionVector): Promise<void> {
    const directory = path.dirname(this.filename);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
    let created = false;
    try {
      const file = await open(temporary, 'wx', 0o600);
      created = true;
      try {
        await file.writeFile(`${JSON.stringify(versionVector)}\n`, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.filename);
      created = false;
      await chmod(this.filename, 0o600);
    } finally {
      if (created) await unlink(temporary).catch(() => undefined);
    }
  }
}

function parseVersionVector(value: unknown): VersionVector {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_device_sync_state');
  }
  const versionVector: VersionVector = {};
  for (const [originNodeId, clock] of Object.entries(value)) {
    if (
      originNodeId.length === 0 ||
      typeof clock !== 'number' ||
      !Number.isSafeInteger(clock) ||
      clock < 0
    ) {
      throw new Error('invalid_device_sync_state');
    }
    versionVector[originNodeId] = clock;
  }
  return versionVector;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
