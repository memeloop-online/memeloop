import { describe, expect, it } from 'vitest';

import { createScriptDeploymentClient, type ScriptArtifactStore } from '../scripts/scriptDeploymentPipeline.js';

const VALID_SCRIPT = 'export default async function* myAgent(ctx) { yield "ok"; }';
const INVALID_SCRIPT = 'import { readFileSync } from "node:fs"; export default async function* f() { yield "x"; }';

describe('createScriptDeploymentClient', () => {
  it('deploys a valid script with host-bound trust and persists via the store', async () => {
    const puts: Array<{ name: string; content: string }> = [];
    const artifactStore: ScriptArtifactStore = {
      putArtifact: (manifest, content) => {
        puts.push({ name: manifest.metadata.name!, content });
      },
    };
    const client = createScriptDeploymentClient({
      authorTrust: 'trusted',
      artifactStore,
      namespace: 'fleet',
    });

    const result = await client.deploy({ source: VALID_SCRIPT, lifecycle: 'service' });

    expect(result.deployed).toBe(true);
    expect(result.deployment?.trustClass).toBe('trusted');
    expect(result.deployment?.lifecycle).toBe('service');
    expect(result.deployment?.runtimeClass).toBe('trusted-process');
    expect(result.artifact?.metadata.namespace).toBe('fleet');
    expect(puts).toHaveLength(1);
    expect(puts[0].name).toBe(result.artifact?.metadata.name);
  });

  it('binds trust from host config — scripts cannot elevate it', async () => {
    const client = createScriptDeploymentClient({ authorTrust: 'quarantine' });

    // A quarantine-context client requesting model-provider (outside the
    // quarantine profile) is denied by admission even though the script
    // itself is syntactically valid.
    const result = await client.deploy({
      source: VALID_SCRIPT,
      lifecycle: 'run-once',
      requestedInterfaces: ['loop-runtime', 'model-provider'],
    });

    expect(result.deployed).toBe(false);
    expect(result.reason).toMatch(/model-provider/);
  });

  it('applies the quarantine runtime envelope for quarantine-bound clients', async () => {
    const client = createScriptDeploymentClient({ authorTrust: 'quarantine' });

    const result = await client.deploy({ source: VALID_SCRIPT, lifecycle: 'run-once' });

    expect(result.deployed).toBe(true);
    expect(result.deployment?.trustClass).toBe('quarantine');
    expect(result.deployment?.runtimeClass).toBe('quarantine-process');
    expect(result.admission?.approvedInterfaces).toEqual(['loop-runtime']);
  });

  it('honors a narrower script-requested interface subset', async () => {
    const client = createScriptDeploymentClient({ authorTrust: 'trusted' });

    const result = await client.deploy({
      source: VALID_SCRIPT,
      lifecycle: 'run-once',
      requestedInterfaces: ['loop-runtime'],
    });

    expect(result.deployed).toBe(true);
    expect(result.admission?.approvedInterfaces).toEqual(['loop-runtime']);
  });

  it('rejects forbidden imports through admission without throwing', async () => {
    const client = createScriptDeploymentClient({ authorTrust: 'restricted' });

    const result = await client.deploy({ source: INVALID_SCRIPT, lifecycle: 'run-once' });

    expect(result.deployed).toBe(false);
    expect(result.reason).toMatch(/node:fs/);
  });

  it('lets a per-request namespace override the configured default', async () => {
    const client = createScriptDeploymentClient({ authorTrust: 'trusted', namespace: 'default-ns' });

    const result = await client.deploy({ source: VALID_SCRIPT, lifecycle: 'run-once', namespace: 'other-ns' });

    expect(result.deployed).toBe(true);
    expect(result.artifact?.metadata.namespace).toBe('other-ns');
  });
});
