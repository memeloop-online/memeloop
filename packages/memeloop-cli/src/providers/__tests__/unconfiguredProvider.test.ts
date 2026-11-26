import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { CredentialBrokerDriver, CredentialHandleVault } from 'memeloop';

import { createNodeRuntime } from '../../runtime/nodeRuntime.js';
import { createUnconfiguredLLMProvider, resolveUnconfiguredDaemonModelRuntime, UNCONFIGURED_PROVIDER_ERROR } from '../unconfiguredProvider.js';

const temporaryDirectories: string[] = [];

const unusedCredentialDriver = {
  async issue() {
    throw new Error('unused credential driver');
  },
  async renew() {
    throw new Error('unused credential driver');
  },
  revoke() {},
  async inspect() {
    throw new Error('unused credential driver');
  },
  async verify() {
    throw new Error('unused credential driver');
  },
} satisfies CredentialBrokerDriver;

const unusedCredentialVault = {
  async put() {},
  async get() {
    return undefined;
  },
  async delete() {},
} satisfies CredentialHandleVault;

function request(providerId = 'unconfigured') {
  return {
    providerId,
    logicalModelId: 'unconfigured',
    wireModelId: 'unconfigured',
    apiMode: 'chat-completions' as const,
    messages: [],
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('unconfigured provider runtime', () => {
  it('fails only when a model request is attempted', async () => {
    const provider = createUnconfiguredLLMProvider();
    const iterator = provider.chat(request()) as AsyncIterable<unknown>;

    await expect(iterator[Symbol.asyncIterator]().next()).rejects.toThrow(
      UNCONFIGURED_PROVIDER_ERROR,
    );
  });

  it('does not override an explicitly configured provider', () => {
    expect(resolveUnconfiguredDaemonModelRuntime({
      providers: [{ name: 'openai', models: {} }],
    })).toBeUndefined();
  });

  it('starts a fresh daemon runtime without advertising a fake model endpoint', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-unconfigured-'));
    temporaryDirectories.push(dataDir);
    const fallback = resolveUnconfiguredDaemonModelRuntime({ providers: [] });
    expect(fallback).toBeDefined();

    const runtime = await createNodeRuntime({
      dataDir,
      includeVscodeCli: false,
      localNodeId: 'unconfigured-node',
      config: { providers: [] },
      ...fallback,
    });
    try {
      expect(runtime.modelEndpointRegistrar).toBeUndefined();
      expect(runtime.modelGateway).toBeUndefined();
      const iterator = runtime.context.llmProvider.chat(request(runtime.context.llmProvider.name)) as AsyncIterable<unknown>;
      await expect(iterator[Symbol.asyncIterator]().next()).rejects.toThrow(
        UNCONFIGURED_PROVIDER_ERROR,
      );
    } finally {
      await runtime.stop();
    }
  });

  it('drains gateway-owned startup work when tool catalog construction fails', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-unconfigured-cleanup-'));
    temporaryDirectories.push(dataDir);
    const fallback = resolveUnconfiguredDaemonModelRuntime({ providers: [] });
    const schema = Object.defineProperty({}, 'toJSONSchema', {
      enumerable: true,
      get: () => {
        throw new Error('schema accessor must not be invoked');
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(createNodeRuntime({
        dataDir,
        includeVscodeCli: false,
        localNodeId: 'unconfigured-cleanup-node',
        config: { providers: [] },
        configureTools: (registry) => {
          registry.registerTool('invalid-schema', () => undefined, schema);
        },
        ...fallback,
      })).rejects.toThrow('Tool parameter schema methods must be data properties');
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('rolls back the gateway and owned stores when a later route fails', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-late-startup-cleanup-'));
    temporaryDirectories.push(dataDir);
    const fallback = resolveUnconfiguredDaemonModelRuntime({ providers: [] });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(createNodeRuntime({
        dataDir,
        includeVscodeCli: false,
        localNodeId: 'late-startup-cleanup-node',
        config: { providers: [] },
        credentialBroker: {
          driver: unusedCredentialDriver,
          vault: unusedCredentialVault,
          brokerClass: 'test-broker',
          audiences: ['test-audience'],
          maxTtlMs: 0,
          authorizeGrant: async () => true,
        },
        ...fallback,
      })).rejects.toThrow('managed credential adapter capabilities are incomplete');
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
