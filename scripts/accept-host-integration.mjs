#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { IDBFactory } from '../packages/memeloop-protocol/node_modules/fake-indexeddb/build/esm/index.js';
import {
  createControlStoreOrchestrationClient,
  createFetchOrchestrationTransport,
  createRemoteOrchestrationClient,
} from '../packages/memeloop/dist/index.js';
import {
  createRemoteOrchestrationHttpHandler,
  SQLiteControlStore,
} from '../packages/memeloop-cli/dist/index.js';
import { createIndexedDatabaseResourceCache } from '../packages/memeloop-protocol/dist/index.js';

const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), 'memeloop-host-acceptance-'),
);
const databasePath = path.join(temporaryDirectory, 'control.db');
const accessToken = randomBytes(32).toString('base64url');
const actor = { id: 'controller/host-acceptance', kind: 'controller' };

function createStore() {
  return new SQLiteControlStore({
    filename: databasePath,
    authorizer: {
      authorize() {},
    },
  });
}

async function startHost(store) {
  const scopedClient = createControlStoreOrchestrationClient(store, actor);
  const handler = createRemoteOrchestrationHttpHandler(scopedClient, {
    authorize: (request) =>
      request.headers.authorization === `Bearer ${accessToken}`,
  });
  const server = http.createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('host acceptance server did not bind TCP');
  }
  const endpoint =
    `http://127.0.0.1:${address.port}/v1/orchestration/resources`;
  return {
    endpoint,
    client: createRemoteOrchestrationClient(
      createFetchOrchestrationTransport({
        endpoint,
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    ),
    async close() {
      const closed = new Promise((resolve) => {
        server.close(resolve);
      });
      server.closeAllConnections();
      await closed;
    },
  };
}

function within(promise, milliseconds, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`${label} exceeded ${milliseconds}ms`)),
        milliseconds,
      );
    }),
  ]);
}

let store;
let host;
try {
  store = createStore();
  host = await startHost(store);

  const unauthorized = await fetch(host.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(unauthorized.status, 403);

  const capabilities = await host.client.getCapabilities();
  assert.ok(capabilities.operations.includes('watch'));

  const watchIterator = host.client.watch({
    apiVersion: 'execution.memeloop.io/v1alpha1',
    kind: 'AgentWorkload',
    namespace: 'acceptance',
  })[Symbol.asyncIterator]();
  const firstEvent = within(watchIterator.next(), 5_000, 'remote watch');
  const created = await host.client.apply({
    apiVersion: 'execution.memeloop.io/v1alpha1',
    kind: 'AgentWorkload',
    metadata: {
      name: 'portable-host',
      namespace: 'acceptance',
      labels: { suite: 'host-integration' },
    },
    spec: {
      lifecycle: 'job',
      runtimeClass: 'restricted-process',
      trust: 'restricted',
    },
  });
  const watched = await firstEvent;
  assert.equal(watched.done, false);
  assert.equal(watched.value?.type, 'ADDED');
  assert.equal(watched.value?.resource?.metadata.name, 'portable-host');
  await watchIterator.return?.();

  const cache = createIndexedDatabaseResourceCache({
    indexedDB: new IDBFactory(),
    databaseName: 'host-acceptance',
  });
  await cache.put(created);
  const cached = await cache.list({
    kind: 'AgentWorkload',
    namespace: 'acceptance',
    labels: { suite: 'host-integration' },
  });
  assert.equal(cached.items.length, 1);

  await host.close();
  await store.close();
  host = undefined;
  store = undefined;

  const offline = await cache.get({
    apiVersion: created.apiVersion,
    kind: created.kind,
    namespace: created.metadata.namespace,
    name: created.metadata.name,
  });
  assert.equal(offline?.metadata.uid, created.metadata.uid);

  store = createStore();
  host = await startHost(store);
  const restored = await host.client.get({
    apiVersion: created.apiVersion,
    kind: created.kind,
    namespace: created.metadata.namespace,
    name: created.metadata.name,
  });
  assert.equal(restored?.metadata.uid, created.metadata.uid);

  await host.client.delete({
    apiVersion: created.apiVersion,
    kind: created.kind,
    namespace: created.metadata.namespace,
    name: created.metadata.name,
  });
  await cache.remove({
    apiVersion: created.apiVersion,
    kind: created.kind,
    namespace: created.metadata.namespace,
    name: created.metadata.name,
  });
  assert.equal((await cache.list({ kind: 'AgentWorkload' })).items.length, 0);
  cache.close();

  console.log(JSON.stringify({
    ok: true,
    authenticatedRequest: true,
    watchAndDisconnect: true,
    offlineCache: true,
    durableReconnect: true,
  }));
} finally {
  await host?.close().catch(() => undefined);
  await store?.close().catch(() => undefined);
  await rm(temporaryDirectory, { recursive: true, force: true });
}
