import { Box, Button, CircularProgress, Paper, Tab, Tabs, Typography } from '@mui/material';
import React, { useRef, useState } from 'react';
import {
  buildPromptInspectionFlat,
  buildPromptInspectionTree,
  defaultPromptExecutionInspectorLabels,
  type PromptExecutionInspectorProps,
  type PromptInspectionNode,
} from '../promptInspection.js';
import { usePromptExecutionInspection } from '../usePromptExecutionInspection.js';

export function PromptExecutionInspector(props: PromptExecutionInspectorProps) {
  const { audit, onFieldSelect } = props;
  const labels = { ...defaultPromptExecutionInspectorLabels, ...props.labels };
  const [localView, setLocalView] = useState<'tree' | 'flat'>('tree');
  const view = props.view ?? localView;
  const state = usePromptExecutionInspection(props);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const back = () => {
    state.closeDetail();
    requestAnimationFrame(() => returnFocus.current?.focus());
  };
  const entries = state.page.items;
  const renderEntry = (node: PromptInspectionNode): React.ReactNode => {
    if (node.gap) {
      return <Typography key={node.key} data-testid='prompt-preview-gap' align='center' variant='caption' component='div'>… {node.gap.first}–{node.gap.last} …</Typography>;
    }
    const entry = node.entry;
    if (entry) {
      return (
        <Paper key={node.key} variant='outlined' sx={{ p: 1, my: 1 }} data-prompt-entry-id={entry.entryId}>
          <Typography variant='caption'>{labels.role(entry.role)} · {labels.source(entry.source)}</Typography>
          <Button
            fullWidth
            data-testid='prompt-preview-entry'
            sx={{ justifyContent: 'flex-start', textAlign: 'left', textTransform: 'none', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
            onClick={event => {
              returnFocus.current = event.currentTarget;
              void state.loadDetail({ kind: 'entry', entryId: entry.entryId, entryIndex: entry.entryIndex });
            }}
          >
            {entry.preview || labels.empty}
          </Button>
        </Paper>
      );
    }
    return (
      <Box component='details' key={node.key} open sx={{ pl: 1.5, borderLeft: 1, borderColor: 'divider', mb: 1 }}>
        <Box component='summary' sx={{ cursor: 'pointer', py: 0.5 }}>
          {node.source ? labels.source(node.source) : node.caption}
          {node.fieldPaths?.length && onFieldSelect
            ? (
              <Button
                size='small'
                onClick={event => {
                  event.preventDefault();
                  onFieldSelect(node.fieldPaths!);
                }}
              >
                {labels.editSource}
              </Button>
            )
            : null}
        </Box>
        {node.children.map(renderEntry)}
      </Box>
    );
  };
  return (
    <Box
      data-testid='prompt-execution-inspector'
      onKeyDown={event => {
        if (event.key === 'Escape' && state.detail) {
          event.preventDefault();
          event.stopPropagation();
          back();
        }
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mb: 1 }}>
        <Typography variant='body2'>{audit.route.providerId} · {audit.route.logicalModelId}</Typography>
        <Button
          data-testid='prompt-preview-model-request-detail'
          onClick={event => {
            returnFocus.current = event.currentTarget;
            void state.loadDetail({ kind: 'request' });
          }}
        >
          {labels.request}
        </Button>
      </Box>
      <Tabs
        value={view}
        onChange={(_, next: 'tree' | 'flat') => {
          state.closeDetail();
          setLocalView(next);
          props.onViewChange?.(next);
        }}
      >
        <Tab value='tree' label={labels.tree} />
        <Tab value='flat' label={labels.flat} />
      </Tabs>
      {state.detail && (
        <Box data-testid='prompt-preview-audit-detail'>
          <Box sx={{ position: 'sticky', top: 0, bgcolor: 'background.paper', py: 1, zIndex: 1 }}>
            <Button autoFocus data-testid='prompt-preview-detail-back' onClick={back}>{labels.back}</Button>
            {state.loading && <CircularProgress size={16} aria-label={labels.loading} />}
          </Box>
          <Typography component='pre' sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{state.detail.text}</Typography>
          {state.detail.nextCursor && (
            <Button
              data-testid='prompt-preview-audit-detail-next'
              disabled={state.loading}
              onClick={() => void state.loadDetail(state.detail!.target, state.detail!.nextCursor)}
            >
              {labels.later}
            </Button>
          )}
        </Box>
      )}
      <Box data-testid={`prompt-preview-${view}`} hidden={!!state.detail}>
        {view === 'tree'
          ? buildPromptInspectionTree(entries).map(renderEntry)
          : buildPromptInspectionFlat(entries).map(renderEntry)}
        {entries.length === 0 && <Typography>{labels.empty}</Typography>}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button disabled={!state.page.hasMoreBefore || state.loading} onClick={() => void state.loadPage('before')}>{labels.earlier}</Button>
          <Typography variant='caption'>
            {state.page.sampled ? entries.length : entries.length ? `${entries[0].entryIndex + 1}–${entries.at(-1)!.entryIndex + 1}` : '0'} / {state.page.totalEntries}
          </Typography>
          <Button disabled={!state.page.hasMoreAfter || state.loading} onClick={() => void state.loadPage('after')}>{labels.later}</Button>
        </Box>
      </Box>
      {state.error && <Typography role='alert' color='error'>{labels.error}</Typography>}
    </Box>
  );
}
