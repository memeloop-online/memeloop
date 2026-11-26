import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createArtifactRecordManifest, deployGeneratedScript } from 'memeloop';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileScriptArtifactStore } from '../orchestration/scriptArtifactStore.js';

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const VALID_SCRIPT = 'export default async function* myAgent(ctx) { yield "ok"; }';
const NORMALIZED = `${VALID_SCRIPT}\n`;

function makeManifest(content: string, name?: string) {
  const digest = sha256Hex(content);
  return createArtifactRecordManifest(name ?? `script-${digest}`, {
    contentHash: `sha256:${digest}`,
    sizeBytes: content.length,
    mimeType: 'text/javascript',
    producer: { trust: 'trusted' },
    trust: 'trusted',
  });
}

describe('createFileScriptArtifactStore', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-artifacts-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists content and manifest content-addressed, with verified read-back', async () => {
    const store = createFileScriptArtifactStore({ dataDir });
    const manifest = makeManifest(NORMALIZED);

    await store.putArtifact(manifest, NORMALIZED);

    const digest = sha256Hex(NORMALIZED);
    expect(store.artifactDirectory).toBe(path.join(dataDir, 'artifacts', 'scripts'));
    expect(fs.existsSync(path.join(store.artifactDirectory, `${digest}.mjs`))).toBe(true);
    expect(fs.existsSync(path.join(store.artifactDirectory, `${digest}.json`))).toBe(true);

    await expect(store.readArtifactContent(manifest.metadata.name!)).resolves.toBe(NORMALIZED);
    await expect(store.readArtifactManifest(manifest.metadata.name!)).resolves.toMatchObject({
      kind: 'ArtifactRecord',
      spec: { contentHash: `sha256:${digest}` },
    });

    // No temp files left behind by the atomic write.
    expect(fs.readdirSync(store.artifactDirectory).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('writes artifacts with owner-only permissions', async () => {
    const store = createFileScriptArtifactStore({ dataDir });
    const manifest = makeManifest(NORMALIZED);
    await store.putArtifact(manifest, NORMALIZED);

    const digest = sha256Hex(NORMALIZED);
    const mode = fs.statSync(path.join(store.artifactDirectory, `${digest}.mjs`)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('rejects content that does not match the manifest hash and writes nothing', async () => {
    const store = createFileScriptArtifactStore({ dataDir });
    const manifest = makeManifest(NORMALIZED);

    await expect(store.putArtifact(manifest, 'tampered content')).rejects.toThrow(/hash mismatch/);
    expect(fs.existsSync(store.artifactDirectory)).toBe(false);
  });

  it('rejects artifact names that are not the digest-derived content address', async () => {
    const store = createFileScriptArtifactStore({ dataDir });
    const manifest = makeManifest(NORMALIZED, 'script-evil');

    await expect(store.putArtifact(manifest, NORMALIZED)).rejects.toThrow(/Invalid script artifact name/);

    // Traversal attempts never reach the filesystem.
    const traversal = makeManifest(NORMALIZED);
    traversal.metadata.name = 'script-../../etc/passwd';
    await expect(store.putArtifact(traversal, NORMALIZED)).rejects.toThrow(/Invalid script artifact name/);
  });

  it('rejects a manifest whose name does not match its content address', async () => {
    const store = createFileScriptArtifactStore({ dataDir });
    const otherDigest = 'a'.repeat(64);
    const manifest = makeManifest(NORMALIZED, `script-${otherDigest}`);

    await expect(store.putArtifact(manifest, NORMALIZED)).rejects.toThrow(/does not match its content address/);
  });

  it('rejects manifests with unsupported contentHash formats', async () => {
    const store = createFileScriptArtifactStore({ dataDir });
    const manifest = makeManifest(NORMALIZED);
    manifest.spec.contentHash = 'md5:deadbeef';

    await expect(store.putArtifact(manifest, NORMALIZED)).rejects.toThrow(/unsupported contentHash/);
  });

  it('returns undefined for missing artifacts', async () => {
    const store = createFileScriptArtifactStore({ dataDir });
    const missing = `script-${'0'.repeat(64)}`;
    await expect(store.readArtifactContent(missing)).resolves.toBeUndefined();
    await expect(store.readArtifactManifest(missing)).resolves.toBeUndefined();
  });

  it('detects on-disk tampering during read-back', async () => {
    const store = createFileScriptArtifactStore({ dataDir });
    const manifest = makeManifest(NORMALIZED);
    await store.putArtifact(manifest, NORMALIZED);

    const digest = sha256Hex(NORMALIZED);
    fs.writeFileSync(path.join(store.artifactDirectory, `${digest}.mjs`), 'evil content');

    await expect(store.readArtifactContent(manifest.metadata.name!)).rejects.toThrow(/read-back hash verification/);
  });

  it('serves as the production artifact store for deployGeneratedScript (24.15)', async () => {
    const store = createFileScriptArtifactStore({ dataDir });

    const result = await deployGeneratedScript(
      {
        source: VALID_SCRIPT,
        authorTrust: 'trusted',
        requestedInterfaces: ['loop-runtime'],
        lifecycle: 'run-once',
      },
      { artifactStore: store },
    );

    expect(result.deployed).toBe(true);
    expect(result.deployment?.artifactRef.name).toBe(result.artifact?.metadata.name);
    expect(result.deployment?.artifactRef.contentDigest).toBe(`sha256:${sha256Hex(NORMALIZED)}`);

    // The deployed artifact is retrievable and hash-verified from disk.
    const restored = await store.readArtifactContent(result.deployment!.artifactRef.name);
    expect(restored).toBe(NORMALIZED);
  });
});
