#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IMAGE = 'quay.io/coreos/etcd:v3.6.11@sha256:6ae247c7666ceec554c51ba1f9bc8dd2212f975370dbd65710c9ca0e36ae1fff';
const ROOT_PASSWORD = 'memeloop-acceptance-only';
const suffix = `${process.pid}-${Date.now()}`;
const network = `memeloop-etcd-${suffix}`;
const names = {
  n1: `memeloop-etcd-n1-${suffix}`,
  n2: `memeloop-etcd-n2-${suffix}`,
  n3: `memeloop-etcd-n3-${suffix}`,
};
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'memeloop-etcd-acceptance-'));
const createdContainers = [];

async function command(file, args, options = {}) {
  return await execFileAsync(file, args, {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

async function docker(...args) {
  return await command('docker', args);
}

async function startMember(name, cluster) {
  const container = names[name];
  const { stdout } = await docker(
    'run',
    '--detach',
    '--name',
    container,
    '--network',
    network,
    '--network-alias',
    name,
    '--env',
    'ALL_PROXY=',
    '--env',
    'HTTP_PROXY=',
    '--env',
    'HTTPS_PROXY=',
    '--env',
    'NO_PROXY=*',
    '--env',
    'all_proxy=',
    '--env',
    'http_proxy=',
    '--env',
    'https_proxy=',
    '--env',
    'no_proxy=*',
    '--publish',
    '127.0.0.1::2379',
    IMAGE,
    '/usr/local/bin/etcd',
    '--name',
    name,
    '--data-dir',
    '/etcd-data',
    '--listen-client-urls',
    'http://0.0.0.0:2379',
    '--advertise-client-urls',
    `http://${name}:2379`,
    '--listen-peer-urls',
    'http://0.0.0.0:2380',
    '--initial-advertise-peer-urls',
    `http://${name}:2380`,
    '--initial-cluster',
    cluster,
    '--initial-cluster-token',
    `memeloop-${suffix}`,
    '--initial-cluster-state',
    name === 'n1' ? 'new' : 'existing',
    '--log-level',
    'warn',
  );
  createdContainers.push(container);
  if (!stdout.trim()) throw new Error(`Docker did not return an id for ${name}`);
}

async function hostEndpoint(name) {
  const { stdout } = await docker(
    'inspect',
    '--format',
    '{{(index (index .NetworkSettings.Ports "2379/tcp") 0).HostPort}}',
    names[name],
  );
  return `http://127.0.0.1:${stdout.trim()}`;
}

async function etcdctl(containerName, ...args) {
  return await docker(
    'exec',
    containerName,
    '/usr/local/bin/etcdctl',
    ...args,
  );
}

async function waitFor(check, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function waitHealthy(name, authenticated = false) {
  const auth = authenticated ? ['--user', `root:${ROOT_PASSWORD}`] : [];
  await waitFor(async () => {
    const { stdout } = await etcdctl(
      names[name],
      '--endpoints',
      `http://${name}:2379`,
      ...auth,
      'endpoint',
      'health',
    );
    return stdout.includes('is healthy');
  }, `${name} health`);
}

async function waitStarted(name) {
  await waitFor(async () => {
    const { stdout } = await etcdctl(
      names[name],
      '--endpoints',
      `http://${name}:2379`,
      'endpoint',
      'status',
      '--write-out',
      'json',
    );
    return JSON.parse(stdout)[0]?.Status?.header?.member_id;
  }, `${name} endpoint status`);
}

function connection(hosts, authenticated = false) {
  return {
    hosts,
    dialTimeout: 2_000,
    defaultCallOptions: (context) => context.isStream ? {} : { deadline: Date.now() + 2_000 },
    ...(authenticated ? { auth: { username: 'root', password: ROOT_PASSWORD } } : {}),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let bootstrapStore;
let store;
try {
  await docker('network', 'create', network);
  await startMember('n1', 'n1=http://n1:2380');
  await waitHealthy('n1');
  const endpoint1 = await hostEndpoint('n1');
  const { EtcdControlStore } = await import('../packages/memeloop-cli/dist/index.js');
  const authorizer = { authorize() {} };
  bootstrapStore = new EtcdControlStore({
    connection: connection([endpoint1]),
    namespace: `/memeloop/acceptance/${suffix}/`,
    authorizer,
  });
  assert((await bootstrapStore.listMembers()).length === 1, 'single-voter bootstrap membership is not one');

  const learner2 = await waitFor(async () => {
    try {
      return await bootstrapStore.addLearner(['http://n2:2380']);
    } catch (error) {
      if (error?.code === 'UNAVAILABLE') return false;
      throw error;
    }
  }, 'n2 learner membership addition');
  assert(learner2.isLearner, 'n2 was not added as a non-voting learner');
  await startMember('n2', 'n1=http://n1:2380,n2=http://n2:2380');
  await waitStarted('n2');
  await waitFor(async () => {
    try {
      const members = await bootstrapStore.promoteMember(learner2.id);
      return members.find((member) => member.id === learner2.id)?.isLearner === false;
    } catch (error) {
      if (String(error).includes('can only promote a learner member which is in sync')) return false;
      throw error;
    }
  }, 'n2 learner catch-up and promotion');
  await Promise.all(['n1', 'n2'].map(async (name) => await waitHealthy(name)));

  const learner3 = await waitFor(async () => {
    try {
      return await bootstrapStore.addLearner(['http://n3:2380']);
    } catch (error) {
      if (error?.code === 'UNAVAILABLE') return false;
      throw error;
    }
  }, 'n3 learner membership addition');
  assert(learner3.isLearner, 'n3 was not added as a non-voting learner');
  await startMember('n3', 'n1=http://n1:2380,n2=http://n2:2380,n3=http://n3:2380');
  await waitStarted('n3');
  await waitFor(async () => {
    try {
      const members = await bootstrapStore.promoteMember(learner3.id);
      return members.find((member) => member.id === learner3.id)?.isLearner === false;
    } catch (error) {
      if (String(error).includes('can only promote a learner member which is in sync')) return false;
      throw error;
    }
  }, 'n3 learner catch-up and promotion');
  await Promise.all(['n1', 'n2', 'n3'].map(async (name) => await waitHealthy(name)));
  const migratedMembers = await bootstrapStore.listMembers();
  assert(migratedMembers.length === 3, 'one-to-three migration did not produce three members');
  assert(migratedMembers.every((member) => !member.isLearner), 'promoted cluster still contains a learner');

  await etcdctl(names.n1, '--endpoints', 'http://n1:2379', 'user', 'add', `root:${ROOT_PASSWORD}`);
  await etcdctl(names.n1, '--endpoints', 'http://n1:2379', 'auth', 'enable');
  await bootstrapStore.close();
  bootstrapStore = undefined;
  await Promise.all(['n1', 'n2', 'n3'].map(async (name) => await waitHealthy(name, true)));
  const endpoints = await Promise.all(['n1', 'n2', 'n3'].map(hostEndpoint));
  store = new EtcdControlStore({
    connection: connection(endpoints, true),
    namespace: `/memeloop/acceptance/${suffix}/`,
    authorizer,
  });

  const actor = { id: 'controller/quorum-acceptance', kind: 'controller' };
  const beforeFailure = await store.create(actor, {
    apiVersion: 'acceptance.memeloop.io/v1alpha1',
    kind: 'QuorumProbe',
    metadata: { name: 'before-failure' },
    spec: { stage: 'three-voters' },
  });
  const firstLease = await store.acquireLease(actor, {
    name: 'controller/acceptance',
    holder: 'controller-a',
    ttlMs: 30_000,
  });

  const { stdout: statusOutput } = await etcdctl(
    names.n1,
    '--endpoints',
    'http://n1:2379,http://n2:2379,http://n3:2379',
    '--user',
    `root:${ROOT_PASSWORD}`,
    'endpoint',
    'status',
    '--write-out',
    'json',
  );
  // etcd member IDs exceed JavaScript's safe integer range, so do not round
  // them through JSON.parse.
  const leaderId = /"leader":\s*(\d+)/u.exec(statusOutput)?.[1];
  assert(leaderId, 'endpoint status did not contain a leader member ID');
  const leader = migratedMembers.find((member) => member.id === leaderId);
  assert(leader, `could not map elected leader ${leaderId} to a member`);
  await docker('stop', '--time', '2', names[leader.name]);

  const afterLeaderLoss = await store.create(actor, {
    apiVersion: 'acceptance.memeloop.io/v1alpha1',
    kind: 'QuorumProbe',
    metadata: { name: 'after-leader-loss' },
    spec: { stage: 'two-voters' },
  });
  const liveAfterLeaderLoss = ['n1', 'n2', 'n3'].filter((name) => name !== leader.name);
  await docker('stop', '--time', '2', names[liveAfterLeaderLoss[0]]);

  let rejectedWithoutQuorum = false;
  try {
    await store.create(actor, {
      apiVersion: 'acceptance.memeloop.io/v1alpha1',
      kind: 'QuorumProbe',
      metadata: { name: 'must-not-commit-without-quorum' },
      spec: { stage: 'one-voter' },
    });
  } catch (error) {
    rejectedWithoutQuorum = error?.code === 'UNAVAILABLE';
  }
  assert(rejectedWithoutQuorum, 'loss of quorum did not fail the authoritative write with UNAVAILABLE');

  await docker('start', names[liveAfterLeaderLoss[0]]);
  await waitHealthy(liveAfterLeaderLoss[0], true);
  const afterRecovery = await store.create(actor, {
    apiVersion: 'acceptance.memeloop.io/v1alpha1',
    kind: 'QuorumProbe',
    metadata: { name: 'after-quorum-recovery' },
    spec: { stage: 'recovered' },
  });
  const recoveredBefore = await store.get({
    apiVersion: beforeFailure.apiVersion,
    kind: beforeFailure.kind,
    name: beforeFailure.metadata.name,
  });
  assert(recoveredBefore?.metadata.uid === beforeFailure.metadata.uid, 'acknowledged pre-failure write was lost');
  assert(
    await store.get({
      apiVersion: afterLeaderLoss.apiVersion,
      kind: afterLeaderLoss.kind,
      name: afterLeaderLoss.metadata.name,
    }),
    'write acknowledged after leader loss was not durable',
  );
  assert(
    await store.get({
      apiVersion: afterRecovery.apiVersion,
      kind: afterRecovery.kind,
      name: afterRecovery.metadata.name,
    }),
    'post-recovery write is missing',
  );
  await store.releaseLease(actor, firstLease);
  const nextLease = await store.acquireLease(actor, {
    name: 'controller/acceptance',
    holder: 'controller-b',
    ttlMs: 30_000,
  });
  assert(BigInt(nextLease.epoch) === BigInt(firstLease.epoch) + 1n, 'fencing epoch did not advance after quorum recovery');

  const snapshotPath = join(temporaryDirectory, 'etcd.snapshot');
  const snapshot = await store.snapshot(snapshotPath);
  assert((await readFile(snapshotPath)).byteLength > 0, 'quorum snapshot is empty');
  const health = await store.getHealth();
  assert(health.healthy, `recovered quorum is unhealthy: ${health.detail}`);

  process.stdout.write(`${JSON.stringify({
    image: IMAGE,
    migration: {
      fromVoters: 1,
      observersAdded: 2,
      promotedVoters: 3,
    },
    authentication: 'etcd username/password enabled',
    leaderStopped: leader.name,
    writeAfterLeaderLossResourceVersion: afterLeaderLoss.metadata.resourceVersion,
    lossOfQuorumRejected: rejectedWithoutQuorum,
    recoveredResourceVersion: afterRecovery.metadata.resourceVersion,
    fencingEpochs: [firstLease.epoch, nextLease.epoch],
    snapshotResourceVersion: snapshot.resourceVersion,
    health: health.detail,
  }, null, 2)}\n`);
} finally {
  await store?.close().catch(() => undefined);
  await bootstrapStore?.close().catch(() => undefined);
  for (const container of createdContainers.reverse()) {
    await docker('rm', '--force', container).catch(() => undefined);
  }
  await docker('network', 'rm', network).catch(() => undefined);
  await rm(temporaryDirectory, { recursive: true, force: true });
}
