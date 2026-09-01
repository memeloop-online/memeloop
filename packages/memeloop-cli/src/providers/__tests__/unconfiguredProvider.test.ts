import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createNodeRuntime } from '../../runtime/nodeRuntime.js';
import { createUnconfiguredLLMProvider, resolveUnconfiguredDaemonModelRuntime, UNCONFIGURED_PROVIDER_ERROR } from '../unconfiguredProvider.js';

const temporaryDirectories: string[] = [];

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
});
