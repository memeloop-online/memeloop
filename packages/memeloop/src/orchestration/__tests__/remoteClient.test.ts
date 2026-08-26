import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import type { AgentOrchestrationClient, OrchestrationResource, OrchestrationResourceManifest, OrchestrationResourceStatus, OrchestrationWatchEvent } from '../client.js';
import { OrchestrationError } from '../errors.js';
import {
  createFetchOrchestrationTransport,
  createRemoteOrchestrationClient,
  createRemoteOrchestrationHandler,
  REMOTE_ORCHESTRATION_PROTOCOL,
  type RemoteOrchestrationRequest,
  type RemoteOrchestrationResponse,
  type RemoteOrchestrationTransport,
} from '../remoteClient.js';

const manifest: OrchestrationResourceManifest<{ value: number }> = {
  apiVersion: 'test.memeloop.io/v1',
  kind: 'Thing',
  metadata: { name: 'one', namespace: 'default' },
  spec: { value: 1 },
};

const resource: OrchestrationResource<{ value: number }> = {
  ...manifest,
  metadata: {
    ...manifest.metadata,
    name: 'one',
    uid: 'thing-uid',
    generation: 1,
    resourceVersion: '2',
    creationTimestamp: '2026-07-23T00:00:00.000Z',
  },
};

function fakeClient(): AgentOrchestrationClient {
  return {
    async getCapabilities() {
      return {
        operations: ['apply', 'get', 'list', 'watch', 'delete'],
        resourceKinds: ['Thing'],
        interfaces: ['resource'],
      };
    },
    async apply<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(input: OrchestrationResourceManifest<TSpec>) {
      return { ...resource, spec: input.spec } as OrchestrationResource<TSpec, TStatus>;
    },
    async get<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(reference: { name?: string }) {
      return reference.name === resource.metadata.name
        ? ({ ...resource, spec: resource.spec } as OrchestrationResource<TSpec, TStatus>)
        : null;
    },
    async list<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>() {
      return {
        items: [{ ...resource, spec: resource.spec } as OrchestrationResource<TSpec, TStatus>],
        resourceVersion: resource.metadata.resourceVersion,
      };
    },
    async *watch<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(): AsyncIterable<OrchestrationWatchEvent<TSpec, TStatus>> {
      yield {
        type: 'ADDED',
        resourceVersion: resource.metadata.resourceVersion,
        resource: { ...resource, spec: resource.spec } as OrchestrationResource<TSpec, TStatus>,
      };
      yield {
        type: 'BOOKMARK',
        resourceVersion: resource.metadata.resourceVersion,
      };
    },
    async delete(reference) {
      return { accepted: true, reference };
    },
  };
}

function loopbackTransport(client: AgentOrchestrationClient): RemoteOrchestrationTransport {
  const handler = createRemoteOrchestrationHandler(client);
  return {
    request: handler.request,
    watch: handler.watch,
  };
}

describe('remote orchestration client protocol', () => {
  it('uses only the v2 wire envelope identifier', async () => {
    expect(REMOTE_ORCHESTRATION_PROTOCOL).toBe('memeloop.resource.v2');

    const handler = createRemoteOrchestrationHandler(fakeClient());
    const response = await handler.request({
      protocol: `${REMOTE_ORCHESTRATION_PROTOCOL.slice(0, -1)}1`,
      requestId: 'legacy-v1',
      operation: 'capabilities',
      payload: {},
    } as never);

    expect(response).toMatchObject({
      protocol: 'memeloop.resource.v2',
      requestId: 'legacy-v1',
      ok: false,
      error: { code: 'INVALID' },
    });
  });

  it('consumes the same golden wire fixture as the Rust/Tauri crate', async () => {
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            '../../../../memeloop-protocol-rust/fixtures/protocol-v2.json',
            import.meta.url,
          ),
        ),
        'utf8',
      ),
    ) as {
      request: RemoteOrchestrationRequest;
      success: Awaited<ReturnType<RemoteOrchestrationTransport['request']>>;
    };
    const transport: RemoteOrchestrationTransport = {
      async request(request) {
        expect(request).toEqual(fixture.request);
        return fixture.success;
      },
      async *watch() {},
    };
    const client = createRemoteOrchestrationClient(transport, {
      createRequestId: () => fixture.request.requestId,
    });
    expect(
      await client.get(
        fixture.request.payload.reference as {
          apiVersion: string;
          kind: string;
          name: string;
          namespace: string;
        },
      ),
    ).toEqual(fixture.success.ok ? fixture.success.result : undefined);
  });

  it('round-trips every facade operation through a policy-bound handler', async () => {
    const client = createRemoteOrchestrationClient(loopbackTransport(fakeClient()), {
      createRequestId: () => 'request-1',
    });

    expect(await client.getCapabilities()).toMatchObject({ resourceKinds: ['Thing'] });
    expect(await client.apply(manifest)).toEqual(resource);
    expect(
      await client.get({
        apiVersion: resource.apiVersion,
        kind: resource.kind,
        name: resource.metadata.name,
      }),
    ).toEqual(resource);
    expect((await client.list({ kind: 'Thing' })).items).toEqual([resource]);
    expect(
      (await client.delete({
        apiVersion: resource.apiVersion,
        kind: resource.kind,
        name: resource.metadata.name,
      })).accepted,
    ).toBe(true);

    const events: OrchestrationWatchEvent[] = [];
    for await (const event of client.watch({ kind: 'Thing' })) events.push(event);
    expect(events.map((event) => event.type)).toEqual(['ADDED', 'BOOKMARK']);
  });

  it('preserves structured errors and rejects response correlation mismatches', async () => {
    const failing = fakeClient();
    failing.get = async () => {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'policy denied',
        retryable: false,
      });
    };
    const client = createRemoteOrchestrationClient(loopbackTransport(failing));
    await expect(client.get({ apiVersion: 'v1', kind: 'Thing', name: 'one' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'policy denied' });

    const mismatched: RemoteOrchestrationTransport = {
      async request(request) {
        return {
          protocol: REMOTE_ORCHESTRATION_PROTOCOL,
          requestId: `${request.requestId}-wrong`,
          ok: true,
          result: {},
        };
      },
      async *watch() {},
    };
    await expect(createRemoteOrchestrationClient(mismatched).getCapabilities())
      .rejects.toMatchObject({ code: 'INVALID' });
  });

  it('returns a protocol error for malformed untrusted input', async () => {
    const handler = createRemoteOrchestrationHandler(fakeClient());
    const response = await handler.request(null as never);

    expect(response).toMatchObject({
      protocol: REMOTE_ORCHESTRATION_PROTOCOL,
      requestId: 'invalid',
      ok: false,
      error: { code: 'INVALID' },
    });
  });

  it('propagates external cancellation to a non-watch handler and never publishes a late result', async () => {
    let resolveGet: ((value: OrchestrationResource<{ value: number }>) => void) | undefined;
    let delegatedSignal: AbortSignal | undefined;
    const source = fakeClient();
    source.get = (_reference, options) => {
      delegatedSignal = options?.signal;
      return new Promise((resolve) => {
        resolveGet = resolve as typeof resolveGet;
      });
    };
    const handler = createRemoteOrchestrationHandler(source);
    const abort = new AbortController();
    const request: RemoteOrchestrationRequest = {
      protocol: REMOTE_ORCHESTRATION_PROTOCOL,
      requestId: 'cancel-during',
      operation: 'get',
      payload: { reference: { apiVersion: 'v1', kind: 'Thing', name: 'one' } },
    };

    const pending = handler.request(request, { signal: abort.signal });
    await vi.waitFor(() => {
      expect(delegatedSignal).toBeDefined();
    });
    abort.abort(new Error('client disconnected'));

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'CANCELLED' },
    });
    expect(delegatedSignal?.aborted).toBe(true);

    resolveGet?.(resource);
    await Promise.resolve();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  });

  it('enforces a non-watch deadline, aborts delegated work, and ignores its late success', async () => {
    vi.useFakeTimers();
    try {
      let resolveGet: ((value: OrchestrationResource<{ value: number }>) => void) | undefined;
      let delegatedSignal: AbortSignal | undefined;
      const source = fakeClient();
      source.get = (_reference, options) => {
        delegatedSignal = options?.signal;
        return new Promise((resolve) => {
          resolveGet = resolve as typeof resolveGet;
        });
      };
      const handler = createRemoteOrchestrationHandler(source);
      const request: RemoteOrchestrationRequest = {
        protocol: REMOTE_ORCHESTRATION_PROTOCOL,
        requestId: 'deadline-during',
        operation: 'get',
        payload: { reference: { apiVersion: 'v1', kind: 'Thing', name: 'one' } },
      };

      const pending = handler.request(request, {
        deadline: new Date(Date.now() + 10).toISOString(),
      });
      await vi.advanceTimersByTimeAsync(10);

      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'TIMEOUT' },
      });
      expect(delegatedSignal?.aborted).toBe(true);

      resolveGet?.(resource);
      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels before transport dispatch and cancels an in-flight transport at its deadline', async () => {
    const requestSpy = vi.fn<RemoteOrchestrationTransport['request']>();
    const transport: RemoteOrchestrationTransport = {
      request: requestSpy,
      async *watch() {},
    };
    const client = createRemoteOrchestrationClient(transport, {
      createRequestId: () => 'cancel-before',
    });
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();

    await expect(
      client.get(
        { apiVersion: 'v1', kind: 'Thing', name: 'one' },
        { signal: alreadyAborted.signal },
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(requestSpy).not.toHaveBeenCalled();

    vi.useFakeTimers();
    try {
      let transportSignal: AbortSignal | undefined;
      requestSpy.mockImplementation((_request, options) => {
        transportSignal = options?.signal;
        return new Promise(() => undefined);
      });
      const pending = client.get(
        { apiVersion: 'v1', kind: 'Thing', name: 'one' },
        { deadline: new Date(Date.now() + 10).toISOString() },
      );
      const rejection = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(10);

      await rejection;
      expect(transportSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('streams split NDJSON watch frames through the browser fetch transport', async () => {
    const handler = createRemoteOrchestrationHandler(fakeClient());
    const encoder = new TextEncoder();
    const fetch_ = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body');
      const request = JSON.parse(init.body) as RemoteOrchestrationRequest;
      const frames: string[] = [];
      for await (const response of handler.watch(request)) {
        frames.push(`${JSON.stringify(response)}\n`);
      }
      const wire = frames.join('');
      return new Response(
        new ReadableStream({
          start(controller) {
            const midpoint = Math.floor(wire.length / 2);
            controller.enqueue(encoder.encode(wire.slice(0, midpoint)));
            controller.enqueue(encoder.encode(wire.slice(midpoint)));
            controller.close();
          },
        }),
        { status: 200 },
      );
    };
    const client = createRemoteOrchestrationClient(
      createFetchOrchestrationTransport({
        endpoint: 'https://control.example/resources',
        fetch: fetch_ as typeof fetch,
      }),
      { createRequestId: () => 'watch-1' },
    );
    const events: OrchestrationWatchEvent[] = [];
    for await (const event of client.watch({ kind: 'Thing' })) events.push(event);
    expect(events).toHaveLength(2);
  });

  it('cancels the response stream when a watch consumer disconnects', async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const fetch_ = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body');
      const request = JSON.parse(init.body) as RemoteOrchestrationRequest;
      const response: RemoteOrchestrationResponse = {
        protocol: REMOTE_ORCHESTRATION_PROTOCOL,
        requestId: request.requestId,
        ok: true,
        result: { type: 'BOOKMARK', resourceVersion: '1' },
      };
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`${JSON.stringify(response)}\n`));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    };
    const client = createRemoteOrchestrationClient(
      createFetchOrchestrationTransport({
        endpoint: 'https://control.example/resources',
        fetch: fetch_ as typeof fetch,
      }),
    );
    const iterator = client.watch({ kind: 'Thing' })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await iterator.return?.();
    expect(cancelled).toBe(true);
  });

  it('bounds ordinary and streaming responses', async () => {
    const oversized = createFetchOrchestrationTransport({
      endpoint: 'https://control.example/resources',
      maxResponseBytes: 8,
      maxWatchLineBytes: 8,
      fetch: async (_input, init) => {
        const accept = new Headers(init?.headers).get('Accept');
        return new Response(
          accept === 'application/x-ndjson'
            ? `${JSON.stringify({ value: 'too-long' })}\n`
            : JSON.stringify({ value: 'too-long' }),
          { status: 200 },
        );
      },
    });
    const request: RemoteOrchestrationRequest = {
      protocol: REMOTE_ORCHESTRATION_PROTOCOL,
      requestId: 'bounded',
      operation: 'capabilities',
      payload: {},
    };
    await expect(oversized.request(request)).rejects.toMatchObject({ code: 'EXHAUSTED' });
    const consume = async () => {
      for await (const _response of oversized.watch({ ...request, operation: 'watch' })) {
        // consume
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: 'EXHAUSTED' });
  });
});
