/**
 * Generated-script validation and normalization (plan 24.16).
 *
 * Validates Agent-generated .mjs scripts before they are scheduled:
 * - Syntax check via a real JavaScript parser (Acorn) — regexes could be
 *   fooled by comments/strings/regex literals; an AST cannot.
 * - Required export shape: the default export must be an async generator
 *   function (inline or via an identifier bound to one in the same module).
 * - Import extraction from the AST: static `import` declarations, re-exports
 *   (`export ... from`), and string-literal dynamic `import()` arguments.
 *   Non-literal dynamic imports are rejected because they defeat admission.
 * - Forbidden imports: no Node builtins except 'node:events'.
 * - Size limits.
 * - Canonical SHA-256 digest for provenance. The digest commits to the
 *   NORMALIZED source (see {@link normalizeScript}), so semantically
 *   identical scripts with different line endings share one digest.
 *
 * Security note: this runs in the controller process, but never executes
 * the script. Execution is delegated to the sandbox from plan 24.48.
 */

import { parse } from 'acorn';

const MAX_SCRIPT_BYTES = 1_048_576; // 1 MiB

export interface ScriptValidationResult {
  valid: boolean;
  /**
   * Canonical SHA-256 hex digest of the NORMALIZED source
   * (`normalizeScript(source)`). The digest commits to the normalized form,
   * not the raw bytes, so CRLF/LF variants of the same script are equal.
   */
  digest: string;
  /** Detected imports, from the AST (static, re-export, literal dynamic). */
  imports: string[];
  /** Whether the script's default export is an async generator function. */
  hasDefaultExport: boolean;
  /**
   * Whether the script contains a dynamic `import()` whose argument is not
   * a string literal. Such scripts are always invalid: the import target
   * cannot be known statically, which defeats admission control.
   */
  hasNonLiteralDynamicImport: boolean;
  /** Human-readable errors if invalid. */
  errors: string[];
  /** Normalized source size in bytes. */
  sizeBytes: number;
}

/** Minimal structural type for generic AST traversal. */
interface AstNode {
  type: string;
  [key: string]: unknown;
}

function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string';
}

/**
 * Recursively visit every node in an ESTree AST. Only properties holding
 * node-like values (objects/arrays of objects with a string `type`) are
 * traversed, so scalar fields (names, literals, ranges) are skipped.
 */
function walkAst(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const key of Object.keys(node)) {
    const value: unknown = node[key];
    if (Array.isArray(value)) {
      for (const child of value as unknown[]) {
        if (isAstNode(child)) walkAst(child, visit);
      }
    } else if (isAstNode(value)) {
      walkAst(value, visit);
    }
  }
}

function isAsyncGeneratorFunction(node: AstNode | null | undefined): boolean {
  if (!node) return false;
  return (
    (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') &&
    node.async === true &&
    node.generator === true
  );
}

function getStaticImportSource(node: AstNode): string | undefined {
  const source = node.source as AstNode | null | undefined;
  if (source && source.type === 'Literal' && typeof source.value === 'string') {
    return source.value;
  }
  return undefined;
}

/** Detect `module.exports = ...` or `exports.foo = ...` assignments. */
function isCommonJsExportAssignment(node: AstNode): boolean {
  if (node.type !== 'AssignmentExpression') return false;
  const left = node.left as AstNode | undefined;
  if (!left || left.type !== 'MemberExpression' || left.computed === true) return false;
  const object = left.object as AstNode | undefined;
  const property = left.property as AstNode | undefined;
  if (!object || object.type !== 'Identifier' || !property || property.type !== 'Identifier') {
    return false;
  }
  if (object.name === 'exports') return true;
  return object.name === 'module' && property.name === 'exports';
}

/**
 * Compute the canonical SHA-256 hex digest of an already-normalized script.
 * Callers with raw source must pass it through {@link normalizeScript} first
 * (or use {@link validateScript}, which normalizes internally).
 */
export async function digestNormalizedScript(normalizedSource: string): Promise<string> {
  const encoded = new TextEncoder().encode(normalizedSource);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate a script string using a real AST parse (Acorn).
 * Returns a structured result; never throws.
 */
export async function validateScript(source: string): Promise<ScriptValidationResult> {
  const errors: string[] = [];
  const imports: string[] = [];
  let hasDefaultExport = false;
  let hasNonLiteralDynamicImport = false;

  const normalized = normalizeScript(source);
  const encoded = new TextEncoder().encode(normalized);

  // Size check (on the canonical form the digest commits to).
  if (encoded.length > MAX_SCRIPT_BYTES) {
    errors.push(`Script exceeds ${MAX_SCRIPT_BYTES} bytes (got ${encoded.length})`);
  }
  if (normalized.trim().length === 0) {
    errors.push('Script is empty');
  }

  // The digest commits to the normalized source, never the raw bytes.
  const digest = await digestNormalizedScript(normalized);

  // Parse with a real JavaScript parser. Comments, strings, template
  // literals, and regex literals cannot smuggle fake imports/exports.
  let program: AstNode | undefined;
  if (normalized.trim().length > 0) {
    try {
      program = parse(normalized, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as AstNode;
    } catch (error) {
      errors.push(`Syntax error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (program) {
    const topLevel = Array.isArray(program.body) ? (program.body as AstNode[]) : [];

    // 1. Default export shape (top-level statements only).
    for (const statement of topLevel) {
      if (statement.type !== 'ExportDefaultDeclaration') continue;
      const declaration = statement.declaration as AstNode | undefined;
      if (isAsyncGeneratorFunction(declaration)) {
        hasDefaultExport = true;
      } else if (declaration?.type === 'Identifier') {
        // Disguised default export: `async function* run() {} export default run;`
        const identifier = declaration;
        hasDefaultExport = topLevel.some((candidate) => {
          if (isAsyncGeneratorFunction(candidate) && (candidate.id as AstNode | undefined)?.name === identifier.name) {
            return true;
          }
          if (candidate.type === 'VariableDeclaration' && Array.isArray(candidate.declarations)) {
            return (candidate.declarations as AstNode[]).some(
              (declarator) =>
                (declarator.id as AstNode | undefined)?.name === identifier.name &&
                isAsyncGeneratorFunction(declarator.init as AstNode | undefined),
            );
          }
          return false;
        });
      }
    }

    // 2. Imports, re-exports, dynamic imports, and CommonJS (full AST walk).
    walkAst(program, (node) => {
      if (node.type === 'ImportDeclaration') {
        const specifier = getStaticImportSource(node);
        if (specifier !== undefined) imports.push(specifier);
      } else if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
        // Re-exports (`export { x } from '...'`, `export * from '...'`) import too.
        const specifier = getStaticImportSource(node);
        if (specifier !== undefined) imports.push(specifier);
      } else if (node.type === 'ImportExpression') {
        const specifier = getStaticImportSource(node);
        if (specifier !== undefined) {
          imports.push(specifier);
        } else {
          hasNonLiteralDynamicImport = true;
        }
      } else if (isCommonJsExportAssignment(node)) {
        errors.push('CommonJS module.exports not supported (use ESM export)');
      }
    });
  }

  // 3. Forbidden imports.
  for (const specifier of imports) {
    if (isForbiddenImport(specifier)) {
      errors.push(`Forbidden import: ${specifier}`);
    }
  }

  // 4. Non-literal dynamic imports defeat admission control.
  if (hasNonLiteralDynamicImport) {
    errors.push('Dynamic import() with a non-literal argument is not allowed (defeats admission control)');
  }

  // 5. Required export shape.
  if (!hasDefaultExport) {
    errors.push('Script must export a default async generator function');
  }

  return {
    valid: errors.length === 0,
    digest,
    imports,
    hasDefaultExport,
    hasNonLiteralDynamicImport,
    errors,
    sizeBytes: encoded.length,
  };
}

/**
 * Normalize a script to a canonical form for digest stability.
 * Strips BOM, normalizes line endings to LF, and trims trailing whitespace.
 * Idempotent: `normalizeScript(normalizeScript(s)) === normalizeScript(s)`.
 * The canonical digest in {@link validateScript} commits to this form.
 */
export function normalizeScript(source: string): string {
  return source
    .replace(/^\uFEFF/, '') // BOM
    .replace(/\r\n/g, '\n') // CRLF → LF
    .replace(/\r/g, '\n') // CR → LF
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim() + '\n';
}

function isForbiddenImport(spec: string): boolean {
  // Node builtins are forbidden except 'events'.
  const builtins = new Set([
    'fs',
    'path',
    'child_process',
    'net',
    'http',
    'https',
    'os',
    'crypto',
    'tls',
    'dgram',
    'dns',
    'readline',
    'repl',
    'stream',
    'timers',
    'tty',
    'url',
    'util',
    'v8',
    'vm',
    'worker_threads',
    'zlib',
    'assert',
    'buffer',
    'querystring',
    'string_decoder',
  ]);
  const base = spec.replace(/^node:/, '');
  if (builtins.has(base) && spec !== 'node:events') return true;

  // Libp2p imports are forbidden.
  if (spec.startsWith('@libp2p/') || spec.startsWith('@chainsafe/libp2p') || spec === 'libp2p') {
    return true;
  }

  // Process/tool-specific: scripts cannot import the host runtime.
  if (spec === 'memeloop' || spec.startsWith('memeloop/')) return true;

  return false;
}
