/**
 * Convert TiddlyWiki tiddler fields into memeloop AgentDefinition.
 *
 * Tiddlers tagged `$:/tags/AI/Template` carry agent configuration in their text field (JSON).
 * This pure function handles the parsing and field mapping.
 */
import { type AgentDefinition, type AgentModelConfig, assertAgentModelConfig } from '../agent/types.js';
import type { AgentFrameworkConfig, PromptNode, PromptPluginConfig } from '../promptUtilities/types.js';

/** Minimal tiddler fields shape consumed by the converter. */
export interface TiddlerFieldsForAgent {
  title: string;
  text?: string;
  caption?: string;
  description?: string;
  avatar_url?: string;
  handler_id?: string;
  agentFrameworkID?: string;
  ai_api_config?: string | Record<string, unknown>;
  agent_tools?: string | unknown[];
}

/**
 * Validate and convert a wiki tiddler to an AgentDefinition.
 * Returns null if the tiddler cannot be parsed.
 */
export function tiddlerToAgentDefinition(
  tiddler: TiddlerFieldsForAgent,
  workspaceName?: string,
): AgentDefinition | null {
  if (!tiddler || !tiddler.title || typeof tiddler.text !== 'string') return null;

  let agentFrameworkConfig: Record<string, unknown>;
  try {
    const parsed = JSON.parse(tiddler.text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    agentFrameworkConfig = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const getString = (field: unknown, fallback = ''): string =>
    typeof field === 'string'
      ? field
      : field && typeof field === 'object'
      ? JSON.stringify(field)
      : fallback;

  const parseJSON = (field: unknown): Record<string, unknown> | unknown[] | undefined => {
    if (typeof field === 'string') {
      try {
        const parsed = JSON.parse(field) as unknown;
        if (typeof parsed === 'object' && parsed !== null) {
          return parsed as Record<string, unknown> | unknown[];
        }
      } catch {
        /* ignore */
      }
    }
    return undefined;
  };

  const id = `wiki-template-${getString(tiddler.title).replace(/[^a-zA-Z0-9-_]/g, '-')}`;
  const name = getString(tiddler.caption) || getString(tiddler.title);
  const description = getString(tiddler.description) || `Agent template from ${workspaceName || 'wiki'}`;

  const modelConfigRaw = parseJSON(tiddler.ai_api_config);
  const rawAsRecord = modelConfigRaw && typeof modelConfigRaw === 'object' && !Array.isArray(modelConfigRaw)
    ? modelConfigRaw
    : undefined;
  let modelConfig: AgentModelConfig | undefined;
  if (rawAsRecord) {
    if (Object.hasOwn(rawAsRecord, 'provider') || Object.hasOwn(rawAsRecord, 'model')) {
      throw new Error('ai_api_config uses removed provider/model fields; use providerId/modelId');
    }
    const candidate = {
      providerId: typeof rawAsRecord.providerId === 'string' ? rawAsRecord.providerId : '',
      modelId: typeof rawAsRecord.modelId === 'string' ? rawAsRecord.modelId : '',
      ...(rawAsRecord.parameters === undefined ? {} : { parameters: rawAsRecord.parameters }),
    };
    assertAgentModelConfig(candidate);
    modelConfig = candidate;
  }

  const toolsRaw = parseJSON(tiddler.agent_tools);
  const toolNames = Array.isArray(toolsRaw)
    ? (toolsRaw as Array<Record<string, unknown>>)
      .filter((t) => typeof t?.toolId === 'string')
      .map((t) => String(t.toolId))
    : [];

  return {
    id,
    name,
    description,
    systemPrompt: '',
    tools: toolNames,
    modelConfig,
    // Keep the original config as promptSchema for the UI editor
    promptSchema: agentFrameworkConfig,
    agentFrameworkConfig: {
      prompts: Array.isArray(agentFrameworkConfig.prompts)
        ? (agentFrameworkConfig.prompts as PromptNode[])
        : [],
      plugins: Array.isArray(agentFrameworkConfig.plugins)
        ? (agentFrameworkConfig.plugins as PromptPluginConfig[])
        : [],
      response: Array.isArray(agentFrameworkConfig.response)
        ? agentFrameworkConfig.response
        : undefined,
    } as AgentFrameworkConfig,
    version: '1',
  };
}
