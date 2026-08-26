import ComputerIcon from '@mui/icons-material/Computer';
import HubIcon from '@mui/icons-material/Hub';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import React from 'react';

import { normalizeMemeLoopChatError } from '../chat/coreTypes.js';
import type { AgentExecutionTarget, MemeLoopChatOperation, SetExecutionTargetOptions } from '../chat/types.js';

export interface ExecutionTargetSelectorProps {
  targets: readonly AgentExecutionTarget[];
  activeTargetId?: string;
  isRunning: boolean;
  disabled?: boolean;
  onChange: (targetId: string, options?: SetExecutionTargetOptions) => Promise<void> | void;
  onError?: (error: Error, operation: MemeLoopChatOperation) => void;
  labels?: Partial<ExecutionTargetSelectorLabels>;
}

export interface ExecutionTargetSelectorLabels {
  runOn: string;
  executionTarget: string;
  runOnTarget: (targetLabel: string) => string;
  confirmTitle: string;
  confirmDescription: (targetLabel: string) => string;
  anotherTarget: string;
  keepRunning: string;
  stopAndRestart: string;
  operationFailed: string;
}

const defaultLabels: ExecutionTargetSelectorLabels = {
  runOn: 'Run on',
  executionTarget: 'Execution target',
  runOnTarget: target => `Run on ${target}`,
  confirmTitle: 'Switch execution target?',
  confirmDescription: target => `The current turn is still running. Switching to ${target} will stop it and restart the latest user turn there.`,
  anotherTarget: 'another target',
  keepRunning: 'Keep running',
  stopAndRestart: 'Stop and restart',
  operationFailed: 'The execution target could not be changed.',
};

function TargetIcon({ kind }: { kind?: AgentExecutionTarget['kind'] }) {
  return kind === 'remote' ? <HubIcon fontSize='small' /> : <ComputerIcon fontSize='small' />;
}

export function ExecutionTargetSelector({
  targets,
  activeTargetId,
  isRunning,
  disabled,
  onChange,
  onError,
  labels: labelOverrides,
}: ExecutionTargetSelectorProps) {
  const labels = { ...defaultLabels, ...labelOverrides };
  const [pendingTargetId, setPendingTargetId] = React.useState<string | null>(null);
  const [switching, setSwitching] = React.useState(false);
  const [error, setError] = React.useState<Error>();
  const active = activeTargetId ?? targets[0]?.id;
  const pendingTarget = targets.find(target => target.id === pendingTargetId);

  if (targets.length <= 1) return null;

  const requestChange = (targetId: string) => {
    if (!targetId || targetId === active) return;
    if (isRunning) {
      setPendingTargetId(targetId);
      return;
    }
    setSwitching(true);
    setError(undefined);
    void (async () => {
      try {
        await onChange(targetId);
      } catch (error_) {
        const normalized = normalizeMemeLoopChatError(error_);
        setError(normalized);
        try {
          onError?.(normalized, 'set-execution-target');
        } catch {
          // Error observers must not reject a UI callback.
        }
      } finally {
        setSwitching(false);
      }
    })();
  };

  const confirmRestart = async () => {
    if (!pendingTargetId) return;
    setSwitching(true);
    try {
      await onChange(pendingTargetId, { restartCurrentTurn: true });
      setPendingTargetId(null);
      setError(undefined);
    } catch (error_) {
      const normalized = normalizeMemeLoopChatError(error_);
      setError(normalized);
      try {
        onError?.(normalized, 'set-execution-target');
      } catch {
        // Error observers must not reject a UI callback.
      }
    } finally {
      setSwitching(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1, borderBottom: 1, borderColor: 'divider' }}>
      <Typography variant='caption' color='text.secondary'>{labels.runOn}</Typography>
      {error && <Alert severity='error'>{labels.operationFailed}</Alert>}
      <ToggleButtonGroup
        exclusive
        size='small'
        value={active}
        onChange={(_event, value) => {
          if (typeof value === 'string') requestChange(value);
        }}
        aria-label={labels.executionTarget}
      >
        {targets.map(target => (
          <ToggleButton
            key={target.id}
            value={target.id}
            disabled={disabled || target.disabled}
            aria-label={labels.runOnTarget(target.label)}
          >
            <Tooltip title={target.description ?? target.label}>
              <Box component='span' sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                <TargetIcon kind={target.kind} />
                {target.label}
              </Box>
            </Tooltip>
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      <Dialog
        open={pendingTargetId !== null}
        onClose={() => {
          setPendingTargetId(null);
        }}
      >
        <DialogTitle>{labels.confirmTitle}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {labels.confirmDescription(pendingTarget?.label ?? labels.anotherTarget)}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setPendingTargetId(null);
            }}
            disabled={switching}
          >
            {labels.keepRunning}
          </Button>
          <Button
            onClick={() => {
              void confirmRestart();
            }}
            disabled={switching}
            variant='contained'
          >
            {labels.stopAndRestart}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
