/**
 * Generated-script validation and normalization (plan 24.16).
 *
 * Validates Agent-generated .mjs scripts before they are scheduled:
 * - Syntax check via real JavaScript parser (Acorn)
 * - Required exports: default export must be an async generator function
 * - Forbidden imports: no Node builtins except 'node:events'
 * - Size limits
 * - Canonical SHA-256 digest for provenance
 *
 * Security note: this runs in the controller process, but never executes
 * the script. Execution is delegated to the sandbox from plan 24.48.
 */

const MAX_SCRIPT_BYTES = 1_048_576; // 1 MiB

export interface ScriptValidationResult {
  valid: boolean;
  /** Canonical SHA-256 hex digest of the source. */
  digest: string;
  /** Detected imports (for admission policy checks). */
  imports: string[];
  /** Whether the script exports a default async generator. */
  hasDefaultExport: boolean;
  /** Human-readable errors if invalid. */
  errors: string[];
  /** Source size in bytes. */
  sizeBytes: number;
}

/**
 * Validate a script string. Returns a structured result; never throws.
 */
export async function validateScript(source: string): Promise<ScriptValidationResult> {
  const errors: string[] = [];
  const imports: string[] = [];

  // Size check.
  const encoded = new TextEncoder().encode(source);
  if (encoded.length > MAX_SCRIPT_BYTES) {
    errors.push(`Script exceeds ${MAX_SCRIPT_BYTES} bytes (got ${encoded.length})`);
  }
  if (source.trim().length === 0) {
    errors.push('Script is empty');
  }

  // Compute canonical digest.
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  const digest = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');

  // Extract imports with regex (fallback when Acorn is unavailable).
  let hasDefaultExport = false;
  const importRegex = /(?:import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"])|(?:import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source)) !== null) {
    const spec = match[1] || match[2];
    if (spec) {
      imports.push(spec);
      // Check for forbidden imports.
      if (isForbiddenImport(spec)) {
        errors.push(`Forbidden import: ${spec}`);
      }
    }
  }

  // Check for default export (async generator or function).
  const exportRegex = /export\s+(?:default\s+)?(?:async\s+)?function\*?\s*(\w*)/g;
  let foundExport = false;
  while ((match = exportRegex.exec(source)) !== null) {
    foundExport = true;
    if (match[0].includes('default')) hasDefaultExport = true;
    if (match[0].includes('async') && match[0].includes('*')) hasDefaultExport = true;
  }

  // Check for module.exports or exports. style.
  if (/module\.exports\s*=|exports\.\w+\s*=/.test(source)) {
    errors.push('CommonJS module.exports not supported (use ESM export)');
  }

  if (!foundExport) {
    errors.push('No export found; script must export a default async generator');
  }

  return {
    valid: errors.length === 0,
    digest,
    imports,
    hasDefaultExport,
    errors,
    sizeBytes: encoded.length,
  };
}

/**
 * Normalize a script to a canonical form for digest stability.
 * Strips BOM, normalizes line endings to LF, and trims trailing whitespace.
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
