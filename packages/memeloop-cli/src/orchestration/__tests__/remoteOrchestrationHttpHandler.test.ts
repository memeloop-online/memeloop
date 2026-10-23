import http from 'node:http';

import { type AgentOrchestrationClient, createFetchOrchestrationTransport, createRemoteOrchestrationClient } from 'memeloop';
import { afterEach, describe, expect, it } from 'vitest';

import { createRemoteOrchestrationHttpHandler } from '../remoteOrchestrationHttpHandler.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        })
      )
    ),
  );
});

function client(): AgentOrchestrationClient {
  return {
    async getCapabilities() {
      return {
        operations: ['apply', 'get', 'list', 'watch', 'delete'],
        resourceKinds: ['AgentWorkload'],
        interfaces: ['resource'],
      };
    },
    async apply(resource) {
      return {
        ...resource,
        metadata: {
          ...resource.metadata,
          name: resource.metadata.name!,
          uid: 'uid-1',
          generation: 1,
          resourceVersion: '1',
          creationTimestamp: '',
        },
      };
    },
    async get() {
      return null;
    },
    async list() {
      return { items: [], resourceVersion: '4' };
    },
    async *watch() {
      yield { type: 'BOOKMARK', resourceVersion: '4' };
    },
    async delete(reference) {
      return { accepted: true, reference };
    },
  };
}

async function listen(
  handler: ReturnType<typeof createRemoteOrchestrationHttpHandler>,
): Promise<string> {
  const server = http.createServer((request, response) => {
    void handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind TCP');
  return `http://127.0.0.1:${address.port}/v2/orchestration/resources`;
}

describe('createRemoteOrchestrationHttpHandler', () => {
  it('serves authenticated request and NDJSON watch paths end to end', async () => {
    const endpoint = await listen(createRemoteOrchestrationHttpHandler(client(), {
      authorize: (request) => request.headers.authorization === 'Bearer test-session',
    }));
    const remote = createRemoteOrchestrationClient(createFetchOrchestrationTransport({
      endpoint,
      headers: { Authorization: 'Bearer test-session' },
    }));
    expect(await remote.getCapabilities()).toMatchObject({
      resourceKinds: ['AgentWorkload'],
    });
    const events = [];
    for await (const event of remote.watch({ kind: 'AgentWorkload' })) events.push(event);
    expect(events).toEqual([{ type: 'BOOKMARK', resourceVersion: '4' }]);
  });

  it('denies missing authentication and oversized bodies before dispatch', async () => {
    const endpoint = await listen(createRemoteOrchestrationHttpHandler(client(), {
      authorize: (request) => request.headers.authorization === 'Bearer test-session',
      maxRequestBytes: 32,
    }));
    expect(
      (await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })).status,
    ).toBe(403);
    expect(
      (await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-session',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ value: 'x'.repeat(64) }),
      })).status,
    ).toBe(413);
  });
});
