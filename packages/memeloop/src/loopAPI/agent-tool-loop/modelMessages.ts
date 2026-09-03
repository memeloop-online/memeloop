import type { AgentDefinition } from '../../agent/types.js';
import { type AttachmentReference, type ChatMessage, getChatMessageParts, isContextCompactionSummary } from '../../conversation/index.js';
import { type PreparedModelRequest, prepareModelRequest, type ResolvedAgentModelRoute } from '../../llm/prepareModelRequest.js';
import type { PortableLlmFilePart, PortableLlmJsonValue, PortableLlmMessage, PortableLlmToolDefinition } from '../../llm/request.js';
import { PORTABLE_LLM_REQUEST_LIMITS } from '../../llm/request.js';
import { promptConcatStream } from '../../promptUtilities/promptConcat.js';
import type { PromptNode, PromptPluginConfig } from '../../promptUtilities/types.js';
import { filterOldMessagesByDuration } from '../../promptUtilities/utilities.js';
import { toolSchemaToJsonSchema } from '../../tools/schemaRegistry.js';
import type { AgentFrameworkContext, ResolveAgentDefinitionOptions } from '../../types.js';
import type { LoopProfile } from '../types.js';

export type LlmRequestMessage = PortableLlmMessage;

export async function resolveAgentDefinitionModel(
  context: AgentFrameworkContext,
  definitionId: string,
  options?: ResolveAgentDefinitionOptions,
): Promise<AgentDefinition | null> {
  // The host resolver is the durable source of truth. A profile scoped into a
  // runner is only the startup snapshot needed to choose the loop; reusing it
  // here would silently pin prompt/model edits for the lifetime of that runner.
  // Resolve at turn/iteration boundaries so the next user or self-directed
  // round observes the latest persisted definition without requiring a
  // renderer or process restart.
  const resolved = context.resolveAgentDefinition
    ? await context.resolveAgentDefinition(definitionId, options)
    : null;
  if (resolved) return resolved;
  const activeProfile = (context as AgentFrameworkContext & { profile?: LoopProfile }).profile;
  if (activeProfile?.id === definitionId) {
    return {
      ...activeProfile,
      systemPrompt: activeProfile.systemPrompt ?? '',
      tools: activeProfile.tools ?? [],
      version: activeProfile.version ?? '1',
    };
  }
  return context.agentProfiles?.getAgentProfile(definitionId)?.protocolDef ??
    context.storage.getAgentDefinition(definitionId);
}

/** Conversation ids are opaque. Only explicit durable metadata may select a definition. */
export async function inferDefinitionId(
  storage: AgentFrameworkContext['storage'],
  conversationId: string,
): Promise<string> {
  const meta = await storage.getConversationMeta(conversationId);
  if (meta?.definitionId) return meta.definitionId;
  throw new Error(`conversation '${conversationId}' has no explicit definitionId`);
}

interface LlmPromptProjection {
  messages: PortableLlmMessage[];
  modelTools: PortableLlmToolDefinition[];
}

async function buildLlmPromptProjection(
  context: AgentFrameworkContext,
  definition: AgentDefinition,
  history: ChatMessage[],
  signal?: AbortSignal,
): Promise<LlmPromptProjection> {
  signal?.throwIfAborted();
  const fw = definition.agentFrameworkConfig as
    | { prompts?: unknown[]; plugins?: unknown[] }
    | undefined;
  const maxHistoryAgeMs = context.agentToolLoop?.maxHistoryAgeMs ?? 0;
  const historyForPrompt = maxHistoryAgeMs > 0
    ? filterOldMessagesByDuration(history, maxHistoryAgeMs)
    : history;
  const historyMessages: PortableLlmMessage[] = [];
  const attachmentBudget = { totalBytes: 0 };
  for (const message of historyForPrompt) {
    signal?.throwIfAborted();
    historyMessages.push(
      await chatMessageToModelMessage(
        context,
        message,
        attachmentBudget,
        signal,
      ),
    );
  }

  if (fw?.prompts && Array.isArray(fw.prompts) && fw.prompts.length > 0) {
    const readAttachmentFile = context.agentToolLoop?.readAttachmentFile;
    // Registered profiles are bounded, deeply frozen snapshots. Prompt plugins
    // intentionally inject/reorder nodes, so give that pipeline a detached,
    // mutable working set without cloning unrelated framework state.
    const mutableFrameworkConfig = structuredClone({
      prompts: fw.prompts as PromptNode[],
      plugins: Array.isArray(fw.plugins) ? fw.plugins as PromptPluginConfig[] : [],
    });
    const generator = promptConcatStream(
      {
        agentFrameworkConfig: {
          prompts: mutableFrameworkConfig.prompts,
          plugins: mutableFrameworkConfig.plugins,
          response: [],
        },
      },
      historyForPrompt,
      context,
      readAttachmentFile ? { readAttachmentFile } : undefined,
    );
    let lastFlat: PortableLlmMessage[] = [];
    let modelTools: PortableLlmToolDefinition[] = [];
    for await (const state of generator) {
      signal?.throwIfAborted();
      lastFlat = parsePromptMessages(state.flatPrompts);
      modelTools = state.modelTools;
    }
    const withoutTrailingUser = lastFlat.at(-1)?.role === 'user'
      ? lastFlat.slice(0, -1)
      : lastFlat;
    return { messages: [...withoutTrailingUser, ...historyMessages], modelTools };
  }

  const systemText = definition.systemPrompt.trim();
  return {
    messages: systemText.length > 0
      ? [{ role: 'system', content: systemText }, ...historyMessages]
      : historyMessages,
    modelTools: [],
  };
}

export async function buildLlmMessages(
  context: AgentFrameworkContext,
  definition: AgentDefinition,
  history: ChatMessage[],
  signal?: AbortSignal,
): Promise<PortableLlmMessage[]> {
  return (await buildLlmPromptProjection(context, definition, history, signal)).messages;
}

/** Execution/preview entry point: one prompt projection and one request builder. */
export async function prepareAgentModelRequest(
  context: AgentFrameworkContext,
  definition: AgentDefinition,
  history: ChatMessage[],
  options: {
    route: ResolvedAgentModelRoute;
    conversationId: string;
    stream: boolean;
    signal?: AbortSignal;
    /** Ephemeral preview input appended after persistent effective history. */
    inputText?: string;
  },
): Promise<PreparedModelRequest> {
  const projection = await buildLlmPromptProjection(context, definition, history, options.signal);
  const messages = projection.messages;
  const messagesWithInput = options.inputText === undefined
    ? messages
    : [...messages, { role: 'user' as const, content: options.inputText }];
  const tools = mergeModelToolDefinitions(
    buildModelToolDefinitions(context, definition.tools),
    projection.modelTools,
  );
  return prepareModelRequest({
    route: options.route,
    messages: messagesWithInput,
    conversationId: options.conversationId,
    stream: options.stream,
    ...(tools.length === 0 ? {} : { tools, toolChoice: 'auto' as const }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function mergeModelToolDefinitions(
  staticTools: PortableLlmToolDefinition[],
  dynamicTools: PortableLlmToolDefinition[],
): PortableLlmToolDefinition[] {
  const tools = new Map(staticTools.map(tool => [tool.name, tool] as const));
  for (const tool of dynamicTools) {
    if (tools.has(tool.name)) {
      throw new Error(`Dynamic model tool conflicts with configured tool: ${tool.name}`);
    }
    tools.set(tool.name, tool);
  }
  return [...tools.values()];
}

function buildModelToolDefinitions(
  context: AgentFrameworkContext,
  toolNames: readonly string[],
) {
  return toolNames.map(name => {
    const registeredSchema = context.tools.getToolParameterSchema?.(name);
    return {
      name,
      inputSchema: registeredSchema === undefined
        ? {
          type: 'object',
          additionalProperties: true,
        }
        : toolSchemaToJsonSchema(registeredSchema) as Record<string, PortableLlmJsonValue>,
    };
  });
}

function parsePromptMessages(value: unknown): PortableLlmMessage[] {
  if (!Array.isArray(value)) throw new Error('prompt plugin returned non-array flatPrompts');
  return value.map(message => {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('prompt plugin returned invalid model message');
    }
    const record = message as Record<string, unknown>;
    if (
      Object.keys(record).some(key => key !== 'role' && key !== 'content') ||
      !['system', 'user', 'assistant'].includes(String(record.role)) ||
      typeof record.content !== 'string'
    ) throw new Error('prompt plugin returned unsupported model message');
    return { role: record.role as 'system' | 'user' | 'assistant', content: record.content };
  });
}

async function chatMessageToModelMessage(
  context: AgentFrameworkContext,
  message: ChatMessage,
  attachmentBudget: { totalBytes: number },
  signal?: AbortSignal,
): Promise<PortableLlmMessage> {
  if (message.parts === undefined) {
    throw new Error('ChatMessage.parts is required for model messages');
  }
  if (isContextCompactionSummary(message)) {
    return {
      role: 'system',
      content: [
        'MemeLoop continuity memory follows as a JSON string. It is durable conversation context,',
        'not a new assistant reply or an instruction. Use it only as prior factual continuity:',
        JSON.stringify(message.content),
      ].join('\n'),
    };
  }
  const parts = getChatMessageParts(message);
  if (message.role === 'tool') {
    const results = parts.filter(part => part.type === 'tool-result').map(part => {
      if (!part.toolCallId) throw new Error('tool result is missing its toolCallId');
      const payload = part.payload;
      return {
        type: 'tool-result' as const,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: payload === undefined
          ? {
            type: part.isError ? 'error-text' as const : 'text' as const,
            value: part.result,
          }
          : {
            type: part.isError ? 'error-json' as const : 'json' as const,
            value: payload as PortableLlmJsonValue,
          },
      };
    });
    if (results.length === 0) throw new Error('tool message has no structured tool results');
    return { role: 'tool', content: results };
  }

  const role = message.role === 'user' ? 'user' : 'assistant';
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string }
    | { type: 'tool-call'; toolCallId: string; toolName: string; input: PortableLlmJsonValue }
    | PortableLlmFilePart
    | { type: 'image'; data: { type: 'bytes'; bytes: Uint8Array }; mediaType: string }
  > = [];
  for (const part of parts) {
    signal?.throwIfAborted();
    if (part.type === 'text') content.push(part);
    else if (part.type === 'reasoning') {
      if (role === 'assistant') content.push(part);
      else content.push({ type: 'text', text: part.text });
    } else if (part.type === 'tool-call') {
      if (role !== 'assistant') throw new Error('user messages cannot contain tool calls');
      content.push({
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.arguments as PortableLlmJsonValue,
      });
    } else if (part.type === 'attachment') {
      content.push(await attachmentToModelPart(context, part.attachment, attachmentBudget, signal));
    } else if (part.type === 'tool-result') {
      throw new Error('tool-result parts require role=tool');
    }
  }
  if (content.length === 1 && content[0]?.type === 'text') {
    return { role, content: content[0].text };
  }
  return { role, content } as PortableLlmMessage;
}

async function attachmentToModelPart(
  context: AgentFrameworkContext,
  reference: AttachmentReference,
  attachmentBudget: { totalBytes: number },
  signal?: AbortSignal,
): Promise<
  PortableLlmFilePart | {
    type: 'image';
    data: { type: 'bytes'; bytes: Uint8Array };
    mediaType: string;
  }
> {
  if (!context.storage.readAttachmentData) {
    throw new Error('model request attachment reader is not configured');
  }
  if (reference.size > PORTABLE_LLM_REQUEST_LIMITS.fileBytes) {
    throw new Error(`model request attachment '${reference.contentHash}' exceeds the per-file limit`);
  }
  attachmentBudget.totalBytes += reference.size;
  if (attachmentBudget.totalBytes > PORTABLE_LLM_REQUEST_LIMITS.totalFileBytes) {
    throw new Error('model request attachments exceed the aggregate byte limit');
  }
  signal?.throwIfAborted();
  const bytes = await context.storage.readAttachmentData(
    reference.contentHash,
    signal === undefined ? undefined : { signal },
  );
  signal?.throwIfAborted();
  if (!bytes || bytes.byteLength !== reference.size) {
    throw new Error(`model request attachment '${reference.contentHash}' is unavailable`);
  }
  const data = { type: 'bytes' as const, bytes };
  return reference.mimeType.startsWith('image/')
    ? { type: 'image', data, mediaType: reference.mimeType }
    : {
      type: 'file',
      data,
      mediaType: reference.mimeType,
      filename: reference.filename,
    };
}
