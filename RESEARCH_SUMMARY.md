# MemeLoop 功能升级调研总览

## 调研时间: 2026-05-25
## 目标: 将参考项目的核心功能集成到 memeloop + memeloop-cloud 中

---

## 一、参考项目核心功能矩阵

### 1. Claude Code (Anthropic)
| 功能类别 | 具体能力 | 优先级 |
|---------|---------|--------|
| 工具系统 | ~40个工具: Bash, FileRead/Write/Edit, Glob, Grep, WebFetch, WebSearch, AgentTool, MCPTool, LSPTool, NotebookEdit, TodoWrite, AskUserQuestion | 高 |
| 查询引擎 | QueryEngine.ts 管理对话生命周期, query.ts while(true) 主循环 | 高 |
| 上下文管理 | auto-compact, microcompact, snip, reactive compact, context collapse, 多策略压缩 | 高 |
| 多代理 | AgentTool 同步/后台/队友/远程子代理, tmux集成, worktree隔离 | 高 |
| IDE集成 | 自动检测VSCode/JetBrains, MCP连接, bridge系统 | 中 |
| 权限系统 | 交互式权限检查, alwaysAllow/alwaysDeny/alwaysAsk, plan模式 | 高 |
| 技能系统 | SkillTool执行, bundled/custom skills, CLAUDE_CODE_SKILLS_DIR | 中 |
| 插件架构 | bundled/第三方插件, 插件命令/技能/MCP | 中 |

### 2. GitHub Copilot CLI
| 功能类别 | 具体能力 | 优先级 |
|---------|---------|--------|
| 三种模式 | Standard/Plan/Autopilot, Shift+Tab切换 | 高 |
| 子代理 | explore/task/research/code review/rubber duck | 中 |
| ACP服务器 | --acp --stdio/--port, IDE集成 | 中 |
| 插件市场 | marketplace add/install/uninstall/update | 低 |
| 钩子系统 | preToolUse/postToolUse/userPromptSubmitted/subagentStart/agentStop | 中 |
| Copilot Memory | 持久跨会话知识, user/repository作用域 | 中 |
| 自定义代理 | .github/agents/, ~/.copilot/agents/ | 低 |
| 远程控制 | --remote, 跨设备会话控制 | 低 |

### 3. OpenCode
| 功能类别 | 具体能力 | 优先级 |
|---------|---------|--------|
| 多代理类型 | build/plan/general/explore/scout/compaction/title/summary | 高 |
| 任务工具 | task tool 同步+后台子代理, task_status轮询 | 高 |
| LLM提供商 | 30+提供商 (OpenAI, Anthropic, Google, Azure, OpenRouter等) | 中 |
| Effect框架 | 函数式编程, Context.Tag+Layer依赖注入 | 低 |
| 上下文压缩 | 溢出检测, Token估算, LLM驱动摘要, 自动继续 | 高 |
| LSP工具 | goToDefinition/findReferences/hover/documentSymbol/workspaceSymbol等 | 中 |
| 权限系统 | 分层合并: 默认→代理→用户→会话, allow/deny/ask | 高 |
| 快照系统 | 文件系统快照, diff计算, 撤销能力 | 中 |

### 4. Oh My OpenCode
| 功能类别 | 具体能力 | 优先级 |
|---------|---------|--------|
| 10个专门代理 | Sisyphus(主控)/Oracle/Explore/Librarian/Multimodal/Momus/Metis/Prometheus/Atlas/Sisyphus-Junior | 高 |
| 三层架构 | Planning(Prometheus+Metis+Momus) → Execution(Atlas) → Workers(各专门代理) | 高 |
| Category+Skill | 语义分类委派: visual-engineering/ultrabrain/artistry/quick/writing等 | 高 |
| AST-grep | ast_grep_search/ast_grep_replace, 25种语言 | 中 |
| 会话连续性 | session_id延续, 70%+token节省 | 中 |
| 钩子系统 | PreToolUse/PostToolUse/UserPromptSubmit/Stop等25+钩子 | 中 |
| 规划流程 | Prometheus面试模式 → Metis缺口分析 → Momus计划审查 → 执行 | 高 |
| 反AI Slop | comment-checker, 减少过度注释 | 低 |

### 5. MemeLoop 当前状态
| 功能类别 | 已有能力 | 缺失 |
|---------|---------|------|
| 核心代理 | TaskAgent (ReAct loop, 256次迭代) | 多代理协作, 专门化代理 |
| 工具系统 | file, terminal, wiki, screenshot, demo, remoteAgent, mcpClient | LSP, AST-grep, WebSearch, WebFetch, TodoWrite, AskUserQuestion |
| 网络 | LAN(mDNS)+Cloud(WS), Noise_XX加密 | ACP服务器, IDE桥接 |
| 存储 | SQLite, 消息历史 | 会话恢复, 检查点, 上下文压缩 |
| LLM | Vercel AI SDK (OpenAI, Anthropic) | 30+提供商支持 |
| 权限 | allow/ask/deny, 通配符 | 分层权限, 持久化权限 |
| IM | Telegram/Discord/Lark/WeCom webhooks | - |
| 知识库 | TiddlyWiki集成 | Skills系统, Copilot Memory |

---

## 二、memeloop-cloud 关键关联

memeloop-cloud 是 Fastify SaaS 后端，提供：
- **用户认证**: 邮箱/密码 + Argon2 + JWT
- **节点认证**: OTP + Ed25519 challenge
- **节点注册表**: 心跳、能力上报、在线状态
- **LLM代理**: One-API 反向代理，按用户token计费
- **计费订阅**: 令牌配额 soft/hard 限制
- **支付**: 支付宝/PayPal/Steam/银联
- **管理面板**: React + Ant Design
- **FRP隧道**: frps 远程端口分配
- **IM中继**: 路由IM事件到节点

**与 memeloop 关系**:
- pnpm-workspace.yaml 直接包含 `../memeloop/packages/*`
- memeloop-node 客户端连接 cloud 进行注册/心跳/LLM代理
- Dockerfile 同时复制两个仓库
- 更大的生态: TidGi-Desktop/Mobile, tw-mobile-sync

### memeloop-cloud 已知问题
1. CI workflow 正确引用 memeloop-cli (但 pnpm-workspace.yaml 仍引用旧 memeloop-node)
2. 需要增强节点注册表以支持代理能力上报
3. 需要远程代理状态轮询API
4. 管理面板需要新增代理管理、技能管理页面

---

## 三、功能集成路线图 (初稿)

### Phase 1: 基础架构增强
1. 改进工具系统 - 新增 LSP, AST-grep, WebSearch, WebFetch, TodoWrite, AskUserQuestion
2. 上下文管理 - 实现 auto-compact, 会话恢复, 检查点
3. 权限系统升级 - 分层合并权限, 持久化

### Phase 2: 多智能体核心
4. 代理注册表 - 支持多种专门化代理类型
5. 子代理委派 - task tool (同步+后台)
6. 三层工作流 - Planning → Execution → Workers

### Phase 3: 高级功能
7. Category+Skill 委派系统
8. ACP服务器模式 (IDE集成)
9. 钩子系统
10. 插件市场

### Phase 4: Cloud集成
11. memeloop-cloud 后端增强
12. 远程代理增强
13. 跨节点智能体协作

---

## 四、已知问题
- CI workflow 引用旧包名 memeloop-node (应改为 memeloop-cli)
- 远程代理: 无附件传输, 30s硬编码超时, 无任务状态轮询
- 无运行时工具审批UI
