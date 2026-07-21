import { describe, expect, it } from 'vitest';
import { admitScript } from '../scriptAdmission.js';
import { digestNormalizedScript, normalizeScript, validateScript } from '../scriptValidation.js';

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

  it('commits the digest to the normalized source (CRLF and LF match)', async () => {
    const lf = 'export default async function* run(ctx) {\n  yield* ctx.runAgent({ profileId: "test" });\n}';
    const crlf = lf.replaceAll('\n', '\r\n');
    const r1 = await validateScript(lf);
    const r2 = await validateScript(crlf);
    expect(r1.digest).toBe(r2.digest);
  });

  it('digest matches a direct digest of the normalized source', async () => {
    const result = await validateScript(VALID_SCRIPT);
    expect(result.digest).toBe(await digestNormalizedScript(normalizeScript(VALID_SCRIPT)));
  });
});

describe('validateScript AST robustness (adversarial)', () => {
  const EXPORT = 'export default async function* run() {}';

  it('ignores imports inside line comments', async () => {
    const result = await validateScript(`// import { readFileSync } from "node:fs";\n${EXPORT}`);
    expect(result.valid).toBe(true);
    expect(result.imports).toHaveLength(0);
  });

  it('ignores imports inside block comments', async () => {
    const result = await validateScript(`/* import "node:fs"; export default 42 */\n${EXPORT}`);
    expect(result.valid).toBe(true);
    expect(result.imports).toHaveLength(0);
  });

  it('ignores imports inside string literals', async () => {
    const result = await validateScript(`const s = 'import { x } from "node:fs"; module.exports = 1;';\n${EXPORT}`);
    expect(result.valid).toBe(true);
    expect(result.imports).toHaveLength(0);
  });

  it('ignores imports inside template literals', async () => {
    const result = await validateScript('const s = `import fs from "node:fs"; exports.x = 1;`;\n' + EXPORT);
    expect(result.valid).toBe(true);
    expect(result.imports).toHaveLength(0);
  });

  it('ignores the word import inside regex literals', async () => {
    const result = await validateScript('const re = /import\\s+fs from "node:fs"; module\\.exports/g;\n' + EXPORT);
    expect(result.valid).toBe(true);
    expect(result.imports).toHaveLength(0);
  });

  it('detects a disguised default export via identifier binding', async () => {
    const result = await validateScript('async function* agent(ctx) { yield ctx; }\nexport default agent;');
    expect(result.valid).toBe(true);
    expect(result.hasDefaultExport).toBe(true);
  });

  it('detects a disguised default export via variable binding', async () => {
    const result = await validateScript('const agent = async function* () {};\nexport default agent;');
    expect(result.valid).toBe(true);
    expect(result.hasDefaultExport).toBe(true);
  });

  it('rejects a default export that is not an async generator', async () => {
    const result = await validateScript('export default function run() {}');
    expect(result.valid).toBe(false);
    expect(result.hasDefaultExport).toBe(false);
  });

  it('counts re-exports as imports', async () => {
    const result = await validateScript(`export { readFileSync } from "node:fs";\n${EXPORT}`);
    expect(result.valid).toBe(false);
    expect(result.imports).toContain('node:fs');
    expect(result.errors.some((e) => e.includes('Forbidden import'))).toBe(true);
  });

  it('counts export-all as an import', async () => {
    const result = await validateScript(`export * from "libp2p";\n${EXPORT}`);
    expect(result.valid).toBe(false);
    expect(result.imports).toContain('libp2p');
  });

  it('rejects dynamic import of a non-literal', async () => {
    const source = `export default async function* run() { const m = await import(specifier); yield m; }`;
    const result = await validateScript(source);
    expect(result.valid).toBe(false);
    expect(result.hasNonLiteralDynamicImport).toBe(true);
    expect(result.errors.some((e) => e.includes('non-literal'))).toBe(true);
  });

  it('records string-literal dynamic imports', async () => {
    const source = `export default async function* run() { const m = await import("node:os"); yield m; }`;
    const result = await validateScript(source);
    expect(result.valid).toBe(false);
    expect(result.hasNonLiteralDynamicImport).toBe(false);
    expect(result.imports).toContain('node:os');
    expect(result.errors.some((e) => e.includes('Forbidden import'))).toBe(true);
  });

  it('rejects CommonJS detected from the AST (not regex)', async () => {
    const result = await validateScript('exports.run = async function* () {};');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('CommonJS'))).toBe(true);
  });

  it('reports syntax errors instead of guessing', async () => {
    const result = await validateScript('export default async function* run( {');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Syntax error'))).toBe(true);
  });

  it('rejects a named async generator without a default export', async () => {
    const result = await validateScript(VALID_SCRIPT_2);
    expect(result.valid).toBe(false);
    expect(result.hasDefaultExport).toBe(false);
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
