import { AGENT_RUN_ERROR_MESSAGE_KEYS, AgentRunFailure, createAgentRunError, extractAgentRunError } from 'memeloop';
import { describe, expect, it } from 'vitest';

import { normalizeMemeLoopChatError } from '../chat/coreTypes.js';

describe('normalizeMemeLoopChatError', () => {
  it('preserves the validated agent configuration contract for the presentation layer', () => {
    const detail = createAgentRunError({
      code: 'PROVIDER_CONFIGURATION_MISSING',
      messageKey: AGENT_RUN_ERROR_MESSAGE_KEYS.PROVIDER_CONFIGURATION_MISSING,
      retryable: false,
      localizedParams: { settingField: 'model' },
      settingTarget: { kind: 'runtime', section: 'agent' },
    });
    const remoteFailure = new Error('remote_agent_execution_port_failure');
    Object.defineProperty(remoteFailure, 'agentRunError', { value: detail, enumerable: true });

    const normalized = normalizeMemeLoopChatError(remoteFailure);

    expect(normalized).toBeInstanceOf(AgentRunFailure);
    expect(extractAgentRunError(normalized)).toEqual(detail);
  });

  it('continues to redact untyped error messages', () => {
    const normalized = normalizeMemeLoopChatError(new Error('Authorization: Bearer super-secret-provider-token'));

    expect(normalized).not.toHaveProperty('agentRunError');
    expect(normalized.message).not.toContain('super-secret-provider-token');
  });
});
