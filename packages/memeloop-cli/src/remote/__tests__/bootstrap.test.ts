import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { bootstrapRemoteCli, MEMELOOP_CLI_VERSION } from '../bootstrap.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.MEMELOOP_TEST_SSH_ARGUMENTS;
  delete process.env.MEMELOOP_TEST_REMOTE_HOME;
  delete process.env.MEMELOOP_TEST_REMOTE_PATH;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fakeSsh(): Promise<{
  directory: string;
  executable: string;
  argumentsPath: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memeloop-bootstrap-test-'));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, 'ssh');
  const argumentsPath = path.join(directory, 'arguments.json');
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
let source = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) source += chunk;
await writeFile(process.env.MEMELOOP_TEST_SSH_ARGUMENTS, JSON.stringify(process.argv.slice(2)));
const separator = process.argv.indexOf("--");
const remoteArguments = process.argv.slice(separator + 5);
const child = spawn("sh", ["-s", "--", ...remoteArguments], {
  env: {
    ...process.env,
    ...(process.env.MEMELOOP_TEST_REMOTE_HOME
      ? { HOME: process.env.MEMELOOP_TEST_REMOTE_HOME }
      : {}),
    ...(process.env.MEMELOOP_TEST_REMOTE_PATH
      ? { PATH: process.env.MEMELOOP_TEST_REMOTE_PATH + ":" + process.env.PATH }
      : {})
  },
  stdio: ["pipe", "inherit", "inherit"]
});
child.stdin.end(source);
process.exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
`,
    { mode: 0o700 },
  );
  return { directory, executable, argumentsPath };
}

describe('bootstrapRemoteCli', () => {
  it('runs the bounded remote probe and returns privacy-safe evidence', async () => {
    const fake = await fakeSsh();
    process.env.MEMELOOP_TEST_SSH_ARGUMENTS = fake.argumentsPath;
    const evidence = await bootstrapRemoteCli({
      target: 'operator@worker.example',
      port: 2222,
      identityFile: './test-key',
      knownHostsFile: './known-hosts',
      hostKeyPolicy: 'accept-new',
      dryRun: true,
      sshCommand: fake.executable,
    });
    expect(evidence).toMatchObject({
      ok: true,
      version: MEMELOOP_CLI_VERSION,
      changed: false,
      dryRun: true,
    });
    expect(Number(evidence.nodeVersion.split('.')[0])).toBeGreaterThanOrEqual(24);
    expect(evidence.executable).toContain(`/memeloop/cli/${MEMELOOP_CLI_VERSION}/bin/memeloop`);

    const arguments_ = JSON.parse(await readFile(fake.argumentsPath, 'utf8')) as string[];
    expect(arguments_).toContain('StrictHostKeyChecking=accept-new');
    expect(arguments_).toContain('2222');
    expect(arguments_).toContain(path.resolve('./test-key'));
    expect(arguments_).toContain(`UserKnownHostsFile=${path.resolve('./known-hosts')}`);
    expect(arguments_).toContain('operator@worker.example');
    expect(arguments_).not.toContain('sudo');
  });

  it('rejects shell syntax, mutable versions, invalid ports, and weak timeouts', async () => {
    await expect(
      bootstrapRemoteCli({
        target: 'worker.example;reboot',
        dryRun: true,
      }),
    ).rejects.toThrow(/SSH target/);
    await expect(
      bootstrapRemoteCli({
        target: 'worker.example',
        version: 'latest',
        dryRun: true,
      }),
    ).rejects.toThrow(/exact semantic version/);
    await expect(
      bootstrapRemoteCli({
        target: 'worker.example',
        port: 70_000,
        dryRun: true,
      }),
    ).rejects.toThrow(/port/);
    await expect(
      bootstrapRemoteCli({
        target: 'worker.example',
        timeoutMs: 10,
        dryRun: true,
      }),
    ).rejects.toThrow(/timeoutMs/);
  });

  it('installs into a versioned user prefix and adopts it idempotently', async () => {
    const fake = await fakeSsh();
    const remoteHome = path.join(fake.directory, 'remote-home');
    const remoteBin = path.join(fake.directory, 'remote-bin');
    const fakeNpmSource = path.join(fake.directory, 'make-fake-npm.mjs');
    await mkdir(remoteBin, { recursive: true });
    await writeFile(
      fakeNpmSource,
      `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
const packageSpec = process.argv.at(-1);
const version = packageSpec.slice(packageSpec.lastIndexOf("@") + 1);
await mkdir(path.join(prefix, "bin"), { recursive: true });
await writeFile(
  path.join(prefix, "bin", "memeloop"),
  "#!/bin/sh\\nprintf '%s\\\\n' " + JSON.stringify(version) + "\\n",
  { mode: 0o700 }
);
`,
    );
    await writeFile(
      path.join(remoteBin, 'npm'),
      `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeNpmSource)} "$@"
`,
      { mode: 0o700 },
    );
    process.env.MEMELOOP_TEST_SSH_ARGUMENTS = fake.argumentsPath;
    process.env.MEMELOOP_TEST_REMOTE_HOME = remoteHome;
    process.env.MEMELOOP_TEST_REMOTE_PATH = remoteBin;
    const options = {
      target: 'worker.example',
      version: MEMELOOP_CLI_VERSION,
      sshCommand: fake.executable,
    };

    const first = await bootstrapRemoteCli(options);
    const second = await bootstrapRemoteCli(options);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(await readlink(path.join(remoteHome, '.local/bin/memeloop'))).toBe(
      path.join(remoteHome, '.local/share/memeloop/cli', MEMELOOP_CLI_VERSION, 'bin/memeloop'),
    );
  });
});
