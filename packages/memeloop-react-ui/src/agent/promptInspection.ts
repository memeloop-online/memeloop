import type { PromptPreviewAuditEntrySource, PromptPreviewAuditEntrySummary, PromptPreviewController, PromptPreviewPreparedExecution } from 'memeloop';

export interface PromptExecutionInspectorLabels {
  tree: string;
  flat: string;
  request: string;
  back: string;
  earlier: string;
  later: string;
  loading: string;
  error: string;
  empty: string;
  editSource: string;
  source: (source: PromptPreviewAuditEntrySource) => string;
  role: (role: string) => string;
}

export const defaultPromptExecutionInspectorLabels: PromptExecutionInspectorLabels = {
  tree: 'Tree',
  flat: 'Messages',
  request: 'Model request',
  back: 'Back',
  earlier: 'Previous',
  later: 'Next',
  loading: 'Loading…',
  error: 'Could not load this content. Try again.',
  empty: 'No messages',
  editSource: 'Edit source',
  source: source =>
    ({
      prompt: 'Instructions',
      system: 'System',
      tool: 'Tools',
      'conversation-message': 'Conversation',
      'context-compaction-summary': 'Conversation summary',
      'preview-input': 'Current message',
    })[source],
  role: role => role,
};

export interface PromptExecutionInspectorProps {
  audit: PromptPreviewPreparedExecution;
  controller: Pick<PromptPreviewController, 'getAuditPage' | 'getAuditDetail'>;
  labels?: Partial<PromptExecutionInspectorLabels>;
  view?: 'tree' | 'flat';
  onViewChange?: (view: 'tree' | 'flat') => void;
  onFieldSelect?: (paths: string[]) => void;
}

export interface PromptInspectionNode {
  key: string;
  caption?: string;
  source?: PromptPreviewAuditEntrySource;
  entry?: PromptPreviewAuditEntrySummary;
  fieldPaths?: string[];
  children: PromptInspectionNode[];
}

/** Group only adjacent entries so traversing the tree preserves request order. */
export function buildPromptInspectionTree(entries: readonly PromptPreviewAuditEntrySummary[]): PromptInspectionNode[] {
  const roots: PromptInspectionNode[] = [];
  for (const entry of entries) {
    let root = roots.at(-1);
    if (!root || root.source !== entry.source) {
      root = { key: `source-${entry.entryIndex}`, source: entry.source, children: [] };
      roots.push(root);
    }
    let children = root.children;
    for (const [depth, part] of (entry.promptPath ?? []).entries()) {
      const key = `${depth}:${part.id}`;
      let branch = children.at(-1);
      if (!branch || branch.key !== key || branch.entry) {
        branch = { key, caption: part.caption ?? part.id, fieldPaths: part.fieldPaths, children: [] };
        children.push(branch);
      }
      children = branch.children;
    }
    children.push({ key: entry.entryId, entry, children: [] });
  }
  return roots;
}
