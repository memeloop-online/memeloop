import { Alert, Box, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import {
  type AgentDefinition,
  BUILTIN_AGENT_AGENT_LOOP_QUALITY_GATE_SCRIPT_ID,
  BUILTIN_AGENT_TOOL_LOOP_DEFAULT_SCRIPT_ID,
  getBuiltinAgentAgentLoopSource,
  getBuiltinAgentToolLoopSource,
  getBuiltinLoopProfiles,
} from 'memeloop';
import { useState } from 'react';

export interface AgentLoopScriptEditorLabels {
  title: string;
  description: string;
  family: string;
  toolLoop: string;
  agentLoop: string;
  source: string;
  metadata: string;
  invalidMetadata: string;
  save: string;
  saved: string;
}

function defaultSource(loopId: string): string {
  return loopId === 'agent-agent-loop'
    ? getBuiltinAgentAgentLoopSource(BUILTIN_AGENT_AGENT_LOOP_QUALITY_GATE_SCRIPT_ID) ?? ''
    : getBuiltinAgentToolLoopSource(BUILTIN_AGENT_TOOL_LOOP_DEFAULT_SCRIPT_ID) ?? '';
}

function definitionSource(definition: AgentDefinition, loopId: string): string {
  const reference = definition.scriptReference;
  if (reference?.kind === 'source') return reference.source;
  if (reference?.kind === 'builtin') {
    return getBuiltinAgentAgentLoopSource(reference.id) ?? getBuiltinAgentToolLoopSource(reference.id) ?? '';
  }
  return defaultSource(loopId);
}

function initialMetadata(definition: AgentDefinition, loopId: string): Record<string, unknown> {
  if (loopId !== 'agent-agent-loop') return definition.metadata ?? {};
  const worker = getBuiltinLoopProfiles().find(profile => profile.id !== definition.id && profile.loopId === 'agent-tool-loop')!;
  return { workers: [worker.id], reviewers: [worker.id], maxIterations: 4, ...definition.metadata };
}

export function AgentLoopScriptEditor({ definition, onSave, labels }: {
  definition: AgentDefinition;
  onSave: (loopId: string, source: string, metadata: Record<string, unknown>) => Promise<void>;
  labels: AgentLoopScriptEditorLabels;
}) {
  const [loopId, setLoopId] = useState(definition.loopId ?? 'agent-tool-loop');
  const [source, setSource] = useState(() => definitionSource(definition, loopId));
  const [metadata, setMetadata] = useState(() => JSON.stringify(initialMetadata(definition, loopId), null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  return (
    <Stack spacing={2} data-testid='agent-loop-script-editor'>
      <Typography variant='h6'>{labels.title}</Typography>
      <Typography variant='body2' color='text.secondary'>{labels.description}</Typography>
      <TextField
        select
        label={labels.family}
        value={loopId}
        disabled={busy}
        onChange={(event) => {
          setLoopId(event.target.value);
          setSource(defaultSource(event.target.value));
          setMetadata(JSON.stringify(initialMetadata(definition, event.target.value), null, 2));
          setSaved(false);
        }}
      >
        <MenuItem value='agent-tool-loop'>{labels.toolLoop}</MenuItem>
        <MenuItem value='agent-agent-loop'>{labels.agentLoop}</MenuItem>
      </TextField>
      <TextField
        label={labels.source}
        multiline
        minRows={8}
        maxRows={20}
        value={source}
        disabled={busy}
        onChange={(event) => {
          setSource(event.target.value);
          setSaved(false);
        }}
        slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: '0.85rem' } } }}
      />
      <TextField
        label={labels.metadata}
        multiline
        minRows={3}
        maxRows={10}
        value={metadata}
        disabled={busy}
        onChange={(event) => {
          setMetadata(event.target.value);
          setSaved(false);
        }}
        slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: '0.85rem' } } }}
      />
      {error && <Alert severity='error'>{error}</Alert>}
      {saved && <Alert severity='success'>{labels.saved}</Alert>}
      <Box>
        <Button
          variant='contained'
          disabled={busy || !source.trim()}
          onClick={() => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(metadata);
            } catch {
              setError(labels.invalidMetadata);
              return;
            }
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              setError(labels.invalidMetadata);
              return;
            }
            setBusy(true);
            setError('');
            setSaved(false);
            void onSave(loopId, source, parsed as Record<string, unknown>).then(() => {
              setSaved(true);
            }).catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : String(cause));
            }).finally(() => {
              setBusy(false);
            });
          }}
        >
          {labels.save}
        </Button>
      </Box>
    </Stack>
  );
}
