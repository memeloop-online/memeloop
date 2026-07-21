import { describe, expect, it } from 'vitest';
import { BUILTIN_AGENT_AGENT_LOOP_QUALITY_GATE_SCRIPT_ID } from '../../loops/agent-agent-loop/builtinLoopSources.js';
import { createScriptLoadGate } from '../../orchestration/scriptDeploymentPipeline.js';
import { digestNormalizedScript, normalizeScript } from '../../orchestration/scriptValidation.js';
import { loadAgentAgentLoopScript } from '../agent-agent-loop/scriptLoader.js';
import {
  FAIL_CLOSED_SCRIPT_LOAD_GATE,
  getLoadedScriptMetadata,
  isRegisteredBuiltinScriptDigest,
  loadAgentLoopScript,
  LOADED_SCRIPT_METADATA,
  registerBuiltinScriptDigests,
  registerBuiltinScriptSources,
  ScriptLoadDeniedError,
} from '../scriptLoader.js';

const VALID_SOURCE = 'export default async function* run(ctx) { yield { type: "message", data: "ok" }; }';

describe('builtin digest allowlist', () => {
  it('registers builtin sources by canonical digest', async () => {
    const registeredSource = 'export default function reg() { return 1; }';
    const digests = await registerBuiltinScriptSources({ 'builtin:test/registered': registeredSource });
    const expected = await digestNormalizedScript(normalizeScript(registeredSource));
    expect(digests).toEqual([expected]);
    expect(isRegisteredBuiltinScriptDigest(expected)).toBe(true);
  });

  it('loads a builtin script whose digest is allowlisted, with metadata', async () => {
    const source = 'export default function run() { return "builtin-ok"; }';
    await registerBuiltinScriptSources({ 'builtin:test/allowed': source });
    const script = await loadAgentLoopScript<() => string>(
      { kind: 'builtin', id: 'builtin:test/allowed' },
      { getBuiltinScriptSource: () => source },
    );
    expect(script()).toBe('builtin-ok');
    const metadata = getLoadedScriptMetadata(script);
    expect(metadata?.builtin).toBe(true);
    expect(metadata?.trustClass).toBe('trusted');
    expect(metadata?.digest).toBe(await digestNormalizedScript(normalizeScript(source)));
  });

  it('registerBuiltinScriptDigests accepts pre-computed digests', async () => {
    const source = 'export default function run() { return "pre"; }';
    const digest = await digestNormalizedScript(normalizeScript(source));
    registerBuiltinScriptDigests([digest]);
    const script = await loadAgentLoopScript<() => string>(
      { kind: 'source', source },
      { allowSource: true },
    );
    expect(script()).toBe('pre');
    expect(getLoadedScriptMetadata(script)?.builtin).toBe(true);
  });
});

describe('fail-closed default gate', () => {
  it('denies source refs when no gate is configured', async () => {
    await expect(loadAgentLoopScript({ kind: 'source', source: VALID_SOURCE }, { allowSource: true }))
      .rejects.toThrowError(ScriptLoadDeniedError);
  });

  it('denies data: URL specifiers when no gate is configured', async () => {
    const specifier = `data:text/javascript,${encodeURIComponent(VALID_SOURCE)}`;
    await expect(loadAgentLoopScript(specifier, { allowSource: true }))
      .rejects.toThrowError(ScriptLoadDeniedError);
  });

  it('produces a structured denial error with digest and reason', async () => {
    const error = await loadAgentLoopScript({ kind: 'source', source: VALID_SOURCE }, { allowSource: true })
      .catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(ScriptLoadDeniedError);
    const denied = error as ScriptLoadDeniedError;
    expect(denied.code).toBe('SCRIPT_LOAD_DENIED');
    expect(denied.digest).toBe(await digestNormalizedScript(normalizeScript(VALID_SOURCE)));
    expect(denied.gateReason).toContain('fail-closed');
    expect(denied.message).toContain('denied');
  });

  it('FAIL_CLOSED_SCRIPT_LOAD_GATE always denies', async () => {
    const decision = await FAIL_CLOSED_SCRIPT_LOAD_GATE.admitScriptLoad({
      normalizedSource: VALID_SOURCE,
      digest: 'x',
      reference: { kind: 'source', source: VALID_SOURCE },
      scriptType: 'test',
    });
    expect(decision.allowed).toBe(false);
  });
});

describe('host-configured gate', () => {
  it('surfaces the gate denial reason in the error', async () => {
    await expect(
      loadAgentLoopScript(
        { kind: 'source', source: VALID_SOURCE },
        {
          allowSource: true,
          scriptLoadGate: { admitScriptLoad: () => ({ allowed: false, reason: 'host policy says no' }) },
        },
      ),
    ).rejects.toThrowError(/host policy says no/);
  });

  it('loads an admitted source and attaches admission metadata', async () => {
    const script = await loadAgentLoopScript(
      { kind: 'source', source: VALID_SOURCE, name: 'admitted.mjs' },
      {
        allowSource: true,
        scriptLoadGate: createScriptLoadGate({
          authorTrust: 'restricted',
          requestedInterfaces: ['loop-runtime'],
        }),
      },
    );
    expect(typeof script).toBe('function');
    const metadata = getLoadedScriptMetadata(script);
    expect(metadata?.builtin).toBe(false);
    expect(metadata?.trustClass).toBe('restricted');
    expect(metadata?.runtimeClass).toBe('restricted-process');
    expect(metadata?.checkpointCompatible).toBe(true);
    expect((script as Record<PropertyKey, unknown>)[LOADED_SCRIPT_METADATA]).toBe(metadata);
  });

  it('rejects scripts with non-literal dynamic imports through the real gate', async () => {
    const sneaky = 'export default async function* run() { const m = await import(name); yield m; }';
    await expect(
      loadAgentLoopScript(
        { kind: 'source', source: sneaky },
        {
          allowSource: true,
          scriptLoadGate: createScriptLoadGate({ authorTrust: 'trusted', requestedInterfaces: [] }),
        },
      ),
    ).rejects.toThrowError(/non-literal/);
  });
});

describe('production wiring', () => {
  it('loads the bundled agent-agent-loop builtin via the digest allowlist', async () => {
    const script = await loadAgentAgentLoopScript({ kind: 'builtin', id: BUILTIN_AGENT_AGENT_LOOP_QUALITY_GATE_SCRIPT_ID });
    expect(typeof script).toBe('function');
    const metadata = getLoadedScriptMetadata(script);
    expect(metadata?.builtin).toBe(true);
    expect(metadata?.trustClass).toBe('trusted');
  });

  it('denies a non-builtin source through the production loader without a host gate', async () => {
    await expect(loadAgentAgentLoopScript({ kind: 'source', source: VALID_SOURCE }, { allowSource: true }))
      .rejects.toThrowError(ScriptLoadDeniedError);
  });
});
