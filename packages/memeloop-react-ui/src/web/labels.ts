/** Labels used by the shared prompt-editor widgets and templates. */
export interface PromptEditorLabels {
  tagsPlaceholder: string;
  tagsHelperText: string;
  noneOption: string;
  configurationSections: string;
  arrayItem: (title: string | undefined, index: number) => string;
  expandArrayItem: string;
  collapseArrayItem: string;
}

export const DEFAULT_PROMPT_EDITOR_LABELS: PromptEditorLabels = {
  tagsPlaceholder: 'Enter tags',
  tagsHelperText: 'Select or create tags',
  noneOption: 'None',
  configurationSections: 'Configuration sections',
  arrayItem: (title, index) => `${title ?? 'Item'} ${index + 1}`,
  expandArrayItem: 'Expand',
  collapseArrayItem: 'Collapse',
};

export function resolvePromptEditorLabels(labels?: Partial<PromptEditorLabels>): PromptEditorLabels {
  return { ...DEFAULT_PROMPT_EDITOR_LABELS, ...labels };
}
