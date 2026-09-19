import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WorkerGatewaySession } from 'memeloop';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkerArtifactUploadStore, type WorkerArtifactManifest } from '../workerArtifactUploadStore.js';

const directories: string[] = [];
const session = {
  name: 'session-1',
  run: { uid: 'run-1', attempt: 1, epoch: 1 },
} as WorkerGatewaySession;

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('worker artifact upload store', () => {
  it('streams multi-chunk artifacts to disk and commits a content-addressed manifest', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-worker-artifact-'));
    directories.push(directory);
    const store = createWorkerArtifactUploadStore(directory);
    const bytes = Buffer.alloc(1024 * 1024 + 17, 0x5A);
    const begin = await store.handle(session, {
      operation: 'begin',
      name: 'game-build',
      relativePath: 'dist/game.zip',
      mimeType: 'application/zip',
      sizeBytes: bytes.byteLength,
    }) as { uploadId: string; nextOffset: number };
    expect(begin.nextOffset).toBe(0);

    let offset = 0;
    for (const chunk of [bytes.subarray(0, 600_000), bytes.subarray(600_000)]) {
      const response = await store.handle(session, {
        operation: 'chunk',
        uploadId: begin.uploadId,
        offset,
        byteLength: chunk.byteLength,
        sha256: `sha256:${createHash('sha256').update(chunk).digest('hex')}`,
        data: chunk.toString('base64'),
      }) as { nextOffset: number };
      offset += chunk.byteLength;
      expect(response.nextOffset).toBe(offset);
    }
    const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    await expect(store.handle(session, {
      operation: 'commit',
      uploadId: begin.uploadId,
      sizeBytes: bytes.byteLength,
      contentHash,
    })).resolves.toEqual({
      artifactHandle: expect.stringMatching(
        new RegExp(`^worker-artifact:run-1:manifest:[a-f0-9]{64}:${contentHash}$`),
      ),
      contentHash,
      sizeBytes: bytes.byteLength,
      mimeType: 'application/zip',
      name: 'game-build',
      relativePath: 'dist/game.zip',
    });
    expect(fs.readFileSync(path.join(directory, 'worker-artifacts', 'sha256', contentHash.slice(7))))
      .toEqual(bytes);
  });

  it('accepts an identical retried chunk and rejects cross-session access', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-worker-artifact-'));
    directories.push(directory);
    const store = createWorkerArtifactUploadStore(directory);
    const chunk = Buffer.from('retry-safe');
    const begin = await store.handle(session, {
      operation: 'begin',
      name: 'result',
      relativePath: 'result.txt',
      mimeType: 'text/plain',
      sizeBytes: chunk.byteLength,
    }) as { uploadId: string };
    const request = {
      operation: 'chunk',
      uploadId: begin.uploadId,
      offset: 0,
      byteLength: chunk.byteLength,
      sha256: `sha256:${createHash('sha256').update(chunk).digest('hex')}`,
      data: chunk.toString('base64'),
    };
    await expect(store.handle(session, request)).resolves.toMatchObject({ nextOffset: chunk.byteLength });
    await expect(store.handle(session, request)).resolves.toMatchObject({ nextOffset: chunk.byteLength });
    await expect(store.handle({ ...session, name: 'session-2' }, {
      operation: 'commit',
      uploadId: begin.uploadId,
      sizeBytes: chunk.byteLength,
      contentHash: `sha256:${createHash('sha256').update(chunk).digest('hex')}`,
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('resumes an interrupted upload after recreating the store and commits idempotently', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-worker-artifact-'));
    directories.push(directory);
    const bytes = Buffer.from('durable-worker-artifact');
    const begin = await createWorkerArtifactUploadStore(directory).handle(session, {
      operation: 'begin',
      name: 'durable-result',
      relativePath: 'dist/result.txt',
      mimeType: 'text/plain',
      sizeBytes: bytes.byteLength,
    }) as { uploadId: string };
    const store = createWorkerArtifactUploadStore(directory);
    await store.handle(session, chunkRequest(begin.uploadId, bytes));
    const descriptor = JSON.parse(fs.readFileSync(
      path.join(directory, 'worker-artifacts', '.uploads', `${begin.uploadId}.json`),
      'utf8',
    )) as Record<string, unknown>;
    expect(descriptor).toMatchObject({
      version: 1,
      uploadId: begin.uploadId,
      receivedBytes: bytes.byteLength,
    });
    expect(descriptor).not.toHaveProperty('temporaryPath');
    expect(descriptor).not.toHaveProperty('descriptorPath');
    const contentHash = hash(bytes);
    const request = {
      operation: 'commit',
      uploadId: begin.uploadId,
      sizeBytes: bytes.byteLength,
      contentHash,
    };
    const first = await store.handle(session, request);
    await expect(createWorkerArtifactUploadStore(directory).handle(session, request)).resolves.toEqual(first);
  });

  it('rejects non-canonical workspace paths and invalid chunk sequencing', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-worker-artifact-'));
    directories.push(directory);
    const store = createWorkerArtifactUploadStore(directory);
    for (const relativePath of ['../secret', '/absolute', 'dist//file', 'dist/./file', 'C:\\file']) {
      await expect(store.handle(session, {
        operation: 'begin',
        name: 'invalid-path',
        relativePath,
        mimeType: 'application/octet-stream',
        sizeBytes: 1,
      })).rejects.toMatchObject({ code: 'INVALID' });
    }

    const bytes = Buffer.from('ordered');
    const begin = await store.handle(session, {
      operation: 'begin',
      name: 'ordered',
      relativePath: 'dist/ordered.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: bytes.byteLength,
    }) as { uploadId: string };
    await expect(store.handle(session, chunkRequest(begin.uploadId, bytes, 1)))
      .rejects.toMatchObject({ code: 'INVALID' });
    await expect(store.handle(session, chunkRequest(begin.uploadId, bytes)))
      .resolves.toMatchObject({ nextOffset: bytes.byteLength });
  });

  it('allows a corrected request after a rejected request on the same upload', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-worker-artifact-'));
    directories.push(directory);
    const store = createWorkerArtifactUploadStore(directory);
    const bytes = Buffer.from('retry-after-rejection');
    const begin = await store.handle(session, {
      operation: 'begin',
      name: 'retry',
      relativePath: 'retry.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: bytes.byteLength,
    }) as { uploadId: string };
    const invalidRequest = { ...chunkRequest(begin.uploadId, bytes), sha256: `sha256:${'0'.repeat(64)}` };
    const [first, second] = await Promise.allSettled([
      store.handle(session, invalidRequest),
      store.handle(session, chunkRequest(begin.uploadId, bytes)),
    ]);
    expect(first.status).toBe('rejected');
    expect(second).toMatchObject({ status: 'fulfilled', value: { nextOffset: bytes.byteLength } });
  });

  it('continues writing until a short-write implementation persists the whole chunk', async () => {
    const directory = temporaryDirectory();
    const store = createWorkerArtifactUploadStore(directory);
    const bytes = Buffer.from('partial-write-loop-proof');
    const begin = await beginUpload(store, session, bytes.byteLength);
    const nativeOpen = fs.promises.open.bind(fs.promises);
    let shortWrites = 0;
    const open = vi.spyOn(fs.promises, 'open').mockImplementation(async (filename, flags, mode) => {
      const file = await nativeOpen(filename, flags, mode);
      if (String(filename).endsWith('.part') && flags === (fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0))) {
        const nativeWrite = file.write.bind(file);
        const shortWrite = ((buffer: Buffer, offset: number, length: number, position: number) => {
          shortWrites += 1;
          return nativeWrite(buffer, offset, Math.max(1, Math.ceil(length / 2)), position);
        }) as typeof file.write;
        Object.defineProperty(file, 'write', {
          configurable: true,
          value: shortWrite,
        });
      }
      return file;
    });
    try {
      await expect(store.handle(session, chunkRequest(begin.uploadId, bytes)))
        .resolves.toMatchObject({ nextOffset: bytes.byteLength });
    } finally {
      open.mockRestore();
    }
    expect(shortWrites).toBeGreaterThan(1);
    await expect(store.handle(session, commitRequest(begin.uploadId, bytes)))
      .resolves.toMatchObject({ contentHash: hash(bytes) });
  });

  it('does not publish when commit is already cancelled and permits a clean retry', async () => {
    const directory = temporaryDirectory();
    const store = createWorkerArtifactUploadStore(directory);
    const bytes = Buffer.from('cancel-before-publication');
    const begin = await beginUpload(store, session, bytes.byteLength);
    await store.handle(session, chunkRequest(begin.uploadId, bytes));
    const contentHash = hash(bytes);
    const destination = path.join(directory, 'worker-artifacts', 'sha256', contentHash.slice(7));
    const controller = new AbortController();
    controller.abort();

    await expect(store.handle(session, commitRequest(begin.uploadId, bytes), controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.existsSync(destination)).toBe(false);
    await expect(store.handle(session, commitRequest(begin.uploadId, bytes)))
      .resolves.toMatchObject({ contentHash });
    expect(fs.readFileSync(destination)).toEqual(bytes);
  });

  it('recovers a publication crash when content exists but the part file is gone', async () => {
    const directory = temporaryDirectory();
    const bytes = Buffer.from('published-before-descriptor');
    const firstStore = createWorkerArtifactUploadStore(directory);
    const begin = await beginUpload(firstStore, session, bytes.byteLength);
    await firstStore.handle(session, chunkRequest(begin.uploadId, bytes));
    const contentHash = hash(bytes);
    const uploads = path.join(directory, 'worker-artifacts', '.uploads');
    const destination = path.join(directory, 'worker-artifacts', 'sha256', contentHash.slice(7));
    const descriptorPath = path.join(uploads, `${begin.uploadId}.json`);
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8')) as Record<string, unknown>;
    descriptor.pendingContentHash = contentHash;
    fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));
    fs.renameSync(path.join(uploads, `${begin.uploadId}.part`), destination);

    const recoveredStore = createWorkerArtifactUploadStore(directory);
    const recovered = await recoveredStore.handle(session, commitRequest(begin.uploadId, bytes));
    await expect(createWorkerArtifactUploadStore(directory).handle(session, commitRequest(begin.uploadId, bytes)))
      .resolves.toEqual(recovered);
    expect(fs.readFileSync(destination)).toEqual(bytes);
  });

  it('enforces per-session and global byte and active-upload reservations', async () => {
    const byteDirectory = temporaryDirectory();
    const byteStore = createWorkerArtifactUploadStore(byteDirectory, {
      maxReservedBytesPerSession: 5,
      maxReservedBytesGlobal: 7,
      maxActiveUploadsPerSession: 10,
      maxActiveUploadsGlobal: 10,
    });
    await beginUpload(byteStore, session, 4);
    await expect(beginUpload(byteStore, session, 2)).rejects.toMatchObject({ code: 'EXHAUSTED' });
    await beginUpload(byteStore, alternateSession('session-2'), 3);
    await expect(beginUpload(byteStore, alternateSession('session-3'), 1))
      .rejects.toMatchObject({ code: 'EXHAUSTED' });

    const activeDirectory = temporaryDirectory();
    const activeStore = createWorkerArtifactUploadStore(activeDirectory, {
      maxReservedBytesPerSession: 100,
      maxReservedBytesGlobal: 100,
      maxActiveUploadsPerSession: 1,
      maxActiveUploadsGlobal: 2,
    });
    const byte = Buffer.from('x');
    const first = await beginUpload(activeStore, session, byte.byteLength);
    await expect(beginUpload(activeStore, session, 0)).rejects.toMatchObject({ code: 'EXHAUSTED' });
    await beginUpload(activeStore, alternateSession('session-2'), 0);
    await expect(beginUpload(activeStore, alternateSession('session-3'), 0))
      .rejects.toMatchObject({ code: 'EXHAUSTED' });
    await activeStore.handle(session, chunkRequest(first.uploadId, byte));
    await activeStore.handle(session, commitRequest(first.uploadId, byte));
    await expect(beginUpload(activeStore, session, 0)).resolves.toMatchObject({ nextOffset: 0 });
  });

  it('reconstructs reservations and removes stale uploads on startup', async () => {
    const directory = temporaryDirectory();
    let clock = 1_000;
    const firstStore = createWorkerArtifactUploadStore(directory, {
      maxReservedBytesPerSession: 10,
      maxReservedBytesGlobal: 10,
      maxActiveUploadsPerSession: 1,
      maxActiveUploadsGlobal: 1,
      staleUploadAgeMs: 100,
      now: () => clock,
    });
    const stale = await beginUpload(firstStore, session, 10);
    const quotaReconstructed = createWorkerArtifactUploadStore(directory, {
      maxReservedBytesPerSession: 10,
      maxReservedBytesGlobal: 10,
      maxActiveUploadsPerSession: 1,
      maxActiveUploadsGlobal: 1,
      staleUploadAgeMs: 100,
      now: () => clock,
    });
    await expect(beginUpload(quotaReconstructed, session, 1)).rejects.toMatchObject({ code: 'EXHAUSTED' });
    clock = 1_200;

    const restarted = createWorkerArtifactUploadStore(directory, {
      maxReservedBytesPerSession: 10,
      maxReservedBytesGlobal: 10,
      maxActiveUploadsPerSession: 1,
      maxActiveUploadsGlobal: 1,
      staleUploadAgeMs: 100,
      now: () => clock,
    });
    await expect(beginUpload(restarted, session, 10)).resolves.toMatchObject({ nextOffset: 0 });
    const uploads = path.join(directory, 'worker-artifacts', '.uploads');
    expect(fs.existsSync(path.join(uploads, `${stale.uploadId}.json`))).toBe(false);
    expect(fs.existsSync(path.join(uploads, `${stale.uploadId}.part`))).toBe(false);
  });

  it('opportunistically cleans stale uploads with a bounded scan', async () => {
    const directory = temporaryDirectory();
    let clock = 1_000;
    const store = createWorkerArtifactUploadStore(directory, {
      maxReservedBytesPerSession: 10,
      maxReservedBytesGlobal: 10,
      maxActiveUploadsPerSession: 1,
      maxActiveUploadsGlobal: 1,
      staleUploadAgeMs: 100,
      cleanupScanLimit: 8,
      now: () => clock,
    });
    const stale = await beginUpload(store, session, 10);
    clock = 1_200;

    await expect(beginUpload(store, session, 10)).resolves.toMatchObject({ nextOffset: 0 });
    const uploads = path.join(directory, 'worker-artifacts', '.uploads');
    expect(fs.existsSync(path.join(uploads, `${stale.uploadId}.json`))).toBe(false);
  });

  it('caps sequential retained bytes and manifest counts per run and globally before publication', async () => {
    const byteDirectory = temporaryDirectory();
    const byteStore = createWorkerArtifactUploadStore(byteDirectory, {
      maxRetainedBytesPerRun: 5,
      maxRetainedBytesGlobal: 7,
      maxRetainedManifestsPerRun: 10,
      maxRetainedManifestsGlobal: 10,
    });
    await uploadArtifact(byteStore, session, Buffer.from('aaaa'));
    const perRunBytes = Buffer.from('bb');
    const perRunUpload = await beginUpload(byteStore, session, perRunBytes.byteLength);
    await byteStore.handle(session, chunkRequest(perRunUpload.uploadId, perRunBytes));
    await expect(byteStore.handle(session, commitRequest(perRunUpload.uploadId, perRunBytes)))
      .rejects.toMatchObject({ code: 'EXHAUSTED' });
    expect(contentExists(byteDirectory, perRunBytes)).toBe(false);

    const runTwo = alternateSession('session-2', 'run-2');
    await uploadArtifact(byteStore, runTwo, Buffer.from('ccc'));
    const globalBytes = Buffer.from('d');
    const globalUpload = await beginUpload(byteStore, alternateSession('session-3', 'run-3'), globalBytes.byteLength);
    await byteStore.handle(alternateSession('session-3', 'run-3'), chunkRequest(globalUpload.uploadId, globalBytes));
    await expect(byteStore.handle(
      alternateSession('session-3', 'run-3'),
      commitRequest(globalUpload.uploadId, globalBytes),
    )).rejects.toMatchObject({ code: 'EXHAUSTED' });
    expect(contentExists(byteDirectory, globalBytes)).toBe(false);

    const countDirectory = temporaryDirectory();
    const countStore = createWorkerArtifactUploadStore(countDirectory, {
      maxRetainedBytesPerRun: 100,
      maxRetainedBytesGlobal: 100,
      maxRetainedManifestsPerRun: 1,
      maxRetainedManifestsGlobal: 2,
    });
    await uploadArtifact(countStore, session, Buffer.from('one'));
    await expect(uploadArtifact(countStore, session, Buffer.from('two')))
      .rejects.toMatchObject({ code: 'EXHAUSTED' });
    await uploadArtifact(countStore, runTwo, Buffer.from('three'));
    await expect(uploadArtifact(countStore, alternateSession('session-3', 'run-3'), Buffer.from('four')))
      .rejects.toMatchObject({ code: 'EXHAUSTED' });
  });

  it('reconstructs retained quotas from strict manifests after restart', async () => {
    const directory = temporaryDirectory();
    const options = {
      maxRetainedBytesPerRun: 4,
      maxRetainedBytesGlobal: 4,
      maxRetainedManifestsPerRun: 1,
      maxRetainedManifestsGlobal: 1,
    };
    await uploadArtifact(createWorkerArtifactUploadStore(directory, options), session, Buffer.from('full'));
    const restarted = createWorkerArtifactUploadStore(directory, options);
    const bytes = Buffer.from('x');
    const upload = await beginUpload(restarted, session, bytes.byteLength);
    await restarted.handle(session, chunkRequest(upload.uploadId, bytes));

    await expect(restarted.handle(session, commitRequest(upload.uploadId, bytes)))
      .rejects.toMatchObject({ code: 'EXHAUSTED' });
    expect(contentExists(directory, bytes)).toBe(false);
  });

  it('deduplicates content references and deletes content only after the final run reference', async () => {
    const directory = temporaryDirectory();
    const bytes = Buffer.from('shared-across-runs');
    const store = createWorkerArtifactUploadStore(directory, {
      maxRetainedBytesPerRun: bytes.byteLength,
      maxRetainedBytesGlobal: bytes.byteLength,
      maxRetainedManifestsPerRun: 1,
      maxRetainedManifestsGlobal: 2,
    });
    const runTwo = alternateSession('session-2', 'run-2');
    const first = await uploadArtifact(store, session, bytes);
    const second = await uploadArtifact(store, runTwo, bytes);
    const contentPath = path.join(directory, 'worker-artifacts', 'sha256', hash(bytes).slice(7));
    expect(fs.existsSync(contentPath)).toBe(true);

    await expect(store.deleteArtifact(runTwo.run.uid, first.artifactHandle))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(store.deleteArtifact(session.run.uid, first.artifactHandle)).resolves.toBe(true);
    await expect(store.resolveManifest(session.run.uid, first.artifactHandle))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fs.existsSync(contentPath)).toBe(true);
    await expect(store.readArtifact(runTwo.run.uid, second.artifactHandle, { length: bytes.byteLength }))
      .resolves.toEqual(bytes);

    await expect(store.deleteArtifact(runTwo.run.uid, second.artifactHandle)).resolves.toBe(true);
    expect(fs.existsSync(contentPath)).toBe(false);
    await expect(store.deleteArtifact(runTwo.run.uid, second.artifactHandle)).resolves.toBe(false);
  });

  it('deduplicates same-run content while retaining metadata-distinct manifest identities', async () => {
    const directory = temporaryDirectory();
    const bytes = Buffer.from('same-run-shared-content');
    const store = createWorkerArtifactUploadStore(directory, {
      maxRetainedBytesPerRun: bytes.byteLength * 2,
      maxRetainedBytesGlobal: bytes.byteLength,
      maxRetainedManifestsPerRun: 2,
      maxRetainedManifestsGlobal: 2,
    });
    const first = await uploadArtifact(store, session, bytes, {
      name: 'debug-build',
      relativePath: 'dist/debug.zip',
    });
    const second = await uploadArtifact(store, session, bytes, {
      name: 'release-build',
      relativePath: 'dist/release.zip',
    });
    expect(first.artifactHandle).not.toBe(second.artifactHandle);
    expect(first.contentHash).toBe(second.contentHash);
    const contentPath = path.join(directory, 'worker-artifacts', 'sha256', hash(bytes).slice(7));

    await expect(store.deleteArtifact(session.run.uid, first.artifactHandle)).resolves.toBe(true);
    expect(fs.existsSync(contentPath)).toBe(true);
    await expect(store.resolveManifest(session.run.uid, second.artifactHandle)).resolves.toEqual(second);
    await expect(store.deleteArtifact(session.run.uid, second.artifactHandle)).resolves.toBe(true);
    expect(fs.existsSync(contentPath)).toBe(false);
  });

  it('reclaims manifestless content at startup without deleting referenced content', async () => {
    const directory = temporaryDirectory();
    const store = createWorkerArtifactUploadStore(directory);
    const retainedBytes = Buffer.from('retained-content');
    const retained = await uploadArtifact(store, session, retainedBytes);
    const orphanBytes = Buffer.from('deletion-crash-orphan');
    const orphan = await uploadArtifact(store, alternateSession('session-2', 'run-2'), orphanBytes);
    const root = path.join(directory, 'worker-artifacts');
    const orphanManifest = path.join(
      root,
      '.manifests',
      `${createHash('sha256').update(orphan.artifactHandle).digest('hex')}.json`,
    );
    fs.unlinkSync(orphanManifest);

    const restarted = createWorkerArtifactUploadStore(directory, { cleanupScanLimit: 8 });
    await expect(restarted.resolveManifest(session.run.uid, retained.artifactHandle)).resolves.toEqual(retained);
    expect(contentExists(directory, retainedBytes)).toBe(true);
    expect(contentExists(directory, orphanBytes)).toBe(false);
  });

  it('releases retained quota on trusted deletion so a rejected commit can be retried', async () => {
    const directory = temporaryDirectory();
    const store = createWorkerArtifactUploadStore(directory, {
      maxRetainedBytesPerRun: 3,
      maxRetainedBytesGlobal: 3,
      maxRetainedManifestsPerRun: 1,
      maxRetainedManifestsGlobal: 1,
    });
    const firstBytes = Buffer.from('old');
    const first = await uploadArtifact(store, session, firstBytes);
    const replacement = Buffer.from('new');
    const replacementUpload = await beginUpload(store, session, replacement.byteLength);
    await store.handle(session, chunkRequest(replacementUpload.uploadId, replacement));
    await expect(store.handle(session, commitRequest(replacementUpload.uploadId, replacement)))
      .rejects.toMatchObject({ code: 'EXHAUSTED' });
    expect(contentExists(directory, replacement)).toBe(false);

    await expect(store.deleteArtifact(session.run.uid, first.artifactHandle)).resolves.toBe(true);
    expect(contentExists(directory, firstBytes)).toBe(false);
    await expect(store.handle(session, commitRequest(replacementUpload.uploadId, replacement)))
      .resolves.toMatchObject({ contentHash: hash(replacement) });
    expect(contentExists(directory, replacement)).toBe(true);
  });

  it('resolves, opens, and boundedly reads manifests without accepting arbitrary handles', async () => {
    const directory = temporaryDirectory();
    const store = createWorkerArtifactUploadStore(directory, { maxReadBytes: 8 });
    const bytes = Buffer.from('safe-manifest-consumption');
    const begin = await beginUpload(store, session, bytes.byteLength);
    await store.handle(session, chunkRequest(begin.uploadId, bytes));
    const manifest = await store.handle(session, commitRequest(begin.uploadId, bytes)) as WorkerArtifactManifest;

    await expect(store.resolveManifest(session.run.uid, manifest.artifactHandle)).resolves.toEqual(manifest);
    const opened = await store.openArtifact(session.run.uid, manifest.artifactHandle);
    try {
      const read = Buffer.alloc(bytes.byteLength);
      await opened.file.read(read, 0, read.byteLength, 0);
      expect(read).toEqual(bytes);
    } finally {
      await opened.file.close();
    }
    await expect(store.readArtifact(session.run.uid, manifest.artifactHandle)).resolves.toEqual(bytes.subarray(0, 8));
    await expect(store.readArtifact(session.run.uid, manifest.artifactHandle, { offset: 5, length: 6 }))
      .resolves.toEqual(bytes.subarray(5, 11));
    await expect(store.readArtifact(session.run.uid, manifest.artifactHandle, { length: 9 }))
      .rejects.toMatchObject({ code: 'INVALID' });

    await expect(store.resolveManifest('run-2', manifest.artifactHandle))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(store.resolveManifest(session.run.uid, 'worker-artifact:run-1:sha256:../../etc/passwd'))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(store.resolveManifest(
      session.run.uid,
      `worker-artifact:run-1:manifest:${'0'.repeat(64)}:sha256:${'0'.repeat(64)}`,
    ))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reserves future upload bytes above a host free-space watermark and rechecks commits', async () => {
    const directory = temporaryDirectory();
    let availableBytes = 20n;
    const statfs = vi.fn(async () => ({ availableBytes }));
    const store = createWorkerArtifactUploadStore(directory, {
      minFreeDiskBytes: 10,
      statfs,
    });

    const reserved = await beginUpload(store, session, 8);
    await expect(beginUpload(store, alternateSession('session-2'), 3))
      .rejects.toMatchObject({ code: 'EXHAUSTED' });
    const bytes = Buffer.alloc(8, 0x51);
    await store.handle(session, chunkRequest(reserved.uploadId, bytes));

    availableBytes = 9n;
    await expect(store.handle(session, commitRequest(reserved.uploadId, bytes)))
      .rejects.toMatchObject({ code: 'EXHAUSTED' });
    expect(contentExists(directory, bytes)).toBe(false);

    availableBytes = 10n;
    await expect(store.handle(session, commitRequest(reserved.uploadId, bytes)))
      .resolves.toMatchObject({ contentHash: hash(bytes) });
    expect(statfs).toHaveBeenCalledWith(
      path.join(directory, 'worker-artifacts'),
      expect.any(AbortSignal),
    );
  });

  it('does not create an upload when the disk-stat boundary is cancelled', async () => {
    const directory = temporaryDirectory();
    const controller = new AbortController();
    const store = createWorkerArtifactUploadStore(directory, {
      minFreeDiskBytes: 1,
      statfs: async () => {
        controller.abort();
        return { availableBytes: 1_000n };
      },
    });

    await expect(store.handle(session, {
      operation: 'begin',
      name: 'cancelled',
      relativePath: 'dist/cancelled.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: 1,
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.readdirSync(path.join(directory, 'worker-artifacts', '.uploads'))).toEqual([]);
  });

  it('expires retained manifests durably and releases recovered quotas after restart', async () => {
    const directory = temporaryDirectory();
    let clock = 1_000;
    const options = {
      maxRetainedBytesPerRun: 4,
      maxRetainedBytesGlobal: 4,
      maxRetainedManifestsPerRun: 1,
      maxRetainedManifestsGlobal: 1,
      retainedArtifactTtlMs: 100,
      cleanupScanLimit: 1,
      now: () => clock,
    };
    const bytes = Buffer.from('old!');
    const manifest = await uploadArtifact(createWorkerArtifactUploadStore(directory, options), session, bytes);
    clock = 1_099;
    await expect(
      createWorkerArtifactUploadStore(directory, options).resolveManifest(
        session.run.uid,
        manifest.artifactHandle,
      ),
    ).resolves.toEqual(manifest);

    clock = 1_100;
    const restarted = createWorkerArtifactUploadStore(directory, options);
    await expect(restarted.resolveManifest(session.run.uid, manifest.artifactHandle))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(contentExists(directory, bytes)).toBe(false);
    await expect(uploadArtifact(restarted, session, Buffer.from('new!')))
      .resolves.toMatchObject({ sizeBytes: 4 });
  });

  it('deletes every retained artifact for a terminal run without deleting shared content', async () => {
    const directory = temporaryDirectory();
    const store = createWorkerArtifactUploadStore(directory);
    const shared = Buffer.from('shared-run-content');
    const unique = Buffer.from('run-one-only');
    const runTwo = alternateSession('session-2', 'run-2');
    const first = await uploadArtifact(store, session, shared);
    const second = await uploadArtifact(store, session, unique, {
      name: 'unique',
      relativePath: 'dist/unique.bin',
    });
    const retained = await uploadArtifact(store, runTwo, shared);
    const pendingRunOne = await beginUpload(store, session, 8, {
      name: 'pending-run-one',
      relativePath: 'dist/pending-run-one.bin',
    });
    const pendingRunTwo = await beginUpload(store, runTwo, 8, {
      name: 'pending-run-two',
      relativePath: 'dist/pending-run-two.bin',
    });

    await expect(store.deleteArtifactsForRun(session.run.uid)).resolves.toBe(2);
    await expect(store.resolveManifest(session.run.uid, first.artifactHandle))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.resolveManifest(session.run.uid, second.artifactHandle))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(contentExists(directory, unique)).toBe(false);
    expect(contentExists(directory, shared)).toBe(true);
    const uploadsDirectory = path.join(directory, 'worker-artifacts', '.uploads');
    expect(fs.existsSync(path.join(uploadsDirectory, `${pendingRunOne.uploadId}.json`))).toBe(false);
    expect(fs.existsSync(path.join(uploadsDirectory, `${pendingRunOne.uploadId}.part`))).toBe(false);
    expect(fs.existsSync(path.join(uploadsDirectory, `${pendingRunTwo.uploadId}.json`))).toBe(true);
    expect(fs.existsSync(path.join(uploadsDirectory, `${pendingRunTwo.uploadId}.part`))).toBe(true);
    await expect(store.readArtifact(runTwo.run.uid, retained.artifactHandle, { length: shared.byteLength }))
      .resolves.toEqual(shared);
    await expect(store.deleteArtifactsForRun(session.run.uid)).resolves.toBe(0);
  });

  it('keeps run deletion restart-safe when cancellation arrives during durable cleanup', async () => {
    const directory = temporaryDirectory();
    const store = createWorkerArtifactUploadStore(directory);
    await uploadArtifact(store, session, Buffer.from('first'), {
      name: 'first',
      relativePath: 'dist/first.bin',
    });
    await uploadArtifact(store, session, Buffer.from('second'), {
      name: 'second',
      relativePath: 'dist/second.bin',
    });
    const controller = new AbortController();
    const nativeUnlink = fs.promises.unlink.bind(fs.promises);
    const unlink = vi.spyOn(fs.promises, 'unlink').mockImplementation(async (filename) => {
      await nativeUnlink(filename);
      if (String(filename).includes(`${path.sep}.manifests${path.sep}`)) controller.abort();
    });
    try {
      await expect(store.deleteArtifactsForRun(session.run.uid, controller.signal))
        .rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      unlink.mockRestore();
    }

    const restarted = createWorkerArtifactUploadStore(directory);
    await expect(restarted.deleteArtifactsForRun(session.run.uid)).resolves.toBe(1);
    await expect(restarted.deleteArtifactsForRun(session.run.uid)).resolves.toBe(0);
  });
});

function hash(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function chunkRequest(uploadId: string, bytes: Buffer, offset = 0): Record<string, unknown> {
  return {
    operation: 'chunk',
    uploadId,
    offset,
    byteLength: bytes.byteLength,
    sha256: hash(bytes),
    data: bytes.toString('base64'),
  };
}

function commitRequest(uploadId: string, bytes: Buffer): Record<string, unknown> {
  return {
    operation: 'commit',
    uploadId,
    sizeBytes: bytes.byteLength,
    contentHash: hash(bytes),
  };
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-worker-artifact-'));
  directories.push(directory);
  return directory;
}

async function beginUpload(
  store: ReturnType<typeof createWorkerArtifactUploadStore>,
  workerSession: WorkerGatewaySession,
  sizeBytes: number,
  metadata: { name?: string; relativePath?: string; mimeType?: string } = {},
): Promise<{ uploadId: string; nextOffset: number }> {
  return store.handle(workerSession, {
    operation: 'begin',
    name: metadata.name ?? 'artifact',
    relativePath: metadata.relativePath ?? 'dist/artifact.bin',
    mimeType: metadata.mimeType ?? 'application/octet-stream',
    sizeBytes,
  }) as Promise<{ uploadId: string; nextOffset: number }>;
}

function alternateSession(name: string, runUid = 'run-1'): WorkerGatewaySession {
  return {
    ...session,
    name,
    run: { ...session.run, uid: runUid },
  };
}

async function uploadArtifact(
  store: ReturnType<typeof createWorkerArtifactUploadStore>,
  workerSession: WorkerGatewaySession,
  bytes: Buffer,
  metadata: { name?: string; relativePath?: string; mimeType?: string } = {},
): Promise<WorkerArtifactManifest> {
  const upload = await beginUpload(store, workerSession, bytes.byteLength, metadata);
  if (bytes.byteLength > 0) await store.handle(workerSession, chunkRequest(upload.uploadId, bytes));
  return store.handle(workerSession, commitRequest(upload.uploadId, bytes)) as Promise<WorkerArtifactManifest>;
}

function contentExists(directory: string, bytes: Buffer): boolean {
  return fs.existsSync(path.join(directory, 'worker-artifacts', 'sha256', hash(bytes).slice(7)));
}
