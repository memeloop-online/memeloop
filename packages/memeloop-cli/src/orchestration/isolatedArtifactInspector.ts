import { spawn } from 'node:child_process';

import { type ArtifactInspectionInput, type ArtifactInspector, type ArtifactSanitizationResult, decodeBase64 as decodeStrictBase64, OrchestrationError } from 'memeloop';

export interface IsolatedArtifactInspectorOptions {
  maxInputBytes?: number;
  timeoutMs?: number;
  maxOldSpaceSizeMb?: number;
  /** Test/telemetry hook; it receives no artifact content. */
  onSpawn?: (pid: number | undefined) => void;
}

interface InspectorRequest {
  operation: 'scan' | 'sanitize' | 'verify';
  input: {
    bytesBase64: string;
    contentHash: string;
    mimeType: string;
  };
  maxInputBytes: number;
  properties?: string[];
}

interface InspectorResponse {
  findings?: string[];
  bytesBase64?: string;
  mimeType?: string;
  properties?: string[];
  passed?: boolean;
  error?: string;
}

/*
 * Kept dependency-free so the same bundled CLI code can spawn it from an
 * Electron utility host or ordinary Node installation. Untrusted bytes cross
 * stdin, never argv/environment, and parsing occurs only in this child.
 */
const INSPECTOR_SOURCE = String.raw`
import { createHash } from 'node:crypto';

const chunks = [];
let inputBytes = 0;
for await (const chunk of process.stdin) {
  inputBytes += chunk.length;
  if (inputBytes > 16 * 1024 * 1024) throw new Error('inspection request is too large');
  chunks.push(chunk);
}
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const bytes = Buffer.from(request.input.bytesBase64, 'base64');
if (!Number.isSafeInteger(request.maxInputBytes) || bytes.length > request.maxInputBytes) {
  throw new Error('artifact exceeds isolated inspection limit');
}
const mimeType = request.input.mimeType;
const hash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const archiveMime = /(?:zip|gzip|tar|rar|7z|compressed|archive)/i;
const archiveMagic =
  (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) ||
  (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) ||
  (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'Rar!') ||
  (bytes.length >= 6 && bytes.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) ||
  (bytes.length >= 262 && bytes.subarray(257, 262).toString('ascii') === 'ustar');
const promptPatterns = [
  /ignore\s+(?:all\s+)?previous\s+instructions?/i,
  /system\s*prompt/i,
  /developer\s+message/i,
  /reveal\s+(?:the\s+)?(?:secret|credential|token|password)/i,
  /execute\s+(?:this\s+)?(?:command|code)/i,
];
function decodedText() {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
function scan() {
  const findings = [];
  if (archiveMime.test(mimeType) || archiveMagic) findings.push('archive-unsupported:archives are rejected rather than parsed in the inspection worker');
  if (archiveMagic && !archiveMime.test(mimeType)) findings.push('mime-confusion:archive magic differs from the declared MIME type');
  if (mimeType.startsWith('text/')) {
    let text;
    try {
      text = decodedText();
    } catch {
      findings.push('mime-confusion:declared text is not valid UTF-8');
      return findings;
    }
    if (bytes.includes(0)) findings.push('mime-confusion:declared text contains NUL bytes');
    for (const pattern of promptPatterns) {
      if (pattern.test(text)) findings.push('prompt-injection:hostile instruction pattern');
    }
  } else if (
    mimeType === 'application/json' &&
    bytes.length > 0 &&
    bytes[0] !== 0x7b &&
    bytes[0] !== 0x5b
  ) {
    findings.push('mime-confusion:declared JSON has a non-JSON prefix');
  }
  return [...new Set(findings)];
}
function sanitize() {
  let text = decodedText();
  text = text
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, '')
    .replace(/<\s*(script|style|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[removed image]')
    .replace(/\[([^\]]+)\]\((?:javascript|data):[^)]*\)/gi, '$1')
    .replace(/\r\n?/g, '\n');
  const output = Buffer.from(text, 'utf8');
  if (output.length > request.maxInputBytes) throw new Error('sanitized output exceeds limit');
  return {
    bytesBase64: output.toString('base64'),
    mimeType: 'text/plain',
    properties: ['render-as:plain-text', 'active-markup-removed', 'terminal-controls-removed'],
  };
}
let response;
if (request.operation === 'scan') {
  response = { findings: scan() };
} else if (request.operation === 'sanitize') {
  response = sanitize();
} else if (request.operation === 'verify') {
  const properties = request.properties ?? [];
  let text;
  const passed = properties.length > 0 && properties.every((property) => {
    if (property === 'content-hash-valid') return hash === request.input.contentHash;
    if (property === 'plain-text-only') return mimeType === 'text/plain';
    if (property === 'no-known-prompt-injection') {
      try {
        text ??= decodedText();
      } catch {
        return false;
      }
      return !promptPatterns.some((pattern) => pattern.test(text));
    }
    return false;
  });
  response = { passed };
} else {
  throw new Error('unsupported inspection operation');
}
process.stdout.write(JSON.stringify(response));
`;

function invalid(message: string): never {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

/** Run scan/sanitize/verify in a bounded, disposable Node subprocess. */
export function createIsolatedArtifactInspector(
  options: IsolatedArtifactInspectorOptions = {},
): ArtifactInspector {
  const maxInputBytes = options.maxInputBytes ?? 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxOldSpaceSizeMb = options.maxOldSpaceSizeMb ?? 64;
  if (
    !Number.isSafeInteger(maxInputBytes) ||
    maxInputBytes < 1 ||
    maxInputBytes > 8 * 1024 * 1024 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(maxOldSpaceSizeMb) ||
    maxOldSpaceSizeMb < 16
  ) invalid('isolated artifact inspector limits are invalid');

  async function inspect(
    operation: InspectorRequest['operation'],
    input: ArtifactInspectionInput,
    properties?: string[],
  ): Promise<InspectorResponse> {
    if (input.bytes.byteLength > maxInputBytes) {
      invalid(`artifact exceeds isolated inspection limit ${maxInputBytes}`);
    }
    const request: InspectorRequest = {
      operation,
      input: {
        bytesBase64: Buffer.from(input.bytes).toString('base64'),
        contentHash: input.contentHash,
        mimeType: input.mimeType,
      },
      maxInputBytes,
      ...(properties ? { properties } : {}),
    };
    return await new Promise<InspectorResponse>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          `--max-old-space-size=${maxOldSpaceSizeMb}`,
          '--input-type=module',
          '--eval',
          INSPECTOR_SOURCE,
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          // Electron embedders use the packaged Electron binary as
          // process.execPath; this makes the same invocation enter its Node
          // runtime instead of starting another browser process.
          env: { ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
        },
      );
      options.onSpawn?.(child.pid);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const fail = (message: string, retryable = false): void => {
        finish(() => {
          reject(
            new OrchestrationError({
              code: 'UNAVAILABLE',
              message,
              retryable,
            }),
          );
        });
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(`isolated artifact inspection exceeded ${timeoutMs}ms`);
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > maxInputBytes * 2 + 64 * 1024) {
          child.kill('SIGKILL');
          fail('isolated artifact inspector exceeded its output limit');
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrBytes >= 8192) return;
        const bounded = chunk.subarray(0, 8192 - stderrBytes);
        stderr.push(bounded);
        stderrBytes += bounded.byteLength;
      });
      child.stdin.once('error', (error) => {
        fail(`isolated artifact inspector input failed: ${error.message}`);
      });
      child.once('error', (error) => {
        fail(`isolated artifact inspector failed to start: ${error.message}`, true);
      });
      child.once('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          fail(
            `isolated artifact inspector exited ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 1024)}`,
          );
          return;
        }
        try {
          const response = JSON.parse(
            Buffer.concat(stdout).toString('utf8'),
          ) as InspectorResponse;
          if (response.error) {
            fail(`isolated artifact inspector rejected content: ${response.error}`);
            return;
          }
          finish(() => {
            resolve(response);
          });
        } catch {
          fail('isolated artifact inspector returned malformed output');
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
  }

  return {
    async scan(input) {
      const response = await inspect('scan', input);
      if (
        !Array.isArray(response.findings) ||
        response.findings.length > 64 ||
        response.findings.some((finding) =>
          typeof finding !== 'string' ||
          !finding ||
          finding.length > 1024
        )
      ) {
        invalid('isolated artifact scanner returned invalid findings');
      }
      return response.findings;
    },
    async sanitize(input): Promise<ArtifactSanitizationResult> {
      const response = await inspect('sanitize', input);
      if (
        typeof response.bytesBase64 !== 'string' ||
        !response.mimeType ||
        response.mimeType.length > 256 ||
        !Array.isArray(response.properties) ||
        response.properties.length > 64 ||
        response.properties.some((property) =>
          typeof property !== 'string' ||
          !property ||
          property.length > 256
        )
      ) invalid('isolated artifact sanitizer returned invalid output');
      let decoded: Uint8Array;
      try {
        decoded = decodeStrictBase64(response.bytesBase64, {
          variant: 'standard',
          padding: 'required',
          maxBytes: maxInputBytes,
        });
      } catch {
        invalid('isolated artifact sanitizer returned invalid encoded bytes');
      }
      const bytes = new Uint8Array(decoded);
      if (bytes.byteLength > maxInputBytes) {
        invalid('isolated artifact sanitizer output exceeded its limit');
      }
      return {
        bytes,
        mimeType: response.mimeType,
        properties: response.properties,
      };
    },
    async verify(input, properties) {
      const response = await inspect('verify', input, properties);
      if (typeof response.passed !== 'boolean') {
        invalid('isolated artifact verifier returned an invalid decision');
      }
      return response.passed;
    },
  };
}
