/**
 * File-backed script artifact store (plan 24.15).
 *
 * Production {@link ScriptArtifactStore} for the CLI reference runtime.
 * Generated-script artifacts are persisted content-addressed under
 * `<dataDir>/artifacts/scripts/`:
 *
 *   <digest-hex>.mjs   — normalized script source (mode 0600)
 *   <digest-hex>.json  — ArtifactRecord manifest (mode 0600)
 *
 * Security properties:
 * - Content is verified against `manifest.spec.contentHash` before any
 *   bytes reach disk; a mismatch throws and nothing is written.
 * - Artifact names must be the digest-derived `script-<64 hex>` form
 *   produced by the deployment pipeline, so a hostile or buggy caller
 *   cannot traverse outside the store directory.
 * - Writes are atomic (unique temp file in the same directory + rename),
 *   so a crash never leaves a half-written artifact.
 * - Read-back re-verifies the content hash, so on-disk corruption or
 *   tampering is detected before the content is handed to a consumer.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactRecordManifest, ScriptArtifactStore } from 'memeloop';

const ARTIFACT_NAME_PATTERN = /^script-[a-f0-9]{64}$/;
const CONTENT_HASH_PATTERN = /^sha256:([a-f0-9]{64})$/;

/** Readable script artifact store used by runtimes that stage admitted bytes. */
export interface ScriptArtifactStoreReader extends ScriptArtifactStore {
  /** Read back verified normalized content by artifact name, or undefined. */
  readArtifactContent(name: string): Promise<string | undefined>;
  /** Read back the stored manifest by artifact name, or undefined. */
  readArtifactManifest(name: string): Promise<ArtifactRecordManifest | undefined>;
}

/** File-backed implementation with its on-disk directory exposed for diagnostics. */
export interface FileScriptArtifactStore extends ScriptArtifactStoreReader {
  /** Absolute directory holding the files. */
  readonly artifactDirectory: string;
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function assertArtifactName(name: string): void {
  if (!ARTIFACT_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid script artifact name "${name}": expected digest-derived "script-<64 hex>" form`);
  }
}

/** Write a file atomically: unique temp sibling + rename, 0600. */
async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(temporaryPath, data, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    try {
      await rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'script artifact write failed and its temporary file could not be removed',
      );
    }
    throw error;
  }
}

/**
 * Create the production script artifact store rooted at `<dataDir>`.
 * The store directory is created lazily on first write.
 */
export function createFileScriptArtifactStore(options: { dataDir: string }): FileScriptArtifactStore {
  const artifactDirectory = path.join(path.resolve(options.dataDir), 'artifacts', 'scripts');

  function pathsFor(name: string): { contentPath: string; manifestPath: string } {
    assertArtifactName(name);
    const digestHex = name.slice('script-'.length);
    return {
      contentPath: path.join(artifactDirectory, `${digestHex}.mjs`),
      manifestPath: path.join(artifactDirectory, `${digestHex}.json`),
    };
  }

  return {
    artifactDirectory,

    async putArtifact(manifest: ArtifactRecordManifest, normalizedContent: string): Promise<void> {
      const name = manifest.metadata.name;
      if (name === undefined) {
        throw new Error('Artifact manifest is missing metadata.name');
      }
      const { contentPath, manifestPath } = pathsFor(name);

      // Verify the manifest's content hash commits to these exact bytes.
      const hashMatch = CONTENT_HASH_PATTERN.exec(manifest.spec.contentHash);
      const committedHex = hashMatch?.[1];
      if (committedHex === undefined) {
        throw new Error(`Artifact "${name}" has unsupported contentHash "${manifest.spec.contentHash}": expected "sha256:<64 hex>"`);
      }
      const actualHex = sha256Hex(normalizedContent);
      if (actualHex !== committedHex) {
        throw new Error(
          `Artifact "${name}" content hash mismatch: manifest commits to ${committedHex}, content hashes to ${actualHex}. Nothing was written.`,
        );
      }
      // The pipeline derives the artifact name from the digest; enforce it so
      // the content address cannot point at different bytes.
      if (name !== `script-${actualHex}`) {
        throw new Error(`Artifact name "${name}" does not match its content address "script-${actualHex}"`);
      }

      await mkdir(artifactDirectory, { recursive: true });
      await writeFileAtomic(contentPath, normalizedContent);
      await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));
    },

    async readArtifactContent(name: string): Promise<string | undefined> {
      const { contentPath, manifestPath } = pathsFor(name);
      let manifestText: string;
      let content: string;
      try {
        [manifestText, content] = await Promise.all([
          readFile(manifestPath, 'utf8'),
          readFile(contentPath, 'utf8'),
        ]);
      } catch {
        return undefined;
      }
      const manifest = JSON.parse(manifestText) as ArtifactRecordManifest;
      const storedHex = CONTENT_HASH_PATTERN.exec(manifest.spec.contentHash)?.[1];
      if (storedHex === undefined || sha256Hex(content) !== storedHex) {
        throw new Error(`Stored artifact "${name}" failed read-back hash verification: on-disk content does not match its manifest`);
      }
      return content;
    },

    async readArtifactManifest(name: string): Promise<ArtifactRecordManifest | undefined> {
      const { manifestPath } = pathsFor(name);
      try {
        return JSON.parse(await readFile(manifestPath, 'utf8')) as ArtifactRecordManifest;
      } catch {
        return undefined;
      }
    },
  };
}
