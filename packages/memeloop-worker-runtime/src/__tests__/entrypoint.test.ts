import { execFile } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const entrypoint = fileURLToPath(new URL('../entrypoint.mjs', import.meta.url));

function normalize(source: string): string {
  return (
    source
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trim() + '\n'
  );
}

function digest(source: string): string {
  return `sha256:${createHash('sha256').update(normalize(source), 'utf8').digest('hex')}`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${
    Object.entries(record)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(',')
  }}`;
}

function fingerprint(publicKey: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('base64url')}`;
}

describe('container worker entrypoint', () => {
  it('uses a numeric non-root identity compatible with Kubernetes runAsNonRoot', () => {
    const dockerfile = readFileSync(
      fileURLToPath(new URL('../../Dockerfile', import.meta.url)),
      'utf8',
    );
    expect(dockerfile).toMatch(/^USER 1000:1000$/m);
    expect(dockerfile).not.toMatch(/^USER (?:root|0)(?::0)?$/m);
  });

  it('verifies and executes an admitted script workload', async () => {
    const source = `export default async function* (ctx) { yield { type: 'message', data: 'hello ' + ctx.input.message }; }`;
    const workload = {
      name: 'game-build',
      namespace: 'jobs',
      uid: 'uid-1',
      spec: { scriptReference: digest(source), trust: 'restricted' },
    };
    const { stdout } = await execute(process.execPath, ['--experimental-vm-modules', entrypoint], {
      env: { MEMELOOP_WORKLOAD: JSON.stringify(workload), MEMELOOP_WORKLOAD_SCRIPT: source },
    });
    expect(stdout).toContain('MEMELOOP_RESULT ');
    expect(JSON.parse(stdout.slice('MEMELOOP_RESULT '.length))).toEqual({
      phase: 'Completed',
      summary: 'hello game-build',
    });
  });

  it('fails closed when script content does not match its digest', async () => {
    const source = `export default () => 'ok'`;
    await expect(
      execute(process.execPath, ['--experimental-vm-modules', entrypoint], {
        env: {
          MEMELOOP_WORKLOAD: JSON.stringify({
            name: 'bad',
            spec: { scriptReference: `sha256:${'0'.repeat(64)}` },
          }),
          MEMELOOP_WORKLOAD_SCRIPT: source,
        },
      }),
    ).rejects.toMatchObject({
      code: 64,
      stdout: expect.stringContaining('script digest mismatch'),
    });
  });

  it('provides only explicitly safe built-in tool operations', async () => {
    const { stdout } = await execute(process.execPath, ['--experimental-vm-modules', entrypoint], {
      env: {
        MEMELOOP_TOOL_OPERATION: JSON.stringify({
          toolRef: { kind: 'Tool', name: 'memeloop.runtime.echo' },
          arguments: { value: 7 },
          effect: 'read',
        }),
      },
    });
    expect(JSON.parse(stdout.slice('MEMELOOP_RESULT '.length))).toMatchObject({
      phase: 'Completed',
      result: { value: { value: 7 } },
    });
  });

  it('rejects ambiguous or absent assignments', async () => {
    await expect(
      execute(process.execPath, ['--experimental-vm-modules', entrypoint], { env: {} }),
    ).rejects.toMatchObject({
      code: 64,
      stdout: expect.stringContaining('set exactly one'),
    });
  });

  it('runs scripts without Node process, fetch, or Function-constructor escape', async () => {
    const source = `export default async function* () {
      let escaped = false;
      try { globalThis.constructor.constructor('return process')(); escaped = true; } catch {}
      yield { type: 'message', data: [typeof process, typeof fetch, escaped].join(':') };
    }`;
    const workload = {
      name: 'sandbox',
      uid: 'uid-sandbox',
      spec: { scriptReference: digest(source) },
    };
    const { stdout } = await execute(process.execPath, ['--experimental-vm-modules', entrypoint], {
      env: { MEMELOOP_WORKLOAD: JSON.stringify(workload), MEMELOOP_WORKLOAD_SCRIPT: source },
    });
    expect(JSON.parse(stdout.slice('MEMELOOP_RESULT '.length))).toEqual({
      phase: 'Completed',
      summary: 'undefined:undefined:false',
    });
  });

  it('bootstraps with a pinned gateway and runs a profile workload over signed requests', async () => {
    const gatewayKeys = generateKeyPairSync('ed25519');
    const gatewayPublicKey = Buffer.from(gatewayKeys.publicKey.export({
      format: 'der',
      type: 'spki',
    })).toString('base64url');
    const gatewayKeyFingerprint = fingerprint(gatewayPublicKey);
    const signedMethods: string[] = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        response.setHeader('content-type', 'application/json');
        if (request.url === '/v1/worker/bootstrap') {
          const workerPublicKey = body.workerPublicKey as string;
          const descriptor = {
            apiVersion: 'worker.memeloop.io/v1alpha1',
            sessionName: 'session-1',
            audience: 'worker-gateway://node-1',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            run: { uid: 'uid-remote', attempt: 1, epoch: 1 },
            policyDigest: 'sha256:policy',
            allowedMethods: ['assignment.pull', 'capability.request'],
            allowedTargets: ['uid-remote'],
            workerKeyFingerprint: fingerprint(workerPublicKey),
            gatewayKeyFingerprint,
            issuedAt: new Date().toISOString(),
          };
          response.end(JSON.stringify({
            ...descriptor,
            gatewaySignature: sign(
              null,
              Buffer.from(canonicalize(descriptor), 'utf8'),
              gatewayKeys.privateKey,
            ).toString('base64url'),
          }));
          return;
        }
        const signature = body.signature as string;
        const unsigned = { ...body };
        delete unsigned.signature;
        const workerPublicKey = createPublicKey({
          key: Buffer.from((globalThis as { testWorkerPublicKey?: string }).testWorkerPublicKey ?? '', 'base64url'),
          format: 'der',
          type: 'spki',
        });
        const signatureAccepted = verify(
          null,
          Buffer.from(canonicalize(unsigned), 'utf8'),
          workerPublicKey,
          Buffer.from(signature, 'base64url'),
        );
        if (signatureAccepted) signedMethods.push(body.method as string);
        const payload = body.method === 'assignment.pull'
          ? { profileId: 'code', prompt: 'build' }
          : {
            profileId: 'code',
            conversationId: 'child-remote',
            steps: [{ type: 'message', data: 'remote-child' }],
            text: 'remote-child',
          };
        response.end(JSON.stringify({
          apiVersion: 'worker.memeloop.io/v1alpha1',
          requestId: body.requestId,
          ok: true,
          payload,
          receivedAt: new Date().toISOString(),
        }));
      });
    });
    // Capture the worker public key from bootstrap without exposing it to the script.
    server.prependListener('request', (request) => {
      if (request.url !== '/v1/worker/bootstrap') return;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { workerPublicKey: string };
        (globalThis as { testWorkerPublicKey?: string }).testWorkerPublicKey = body.workerPublicKey;
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('gateway did not bind');
    const directory = mkdtempSync(path.join(os.tmpdir(), 'memeloop-worker-bootstrap-'));
    const bootstrapPath = path.join(directory, 'bootstrap.json');
    writeFileSync(
      bootstrapPath,
      JSON.stringify({
        apiVersion: 'worker.memeloop.io/v1alpha1',
        gatewayUrl: `http://127.0.0.1:${address.port}`,
        gatewayPublicKey,
        gatewayKeyFingerprint,
        enrollmentName: 'enrollment-1',
        bootstrapToken: 'b'.repeat(43),
      }),
    );
    try {
      const { stdout } = await execute(process.execPath, ['--experimental-vm-modules', entrypoint], {
        env: {
          MEMELOOP_WORKLOAD: JSON.stringify({
            name: 'remote',
            uid: 'uid-remote',
            spec: { profileId: 'code' },
          }),
          MEMELOOP_WORKER_BOOTSTRAP_FILE: bootstrapPath,
        },
      });
      expect(JSON.parse(stdout.slice('MEMELOOP_RESULT '.length))).toEqual({
        phase: 'Completed',
        summary: 'remote-child',
      });
      expect(signedMethods).toEqual(['assignment.pull', 'capability.request']);
    } finally {
      delete (globalThis as { testWorkerPublicKey?: string }).testWorkerPublicKey;
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        })
      );
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
