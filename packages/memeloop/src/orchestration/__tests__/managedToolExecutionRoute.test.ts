import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v3';

import { registerToolParameterSchema } from '../../tools/schemaRegistry.js';
import type { IToolRegistry } from '../../types.js';
import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import { createManagedToolDescriptors, createManagedToolExecutionRoute } from '../drivers/managedToolExecutionRoute.js';
import type { ToolExecutionDriver } from '../drivers/toolExecutionDriver.js';
import type { ToolOperationResource } from '../resources.js';

const now = () => new Date('2026-07-27T01:00:00.000Z');

const operation: ToolOperationResource = {
  apiVersion: 'execution.memeloop.io/v1alpha1',
  kind: 'ToolOperation',
  metadata: {
    name: 'managed-echo',
    uid: 'tool-operation-uid-1',
    generation: 1,
    resourceVersion: '1',
    creationTimestamp: '',
  },
  spec: {
    toolRef: { kind: 'BuiltinTool', name: 'managed.test.echo' },
    arguments: { value: 'hello' },
    effect: 'read',
    idempotencyKey: 'echo-effect-1',
  },
  status: {
    phase: 'Running',
    executionClaim: { leaseEpoch: '3', claimedAt: now().toISOString() },
  },
};

function request<T>(method: string, payload: T, idempotencyKey: string): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: operation.apiVersion,
      kind: operation.kind,
      name: operation.metadata.name,
      uid: operation.metadata.uid,
      generation: operation.metadata.generation,
    },
    fencingEpoch: 3,
    requestId: `${method}:${idempotencyKey}`,
    idempotencyKey,
    deadline: '2026-07-27T01:01:00.000Z',
    actor: { id: 'controller/tool', kind: 'controller' },
    session: { id: 'tool-session-1' },
    capabilityHandleRef: 'capability:tool-1',
    trace: { traceId: 'trace-1', spanId: idempotencyKey },
    payloadSchemaDigest: `sha256:${'a'.repeat(64)}`,
    payload,
  };
}

describe('managed production Tool execution route', () => {
  it('derives canonical schema descriptors and round-trips execution with evidence', async () => {
    const implementation = vi.fn();
    const registry: IToolRegistry = {
      registerTool() {},
      getTool: () => implementation,
      listTools: () => ['managed.test.echo'],
      getToolEffect: () => 'read',
    };
    registerToolParameterSchema('managed.test.echo', z.object({ value: z.string() }).strict());
    const descriptors = await createManagedToolDescriptors(registry, 'node-1');
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.effect).toBe('read');
    expect(new Set(descriptors.map((descriptor) => descriptor.schemaDigest)).size).toBe(1);
    expect(descriptors[0].schemaDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(descriptors[0].inputSchema).toMatchObject({
      properties: { value: { type: 'string' } },
      additionalProperties: false,
    });

    const narrowExecute = vi.fn(async (input: ToolOperationResource) => ({
      ...input,
      status: {
        ...input.status,
        phase: 'Completed' as const,
        result: { value: { echoed: input.spec.arguments?.value } },
        completedAt: now().toISOString(),
      },
    }));
    const route = createManagedToolExecutionRoute(
      { execute: narrowExecute } satisfies ToolExecutionDriver,
      {
        descriptors,
        name: 'managed-test-tools',
        now,
        resolveOperation: async (uid) => (uid === operation.metadata.uid ? operation : undefined),
        authorizeOperation: async () => ({
          handle: 'policy-decision:trusted',
          policyDigest: `sha256:${'b'.repeat(64)}`,
        }),
        authorizeRequest: (input) =>
          input.capabilityHandleRef === 'capability:tool-1' &&
          input.session?.id === 'tool-session-1',
        createRequest: (input) => request(input.method, input.payload, input.idempotencyKey),
        threatAssumptions: ['the test registry and policy decision are trusted'],
      },
    );
    const executed = await route.executionDriver.execute(operation, {
      actor: { id: 'controller/tool', kind: 'controller' },
      leaseEpoch: '3',
    });
    expect(narrowExecute).toHaveBeenCalledOnce();
    expect(executed.status).toMatchObject({
      phase: 'Completed',
      result: {
        value: { echoed: 'hello' },
        evidenceRef: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
    await expect(route.managementDriver.getCapabilities()).resolves.toMatchObject({
      name: 'managed-test-tools',
      persistence: 'process',
    });
  });

  it('rejects untrusted capabilities and payload extensions before dispatch', async () => {
    const registry: IToolRegistry = {
      registerTool() {},
      getTool: () => undefined,
      listTools: () => ['managed.test.denied'],
    };
    registerToolParameterSchema('managed.test.denied', {
      type: 'object',
      additionalProperties: false,
    });
    const route = createManagedToolExecutionRoute(
      { execute: vi.fn() } as unknown as ToolExecutionDriver,
      {
        descriptors: await createManagedToolDescriptors(registry, 'node-1'),
        name: 'managed-test-tools',
        now,
        resolveOperation: async () => undefined,
        authorizeOperation: async () => ({
          handle: 'policy-decision:trusted',
          policyDigest: `sha256:${'b'.repeat(64)}`,
        }),
        authorizeRequest: (input) => input.capabilityHandleRef === 'capability:tool-1',
        createRequest: (input) => request(input.method, input.payload, input.idempotencyKey),
        threatAssumptions: ['the test registry is trusted'],
      },
    );
    await expect(
      route.managementDriver.discover({
        ...request('tool.discover', {}, 'denied'),
        capabilityHandleRef: 'capability:wrong',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      route.managementDriver.discover(
        request('tool.discover', { secret: 'must-not-cross' } as never, 'extension'),
      ),
    ).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('omits a registered tool from the managed catalog when it has no portable schema', async () => {
    const registry: IToolRegistry = {
      registerTool() {},
      getTool: () => undefined,
      listTools: () => ['managed.test.missing-schema'],
    };

    await expect(createManagedToolDescriptors(registry, 'node-1')).resolves.toEqual([]);
  });
});
