// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type AgentDefinition, type AgentLoopRuntime, createAgentAgentLoopDefinition } from 'memeloop';
import { describe, expect, it, vi } from 'vitest';
import { AgentLoopScriptEditor, type AgentLoopScriptEditorLabels } from './AgentLoopScriptEditor.js';

const labels: AgentLoopScriptEditorLabels = {
  title: 'Execution script',
  description: 'Run saved JavaScript locally.',
  family: 'Loop',
  toolLoop: 'Tools',
  agentLoop: 'Subagents',
  source: 'Source',
  metadata: 'Configuration',
  invalidMetadata: 'Enter a JSON object',
  save: 'Save script',
  saved: 'Saved',
};
const definition: AgentDefinition = {
  id: 'scripted',
  name: 'Scripted',
  description: 'Scripted',
  systemPrompt: '',
  tools: [],
  version: '1',
  loopId: 'agent-agent-loop',
  scriptReference: { kind: 'source', source: 'export default function run(ctx) { ctx.finish("first"); }' },
};

describe('AgentLoopScriptEditor', () => {
  it('keeps source local until saving and renders the result', async () => {
    const onSave = vi.fn(async () => {});
    const view = render(<AgentLoopScriptEditor definition={definition} labels={labels} onSave={onSave} />);
    const source = 'export default function run(ctx) { ctx.finish("edited"); }';
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: source } });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save script' }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        'agent-agent-loop',
        source,
        expect.objectContaining({
          workers: ['memeloop:general-assistant'],
          reviewers: ['memeloop:general-assistant'],
        }),
      );
    });
    expect(await screen.findByText('Saved')).toBeDefined();
    view.unmount();
  });

  it('keeps source after a save failure and supports retry', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error('Storage unavailable')).mockResolvedValueOnce(undefined);
    const view = render(<AgentLoopScriptEditor definition={definition} labels={labels} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save script' }));
    expect(await screen.findByText('Storage unavailable')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Save script' }));
    expect(await screen.findByText('Saved')).toBeDefined();
    expect(screen.queryByText('Storage unavailable')).toBeNull();
    view.unmount();
  });

  it('selects a runnable subagent composition with visible worker and reviewer configuration', async () => {
    const childRuns: string[] = [];
    const outputs: unknown[] = [];
    const onSave = vi.fn(async (loopId: string, source: string, metadata: Record<string, unknown>) => {
      const runner = createAgentAgentLoopDefinition().createRunner({
        profile: { ...definition, id: 'memeloop:general-assistant', loopId, scriptReference: { kind: 'source', source }, metadata },
        scriptPolicy: { allowSource: true },
        runtime: {
          async *runChildAgent(input: Parameters<AgentLoopRuntime['runChildAgent']>[0]) {
            childRuns.push(input.profileId);
            yield { type: 'message', data: input.conversationId.includes(':review:') ? 'APPROVED' : 'completed work' };
          },
          checkpoint: async () => undefined,
          loadCheckpoint: async () => undefined,
          signal: { cancelled: false },
        },
      });
      for await (const step of runner({ conversationId: 'editor-composition', message: 'Do the work' })) outputs.push(step);
    });
    const view = render(
      <AgentLoopScriptEditor
        definition={{ ...definition, id: 'memeloop:general-assistant', loopId: 'agent-tool-loop', scriptReference: undefined }}
        labels={labels}
        onSave={onSave}
      />,
    );
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Loop' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Subagents' }));
    const metadata = JSON.parse(screen.getByLabelText<HTMLTextAreaElement>('Configuration').value) as Record<string, unknown>;
    expect(metadata).toMatchObject({ workers: ['memeloop:code-assistant'], reviewers: ['memeloop:code-assistant'] });
    fireEvent.click(screen.getByRole('button', { name: 'Save script' }));
    await screen.findByText('Saved');
    expect(childRuns).toEqual(['memeloop:code-assistant', 'memeloop:code-assistant']);
    expect(outputs).toContainEqual({ type: 'message', data: 'completed work' });
    view.unmount();
  });

  it('validates the metadata object inline before applying source', async () => {
    const onSave = vi.fn(async () => {});
    const view = render(<AgentLoopScriptEditor definition={definition} labels={labels} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('Configuration'), { target: { value: '[]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save script' }));
    expect(await screen.findByText('Enter a JSON object')).toBeDefined();
    expect(onSave).not.toHaveBeenCalled();
    view.unmount();
  });
});
