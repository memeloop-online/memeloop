/**
 * Hostile artifact defenses (plan 24.48).
 *
 * Pure, portable sanitizers run by the artifact driver — OUTSIDE controller
 * processes. Every function is bounded (explicit size limits) and returns
 * structured findings; callers quarantine on hostile fixtures. Nothing here
 * executes, renders, or mounts content.
 */

import { safeErrorMessageFromUnknown } from '../../safeError.js';

export interface SanitizerFinding {
  kind:
    | 'terminal-escape'
    | 'active-markup'
    | 'path-traversal'
    | 'archive-link'
    | 'archive-limit'
    | 'mime-confusion'
    | 'prompt-injection'
    | 'oversized';
  detail: string;
}

export interface SanitizedText {
  text: string;
  findings: SanitizerFinding[];
  renderAs: 'plain-text';
}

// ── Terminal escapes ────────────────────────────────────────────────────────

/* These patterns exist to REMOVE control characters; control escapes are the point. */
/* eslint-disable no-control-regex */
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ESC_SEQUENCE_PATTERN = /\x1b[@-Z\\-_]/g;
// C0 controls except \n \t, plus DEL and the C1 range.
const CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g;
/* eslint-enable no-control-regex */

/**
 * Strip ANSI/OSC/control sequences from worker-produced text before display.
 * Bounded: input beyond `maxLength` is truncated and reported.
 */
export function sanitizeTerminalText(input: string, options: { maxLength?: number } = {}): SanitizedText {
  const maxLength = options.maxLength ?? 64 * 1024;
  const findings: SanitizerFinding[] = [];
  let text = input;
  if (text.length > maxLength) {
    text = text.slice(0, maxLength);
    findings.push({ kind: 'oversized', detail: `text truncated to ${maxLength} characters` });
  }
  for (
    const [pattern, detail] of [
      [OSC_PATTERN, 'OSC sequence'],
      [CSI_PATTERN, 'CSI sequence'],
      [ESC_SEQUENCE_PATTERN, 'escape sequence'],
      [CONTROL_PATTERN, 'control character'],
    ] as const
  ) {
    if (pattern.test(text)) {
      findings.push({ kind: 'terminal-escape', detail });
      text = text.replace(pattern, '');
    }
  }
  return { text, findings, renderAs: 'plain-text' };
}

// ── Active markup ───────────────────────────────────────────────────────────

const MARKUP_PATTERN = /<\s*\/?[a-z!][^>]*>|(?:^|\s)(?:\[[^\]]+\]\([^)]*\)|!\[[^\]]*\]\([^)]*\))/i;

/**
 * Convert untrusted markup to an explicitly plain-text representation. The
 * result must be displayed as text, never passed back through an HTML or
 * Markdown renderer.
 */
export function sanitizeMarkup(input: string, options: { maxLength?: number } = {}): SanitizedText {
  const maxLength = options.maxLength ?? 256 * 1024;
  const findings: SanitizerFinding[] = [];
  let text = input;
  if (text.length > maxLength) {
    text = text.slice(0, maxLength);
    findings.push({ kind: 'oversized', detail: `markup truncated to ${maxLength} characters` });
  }
  if (MARKUP_PATTERN.test(text)) findings.push({ kind: 'active-markup', detail: 'markup escaped for plain-text display' });
  text = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return { text, findings, renderAs: 'plain-text' };
}

// ── Paths and archives ──────────────────────────────────────────────────────

export interface ArchiveEntry {
  path: string;
  sizeBytes: number;
  /** Compressed size when known (for ratio checks). */
  compressedBytes?: number;
  /** Entry is a symlink/hardlink (never extracted). */
  link?: 'symlink' | 'hardlink';
}

export interface ArchiveLimits {
  maxFiles?: number;
  maxTotalBytes?: number;
  maxDepth?: number;
  maxCompressionRatio?: number;
}

const DEFAULT_ARCHIVE_LIMITS: Required<ArchiveLimits> = {
  maxFiles: 10_000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxDepth: 16,
  maxCompressionRatio: 100,
};

/** Normalize a path and reject absolute paths, drive letters, and traversal. */
export function assertSafeArchivePath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.includes('\0')) {
    throw new Error(`NUL byte rejected in archive path: ${path}`);
  }
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`absolute path rejected: ${path}`);
  }
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`path traversal rejected: ${path}`);
  }
  const safe = segments.join('/');
  if (!safe) throw new Error('empty archive path rejected');
  return safe;
}

/** Validate an archive manifest without extracting; throws nothing, returns findings. */
export function validateArchiveManifest(entries: ArchiveEntry[], limits: ArchiveLimits = {}): SanitizerFinding[] {
  const resolved = { ...DEFAULT_ARCHIVE_LIMITS, ...limits };
  const findings: SanitizerFinding[] = [];
  if (entries.length > resolved.maxFiles) {
    findings.push({ kind: 'archive-limit', detail: `${entries.length} entries exceed maxFiles ${resolved.maxFiles}` });
  }
  let total = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
      findings.push({ kind: 'archive-limit', detail: `entry '${entry.path}' has invalid size ${entry.sizeBytes}` });
      continue;
    }
    if (entry.compressedBytes !== undefined && (!Number.isSafeInteger(entry.compressedBytes) || entry.compressedBytes < 0)) {
      findings.push({ kind: 'archive-limit', detail: `entry '${entry.path}' has invalid compressed size ${entry.compressedBytes}` });
      continue;
    }
    total += entry.sizeBytes;
    try {
      const safe = assertSafeArchivePath(entry.path);
      const depth = safe.split('/').length;
      if (depth > resolved.maxDepth) {
        findings.push({ kind: 'archive-limit', detail: `path '${entry.path}' exceeds maxDepth ${resolved.maxDepth}` });
      }
    } catch (error) {
      findings.push({ kind: 'path-traversal', detail: safeErrorMessageFromUnknown(error, { fallback: 'Invalid artifact path' }) });
    }
    if (entry.link) {
      findings.push({ kind: 'archive-link', detail: `${entry.link} entry rejected: ${entry.path}` });
    }
    if (entry.compressedBytes && entry.compressedBytes > 0 && entry.sizeBytes / entry.compressedBytes > resolved.maxCompressionRatio) {
      findings.push({
        kind: 'archive-limit',
        detail: `entry '${entry.path}' compression ratio ${(entry.sizeBytes / entry.compressedBytes).toFixed(0)} exceeds ${resolved.maxCompressionRatio}`,
      });
    }
  }
  if (total > resolved.maxTotalBytes) {
    findings.push({ kind: 'archive-limit', detail: `total size ${total} exceeds maxTotalBytes ${resolved.maxTotalBytes}` });
  }
  return findings;
}

// ── MIME confusion ──────────────────────────────────────────────────────────

const MAGIC_SIGNATURES: Array<{ mime: string; bytes: number[] }> = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'application/x-elf', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { mime: 'application/gzip', bytes: [0x1f, 0x8b] },
];

function sniffMime(content: Uint8Array): string | null {
  for (const signature of MAGIC_SIGNATURES) {
    if (signature.bytes.every((byte, index) => content[index] === byte)) {
      return signature.mime;
    }
  }
  const prefix = new TextDecoder().decode(content.slice(0, 256)).trimStart().toLowerCase();
  if (prefix.startsWith('<!doctype html') || prefix.startsWith('<html')) {
    return 'text/html';
  }
  return null;
}

/** Flag content whose declared MIME disagrees with its magic bytes. */
export function detectMimeConfusion(declaredMime: string, content: Uint8Array): SanitizerFinding | null {
  const sniffed = sniffMime(content);
  if (!sniffed) return null;
  const declared = declaredMime.toLowerCase().split(';')[0].trim();
  if (sniffed === declared) return null;
  // Executables and active documents masquerading as inert types are hostile.
  return { kind: 'mime-confusion', detail: `declared '${declared}' but content looks like '${sniffed}'` };
}

// ── Prompt injection ────────────────────────────────────────────────────────

const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |any )?(previous|prior|above) instructions/i,
  /disregard (all |any )?(previous|prior|above)/i,
  /you are now (a|an) /i,
  /new (system )?(instructions?|prompt|role):/i,
  /\bsystem prompt\b/i,
  /override (your )?(safety|security|policy|guardrails?)/i,
  /exfiltrat/i,
  /\bdo not tell the user\b/i,
];

/**
 * Heuristic prompt-injection markers for text derived from untrusted sources.
 * A hit means the content must stay tainted/quarantined — absence of a hit is
 * NOT proof of safety.
 */
export function scanForPromptInjection(text: string): SanitizerFinding[] {
  const findings: SanitizerFinding[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      findings.push({ kind: 'prompt-injection', detail: `marker '${match[0].slice(0, 60)}'` });
    }
  }
  return findings;
}

// ── Bounded streams ─────────────────────────────────────────────────────────

export interface BoundedCollector {
  push(chunk: Uint8Array): void;
  bytes(): Uint8Array;
  readonly size: number;
}

/** Accumulate a stream with a hard cap; throws `oversized` when exceeded. */
export function createBoundedCollector(maxBytes: number): BoundedCollector {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('maxBytes must be a non-negative safe integer');
  const chunks: Uint8Array[] = [];
  let total = 0;
  return {
    get size() {
      return total;
    },
    push(chunk) {
      if (chunk.byteLength > maxBytes - total) {
        throw new Error(`stream exceeds bound ${maxBytes} bytes`);
      }
      total += chunk.byteLength;
      chunks.push(chunk);
    },
    bytes() {
      const output = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return output;
    },
  };
}
