import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ScriptLoadGate } from 'memeloop';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SQLiteAgentStorage } from '../../storage/sqliteStorage.js';
import { createNodeRuntime } from '../nodeRuntime.js';

const VALID_SCRIPT = 'export default async function* myAgent(ctx) { yield "ok"; }';
const FS_IMPORT_SCRIPT = 'import { readFileSync } from "node:fs"; export default async function* f() { yield "x"; }';

function mkLLMProvider() {
  return {
    name: 'script-chain-test',
    chat: async function*() {
      yield { type: 'text-delta' as const, content: 'ok', id: '1' };
    },
  };
}

function gateOf(context: { loopScriptPolicy?: { scriptLoadGate?: ScriptLoadGate } }): ScriptLoadGate {
  const gate = context.loopScriptPolicy?.scriptLoadGate;
  if (!gate) throw new Error('expected a wired script load gate');
  return gate;
}

describe('createNodeRuntime script deployment chain (24.15)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-scriptchain-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function makeRuntime(options: Parameters<typeof createNodeRuntime>[0] = {}) {
    return await createNodeRuntime({
      storage: new SQLiteAgentStorage({ filename: ':memory:' }),
      llmProvider: mkLLMProvider() as never,
      dataDir,
      config: { providers: [] },
      ...options,
    });
  }

  it('wires the default script load gate and artifact store for trusted mode', async () => {
    const runtime = await makeRuntime();

    expect(runtime.workerTrustClass).toBe('trusted');
    expect(runtime.scriptArtifactStore).toBeDefined();
    expect(runtime.scriptArtifactStore?.artifactDirectory).toBe(
      path.join(dataDir, 'artifacts', 'scripts'),
    );

    const gate = gateOf(runtime.context);
    const admitted = await gate.admitScriptLoad({
      normalizedSource: `${VALID_SCRIPT}\n`,
      digest: await digestOf(VALID_SCRIPT),
      reference: { kind: 'source', source: VALID_SCRIPT },
      scriptType: 'test',
    });
    expect(admitted.allowed).toBe(true);
    expect(admitted.trustClass).toBe('trusted');
    expect(admitted.runtimeClass).toBe('trusted-process');
  });

  it('denies scripts violating the configured trust-class policy', async () => {
    const runtime = await makeRuntime({ trustClass: 'restricted' });
    expect(runtime.workerTrustClass).toBe('restricted');

    const gate = gateOf(runtime.context);
    const denied = await gate.admitScriptLoad({
      normalizedSource: `${FS_IMPORT_SCRIPT}\n`,
      digest: await digestOf(FS_IMPORT_SCRIPT),
      reference: { kind: 'source', source: FS_IMPORT_SCRIPT },
      scriptType: 'test',
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch(/node:fs/);
  });

  it('quarantine mode admits only the loop-runtime interface envelope', async () => {
    const runtime = await makeRuntime({ trustClass: 'quarantine' });

    const gate = gateOf(runtime.context);
    const admitted = await gate.admitScriptLoad({
      normalizedSource: `${VALID_SCRIPT}\n`,
      digest: await digestOf(VALID_SCRIPT),
      reference: { kind: 'source', source: VALID_SCRIPT },
      scriptType: 'test',
    });
    expect(admitted.allowed).toBe(true);
    expect(admitted.trustClass).toBe('quarantine');
    expect(admitted.runtimeClass).toBe('quarantine-process');
  });

  it('respects an explicitly provided loopScriptPolicy over the default gate', async () => {
    const runtime = await makeRuntime({ loopScriptPolicy: { allowSource: false } });
    expect(runtime.context.loopScriptPolicy).toEqual({ allowSource: false });
    expect(runtime.context.loopScriptPolicy?.scriptLoadGate).toBeUndefined();
  });

  it('wires host-bound scriptDeployment for ctx.scriptClient (24.14)', async () => {
    const runtime = await makeRuntime({ trustClass: 'restricted' });

    const config = runtime.context.scriptDeployment;
    expect(config?.authorTrust).toBe('restricted');
    expect(config?.requestedInterfaces).toEqual(['resource', 'loop-runtime', 'model-provider']);
    expect(config?.artifactStore).toBe(runtime.scriptArtifactStore);
  });

  it('omits the artifact store when no dataDir is provided', async () => {
    const runtime = await createNodeRuntime({
      storage: new SQLiteAgentStorage({ filename: ':memory:' }),
      llmProvider: mkLLMProvider() as never,
      config: { providers: [] },
    });
    expect(runtime.scriptArtifactStore).toBeUndefined();
    // The default gate still applies (fail-closed behavior is a loader
    // fallback when no gate exists at all).
    expect(runtime.context.loopScriptPolicy?.scriptLoadGate).toBeDefined();
  });
});

async function digestOf(source: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(`${source}\n`, 'utf8').digest('hex');
}
