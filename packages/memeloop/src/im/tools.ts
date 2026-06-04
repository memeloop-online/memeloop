import type { IMChannelManager } from './channelManager.js';
import type { ImAgentDriver } from './interface.js';

/**
 * IM 会话控制工具（计划 20.4）：在带 IM binding 的会话中注入。
 * 这里仅导出工具 schema 描述，实际注册由上层 ToolRegistry 完成。
 */
export const imToolDefinitions = [
  {
    name: 'im.listConversations',
    description: '列出可切换的会话（由 memeloop-cli registerImSessionTools 注册，仅 IM 来源会话可用）。',
  },
  {
    name: 'im.switchConversation',
    description: '切换当前 IM 用户绑定的活跃会话。参数：{ conversationId: string }',
  },
  {
    name: 'im.newConversation',
    description: '创建新会话并切换绑定。参数：{ definitionId?: string }',
  },
  {
    name: 'im.summarizeHistory',
    description: '返回当前会话最近消息的纯文本摘要（规则拼接，非 LLM）。参数：{ maxMessages?: number }',
  },
] as const;

export interface ImToolsRuntime {
  channelId: string;
  imUserId: string;
  manager: IMChannelManager;
  driver: ImAgentDriver;
  defaultDefinitionId: string;
}

/** 供工具实现层调用的命令式 API（避免在 core 内耦合 defineTool） */
export async function imSwitchConversation(rt: ImToolsRuntime, conversationId: string): Promise<void> {
  await rt.manager.switchConversation(rt.channelId, rt.imUserId, conversationId);
}
