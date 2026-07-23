import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
});
