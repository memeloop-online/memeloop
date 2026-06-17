import { describe, expect, it } from 'vitest';

import type { AgentDefinition } from '../agent/types.js';
import type { ChatMessage } from '../conversation/index.js';
import type { ConversationMeta } from '../sync/protocol.js';

import { AgentInstanceLatestStatus, AgentInstanceModel, AgentInstanceState, createInstanceDeltaFromDefinition, isUserInitiatedConversation } from '../types.js';

describe('memeloop types/models alignment', () => {
  it('isUserInitiatedConversation returns flag from ConversationMeta', () => {
    const meta: ConversationMeta = {
      conversationId: 'c1',
      title: 't',
      lastMessagePreview: '',
      lastMessageTimestamp: Date.now(),
      messageCount: 0,
      originNodeId: 'n1',
      definitionId: 'def1',
      isUserInitiated: true,
    };

    expect(isUserInitiatedConversation(meta)).toBe(true);
  });

  it('createInstanceDeltaFromDefinition only keeps changed fields', () => {
    const base: AgentDefinition = {
      id: 'd1',
      name: 'base',
      description: 'desc',
      systemPrompt: 'sys',
      tools: ['t1'],
      modelConfig: { provider: 'p1', model: 'm1', temperature: 0.5, maxTokens: 1024 },
      version: '1.0.0',
    };

    const overrides: Partial<AgentDefinition> = {
      name: 'base', // unchanged
      description: 'new-desc', // changed
      modelConfig: { provider: 'p1', model: 'm2', temperature: 0.5, maxTokens: 1024 }, // changed
    };

    const delta = createInstanceDeltaFromDefinition(base, overrides);

    expect(delta).toHaveProperty('description', 'new-desc');
    expect(delta).toHaveProperty('modelConfig');
    expect(Object.keys(delta)).not.toContain('name');
  });

  it('AgentInstanceModel / ChatMessage runtime shape is consistent', () => {
    const msg: ChatMessage = {
      messageId: 'm1',
      conversationId: 'a1',
      originNodeId: 'local',
      timestamp: Date.now(),
      lamportClock: 0,
      role: 'user',
      content: 'hello',
      metadata: { foo: 'bar' },
    };

    const status: AgentInstanceLatestStatus = {
      state: 'working',
      message: msg,
      created: new Date(),
    };

    const instance: AgentInstanceModel = {
      id: 'def1',
      agentDefId: 'def1',
      description: 'd',
      systemPrompt: 's',
      tools: [],
      modelConfig: {},
      version: '1.0.0',
      messages: [msg],
      status,
      created: new Date(),
    };

    expect(instance.messages[0].content).toBe('hello');
    expect(instance.status.state).toBe<AgentInstanceState>('working');
  });
});
