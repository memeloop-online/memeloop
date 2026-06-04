export interface NodeIdentity {
  nodeId: string;
  userId: string;
  name: string;
  type: "desktop" | "node" | "mobile";
}

/** 节点暴露的 Wiki / 知识库条目（与计划「能力发现」对齐）。 */
export interface WikiInfo {
  wikiId: string;
  title?: string;
  /** 可选：相对节点配置的根路径说明，不含敏感绝对路径 */
  pathHint?: string;
}

export interface NodeCapabilities {
  tools: string[];
  mcpServers: string[];
  hasWiki: boolean;
  imChannels: string[];
  /** 已挂载的 Wiki 列表（无 Wiki 能力时可为空数组） */
  wikis: WikiInfo[];
}

export interface NodeConnectivity {
  publicIP?: string;
  frpAddress?: string;
  lanAddress?: string;
}

export interface NodeStatus {
  identity: NodeIdentity;
  capabilities: NodeCapabilities;
  connectivity: NodeConnectivity;
  status: "online" | "offline" | "unknown";
  lastSeen: number;
}
