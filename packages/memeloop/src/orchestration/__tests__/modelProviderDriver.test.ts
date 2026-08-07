import { describe, expect, it, vi } from 'vitest';

import type { ILLMProvider } from '../../types.js';
import { assertClassificationAllowed, classificationRank, createModelProviderDriverFromLLMProvider, type ModelGenerateRequest } from '../drivers/modelProviderDriver.js';
import { OrchestrationError } from '../errors.js';
import type { ModelClassSpec } from '../resources.js';

const MODEL: ModelClassSpec = {
  provider: 'mock',
  model: 'mock-1',
  digest: 'sha256:m1',
  modalities: ['text'],
};

function request(overrides: Partial<ModelGenerateRequest> = {}): ModelGenerateRequest {
  return {
    callId: 'call-1',
    modelClassRef: {
      apiVersion: 'models.memeloop.io/v1alpha1',
      kind: 'ModelClass',
      name: 'mock-1',
    },
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  };
}

describe('classification enforcement', () => {
  it('orders classifications from public to restricted', () => {
    expect(classificationRank('public')).toBeLessThan(classificationRank('internal'));
    expect(classificationRank('internal')).toBeLessThan(classificationRank('confidential'));
    expect(classificationRank('confidential')).toBeLessThan(classificationRank('restricted'));
  });

  it('rejects input above the endpoint classification limit', () => {
    expect(() => {
      assertClassificationAllowed({ maxInputClassification: 'internal' }, 'confidential');
    }).toThrow(OrchestrationError);
    expect(() => {
      assertClassificationAllowed({ maxInputClassification: 'internal' }, 'internal');
    }).not.toThrow();
    expect(() => {
      assertClassificationAllowed(undefined, 'restricted');
    }).not.toThrow();
    expect(() => {
      assertClassificationAllowed({ maxInputClassification: 'internal' }, undefined);
    }).not.toThrow();
  });

  it('rejects with a structured FORBIDDEN error', () => {
    try {
      assertClassificationAllowed({ maxInputClassification: 'public' }, 'restricted');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestrationError);
      expect((error as OrchestrationError).code).toBe('FORBIDDEN');
      expect((error as OrchestrationError).retryable).toBe(false);
    }
  });
});

describe('createModelProviderDriverFromLLMProvider', () => {
  it('maps the requested ModelClass to its declared wire model without leaking the model factory', async () => {
    const chat = vi.fn(async function*() {
      yield 'ok';
    });
    const provider: ILLMProvider = {
      name: 'mock',
      modelId: 'configured-model',
      model: () => ({ specificationVersion: 'v1' }),
      chat,
    };
    const driver = createModelProviderDriverFromLLMProvider(provider, {
      models: [MODEL],
    });

    for await (const _ of driver.generate(request({ maxOutputTokens: 123, temperature: 0.25 }))) {
      // consume
    }

    expect(chat).toHaveBeenCalledWith({
      model: 'mock-1',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 123,
      temperature: 0.25,
      topP: undefined,
      providerOptions: undefined,
      abortSignal: expect.any(AbortSignal),
    });
    expect(chat.mock.calls[0]?.[0]?.model).not.toBe(provider.model);
  });

  it('rejects an undeclared ModelClass instead of falling back to the provider default', async () => {
    const chat = vi.fn();
    const driver = createModelProviderDriverFromLLMProvider(
      { name: 'mock', modelId: 'configured-model', chat },
      { models: [MODEL] },
    );

    await expect(async () => {
      for await (
        const _ of driver.generate(request({
          modelClassRef: {
            apiVersion: 'models.memeloop.io/v1alpha1',
            kind: 'ModelClass',
            name: 'unknown-model',
          },
        }))
      ) {
        // consume
      }
    }).rejects.toMatchObject({ code: 'INVALID' });
    expect(chat).not.toHaveBeenCalled();
  });

  it('streams legacy provider chunks as portable deltas', async () => {
    const provider: ILLMProvider = {
      name: 'mock',
      async *chat() {
        yield 'hel';
        yield 'lo';
      },
    };
    const driver = createModelProviderDriverFromLLMProvider(provider, { models: [MODEL] });

    const chunks = [];
    for await (const chunk of driver.generate(request())) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: 'delta', delta: 'hel' },
      { type: 'delta', delta: 'lo' },
      { type: 'done' },
    ]);
  });

  it('enforces classification before invoking the legacy provider', async () => {
    const chat = vi.fn();
    const provider: ILLMProvider = { name: 'mock', chat };
    const driver = createModelProviderDriverFromLLMProvider(provider, {
      models: [MODEL],
      dataPolicy: { maxInputClassification: 'internal' },
    });

    await expect(async () => {
      for await (const _ of driver.generate(request({ inputClassification: 'restricted' }))) {
        // consume
      }
    }).rejects.toThrow(OrchestrationError);
    expect(chat).not.toHaveBeenCalled();
  });

  it('maps custom legacy chunks through toDelta', async () => {
    const provider: ILLMProvider = {
      name: 'mock',
      async *chat() {
        yield { text: 'a' };
        yield { other: true };
        yield { text: 'b' };
      },
    };
    const driver = createModelProviderDriverFromLLMProvider(provider, {
      models: [MODEL],
      toDelta: (chunk) =>
        chunk != null &&
          typeof chunk === 'object' &&
          'text' in chunk &&
          typeof chunk.text === 'string'
          ? chunk.text
          : undefined,
    });

    const deltas = [];
    for await (const chunk of driver.generate(request())) {
      if (chunk.type === 'delta') deltas.push(chunk.delta);
    }
    expect(deltas).toEqual(['a', 'b']);
  });

  it('lists declared models and reports health', async () => {
    const provider: ILLMProvider = { name: 'mock', chat: vi.fn() };
    const driver = createModelProviderDriverFromLLMProvider(provider, { models: [MODEL] });

    await expect(driver.listModels()).resolves.toEqual([MODEL]);
    const health = await driver.getHealth();
    expect(health.healthy).toBe(true);
    expect(health.checkedAt).toBeTruthy();
  });

  it('cancel(callId) aborts an in-flight generate and yields CANCELLED', async () => {
    const provider: ILLMProvider = {
      name: 'mock',
      async *chat() {
        yield 'a';
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        yield 'b';
        yield 'c';
      },
    };
    const driver = createModelProviderDriverFromLLMProvider(provider, { models: [MODEL] });

    const chunks = [];
    for await (const chunk of driver.generate(request())) {
      chunks.push(chunk);
      if (chunk.type === 'delta' && chunk.delta === 'a') {
        await driver.cancel?.('call-1');
      }
    }

    expect(chunks[0]).toEqual({ type: 'delta', delta: 'a' });
    expect(chunks.at(-1)).toEqual({
      type: 'error',
      error: { code: 'CANCELLED', message: 'generate cancelled', retryable: false },
    });
    expect(chunks.filter((c) => c.type === 'delta')).toHaveLength(1);
  });

  it('cancel is a no-op for unknown call ids', async () => {
    const provider: ILLMProvider = { name: 'mock', chat: vi.fn() };
    const driver = createModelProviderDriverFromLLMProvider(provider, { models: [MODEL] });
    await expect(driver.cancel?.('missing')).resolves.toBeUndefined();
  });
});
