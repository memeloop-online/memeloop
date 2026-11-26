import { describe, expect, it } from 'vitest';

import {
  AGENT_RUN_ERROR_MESSAGE_KEYS,
  agentRunErrorFromUnknown,
  AgentRunErrorValidationError,
  AgentRunFailure,
  assertAgentRunError,
  createAgentRunError,
  createMissingApiKeyAgentRunError,
  createMissingProviderSettingAgentRunError,
  extractAgentRunError,
  isAgentRunError,
  isAgentRunFailure,
  normalizeAgentRunError,
} from '../runState.js';

function validError(): Record<string, unknown> {
  return {
    code: 'RATE_LIMITED',
    messageKey: AGENT_RUN_ERROR_MESSAGE_KEYS.RATE_LIMITED,
    retryable: true,
    diagnosticId: 'diag-rate-limit-1',
    providerId: 'openai',
    modelId: 'gpt-5',
    localizedParams: {
      providerId: 'openai',
      modelId: 'gpt-5',
      retryAfterMs: 1250.5,
      requested: 12.25,
      limit: 10.5,
    },
    settingTarget: { kind: 'model', providerId: 'openai', modelId: 'gpt-5' },
  };
}

describe('AgentRunError public contract', () => {
  it('strictly clones and freezes safe metadata while preserving finite decimals', () => {
    const source = validError();
    const normalized = normalizeAgentRunError(source);

    expect(normalized).toEqual(source);
    expect(normalized).not.toBe(source);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.localizedParams)).toBe(true);
    expect(Object.isFrozen(normalized.settingTarget)).toBe(true);
    expect(normalized.localizedParams?.retryAfterMs).toBe(1250.5);
    expect(isAgentRunError(normalized)).toBe(true);
    expect(() => {
      assertAgentRunError(normalized);
    }).not.toThrow();
  });

  it('requires the canonical localization key for each stable code', () => {
    expect(() =>
      normalizeAgentRunError({
        ...validError(),
        messageKey: 'provider said sk-not-a-public-message',
      })
    ).toThrow(AgentRunErrorValidationError);
  });

  it.each(['message', 'metadata', 'providerBody', 'rawProviderBody', 'apiKey', 'secret'])(
    'rejects forbidden root field %s',
    field => {
      expect(() => normalizeAgentRunError({ ...validError(), [field]: 'sensitive' }))
        .toThrow(AgentRunErrorValidationError);
    },
  );

  it('rejects arbitrary localization and setting-target keys', () => {
    expect(() =>
      normalizeAgentRunError({
        ...validError(),
        localizedParams: { arbitrary: 'provider body' },
      })
    ).toThrow(AgentRunErrorValidationError);
    expect(() =>
      normalizeAgentRunError({
        ...validError(),
        settingTarget: {
          kind: 'provider',
          providerId: 'openai',
          field: 'apiKey',
          apiKey: 'secret',
        },
      })
    ).toThrow(AgentRunErrorValidationError);
  });

  it('requires an exact provider setting field and correlated identifiers', () => {
    const base = {
      code: 'PROVIDER_AUTH_MISSING',
      messageKey: AGENT_RUN_ERROR_MESSAGE_KEYS.PROVIDER_AUTH_MISSING,
      retryable: false,
      diagnosticId: 'diag-auth-1',
      providerId: 'openai',
      localizedParams: { providerId: 'openai', settingField: 'apiKey' },
    };
    expect(
      normalizeAgentRunError({
        ...base,
        settingTarget: { kind: 'provider', providerId: 'openai', field: 'apiKey' },
      }).settingTarget,
    ).toEqual({ kind: 'provider', providerId: 'openai', field: 'apiKey' });
    expect(() =>
      normalizeAgentRunError({
        ...base,
        settingTarget: { kind: 'provider', providerId: 'openai' },
      })
    ).toThrow(AgentRunErrorValidationError);
    expect(() =>
      normalizeAgentRunError({
        ...base,
        settingTarget: { kind: 'provider', providerId: 'openai', field: 'deploymentId' },
      })
    ).toThrow(AgentRunErrorValidationError);
    expect(() =>
      normalizeAgentRunError({
        ...base,
        settingTarget: { kind: 'provider', providerId: 'other', field: 'apiKey' },
      })
    ).toThrow(AgentRunErrorValidationError);
    expect(() =>
      normalizeAgentRunError({
        ...base,
        localizedParams: { providerId: 'other', settingField: 'apiKey' },
        settingTarget: { kind: 'provider', providerId: 'openai', field: 'apiKey' },
      })
    ).toThrow(AgentRunErrorValidationError);
  });

  it('rejects controls, lone surrogates, secret-shaped identifiers, and unsafe numbers', () => {
    for (
      const providerId of [
        'open\nai',
        '\ud800',
        'sk-1234567890abcdefghijklmnop',
        'Bearer abcdefghijklmnop',
      ]
    ) {
      expect(() => normalizeAgentRunError({ ...validError(), providerId }))
        .toThrow(AgentRunErrorValidationError);
    }
    for (const retryAfterMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, -1]) {
      expect(() =>
        normalizeAgentRunError({
          ...validError(),
          localizedParams: { retryAfterMs },
        })
      ).toThrow(AgentRunErrorValidationError);
    }
    expect(() =>
      normalizeAgentRunError({
        ...validError(),
        diagnosticId: 'diag with spaces',
      })
    ).toThrow(AgentRunErrorValidationError);
    expect(() =>
      normalizeAgentRunError({
        ...validError(),
        modelId: '模'.repeat(86),
      })
    ).toThrow(AgentRunErrorValidationError);
  });

  it('uses descriptors without invoking root or nested getters', () => {
    let getterCalls = 0;
    const root = validError();
    Object.defineProperty(root, 'diagnosticId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'diag-getter';
      },
    });
    expect(() => normalizeAgentRunError(root)).toThrow(AgentRunErrorValidationError);

    const nested = validError();
    Object.defineProperty(nested.localizedParams as object, 'providerId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'openai';
      },
    });
    expect(() => normalizeAgentRunError(nested)).toThrow(AgentRunErrorValidationError);
    expect(getterCalls).toBe(0);
  });

  it('rejects cycles, symbols, non-enumerable properties, arrays, and class instances', () => {
    const cyclic = validError();
    cyclic.localizedParams = cyclic;
    expect(() => normalizeAgentRunError(cyclic)).toThrow(AgentRunErrorValidationError);

    const symbolic = validError();
    Object.defineProperty(symbolic, Symbol('secret'), { enumerable: true, value: 'value' });
    expect(() => normalizeAgentRunError(symbolic)).toThrow(AgentRunErrorValidationError);

    const hidden = validError();
    Object.defineProperty(hidden, 'hidden', { enumerable: false, value: 'value' });
    expect(() => normalizeAgentRunError(hidden)).toThrow(AgentRunErrorValidationError);
    expect(() => normalizeAgentRunError([])).toThrow(AgentRunErrorValidationError);

    class ErrorLike {
      code = 'INTERNAL';
      messageKey = AGENT_RUN_ERROR_MESSAGE_KEYS.INTERNAL;
      retryable = false;
      diagnosticId = 'diag-class';
    }
    expect(() => normalizeAgentRunError(new ErrorLike())).toThrow(AgentRunErrorValidationError);
  });

  it('constructs precise provider settings navigation without accepting a setting value', () => {
    expect(createMissingApiKeyAgentRunError({
      providerId: 'openai',
      modelId: 'gpt-5',
      diagnosticId: 'diag-missing-api-key',
    })).toEqual({
      code: 'PROVIDER_AUTH_MISSING',
      messageKey: AGENT_RUN_ERROR_MESSAGE_KEYS.PROVIDER_AUTH_MISSING,
      retryable: false,
      diagnosticId: 'diag-missing-api-key',
      providerId: 'openai',
      modelId: 'gpt-5',
      localizedParams: {
        providerId: 'openai',
        modelId: 'gpt-5',
        settingField: 'apiKey',
      },
      settingTarget: { kind: 'provider', providerId: 'openai', field: 'apiKey' },
    });
    expect(createMissingProviderSettingAgentRunError({
      providerId: 'openai-compatible',
      field: 'baseUrl',
      diagnosticId: 'diag-missing-base-url',
    })).toMatchObject({
      code: 'PROVIDER_CONFIGURATION_MISSING',
      settingTarget: {
        kind: 'provider',
        providerId: 'openai-compatible',
        field: 'baseUrl',
      },
    });
  });

  it('does not invoke getters passed to safe constructors', () => {
    let getterCalls = 0;
    const input = {
      get code() {
        getterCalls += 1;
        return 'INTERNAL' as const;
      },
      messageKey: AGENT_RUN_ERROR_MESSAGE_KEYS.INTERNAL,
      retryable: false,
    };
    expect(() => createAgentRunError(input)).toThrow(AgentRunErrorValidationError);
    const helperInput = {
      get providerId() {
        getterCalls += 1;
        return 'openai';
      },
    };
    expect(() => createMissingApiKeyAgentRunError(helperInput))
      .toThrow(AgentRunErrorValidationError);
    expect(getterCalls).toBe(0);
  });

  it('supports typed throwable failures with a fixed safe Error message', () => {
    const error = createAgentRunError({
      code: 'CONTEXT_COMPACTION_FAILED',
      messageKey: AGENT_RUN_ERROR_MESSAGE_KEYS.CONTEXT_COMPACTION_FAILED,
      retryable: true,
      diagnosticId: 'diag-compaction-1',
    });
    const failure = new AgentRunFailure(error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('CONTEXT_COMPACTION_FAILED');
    expect(isAgentRunFailure(failure)).toBe(true);
    expect(extractAgentRunError(failure)).toEqual(error);
    expect(agentRunErrorFromUnknown(failure)).toEqual(error);
  });

  it('preserves actionable error details in JSON without exposing private Error fields', () => {
    const detail = createAgentRunError({
      code: 'PROVIDER_CONFIGURATION_MISSING',
      messageKey: AGENT_RUN_ERROR_MESSAGE_KEYS.PROVIDER_CONFIGURATION_MISSING,
      retryable: false,
      localizedParams: { settingField: 'model' },
      settingTarget: { kind: 'runtime', section: 'agent' },
    });
    const failure = new AgentRunFailure(detail);
    failure.stack = 'private diagnostic stack';
    failure.message = 'private provider response';
    const serialized = JSON.parse(JSON.stringify(failure));
    expect(serialized).toEqual({
      name: 'AgentRunFailure',
      message: 'PROVIDER_CONFIGURATION_MISSING',
      agentRunError: detail,
    });
    expect(extractAgentRunError(serialized)).toEqual(detail);
  });

  it('publishes content-free long-history compaction progress', () => {
    const pending = createAgentRunError({
      code: 'CONTEXT_COMPACTION_PENDING',
      messageKey: AGENT_RUN_ERROR_MESSAGE_KEYS.CONTEXT_COMPACTION_PENDING,
      retryable: true,
      diagnosticId: 'diag-compaction-pending-1',
      localizedParams: {
        checkpointRevision: 'compaction:checkpoint-0001',
        processedMessages: 200,
        remainingEstimate: 800,
      },
    });

    expect(normalizeAgentRunError(pending)).toEqual(pending);
    expect(JSON.stringify(pending)).not.toContain('message content');
    expect(() =>
      createAgentRunError({
        ...pending,
        localizedParams: { remainingEstimate: 0 },
      })
    ).toThrow(AgentRunErrorValidationError);
  });

  it('normalizes unknown and accessor-backed errors to generic safe metadata', () => {
    const raw = new Error('Authorization: Bearer super-secret-provider-body');
    const generic = agentRunErrorFromUnknown(raw);
    expect(generic).toMatchObject({
      code: 'INTERNAL',
      messageKey: AGENT_RUN_ERROR_MESSAGE_KEYS.INTERNAL,
      retryable: false,
    });
    expect(generic.diagnosticId).toMatch(/^agent-/u);
    expect(JSON.stringify(generic)).not.toContain('super-secret');

    let getterCalls = 0;
    Object.defineProperty(raw, 'agentRunError', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return validError();
      },
    });
    expect(agentRunErrorFromUnknown(raw).code).toBe('INTERNAL');
    expect(getterCalls).toBe(0);
  });

  it.each(['DEVICE_AUTH_REQUIRED', 'DEVICE_PERMISSION_DENIED', 'NETWORK_UNAVAILABLE'] as const)(
    'publishes cloud/network code %s without parsing a local Error message',
    code => {
      const error = createAgentRunError({
        code,
        messageKey: AGENT_RUN_ERROR_MESSAGE_KEYS[code],
        retryable: code === 'NETWORK_UNAVAILABLE',
        diagnosticId: `diag-${code.toLowerCase()}`,
        settingTarget: { kind: 'runtime', section: 'network' },
      });
      expect(agentRunErrorFromUnknown(new AgentRunFailure(error))).toEqual(error);
    },
  );
});
