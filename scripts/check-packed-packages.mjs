#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const packageDirectories = [
  'packages/memeloop',
  'packages/memeloop-libp2p',
  'packages/memeloop-cli',
  'packages/memeloop-protocol',
  'packages/memeloop-react-ui',
  'packages/memeloop-k8s',
  'packages/memeloop-swarm',
];

function collectLocalTargets(value, targets = []) {
  if (typeof value === 'string') {
    if (value.startsWith('./')) targets.push(value.slice(2));
    return targets;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectLocalTargets(entry, targets);
    return targets;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectLocalTargets(entry, targets);
  }
  return targets;
}

function containsWorkspaceProtocol(value) {
  if (typeof value === 'string') return value.startsWith('workspace:');
  if (Array.isArray(value)) return value.some(containsWorkspaceProtocol);
  if (value && typeof value === 'object') {
    return Object.values(value).some(containsWorkspaceProtocol);
  }
  return false;
}

async function inspectPackedPackage(packageDirectory, destination) {
  const cwd = path.join(root, packageDirectory);
  const { stdout } = await execFileAsync(
    'pnpm',
    ['pack', '--pack-destination', destination],
    { cwd, maxBuffer: 16 * 1024 * 1024 },
  );
  const archiveLine = stdout.trim().split(/\r?\n/).at(-1);
  if (!archiveLine?.endsWith('.tgz')) {
    throw new Error(`${packageDirectory}: pnpm pack did not report a tarball`);
  }
  const archive = path.resolve(cwd, archiveLine);
  const { stdout: manifestJson } = await execFileAsync(
    'tar',
    ['-xOzf', archive, 'package/package.json'],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const manifest = JSON.parse(manifestJson);
  if (containsWorkspaceProtocol(manifest)) {
    throw new Error(`${manifest.name}: packed manifest contains an unpublishable workspace protocol`);
  }

  const { stdout: tarListing } = await execFileAsync(
    'tar',
    ['-tzf', archive],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const packedFiles = new Set(
    tarListing
      .trim()
      .split(/\r?\n/)
      .map((entry) => entry.replace(/^package\//, '')),
  );
  const archiveStats = await stat(archive);
  if (packedFiles.size > 250) {
    throw new Error(
      `${manifest.name}: packed file count ${packedFiles.size} exceeds the stale-output ceiling of 250`,
    );
  }
  if (archiveStats.size > 16 * 1024 * 1024) {
    throw new Error(
      `${manifest.name}: packed archive size ${archiveStats.size} exceeds 16 MiB`,
    );
  }
  const localTargets = collectLocalTargets({
    main: manifest.main,
    module: manifest.module,
    types: manifest.types,
    bin: manifest.bin,
    exports: manifest.exports,
  });
  for (const target of localTargets) {
    if (!packedFiles.has(target)) {
      throw new Error(`${manifest.name}: packed entry target '${target}' is missing`);
    }
  }
  return {
    name: manifest.name,
    version: manifest.version,
    files: packedFiles.size,
    archiveBytes: archiveStats.size,
  };
}

async function verifyBuiltExports() {
  const [core, cli] = await Promise.all([
    import(new URL('../packages/memeloop/dist/index.js', import.meta.url)),
    import(new URL('../packages/memeloop-cli/dist/index.js', import.meta.url)),
  ]);
  for (
    const name of [
      'createNamespacedOrchestrationClient',
      'createDeviceOrchestrationTransport',
      'createRemoteOrchestrationClient',
    ]
  ) {
    if (typeof core[name] !== 'function') throw new Error(`memeloop: missing built export '${name}'`);
  }
  for (
    const name of [
      'createNodeRuntime',
      'createOrdinaryPeerOrchestrationHandler',
      'ordinaryPeerNamespace',
    ]
  ) {
    if (typeof cli[name] !== 'function') throw new Error(`memeloop-cli: missing built export '${name}'`);
  }
}

const destination = await mkdtemp(path.join(tmpdir(), 'memeloop-packed-packages-'));
try {
  const inspected = [];
  for (const packageDirectory of packageDirectories) {
    inspected.push(await inspectPackedPackage(packageDirectory, destination));
  }
  await verifyBuiltExports();
  console.log(JSON.stringify({ ok: true, packages: inspected }, null, 2));
} finally {
  await rm(destination, { recursive: true, force: true });
}
