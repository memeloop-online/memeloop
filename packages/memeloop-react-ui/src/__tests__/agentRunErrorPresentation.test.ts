import { AgentRunFailure, type ConversationMessageListProjection, createMissingApiKeyAgentRunError } from 'memeloop';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveAgentRunErrorPresentation } from '../chat/agentRunErrorPresentation.js';

function errorMessage(metadata: Record<string, unknown>, content = 'untrusted raw body'): ConversationMessageListProjection {
  return {
    messageId: 'error-1',
    turnId: 'turn-1',
    conversationId: 'conversation-1',
    originNodeId: 'node-1',
    originSequence: 1,
    timestamp: 1,
    lamportClock: 1,
    role: 'error',
    content,
    metadata,
  };
}

describe('resolveAgentRunErrorPresentation', () => {
  const localize = vi.fn(() => ({ title: '需要配置提供方', message: '请先填写 API 密钥。' }));

  beforeEach(() => {
    localize.mockClear();
  });

  it('maps the strict typed contract and exposes a structural settings target', () => {
    const error = createMissingApiKeyAgentRunError({
      providerId: 'siliconflow',
      modelId: 'deepseek',
      diagnosticId: 'diagnostic-1',
    });
    const presentation = resolveAgentRunErrorPresentation(new AgentRunFailure(error), {
      localize,
      settingActionLabel: target => target.kind === 'provider' ? '打开提供方设置' : '打开设置',
    });

    expect(presentation).toMatchObject({
      title: '需要配置提供方',
      message: '请先填写 API 密钥。',
      diagnosticId: 'diagnostic-1',
      errorCode: 'PROVIDER_AUTH_MISSING',
      retryable: false,
      actionId: 'agent-run-setting',
      actionLabel: '打开提供方设置',
      settingTarget: { kind: 'provider', providerId: 'siliconflow', field: 'apiKey' },
    });
    expect(localize).toHaveBeenCalledWith('agent.run.error.providerAuthMissing', expect.objectContaining({ providerId: 'siliconflow' }));
  });

  it('does not inspect legacy errorDetail, raw content, or Error.message', () => {
    expect(resolveAgentRunErrorPresentation(
      errorMessage({
        errorDetail: { message: 'API key for siliconflow not found', name: 'MissingAPIKeyError' },
      }),
      { localize },
    )).toBeNull();
    expect(resolveAgentRunErrorPresentation(new Error('API key for siliconflow not found'), { localize })).toBeNull();
    expect(localize).not.toHaveBeenCalled();
  });
});
