export type IMPlatformType = 'telegram' | 'discord' | 'lark' | 'wecom' | 'slack' | 'line' | 'qq';

export interface IMChannel {
  channelId: string;
  platform: IMPlatformType;
  nodeId: string;
  webhookMode: 'cloud-relay' | 'direct';
  webhookUrl?: string;
  defaultDefinitionId?: string;
  status: 'active' | 'inactive' | 'error';
}

export interface IMChannelBinding {
  channelId: string;
  imUserId: string;
  activeConversationId: string;
  createdAt: number;
  defaultDefinitionId?: string;
  /** When set, the user's next inbound message is treated as an askQuestion answer (plan §20.3). */
  pendingQuestionId?: string;
}

/** @deprecated Use IMChannelBinding */
export type ImChannelBindingRecord = IMChannelBinding;
