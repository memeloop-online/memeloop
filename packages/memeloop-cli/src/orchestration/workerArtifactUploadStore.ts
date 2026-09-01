import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { OrchestrationError, type WorkerGatewaySession } from 'memeloop';

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_CHUNK_BYTES = 700 * 1024;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const UPLOAD_ID_PATTERN = /^[a-f0-9]{48}$/;
const MANIFEST_FILENAME_PATTERN = /^[a-f0-9]{64}\.json$/;
const CONTENT_FILENAME_PATTERN = /^[a-f0-9]{64}$/;
const MANIFEST_HANDLE_TAIL_PATTERN = /^manifest:([a-f0-9]{64}):(sha256:[a-f0-9]{64})$/;
const DEFAULT_SIGNAL = new AbortController().signal;

interface WorkerArtifactUpload {
  version: 1;
  uploadId: string;
  sessionName: string;
  runUid: string;
  name: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  receivedBytes: number;
  createdAtMs: number;
  updatedAtMs: number;
  pendingContentHash?: string;
  completed?: WorkerArtifactManifest;
}

interface StoredWorkerArtifactManifest {
  version: 1;
  runUid: string;
  createdAtMs: number;
  manifest: WorkerArtifactManifest;
}

interface Reservation {
  sessionKey: string;
  sizeBytes: number;
  pendingWriteBytes: number;
}

interface ReservationTotals {
  count: number;
  bytes: number;
}

interface ContentInspection {
  dev: bigint;
  ino: bigint;
}

interface RetainedTotals {
  count: number;
  bytes: number;
}

interface ContentReferences {
  count: number;
  sizeBytes: number;
}

export interface WorkerArtifactManifest {
  artifactHandle: string;
  contentHash: string;
  sizeBytes: number;
  mimeType: string;
  name: string;
  relativePath: string;
}

export interface OpenWorkerArtifact {
  manifest: WorkerArtifactManifest;
  file: fs.promises.FileHandle;
}

export interface WorkerArtifactReadOptions {
  offset?: number;
  length?: number;
}

export interface WorkerArtifactUploadStoreOptions {
  maxReservedBytesPerSession?: number;
  maxReservedBytesGlobal?: number;
  maxActiveUploadsPerSession?: number;
  maxActiveUploadsGlobal?: number;
  maxRetainedBytesPerRun?: number;
  maxRetainedBytesGlobal?: number;
  maxRetainedManifestsPerRun?: number;
  maxRetainedManifestsGlobal?: number;
  /** Retained manifests and their unreferenced content are reclaimed after this duration. */
  retainedArtifactTtlMs?: number;
  /** New reservations and commits fail before crossing this host free-space watermark. */
  minFreeDiskBytes?: number;
  staleUploadAgeMs?: number;
  cleanupScanLimit?: number;
  maxReadBytes?: number;
  now?: () => number;
  /** Injectable host boundary for deterministic tests and non-standard filesystems. */
  statfs?: (directory: string, signal: AbortSignal) => Promise<{ availableBytes: bigint }>;
}

export interface WorkerArtifactUploadStore {
  handle(session: WorkerGatewaySession, payload: unknown, signal?: AbortSignal): Promise<unknown>;
  resolveManifest(
    runUid: string,
    artifactHandle: string,
    signal?: AbortSignal,
  ): Promise<WorkerArtifactManifest>;
  openArtifact(
    runUid: string,
    artifactHandle: string,
    signal?: AbortSignal,
  ): Promise<OpenWorkerArtifact>;
  readArtifact(
    runUid: string,
    artifactHandle: string,
    options?: WorkerArtifactReadOptions,
    signal?: AbortSignal,
  ): Promise<Buffer>;
  deleteArtifact(runUid: string, artifactHandle: string, signal?: AbortSignal): Promise<boolean>;
  /**
   * Trusted lifecycle hook. Call only after the run is terminal and its
   * WorkerSession has been revoked, so no new upload can race this deletion.
   */
  deleteArtifactsForRun(runUid: string, signal?: AbortSignal): Promise<number>;
}

/**
 * Disk-backed, bounded chunk receiver for external CI workers. Large build
 * outputs never enter a response envelope or process-sized buffer; only the
 * final content-addressed manifest crosses the control plane.
 */
export function createWorkerArtifactUploadStore(
  dataDirectory: string,
  inputOptions: WorkerArtifactUploadStoreOptions = {},
): WorkerArtifactUploadStore {
  const options = normalizedOptions(inputOptions);
  const root = path.join(dataDirectory, 'worker-artifacts');
  const uploadsDirectory = path.join(root, '.uploads');
  const contentDirectory = path.join(root, 'sha256');
  const manifestsDirectory = path.join(root, '.manifests');
  fs.mkdirSync(uploadsDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(contentDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(manifestsDirectory, { recursive: true, mode: 0o700 });

  const active = new Map<string, Promise<unknown>>();
  const reservations = new Map<string, Reservation>();
  const totalsBySession = new Map<string, ReservationTotals>();
  const retainedByHandle = new Map<string, WorkerArtifactManifest>();
  const retainedCreatedAtByHandle = new Map<string, number>();
  const retainedByRun = new Map<string, RetainedTotals>();
  const contentReferences = new Map<string, ContentReferences>();
  const pendingContentUploads = new Map<string, Set<string>>();
  let totalReservedBytes = 0;
  let totalPendingWriteBytes = 0;
  let totalRetainedBytes = 0;
  let totalRetainedManifests = 0;
  let cleanupDirectory: fs.Dir | undefined;
  let manifestCleanupDirectory: fs.Dir | undefined;
  let contentCleanupDirectory: fs.Dir | undefined;
  let cleanupChain: Promise<void> = Promise.resolve();
  let retainedMutationChain: Promise<void> = Promise.resolve();
  const initialized = initialize();

  const store: WorkerArtifactUploadStore = {
    async handle(
      session: WorkerGatewaySession,
      payload: unknown,
      signal = DEFAULT_SIGNAL,
    ): Promise<unknown> {
      signal.throwIfAborted();
      await prepare(signal);
      const operation = record(payload).operation;
      if (operation === 'begin') return begin(session, payload, signal);
      const uploadId = uploadIdentifier(record(payload).uploadId);
      // A rejected request must not poison this upload's serialization chain:
      // the worker may correct a bad/retried chunk on its next request.
      const previous: Promise<unknown> = active.get(uploadId)?.catch(() => undefined) ?? Promise.resolve();
      const current: Promise<unknown> = previous.then(async (): Promise<unknown> =>
        operation === 'chunk'
          ? writeChunk(session, payload, signal)
          : operation === 'commit'
          ? commit(session, payload, signal)
          : invalid('artifact upload operation is invalid')
      );
      active.set(uploadId, current);
      return current.finally(() => {
        if (active.get(uploadId) === current) active.delete(uploadId);
      });
    },

    async resolveManifest(
      runUid: string,
      artifactHandle: string,
      signal = DEFAULT_SIGNAL,
    ): Promise<WorkerArtifactManifest> {
      signal.throwIfAborted();
      await initialized;
      const opened = await openArtifact(runUid, artifactHandle, signal);
      await opened.file.close();
      return opened.manifest;
    },

    async openArtifact(
      runUid: string,
      artifactHandle: string,
      signal = DEFAULT_SIGNAL,
    ): Promise<OpenWorkerArtifact> {
      signal.throwIfAborted();
      await initialized;
      return openArtifact(runUid, artifactHandle, signal);
    },

    async readArtifact(
      runUid: string,
      artifactHandle: string,
      readOptions: WorkerArtifactReadOptions = {},
      signal = DEFAULT_SIGNAL,
    ): Promise<Buffer> {
      signal.throwIfAborted();
      await initialized;
      const opened = await openArtifact(runUid, artifactHandle, signal);
      try {
        const offset = readOptions.offset === undefined
          ? 0
          : safeInteger(readOptions.offset, 'read offset', 0, opened.manifest.sizeBytes);
        const maximumLength = Math.min(options.maxReadBytes, opened.manifest.sizeBytes - offset);
        const length = readOptions.length === undefined
          ? maximumLength
          : safeInteger(readOptions.length, 'read length', 0, maximumLength);
        const bytes = Buffer.allocUnsafe(length);
        await readFully(opened.file, bytes, offset, signal);
        signal.throwIfAborted();
        return bytes;
      } finally {
        await opened.file.close();
      }
    },

    async deleteArtifact(
      runUid: string,
      artifactHandleValue: string,
      signal = DEFAULT_SIGNAL,
    ): Promise<boolean> {
      signal.throwIfAborted();
      await initialized;
      const parsed = parseArtifactHandle(runUid, artifactHandleValue);
      return mutateRetainedArtifacts(() => deleteArtifact(parsed, signal));
    },

    async deleteArtifactsForRun(runUidValue: string, signal = DEFAULT_SIGNAL): Promise<number> {
      signal.throwIfAborted();
      await initialized;
      const runUid = sessionIdentifier(runUidValue, 'run uid');
      // The host contract requires the session to be revoked first. Drain any
      // already-admitted request outside retainedMutationChain: a commit also
      // uses that chain and awaiting it from inside would deadlock.
      await deleteUploadsForRun(runUid, signal);
      return mutateRetainedArtifacts(async () => {
        let deleted = 0;
        // Per-run manifest quotas bound this snapshot, and each deletion is
        // independently durable if cancellation interrupts the batch.
        const handles = [...retainedByHandle.values()]
          .filter((manifest) => manifestRunUid(manifest) === runUid)
          .map((manifest) => manifest.artifactHandle);
        for (const handle of handles) {
          signal.throwIfAborted();
          if (await deleteArtifact(parseArtifactHandle(runUid, handle), signal)) deleted += 1;
        }
        signal.throwIfAborted();
        return deleted;
      });
    },
  };

  return Object.freeze(store);

  async function prepare(signal: AbortSignal): Promise<void> {
    await initialized;
    signal.throwIfAborted();
    const cleanup = cleanupChain.catch(() => undefined).then(() => cleanupBatch(signal));
    cleanupChain = cleanup;
    await cleanup;
    signal.throwIfAborted();
  }

  async function initialize(): Promise<void> {
    const manifests = await fs.promises.opendir(manifestsDirectory);
    for await (const entry of manifests) {
      if (!MANIFEST_FILENAME_PATTERN.test(entry.name)) continue;
      const filename = path.join(manifestsDirectory, entry.name);
      const stored = await readStoredManifestEntry(filename);
      if (manifestFilename(stored.manifest.artifactHandle) !== filename) {
        throw new Error('artifact manifest filename is not canonical');
      }
      addRetained(stored.manifest, stored.createdAtMs);
    }
    const directory = await fs.promises.opendir(uploadsDirectory);
    for await (const entry of directory) await inspectStartupEntry(entry.name);
    await cleanupExpiredManifestsBatch(DEFAULT_SIGNAL);
    contentCleanupDirectory = await fs.promises.opendir(contentDirectory);
    await cleanupOrphanContentBatch(DEFAULT_SIGNAL);
  }

  async function inspectStartupEntry(entryName: string): Promise<void> {
    const uploadId = uploadIdFromDescriptorName(entryName);
    if (uploadId) {
      const descriptorPath = descriptorFilename(uploadId);
      try {
        const upload = await readUpload(descriptorPath, uploadId);
        if (isStale(upload.updatedAtMs)) {
          await removeUpload(uploadId);
        } else if (!upload.completed) {
          reserveExisting(upload);
        }
      } catch {
        if (await pathIsStale(descriptorPath)) await removeUpload(uploadId);
      }
      return;
    }
    if (UPLOAD_ID_PATTERN.test(entryName.slice(0, -'.part'.length)) && entryName.endsWith('.part')) {
      const partPath = path.join(uploadsDirectory, entryName);
      const descriptorPath = descriptorFilename(entryName.slice(0, -'.part'.length));
      if (!await existsNoFollow(descriptorPath) && await pathIsStale(partPath)) {
        await fs.promises.rm(partPath, { force: true });
      }
      return;
    }
    if (entryName.endsWith('.tmp')) {
      const temporaryDescriptor = path.join(uploadsDirectory, entryName);
      if (await pathIsStale(temporaryDescriptor)) await fs.promises.rm(temporaryDescriptor, { force: true });
    }
  }

  async function cleanupBatch(signal: AbortSignal): Promise<void> {
    if (!cleanupDirectory) cleanupDirectory = await fs.promises.opendir(uploadsDirectory);
    for (let index = 0; index < options.cleanupScanLimit; index += 1) {
      const entry = await cleanupDirectory.read();
      if (!entry) {
        await cleanupDirectory.close();
        cleanupDirectory = undefined;
        break;
      }
      const uploadId = uploadIdFromDescriptorName(entry.name);
      if (uploadId && active.has(uploadId)) continue;
      await inspectCleanupEntry(entry.name);
    }
    await mutateRetainedArtifacts(async () => {
      await cleanupExpiredManifestsBatch(signal);
      await cleanupOrphanContentBatch(signal);
    });
  }

  async function cleanupExpiredManifestsBatch(signal: AbortSignal): Promise<void> {
    if (!manifestCleanupDirectory) manifestCleanupDirectory = await fs.promises.opendir(manifestsDirectory);
    for (let index = 0; index < options.cleanupScanLimit; index += 1) {
      signal.throwIfAborted();
      const entry = await manifestCleanupDirectory.read();
      if (!entry) {
        await manifestCleanupDirectory.close();
        manifestCleanupDirectory = undefined;
        return;
      }
      if (!MANIFEST_FILENAME_PATTERN.test(entry.name)) continue;
      const filename = path.join(manifestsDirectory, entry.name);
      let stored: StoredWorkerArtifactManifest;
      try {
        stored = await readStoredManifestEntry(filename);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) continue;
        throw error;
      }
      if (manifestFilename(stored.manifest.artifactHandle) !== filename) {
        throw new Error('artifact manifest filename is not canonical');
      }
      if (!isRetainedExpired(stored.createdAtMs)) continue;
      await deleteArtifact(parseArtifactHandle(stored.runUid, stored.manifest.artifactHandle), signal);
    }
  }

  async function cleanupOrphanContentBatch(signal: AbortSignal): Promise<void> {
    if (!contentCleanupDirectory) contentCleanupDirectory = await fs.promises.opendir(contentDirectory);
    for (let index = 0; index < options.cleanupScanLimit; index += 1) {
      signal.throwIfAborted();
      const entry = await contentCleanupDirectory.read();
      if (!entry) {
        await contentCleanupDirectory.close();
        contentCleanupDirectory = undefined;
        return;
      }
      if (!CONTENT_FILENAME_PATTERN.test(entry.name)) continue;
      const contentHash = `sha256:${entry.name}`;
      if (contentReferences.has(contentHash) || pendingContentUploads.has(contentHash)) continue;
      const filename = path.join(contentDirectory, entry.name);
      let stats: fs.Stats;
      try {
        stats = await fs.promises.lstat(filename);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) continue;
        throw error;
      }
      if (!stats.isFile() && !stats.isSymbolicLink()) continue;
      await fs.promises.unlink(filename);
      await syncDirectory(contentDirectory);
    }
  }

  function isRetainedExpired(createdAtMs: number): boolean {
    return options.now() - createdAtMs >= options.retainedArtifactTtlMs;
  }

  async function inspectCleanupEntry(entryName: string): Promise<void> {
    const uploadId = uploadIdFromDescriptorName(entryName);
    if (uploadId) {
      const descriptorPath = descriptorFilename(uploadId);
      try {
        const upload = await readUpload(descriptorPath, uploadId);
        if (isStale(upload.updatedAtMs)) {
          unregisterPendingContent(upload);
          await removeUpload(uploadId);
          release(uploadId);
        }
      } catch {
        if (await pathIsStale(descriptorPath)) {
          await removeUpload(uploadId);
          release(uploadId);
        }
      }
      return;
    }
    await inspectStartupEntry(entryName);
  }

  function isStale(updatedAtMs: number): boolean {
    return options.now() - updatedAtMs >= options.staleUploadAgeMs;
  }

  async function pathIsStale(filename: string): Promise<boolean> {
    try {
      const stats = await fs.promises.lstat(filename, { bigint: false });
      return isStale(stats.mtimeMs);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return false;
      throw error;
    }
  }

  async function begin(
    session: WorkerGatewaySession,
    value: unknown,
    signal: AbortSignal,
  ): Promise<{ uploadId: string; nextOffset: number }> {
    signal.throwIfAborted();
    const input = record(value);
    const sizeBytes = safeInteger(input.sizeBytes, 'sizeBytes', 0, MAX_ARTIFACT_BYTES);
    await assertDiskReserve(sizeBytes, signal);
    const sessionName = sessionIdentifier(session.name, 'session name');
    const runUid = sessionIdentifier(session.run.uid, 'run uid');
    const name = boundedString(input.name, 'name', 256);
    const relativePath = workspaceRelativePath(input.relativePath);
    const mimeType = boundedString(input.mimeType, 'mimeType', 256);
    const uploadId = randomBytes(24).toString('hex');
    const timestamp = options.now();
    const upload: WorkerArtifactUpload = {
      version: 1,
      uploadId,
      sessionName,
      runUid,
      name,
      relativePath,
      mimeType,
      sizeBytes,
      receivedBytes: 0,
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
    };
    reserveNew(upload);
    try {
      const file = await fs.promises.open(
        partFilename(uploadId),
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollowFlag(),
        0o600,
      );
      await file.close();
      signal.throwIfAborted();
      await saveUpload(upload);
      signal.throwIfAborted();
      return { uploadId, nextOffset: 0 };
    } catch (error) {
      await removeUpload(uploadId);
      release(uploadId);
      throw error;
    }
  }

  async function writeChunk(
    session: WorkerGatewaySession,
    value: unknown,
    signal: AbortSignal,
  ): Promise<{ uploadId: string; nextOffset: number }> {
    signal.throwIfAborted();
    const input = record(value);
    const upload = await loadForSession(session, uploadIdentifier(input.uploadId));
    if (upload.completed) return { uploadId: upload.uploadId, nextOffset: upload.sizeBytes };
    const offset = safeInteger(input.offset, 'offset', 0, upload.sizeBytes);
    const declaredBytes = safeInteger(input.byteLength, 'byteLength', 1, MAX_CHUNK_BYTES);
    const bytes = decodeBase64(boundedString(input.data, 'data', Math.ceil(MAX_CHUNK_BYTES / 3) * 4 + 8));
    if (
      bytes.byteLength !== declaredBytes || !SHA256_PATTERN.test(String(input.sha256)) ||
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== input.sha256
    ) {
      return invalid('artifact upload chunk integrity is invalid');
    }
    if (offset + bytes.byteLength > upload.sizeBytes) return invalid('artifact upload exceeds declared size');
    signal.throwIfAborted();
    const file = await fs.promises.open(partFilename(upload.uploadId), fs.constants.O_RDWR | noFollowFlag());
    try {
      await assertRegularFile(file, upload.sizeBytes);
      if (offset < upload.receivedBytes) {
        if (offset + bytes.byteLength > upload.receivedBytes) {
          return invalid('artifact upload retry overlaps unpersisted bytes');
        }
        const existing = Buffer.allocUnsafe(bytes.byteLength);
        await readFully(file, existing, offset, signal);
        if (!existing.equals(bytes)) return invalid('artifact upload retry conflicts with persisted bytes');
        return { uploadId: upload.uploadId, nextOffset: upload.receivedBytes };
      }
      if (offset !== upload.receivedBytes) return invalid('artifact upload chunk offset is not contiguous');
      await writeFully(file, bytes, offset, signal);
      await file.sync();
    } finally {
      await file.close();
    }
    signal.throwIfAborted();
    upload.receivedBytes += bytes.byteLength;
    upload.updatedAtMs = options.now();
    await saveUpload(upload);
    consumePendingWriteReservation(upload.uploadId, bytes.byteLength);
    signal.throwIfAborted();
    return { uploadId: upload.uploadId, nextOffset: upload.receivedBytes };
  }

  async function commit(
    session: WorkerGatewaySession,
    value: unknown,
    signal: AbortSignal,
  ): Promise<WorkerArtifactManifest> {
    signal.throwIfAborted();
    const input = record(value);
    const upload = await loadForSession(session, uploadIdentifier(input.uploadId));
    const sizeBytes = safeInteger(input.sizeBytes, 'sizeBytes', 0, MAX_ARTIFACT_BYTES);
    const contentHash = boundedString(input.contentHash, 'contentHash', 71);
    if (
      sizeBytes !== upload.sizeBytes || upload.receivedBytes !== upload.sizeBytes || !SHA256_PATTERN.test(contentHash) ||
      (upload.completed && upload.completed.contentHash !== contentHash)
    ) {
      return invalid('artifact upload commit does not match the declared upload');
    }
    if (upload.completed) {
      const resolved = await openArtifact(upload.runUid, upload.completed.artifactHandle, signal);
      await resolved.file.close();
      return resolved.manifest;
    }

    const manifest: WorkerArtifactManifest = {
      artifactHandle: artifactHandle(
        upload.runUid,
        manifestIdentity(upload.name, upload.relativePath, upload.mimeType),
        contentHash,
      ),
      contentHash,
      sizeBytes,
      mimeType: upload.mimeType,
      name: upload.name,
      relativePath: upload.relativePath,
    };
    return mutateRetainedArtifacts(async () => {
      signal.throwIfAborted();
      const isNewManifest = assertRetainedCapacity(manifest);
      await assertDiskReserve(0, signal);
      if (upload.pendingContentHash && upload.pendingContentHash !== contentHash) {
        return invalid('artifact upload pending content hash conflicts with commit');
      }
      if (!upload.pendingContentHash) {
        upload.pendingContentHash = contentHash;
        upload.updatedAtMs = options.now();
        await saveUpload(upload);
        registerPendingContent(upload);
        signal.throwIfAborted();
      }
      const destination = contentFilename(contentHash);
      await publishContent(upload, contentHash, destination, signal);
      signal.throwIfAborted();
      const stored = await persistManifest(upload.runUid, manifest);
      if (isNewManifest) addRetained(stored.manifest, stored.createdAtMs);
      signal.throwIfAborted();
      unregisterPendingContent(upload);
      delete upload.pendingContentHash;
      upload.completed = manifest;
      upload.updatedAtMs = options.now();
      await saveUpload(upload);
      release(upload.uploadId);
      signal.throwIfAborted();
      return manifest;
    });
  }

  async function publishContent(
    upload: WorkerArtifactUpload,
    contentHash: string,
    destination: string,
    signal: AbortSignal,
  ): Promise<void> {
    const temporaryPath = partFilename(upload.uploadId);
    let source: ContentInspection;
    try {
      source = await inspectContent(temporaryPath, upload.sizeBytes, contentHash, signal);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
      await inspectContent(destination, upload.sizeBytes, contentHash, signal);
      return;
    }

    signal.throwIfAborted();
    let created = false;
    try {
      await fs.promises.link(temporaryPath, destination);
      created = true;
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }
    if (created) {
      const published = await inspectContent(destination, upload.sizeBytes, undefined, signal);
      if (published.dev !== source.dev || published.ino !== source.ino) {
        await fs.promises.rm(destination, { force: true });
        return invalid('artifact upload content changed during publication');
      }
    } else {
      await inspectContent(destination, upload.sizeBytes, contentHash, signal);
    }
    await syncDirectory(contentDirectory);
    signal.throwIfAborted();
    await fs.promises.unlink(temporaryPath);
    await syncDirectory(uploadsDirectory);
  }

  async function loadForSession(session: WorkerGatewaySession, uploadId: string): Promise<WorkerArtifactUpload> {
    let upload: WorkerArtifactUpload;
    try {
      upload = await readUpload(descriptorFilename(uploadId), uploadId);
    } catch {
      throw new OrchestrationError({ code: 'NOT_FOUND', message: 'artifact upload is unavailable', retryable: false });
    }
    if (upload.sessionName !== session.name || upload.runUid !== session.run.uid) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'artifact upload belongs to another worker session',
        retryable: false,
      });
    }
    return upload;
  }

  async function readUpload(filename: string, uploadId: string): Promise<WorkerArtifactUpload> {
    const value = await readJsonNoFollow(filename);
    const input = recordForStorage(value);
    if (input.version !== 1 || input.uploadId !== uploadId || !UPLOAD_ID_PATTERN.test(uploadId)) {
      throw new Error('invalid artifact upload descriptor identity');
    }
    const sizeBytes = storageInteger(input.sizeBytes, 0, MAX_ARTIFACT_BYTES);
    const receivedBytes = storageInteger(input.receivedBytes, 0, sizeBytes);
    const upload: WorkerArtifactUpload = {
      version: 1,
      uploadId,
      sessionName: storageString(input.sessionName, 4096),
      runUid: storageString(input.runUid, 4096),
      name: storageString(input.name, 256),
      relativePath: workspaceRelativePath(input.relativePath),
      mimeType: storageString(input.mimeType, 256),
      sizeBytes,
      receivedBytes,
      createdAtMs: storageInteger(input.createdAtMs, 0, Number.MAX_SAFE_INTEGER),
      updatedAtMs: storageInteger(input.updatedAtMs, 0, Number.MAX_SAFE_INTEGER),
    };
    if (input.completed !== undefined) upload.completed = storedManifest(input.completed, upload.runUid);
    if (input.pendingContentHash !== undefined) {
      const pendingContentHash = storageString(input.pendingContentHash, 71);
      if (!SHA256_PATTERN.test(pendingContentHash)) throw new Error('invalid pending artifact content hash');
      upload.pendingContentHash = pendingContentHash;
    }
    if (upload.completed && upload.pendingContentHash) {
      throw new Error('completed artifact upload cannot retain a pending content hash');
    }
    if (upload.updatedAtMs < upload.createdAtMs) throw new Error('invalid artifact upload descriptor timestamp');
    return upload;
  }

  async function saveUpload(upload: WorkerArtifactUpload): Promise<void> {
    await durableWriteJson(descriptorFilename(upload.uploadId), upload, uploadsDirectory);
  }

  async function persistManifest(
    runUid: string,
    manifest: WorkerArtifactManifest,
  ): Promise<StoredWorkerArtifactManifest> {
    const filename = manifestFilename(manifest.artifactHandle);
    const stored: StoredWorkerArtifactManifest = {
      version: 1,
      runUid,
      createdAtMs: options.now(),
      manifest,
    };
    if (await durableCreateJson(filename, stored, manifestsDirectory, uploadsDirectory)) return stored;
    const existing = await readStoredManifestEntry(filename);
    if (
      existing.runUid !== runUid ||
      existing.manifest.artifactHandle !== manifest.artifactHandle ||
      !manifestsEqual(existing.manifest, manifest)
    ) {
      throw new Error('artifact manifest conflicts with durable state');
    }
    return existing;
  }

  async function readStoredManifest(
    filename: string,
    runUid: string,
    expectedHandle: string,
  ): Promise<WorkerArtifactManifest> {
    const stored = await readStoredManifestEntry(filename);
    if (stored.runUid !== runUid || stored.manifest.artifactHandle !== expectedHandle) {
      throw new Error('invalid artifact manifest owner');
    }
    return stored.manifest;
  }

  async function readStoredManifestEntry(filename: string): Promise<StoredWorkerArtifactManifest> {
    const input = recordForStorage(await readJsonNoFollow(filename));
    assertExactKeys(input, ['version', 'runUid', 'createdAtMs', 'manifest']);
    if (input.version !== 1) throw new Error('invalid artifact manifest version');
    const runUid = storageString(input.runUid, 4096);
    return {
      version: 1,
      runUid,
      createdAtMs: storageInteger(input.createdAtMs, 0, Number.MAX_SAFE_INTEGER),
      manifest: storedManifest(input.manifest, runUid),
    };
  }

  async function openArtifact(
    runUidValue: string,
    artifactHandleValue: string,
    signal: AbortSignal,
  ): Promise<OpenWorkerArtifact> {
    const parsed = parseArtifactHandle(runUidValue, artifactHandleValue);
    let manifest: WorkerArtifactManifest;
    try {
      manifest = await readStoredManifest(
        manifestFilename(parsed.artifactHandle),
        parsed.runUid,
        parsed.artifactHandle,
      );
    } catch {
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: 'worker artifact manifest is unavailable',
        retryable: false,
      });
    }
    if (manifest.contentHash !== parsed.contentHash) return invalid('worker artifact handle hash is invalid');
    const createdAtMs = retainedCreatedAtByHandle.get(parsed.artifactHandle);
    if (createdAtMs === undefined || isRetainedExpired(createdAtMs)) {
      await mutateRetainedArtifacts(() => deleteArtifact(parsed, signal));
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: 'worker artifact manifest has expired',
        retryable: false,
      });
    }
    signal.throwIfAborted();
    let file: fs.promises.FileHandle;
    try {
      file = await fs.promises.open(contentFilename(parsed.contentHash), fs.constants.O_RDONLY | noFollowFlag());
    } catch {
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: 'worker artifact content is unavailable',
        retryable: false,
      });
    }
    try {
      const stats = await file.stat({ bigint: true });
      if (!stats.isFile() || stats.size !== BigInt(manifest.sizeBytes)) {
        throw new OrchestrationError({
          code: 'UNAVAILABLE',
          message: 'worker artifact content does not match its manifest',
          retryable: false,
        });
      }
      signal.throwIfAborted();
      return { manifest, file };
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async function deleteArtifact(
    parsed: ReturnType<typeof parseArtifactHandle>,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    const retained = retainedByHandle.get(parsed.artifactHandle);
    let deleted = false;
    if (retained) {
      if (retained.contentHash !== parsed.contentHash) throw new Error('retained artifact hash is inconsistent');
      try {
        await fs.promises.unlink(manifestFilename(parsed.artifactHandle));
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
      await syncDirectory(manifestsDirectory);
      const references = contentReferences.get(parsed.contentHash);
      if (!references) throw new Error('retained artifact content references are unavailable');
      if (references.count === 1) {
        try {
          await fs.promises.unlink(contentFilename(parsed.contentHash));
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw error;
        }
        await syncDirectory(contentDirectory);
      }
      removeRetained(retained);
      deleted = true;
    } else if (!contentReferences.has(parsed.contentHash)) {
      try {
        await fs.promises.unlink(contentFilename(parsed.contentHash));
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
      await syncDirectory(contentDirectory);
    }
    signal.throwIfAborted();
    return deleted;
  }

  async function deleteUploadsForRun(runUid: string, signal: AbortSignal): Promise<void> {
    const directory = await fs.promises.opendir(uploadsDirectory);
    for await (const entry of directory) {
      signal.throwIfAborted();
      const uploadId = uploadIdFromDescriptorName(entry.name);
      if (!uploadId) continue;
      let upload: WorkerArtifactUpload;
      try {
        upload = await readUpload(descriptorFilename(uploadId), uploadId);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) continue;
        throw error;
      }
      if (upload.runUid !== runUid) continue;
      await active.get(uploadId)?.catch(() => undefined);
      signal.throwIfAborted();
      try {
        upload = await readUpload(descriptorFilename(uploadId), uploadId);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) continue;
        throw error;
      }
      if (upload.runUid !== runUid) throw new Error('artifact upload owner changed during run cleanup');
      unregisterPendingContent(upload);
      await removeUpload(uploadId);
      release(uploadId);
    }
  }

  function mutateRetainedArtifacts<T>(operation: () => Promise<T>): Promise<T> {
    const result = retainedMutationChain.catch(() => undefined).then(operation);
    retainedMutationChain = result.then(() => undefined, () => undefined);
    return result;
  }

  function assertRetainedCapacity(manifest: WorkerArtifactManifest): boolean {
    const existing = retainedByHandle.get(manifest.artifactHandle);
    if (existing) {
      if (!manifestsEqual(existing, manifest)) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: 'artifact manifest conflicts with retained state',
          retryable: false,
        });
      }
      return false;
    }
    const runTotals = retainedByRun.get(manifestRunUid(manifest)) ?? { count: 0, bytes: 0 };
    const additionalGlobalBytes = contentReferences.has(manifest.contentHash) ? 0 : manifest.sizeBytes;
    if (
      runTotals.count >= options.maxRetainedManifestsPerRun ||
      totalRetainedManifests >= options.maxRetainedManifestsGlobal ||
      runTotals.bytes + manifest.sizeBytes > options.maxRetainedBytesPerRun ||
      totalRetainedBytes + additionalGlobalBytes > options.maxRetainedBytesGlobal
    ) {
      throw new OrchestrationError({
        code: 'EXHAUSTED',
        message: 'retained artifact quota is exhausted',
        retryable: true,
      });
    }
    return true;
  }

  function addRetained(manifest: WorkerArtifactManifest, createdAtMs: number): void {
    const existing = retainedByHandle.get(manifest.artifactHandle);
    if (existing) {
      if (!manifestsEqual(existing, manifest)) throw new Error('artifact manifest conflicts with retained state');
      return;
    }
    const runUid = manifestRunUid(manifest);
    const references = contentReferences.get(manifest.contentHash);
    if (references && references.sizeBytes !== manifest.sizeBytes) {
      throw new Error('artifact manifests disagree about content size');
    }
    retainedByHandle.set(manifest.artifactHandle, manifest);
    retainedCreatedAtByHandle.set(manifest.artifactHandle, createdAtMs);
    const runTotals = retainedByRun.get(runUid) ?? { count: 0, bytes: 0 };
    runTotals.count += 1;
    runTotals.bytes += manifest.sizeBytes;
    retainedByRun.set(runUid, runTotals);
    totalRetainedManifests += 1;
    if (!references) totalRetainedBytes += manifest.sizeBytes;
    contentReferences.set(manifest.contentHash, {
      count: (references?.count ?? 0) + 1,
      sizeBytes: manifest.sizeBytes,
    });
  }

  function removeRetained(manifest: WorkerArtifactManifest): void {
    if (!retainedByHandle.delete(manifest.artifactHandle)) return;
    retainedCreatedAtByHandle.delete(manifest.artifactHandle);
    const runUid = manifestRunUid(manifest);
    const runTotals = retainedByRun.get(runUid);
    if (!runTotals) throw new Error('retained artifact run totals are unavailable');
    runTotals.count -= 1;
    runTotals.bytes -= manifest.sizeBytes;
    if (runTotals.count === 0) retainedByRun.delete(runUid);
    totalRetainedManifests -= 1;
    const references = contentReferences.get(manifest.contentHash);
    if (!references) throw new Error('retained artifact content references are unavailable');
    references.count -= 1;
    if (references.count === 0) {
      contentReferences.delete(manifest.contentHash);
      totalRetainedBytes -= manifest.sizeBytes;
    }
  }

  function reserveNew(upload: WorkerArtifactUpload): void {
    const sessionKey = reservationSessionKey(upload.sessionName, upload.runUid);
    const sessionTotals = totalsBySession.get(sessionKey) ?? { count: 0, bytes: 0 };
    if (
      reservations.size >= options.maxActiveUploadsGlobal ||
      sessionTotals.count >= options.maxActiveUploadsPerSession ||
      totalReservedBytes + upload.sizeBytes > options.maxReservedBytesGlobal ||
      sessionTotals.bytes + upload.sizeBytes > options.maxReservedBytesPerSession
    ) {
      throw new OrchestrationError({
        code: 'EXHAUSTED',
        message: 'artifact upload reservation quota is exhausted',
        retryable: true,
      });
    }
    addReservation(upload.uploadId, sessionKey, upload.sizeBytes, upload.sizeBytes);
  }

  function reserveExisting(upload: WorkerArtifactUpload): void {
    if (reservations.has(upload.uploadId)) return;
    addReservation(
      upload.uploadId,
      reservationSessionKey(upload.sessionName, upload.runUid),
      upload.sizeBytes,
      upload.sizeBytes - upload.receivedBytes,
    );
    registerPendingContent(upload);
  }

  function registerPendingContent(upload: WorkerArtifactUpload): void {
    if (!upload.pendingContentHash) return;
    const uploads = pendingContentUploads.get(upload.pendingContentHash) ?? new Set<string>();
    uploads.add(upload.uploadId);
    pendingContentUploads.set(upload.pendingContentHash, uploads);
  }

  function unregisterPendingContent(upload: WorkerArtifactUpload): void {
    if (!upload.pendingContentHash) return;
    const uploads = pendingContentUploads.get(upload.pendingContentHash);
    if (!uploads) return;
    uploads.delete(upload.uploadId);
    if (uploads.size === 0) pendingContentUploads.delete(upload.pendingContentHash);
  }

  function addReservation(
    uploadId: string,
    sessionKey: string,
    sizeBytes: number,
    pendingWriteBytes: number,
  ): void {
    reservations.set(uploadId, { sessionKey, sizeBytes, pendingWriteBytes });
    const totals = totalsBySession.get(sessionKey) ?? { count: 0, bytes: 0 };
    totals.count += 1;
    totals.bytes += sizeBytes;
    totalsBySession.set(sessionKey, totals);
    totalReservedBytes += sizeBytes;
    totalPendingWriteBytes += pendingWriteBytes;
  }

  function consumePendingWriteReservation(uploadId: string, bytes: number): void {
    const reservation = reservations.get(uploadId);
    if (!reservation) return;
    if (bytes > reservation.pendingWriteBytes) throw new Error('artifact pending-write reservation underflow');
    reservation.pendingWriteBytes -= bytes;
    totalPendingWriteBytes -= bytes;
  }

  function release(uploadId: string): void {
    const reservation = reservations.get(uploadId);
    if (!reservation) return;
    reservations.delete(uploadId);
    totalReservedBytes -= reservation.sizeBytes;
    totalPendingWriteBytes -= reservation.pendingWriteBytes;
    const totals = totalsBySession.get(reservation.sessionKey);
    if (!totals) return;
    totals.count -= 1;
    totals.bytes -= reservation.sizeBytes;
    if (totals.count === 0) totalsBySession.delete(reservation.sessionKey);
  }

  async function removeUpload(uploadId: string): Promise<void> {
    await Promise.all([
      fs.promises.rm(partFilename(uploadId), { force: true }),
      fs.promises.rm(descriptorFilename(uploadId), { force: true }),
    ]);
    await syncDirectory(uploadsDirectory);
  }

  function descriptorFilename(uploadId: string): string {
    return path.join(uploadsDirectory, `${uploadId}.json`);
  }

  function partFilename(uploadId: string): string {
    return path.join(uploadsDirectory, `${uploadId}.part`);
  }

  function contentFilename(contentHash: string): string {
    return path.join(contentDirectory, contentHash.slice('sha256:'.length));
  }

  function manifestFilename(handle: string): string {
    return path.join(manifestsDirectory, `${createHash('sha256').update(handle).digest('hex')}.json`);
  }

  async function assertDiskReserve(additionalBytes: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const { availableBytes } = await options.statfs(root, signal);
    signal.throwIfAborted();
    if (typeof availableBytes !== 'bigint' || availableBytes < 0n) {
      throw new Error('worker artifact filesystem reported invalid free space');
    }
    const required = BigInt(options.minFreeDiskBytes) + BigInt(totalPendingWriteBytes) + BigInt(additionalBytes);
    if (availableBytes < required) {
      throw new OrchestrationError({
        code: 'EXHAUSTED',
        message: 'worker artifact filesystem free-space reserve is exhausted',
        retryable: true,
      });
    }
  }
}

function normalizedOptions(input: WorkerArtifactUploadStoreOptions): Required<WorkerArtifactUploadStoreOptions> {
  const options: Required<WorkerArtifactUploadStoreOptions> = {
    maxReservedBytesPerSession: input.maxReservedBytesPerSession ?? 20 * 1024 * 1024 * 1024,
    maxReservedBytesGlobal: input.maxReservedBytesGlobal ?? 50 * 1024 * 1024 * 1024,
    maxActiveUploadsPerSession: input.maxActiveUploadsPerSession ?? 16,
    maxActiveUploadsGlobal: input.maxActiveUploadsGlobal ?? 64,
    maxRetainedBytesPerRun: input.maxRetainedBytesPerRun ?? 50 * 1024 * 1024 * 1024,
    maxRetainedBytesGlobal: input.maxRetainedBytesGlobal ?? 200 * 1024 * 1024 * 1024,
    maxRetainedManifestsPerRun: input.maxRetainedManifestsPerRun ?? 64,
    maxRetainedManifestsGlobal: input.maxRetainedManifestsGlobal ?? 512,
    retainedArtifactTtlMs: input.retainedArtifactTtlMs ?? 7 * 24 * 60 * 60 * 1000,
    minFreeDiskBytes: input.minFreeDiskBytes ?? 1024 * 1024 * 1024,
    staleUploadAgeMs: input.staleUploadAgeMs ?? 24 * 60 * 60 * 1000,
    cleanupScanLimit: input.cleanupScanLimit ?? 32,
    maxReadBytes: input.maxReadBytes ?? MAX_CHUNK_BYTES,
    now: input.now ?? Date.now,
    statfs: input.statfs ?? defaultArtifactStatfs,
  };
  if (typeof options.now !== 'function') {
    throw new TypeError('worker artifact store now must be a function');
  }
  if (typeof options.statfs !== 'function') {
    throw new TypeError('worker artifact store statfs must be a function');
  }
  for (const [name, value] of Object.entries(options)) {
    if (typeof value === 'function') continue;
    const minimum = name === 'minFreeDiskBytes' ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new TypeError(`worker artifact store ${name} must be a safe integer of at least ${minimum}`);
    }
  }
  if (options.maxReservedBytesPerSession > options.maxReservedBytesGlobal) {
    throw new TypeError('worker artifact per-session byte quota cannot exceed its global quota');
  }
  if (options.maxActiveUploadsPerSession > options.maxActiveUploadsGlobal) {
    throw new TypeError('worker artifact per-session upload quota cannot exceed its global quota');
  }
  if (options.maxRetainedManifestsPerRun > options.maxRetainedManifestsGlobal) {
    throw new TypeError('worker artifact per-run retained manifest quota cannot exceed its global quota');
  }
  if (options.maxReadBytes > MAX_CHUNK_BYTES) {
    throw new TypeError('worker artifact read limit cannot exceed the chunk limit');
  }
  return options;
}

async function defaultArtifactStatfs(
  directory: string,
  signal: AbortSignal,
): Promise<{ availableBytes: bigint }> {
  signal.throwIfAborted();
  const stats = await fs.promises.statfs(directory, { bigint: true });
  signal.throwIfAborted();
  return { availableBytes: stats.bavail * stats.bsize };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('artifact upload payload must be an object');
  return value as Record<string, unknown>;
}

function recordForStorage(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid artifact descriptor');
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('artifact descriptor has unexpected fields');
  }
}

function boundedString(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > maximumBytes || value.includes('\0')) {
    return invalid(`artifact upload ${field} is invalid`);
  }
  return value;
}

function storageString(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > maximumBytes || value.includes('\0')) {
    throw new Error('invalid artifact descriptor string');
  }
  return value;
}

function safeInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return invalid(`artifact upload ${field} is invalid`);
  }
  return value as number;
}

function storageInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error('invalid artifact descriptor integer');
  }
  return value as number;
}

function uploadIdentifier(value: unknown): string {
  const uploadId = boundedString(value, 'uploadId', 48);
  if (!UPLOAD_ID_PATTERN.test(uploadId)) return invalid('artifact upload uploadId is invalid');
  return uploadId;
}

function uploadIdFromDescriptorName(name: string): string | undefined {
  if (!name.endsWith('.json')) return undefined;
  const uploadId = name.slice(0, -'.json'.length);
  return UPLOAD_ID_PATTERN.test(uploadId) ? uploadId : undefined;
}

function sessionIdentifier(value: unknown, field: string): string {
  return boundedString(value, field, 4096);
}

function workspaceRelativePath(value: unknown): string {
  const candidate = boundedString(value, 'relativePath', 4096);
  const segments = candidate.split('/');
  if (
    candidate !== candidate.normalize('NFC') ||
    candidate.includes('\\') ||
    path.posix.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate) ||
    path.posix.normalize(candidate) !== candidate ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return invalid('artifact upload relativePath must be a canonical workspace-relative path');
  }
  return candidate;
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value)) {
    return invalid('artifact upload data is not canonical base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) return invalid('artifact upload data is not canonical base64');
  return bytes;
}

function manifestIdentity(name: string, relativePath: string, mimeType: string): string {
  return createHash('sha256').update(JSON.stringify({ name, relativePath, mimeType })).digest('hex');
}

function artifactHandle(runUid: string, manifestId: string, contentHash: string): string {
  return `worker-artifact:${runUid}:manifest:${manifestId}:${contentHash}`;
}

function parseArtifactHandle(
  runUidValue: string,
  value: unknown,
): { artifactHandle: string; runUid: string; manifestId: string; contentHash: string } {
  if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 8192) {
    return invalid('worker artifact handle is invalid');
  }
  const runUid = sessionIdentifier(runUidValue, 'run uid');
  const prefix = `worker-artifact:${runUid}:`;
  const match = value.startsWith(prefix) ? MANIFEST_HANDLE_TAIL_PATTERN.exec(value.slice(prefix.length)) : null;
  const manifestId = match?.[1] ?? '';
  const contentHash = match?.[2] ?? '';
  if (!manifestId || !SHA256_PATTERN.test(contentHash) || value !== artifactHandle(runUid, manifestId, contentHash)) {
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: 'worker artifact handle does not belong to this run',
      retryable: false,
    });
  }
  return { artifactHandle: value, runUid, manifestId, contentHash };
}

function storedManifest(value: unknown, runUid: string, expectedHandle?: string): WorkerArtifactManifest {
  const input = recordForStorage(value);
  assertExactKeys(input, ['artifactHandle', 'contentHash', 'sizeBytes', 'mimeType', 'name', 'relativePath']);
  const contentHash = storageString(input.contentHash, 71);
  if (!SHA256_PATTERN.test(contentHash)) throw new Error('invalid artifact manifest hash');
  const handle = storageString(input.artifactHandle, 8192);
  const manifest = {
    artifactHandle: handle,
    contentHash,
    sizeBytes: storageInteger(input.sizeBytes, 0, MAX_ARTIFACT_BYTES),
    mimeType: storageString(input.mimeType, 256),
    name: storageString(input.name, 256),
    relativePath: workspaceRelativePath(input.relativePath),
  };
  const expected = artifactHandle(
    runUid,
    manifestIdentity(manifest.name, manifest.relativePath, manifest.mimeType),
    contentHash,
  );
  if (handle !== expected || (expectedHandle !== undefined && handle !== expectedHandle)) {
    throw new Error('invalid artifact manifest handle');
  }
  return manifest;
}

function manifestRunUid(manifest: WorkerArtifactManifest): string {
  const prefix = 'worker-artifact:';
  const suffix = `:manifest:${manifestIdentity(manifest.name, manifest.relativePath, manifest.mimeType)}:${manifest.contentHash}`;
  if (!manifest.artifactHandle.startsWith(prefix) || !manifest.artifactHandle.endsWith(suffix)) {
    throw new Error('artifact manifest handle is invalid');
  }
  const runUid = manifest.artifactHandle.slice(prefix.length, -suffix.length);
  if (
    !runUid || artifactHandle(
        runUid,
        manifestIdentity(manifest.name, manifest.relativePath, manifest.mimeType),
        manifest.contentHash,
      ) !== manifest.artifactHandle
  ) {
    throw new Error('artifact manifest run is invalid');
  }
  return runUid;
}

async function inspectContent(
  filename: string,
  expectedSize: number,
  expectedHash: string | undefined,
  signal: AbortSignal,
): Promise<ContentInspection> {
  const file = await fs.promises.open(filename, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const stats = await file.stat({ bigint: true });
    if (!stats.isFile() || stats.size !== BigInt(expectedSize)) {
      return invalid('artifact upload content size is invalid');
    }
    if (expectedHash !== undefined) {
      const digest = createHash('sha256');
      const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, Math.max(expectedSize, 1)));
      let position = 0;
      while (position < expectedSize) {
        signal.throwIfAborted();
        const length = Math.min(buffer.byteLength, expectedSize - position);
        const { bytesRead } = await file.read(buffer, 0, length, position);
        if (bytesRead === 0) return invalid('artifact upload content ended unexpectedly');
        digest.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      signal.throwIfAborted();
      if (`sha256:${digest.digest('hex')}` !== expectedHash) {
        return invalid('artifact upload content digest mismatch');
      }
    }
    return { dev: stats.dev, ino: stats.ino };
  } finally {
    await file.close();
  }
}

async function assertRegularFile(file: fs.promises.FileHandle, maximumSize: number): Promise<void> {
  const stats = await file.stat({ bigint: true });
  if (!stats.isFile() || stats.size > BigInt(maximumSize)) {
    return invalid('artifact upload temporary file is invalid');
  }
}

async function writeFully(
  file: fs.promises.FileHandle,
  bytes: Buffer,
  position: number,
  signal: AbortSignal,
): Promise<void> {
  let written = 0;
  while (written < bytes.byteLength) {
    signal.throwIfAborted();
    const result = await file.write(bytes, written, bytes.byteLength - written, position + written);
    if (result.bytesWritten === 0) throw new Error('artifact upload write made no progress');
    written += result.bytesWritten;
  }
}

async function readFully(
  file: fs.promises.FileHandle,
  bytes: Buffer,
  position: number,
  signal: AbortSignal,
): Promise<void> {
  let read = 0;
  while (read < bytes.byteLength) {
    signal.throwIfAborted();
    const result = await file.read(bytes, read, bytes.byteLength - read, position + read);
    if (result.bytesRead === 0) throw new Error('worker artifact content ended unexpectedly');
    read += result.bytesRead;
  }
}

async function readJsonNoFollow(filename: string): Promise<unknown> {
  const file = await fs.promises.open(filename, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const stats = await file.stat({ bigint: false });
    if (!stats.isFile() || stats.size > MAX_DESCRIPTOR_BYTES) throw new Error('artifact descriptor is invalid');
    return JSON.parse(await file.readFile('utf8')) as unknown;
  } finally {
    await file.close();
  }
}

async function durableWriteJson(filename: string, value: unknown, directory: string): Promise<void> {
  const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
  let file: fs.promises.FileHandle | undefined;
  try {
    file = await fs.promises.open(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollowFlag(),
      0o600,
    );
    await file.writeFile(JSON.stringify(value), 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    await fs.promises.rename(temporary, filename);
    await syncDirectory(directory);
  } catch (error) {
    if (file) await file.close().catch(() => undefined);
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function durableCreateJson(
  filename: string,
  value: unknown,
  directory: string,
  temporaryDirectory: string,
): Promise<boolean> {
  const temporary = path.join(
    temporaryDirectory,
    `${path.basename(filename)}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let file: fs.promises.FileHandle | undefined;
  try {
    file = await fs.promises.open(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollowFlag(),
      0o600,
    );
    await file.writeFile(JSON.stringify(value), 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    try {
      await fs.promises.link(temporary, filename);
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
      await fs.promises.rm(temporary, { force: true });
      return false;
    }
    await syncDirectory(directory);
    await fs.promises.unlink(temporary);
    await syncDirectory(temporaryDirectory);
    return true;
  } catch (error) {
    if (file) await file.close().catch(() => undefined);
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function existsNoFollow(filename: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filename);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

function reservationSessionKey(sessionName: string, runUid: string): string {
  return JSON.stringify([sessionName, runUid]);
}

function manifestsEqual(left: WorkerArtifactManifest, right: WorkerArtifactManifest): boolean {
  return left.artifactHandle === right.artifactHandle &&
    left.contentHash === right.contentHash &&
    left.sizeBytes === right.sizeBytes &&
    left.mimeType === right.mimeType &&
    left.name === right.name &&
    left.relativePath === right.relativePath;
}

function noFollowFlag(): number {
  return fs.constants.O_NOFOLLOW ?? 0;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code;
}

function invalid(message: string): never {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}
