import { describe, expect, it } from 'vitest';
import { admitScript } from '../scriptAdmission.js';
import { normalizeScript, validateScript } from '../scriptValidation.js';

const VALID_SCRIPT = 'export default async function* myAgent(ctx) { yield* ctx.runAgent({ profileId: "test" }); }';
const VALID_SCRIPT_2 = 'export async function* agentScript({ state, runAgent, finish }) { await state.set("x", 1); finish("done"); }';
const INVALID_IMPORT_SCRIPT = 'import { readFileSync } from "node:fs"; export default async function* f() {}';
const COMMONJS_SCRIPT = 'module.exports = function() {};';
const NO_EXPORT_SCRIPT = 'const x = 1;';
const LARGE_SCRIPT = 'x'.repeat(2_000_000);

describe('validateScript', () => {
  it('validates a correct script', async () => {
    const result = await validateScript(VALID_SCRIPT);
    expect(result.valid).toBe(true);
    expect(result.digest).toBeTruthy();
    expect(result.hasDefaultExport).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects oversized scripts', async () => {
    const result = await validateScript(LARGE_SCRIPT);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('exceeds'))).toBe(true);
  });

  it('rejects empty scripts', async () => {
    const result = await validateScript('');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('empty'))).toBe(true);
  });

  it('detects forbidden imports', async () => {
    const result = await validateScript(INVALID_IMPORT_SCRIPT);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Forbidden import'))).toBe(true);
    expect(result.imports).toContain('node:fs');
  });

  it('detects CommonJS modules', async () => {
    const result = await validateScript(COMMONJS_SCRIPT);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('CommonJS'))).toBe(true);
  });

  it('rejects scripts without export', async () => {
    const result = await validateScript(NO_EXPORT_SCRIPT);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('export'))).toBe(true);
  });

  it('produces deterministic digest', async () => {
    const r1 = await validateScript(VALID_SCRIPT);
    const r2 = await validateScript(VALID_SCRIPT);
    expect(r1.digest).toBe(r2.digest);
  });
});

describe('normalizeScript', () => {
  it('normalizes line endings', () => {
    const result = normalizeScript('a\r\nb\nc\r\n');
    expect(result).toBe('a\nb\nc\n');
  });

  it('strips BOM', () => {
    const result = normalizeScript('\uFEFFexport default async function*(){}');
    expect(result.startsWith('\uFEFF')).toBe(false);
    expect(result).toContain('export');
  });
});

describe('admitScript', () => {
  it('admits a valid trusted script', async () => {
    const validated = await validateScript(VALID_SCRIPT);
    const decision = admitScript({
      script: validated,
      authorTrust: 'trusted',
      requestedInterfaces: ['loop-runtime'],
    });
    expect(decision.admitted).toBe(true);
    expect(decision.approvedInterfaces).toContain('loop-runtime');
  });

  it('rejects oversized restricted script', async () => {
    const validated = await validateScript(LARGE_SCRIPT);
    const decision = admitScript({
      script: validated,
      authorTrust: 'restricted',
      requestedInterfaces: ['loop-runtime'],
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toContain('exceeds');
  });

  it('rejects quarantine script requesting network', async () => {
    const validated = await validateScript(VALID_SCRIPT);
    const decision = admitScript({
      script: validated,
      authorTrust: 'quarantine',
      requestedInterfaces: ['network'],
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toContain('network');
  });

  it('rejects script without default export', async () => {
    const validated = await validateScript(NO_EXPORT_SCRIPT);
    const decision = admitScript({
      script: validated,
      authorTrust: 'trusted',
      requestedInterfaces: ['loop-runtime'],
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toContain('export');
  });

  it('detects checkpoint incompatibility', async () => {
    const validated = await validateScript(VALID_SCRIPT);
    const validated2 = await validateScript(VALID_SCRIPT_2);
    const decision = admitScript({
      script: validated,
      authorTrust: 'trusted',
      requestedInterfaces: ['loop-runtime'],
      expectedCheckpointDigest: validated2.digest,
      checkpointApiVersion: 'loops.memeloop.io/v1alpha1',
    });
    expect(decision.admitted).toBe(true); // admission succeeds even if checkpoint incompatible
    expect(decision.checkpointCompatible).toBe(false);
  });

  it('allows compatible checkpoint', async () => {
    const validated = await validateScript(VALID_SCRIPT);
    const decision = admitScript({
      script: validated,
      authorTrust: 'trusted',
      requestedInterfaces: ['loop-runtime'],
      expectedCheckpointDigest: validated.digest,
      checkpointApiVersion: 'loops.memeloop.io/v1alpha1',
    });
    expect(decision.checkpointCompatible).toBe(true);
  });
});
