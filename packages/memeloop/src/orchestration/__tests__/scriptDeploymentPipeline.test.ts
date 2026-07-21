import { describe, expect, it } from 'vitest';
import type { ArtifactRecordManifest } from '../resources.js';
import { createScriptLoadGate, deployGeneratedScript, type ScriptArtifactStore } from '../scripts/scriptDeploymentPipeline.js';
import { validateScript } from '../scripts/scriptValidation.js';

const VALID_SCRIPT = 'export default async function* myAgent(ctx) { yield* ctx.runAgent({ profileId: "test" }); }';
const INVALID_SCRIPT = 'import { readFileSync } from "node:fs"; export default async function* f() {}';

function createRecordingStore(): { store: ScriptArtifactStore; puts: Array<{ manifest: ArtifactRecordManifest; content: string }> } {
  const puts: Array<{ manifest: ArtifactRecordManifest; content: string }> = [];
  return {
    puts,
    store: {
      putArtifact: (manifest, content) => {
        puts.push({ manifest, content });
      },
    },
  };
}

describe('deployGeneratedScript', () => {
  it('runs the full chain: validate → admit → artifact → runtime class → deployment', async () => {
    const { store, puts } = createRecordingStore();
    const result = await deployGeneratedScript(
      {
        source: VALID_SCRIPT,
        authorTrust: 'trusted',
        requestedInterfaces: ['loop-runtime'],
        lifecycle: 'service',
        namespace: 'agents',
        nodeSelector: { role: 'worker' },
        env: { MODE: 'service' },
      },
      { artifactStore: store },
    );

    expect(result.deployed).toBe(true);
    expect(result.validation.valid).toBe(true);
    expect(result.admission?.admitted).toBe(true);

    // Artifact manifest is content-addressed by the canonical digest.
    const digest = result.validation.digest;
    expect(result.artifact?.metadata.name).toBe(`script-${digest}`);
    expect(result.artifact?.metadata.namespace).toBe('agents');
    expect(result.artifact?.spec.contentHash).toBe(`sha256:${digest}`);
    expect(result.artifact?.spec.mimeType).toBe('text/javascript');
    expect(result.artifact?.spec.trust).toBe('trusted');

    // Deployment references the artifact by digest and never carries source.
    expect(result.deployment?.artifactRef).toEqual({
      apiVersion: 'artifacts.memeloop.io/v1alpha1',
      kind: 'ArtifactRecord',
      name: `script-${digest}`,
      namespace: 'agents',
      contentDigest: `sha256:${digest}`,
    });
    expect(result.deployment).not.toHaveProperty('script');
    expect(result.deployment).not.toHaveProperty('scriptDigest');
    expect(result.deployment?.trustClass).toBe('trusted');
    expect(result.deployment?.lifecycle).toBe('service');
    expect(result.deployment?.nodeSelector).toEqual({ role: 'worker' });
    expect(result.deployment?.env).toEqual({ MODE: 'service' });

    // Artifact persistence port received the manifest and normalized content.
    expect(puts).toHaveLength(1);
    expect(puts[0].manifest.spec.contentHash).toBe(`sha256:${digest}`);
  });

  it.each(
    [
      ['trusted', 'trusted-process'],
      ['restricted', 'restricted-process'],
      ['quarantine', 'quarantine-process'],
    ] as const,
  )('selects %s runtime class for %s scripts', async (trust, expectedRuntimeClass) => {
    const result = await deployGeneratedScript({
      source: VALID_SCRIPT,
      authorTrust: trust,
      requestedInterfaces: ['loop-runtime'],
      lifecycle: 'run-once',
    });
    expect(result.deployed).toBe(true);
    expect(result.deployment?.runtimeClass).toBe(expectedRuntimeClass);
    expect(result.runtimeClass?.runtimeClass).toBe(expectedRuntimeClass);
  });

  it('persists normalized content so CRLF sources share one artifact address', async () => {
    const { store, puts } = createRecordingStore();
    const lf = VALID_SCRIPT;
    const crlf = VALID_SCRIPT.replaceAll('\n', '\r\n') + '\r\n';
    const first = await deployGeneratedScript(
      { source: lf, authorTrust: 'trusted', requestedInterfaces: [], lifecycle: 'run-once' },
      { artifactStore: store },
    );
    const second = await deployGeneratedScript(
      { source: crlf, authorTrust: 'trusted', requestedInterfaces: [], lifecycle: 'run-once' },
      { artifactStore: store },
    );
    expect(first.deployment?.artifactRef.contentDigest).toBe(second.deployment?.artifactRef.contentDigest);
    expect(puts[0].content).toBe(puts[1].content);
  });

  it('rejects invalid scripts before building any artifact', async () => {
    const { store, puts } = createRecordingStore();
    const result = await deployGeneratedScript(
      { source: INVALID_SCRIPT, authorTrust: 'trusted', requestedInterfaces: [], lifecycle: 'run-once' },
      { artifactStore: store },
    );
    expect(result.deployed).toBe(false);
    expect(result.reason).toContain('validation failed');
    expect(result.artifact).toBeUndefined();
    expect(result.deployment).toBeUndefined();
    expect(puts).toHaveLength(0);
  });

  it('rejects scripts denied by admission policy', async () => {
    const result = await deployGeneratedScript({
      source: VALID_SCRIPT,
      authorTrust: 'quarantine',
      requestedInterfaces: ['network'],
      lifecycle: 'run-once',
    });
    expect(result.deployed).toBe(false);
    expect(result.admission?.admitted).toBe(false);
    expect(result.deployment).toBeUndefined();
  });

  it('enforces checkpoint compatibility: changed script cannot resume old checkpoint', async () => {
    const other = await validateScript('export default async function* other() {}');
    const result = await deployGeneratedScript({
      source: VALID_SCRIPT,
      authorTrust: 'trusted',
      requestedInterfaces: ['loop-runtime'],
      lifecycle: 'run-once',
      expectedCheckpointDigest: other.digest,
      checkpointApiVersion: 'loops.memeloop.io/v1alpha1',
    });
    expect(result.deployed).toBe(false);
    expect(result.admission?.admitted).toBe(true);
    expect(result.admission?.checkpointCompatible).toBe(false);
    expect(result.reason).toContain('Checkpoint');
    expect(result.deployment).toBeUndefined();
  });

  it('allows resuming a checkpoint produced by the same script digest', async () => {
    const validated = await validateScript(VALID_SCRIPT);
    const result = await deployGeneratedScript({
      source: VALID_SCRIPT,
      authorTrust: 'trusted',
      requestedInterfaces: ['loop-runtime'],
      lifecycle: 'run-once',
      expectedCheckpointDigest: validated.digest,
      checkpointApiVersion: 'loops.memeloop.io/v1alpha1',
    });
    expect(result.deployed).toBe(true);
    expect(result.admission?.checkpointCompatible).toBe(true);
  });
});

describe('createScriptLoadGate', () => {
  const gate = createScriptLoadGate({
    authorTrust: 'trusted',
    requestedInterfaces: ['loop-runtime'],
  });

  it('admits valid scripts and assigns trust class + runtime class', async () => {
    const validated = await validateScript(VALID_SCRIPT);
    const decision = await gate.admitScriptLoad({
      normalizedSource: VALID_SCRIPT,
      digest: validated.digest,
      reference: { kind: 'source', source: VALID_SCRIPT },
      scriptType: 'test',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.trustClass).toBe('trusted');
    expect(decision.runtimeClass).toBe('trusted-process');
    expect(decision.checkpointCompatible).toBe(true);
  });

  it('denies invalid scripts with the validation errors', async () => {
    const validated = await validateScript(INVALID_SCRIPT);
    const decision = await gate.admitScriptLoad({
      normalizedSource: INVALID_SCRIPT,
      digest: validated.digest,
      reference: { kind: 'source', source: INVALID_SCRIPT },
      scriptType: 'test',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Forbidden import');
  });

  it('denies when the loader digest does not match the validated source', async () => {
    const decision = await gate.admitScriptLoad({
      normalizedSource: VALID_SCRIPT,
      digest: '0'.repeat(64),
      reference: { kind: 'source', source: VALID_SCRIPT },
      scriptType: 'test',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Digest mismatch');
  });

  it('enforces checkpoint compatibility at the gate', async () => {
    const incompatibleGate = createScriptLoadGate({
      authorTrust: 'trusted',
      requestedInterfaces: ['loop-runtime'],
      expectedCheckpointDigest: 'f'.repeat(64),
      checkpointApiVersion: 'loops.memeloop.io/v1alpha1',
    });
    const validated = await validateScript(VALID_SCRIPT);
    const decision = await incompatibleGate.admitScriptLoad({
      normalizedSource: VALID_SCRIPT,
      digest: validated.digest,
      reference: { kind: 'source', source: VALID_SCRIPT },
      scriptType: 'test',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Checkpoint');
  });
});
