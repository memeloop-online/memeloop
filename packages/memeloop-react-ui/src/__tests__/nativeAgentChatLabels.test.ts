import { describe, expect, it } from 'vitest';

import { resolveNativeAgentChatLabels, resolveNativeTimelineLabels } from '../native/agentChatLabels.js';

describe('native agent chat labels', () => {
  it('allows hosts to localize native controls without losing defaults', () => {
    const labels = resolveNativeAgentChatLabels({ loadDetails: '查看详情' });
    expect(labels.loadDetails).toBe('查看详情');
    expect(labels.reloadDetails).toBe('Reload details');
    expect(labels.exportFullMessage).toBe('Export full message');
  });

  it('accepts host-localized timeline formatters', () => {
    const labels = resolveNativeTimelineLabels({
      navigation: '对话时间线',
      message: (index, total, role) => `第 ${index} / ${total} 条${role === 'user' ? '用户' : '助手'}消息`,
    });
    expect(labels.navigation).toBe('对话时间线');
    expect(labels.message(3, 12, 'assistant')).toBe('第 3 / 12 条助手消息');
    expect(labels.compacted(8)).toBe('8 earlier messages compacted');
  });

  it('allows a host locale to format native timeline timestamps', () => {
    const labels = resolveNativeAgentChatLabels({
      timelineTimestamp: timestamp => `本地时间 ${timestamp}`,
    });
    expect(labels.timelineTimestamp(123)).toBe('本地时间 123');
  });
});
