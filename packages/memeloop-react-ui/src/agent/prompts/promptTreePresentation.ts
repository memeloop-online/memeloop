import type { PromptNode } from 'memeloop';

const GENERATED_TOOL_GROUP_ID = 'memeloop-generated-tools';

function isGeneratedToolPrompt(prompt: PromptNode): boolean {
  return Array.isArray(prompt.source) && prompt.source[0] === 'plugins';
}

/**
 * Plugin hooks inject model-visible tool descriptions as prompt siblings so
 * flattening preserves exact wire order. Tree renderers can use this pure
 * projection to present those siblings as one navigable tool group without
 * mutating the runtime prompt tree.
 */
export function groupGeneratedToolPrompts(prompts: PromptNode[], caption: string): PromptNode[] {
  const generatedTools = prompts.filter(isGeneratedToolPrompt);
  if (generatedTools.length === 0) return prompts;

  const firstToolIndex = prompts.findIndex(isGeneratedToolPrompt);
  const withoutTools = prompts.filter(prompt => !isGeneratedToolPrompt(prompt));
  withoutTools.splice(Math.min(firstToolIndex, withoutTools.length), 0, {
    id: GENERATED_TOOL_GROUP_ID,
    caption,
    role: 'tool',
    enabled: true,
    source: ['plugins'],
    children: generatedTools,
  });
  return withoutTools;
}
