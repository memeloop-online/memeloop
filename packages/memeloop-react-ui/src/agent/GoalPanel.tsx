import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
import React from 'react';
import { defaultGoalPanelLabels, type GoalPanelProps } from './goals.js';
import { useGoalPanel } from './useGoalPanel.js';

export function GoalPanel({ labels = defaultGoalPanelLabels, ...props }: GoalPanelProps): React.ReactElement {
  const state = useGoalPanel(props);
  const { goal, busy } = state;
  return (
    <Stack spacing={2} sx={{ minWidth: 0 }} aria-label={labels.title}>
      <Typography color='text.secondary' variant='body2'>{labels.description}</Typography>
      {state.loading && (
        <Box role='status' aria-label={labels.loading}>
          <CircularProgress size={24} />
        </Box>
      )}
      {state.failed && <Alert severity='error' action={<Button disabled={busy} onClick={state.retry}>{labels.retry}</Button>}>{labels.failed}</Alert>}
      {goal && (
        <>
          <Stack direction='row' spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }} useFlexGap>
            <Chip size='small' label={labels.status[goal.status]} color={goal.status === 'active' ? 'primary' : 'default'} />
            <Typography variant='caption' color='text.secondary'>{labels.round(goal.round)}</Typography>
          </Stack>
          <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{goal.objective}</Typography>
          {goal.blockedReason && <Alert severity='info'>{goal.blockedReason}</Alert>}
          {goal.lastRunError && <Alert severity='warning'>{labels.runIssue}</Alert>}
          {goal.evidence && <Typography variant='body2' sx={{ whiteSpace: 'pre-wrap' }}>{goal.evidence}</Typography>}
        </>
      )}
      {!state.loading && !state.failed && (!goal || goal.status === 'completed') && (
        <>
          <TextField
            label={labels.objective}
            multiline
            minRows={3}
            fullWidth
            value={state.objective}
            disabled={busy}
            onChange={event => {
              state.setObjective(event.target.value);
            }}
          />
          <Box>
            <Button variant='contained' disabled={busy || !state.objective.trim()} onClick={() => void state.start()}>{labels.start}</Button>
          </Box>
        </>
      )}
      {goal && goal.status !== 'completed' && (
        <Stack direction='row' spacing={1} sx={{ flexWrap: 'wrap' }} useFlexGap>
          <Button variant='contained' disabled={busy} onClick={() => void (goal.status === 'active' ? state.pause() : state.resume())}>
            {goal.status === 'active' ? labels.pause : labels.resume}
          </Button>
          {!state.completing && (
            <Button
              disabled={busy}
              onClick={() => {
                state.setCompleting(true);
              }}
            >
              {labels.complete}
            </Button>
          )}
        </Stack>
      )}
      {state.completing && goal && goal.status !== 'completed' && (
        <>
          <TextField
            label={labels.evidence}
            multiline
            minRows={2}
            fullWidth
            value={state.evidence}
            disabled={busy}
            onChange={event => {
              state.setEvidence(event.target.value);
            }}
          />
          <Stack direction='row' spacing={1}>
            <Button variant='contained' disabled={busy || !state.evidence.trim()} onClick={() => void state.complete()}>{labels.confirmComplete}</Button>
            <Button
              disabled={busy}
              onClick={() => {
                state.setCompleting(false);
              }}
            >
              {labels.cancel}
            </Button>
          </Stack>
        </>
      )}
    </Stack>
  );
}

export function GoalDialog({ onClose, labels = defaultGoalPanelLabels, ...props }: GoalPanelProps & { onClose: () => void }): React.ReactElement {
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth='sm' aria-labelledby='goal-dialog-title'>
      <DialogTitle id='goal-dialog-title'>{labels.title}</DialogTitle>
      <DialogContent>
        <GoalPanel {...props} labels={labels} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{labels.back}</Button>
      </DialogActions>
    </Dialog>
  );
}
