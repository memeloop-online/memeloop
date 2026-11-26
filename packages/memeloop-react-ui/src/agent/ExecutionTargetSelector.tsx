import ComputerIcon from '@mui/icons-material/Computer';
import HubIcon from '@mui/icons-material/Hub';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import type { RemoteAgentExecutionTarget } from 'memeloop';
import React from 'react';

import { normalizeMemeLoopChatError } from '../chat/coreTypes.js';
import { notifyMemeLoopObserver } from '../chat/observerErrors.js';
import type { MemeLoopObserverErrorHandler } from '../chat/observerErrors.js';
import type { AgentExecutionTarget, MemeLoopChatOperation, SetExecutionTargetOptions } from '../chat/types.js';

export interface ExecutionTargetSelectorProps {
  targets: readonly AgentExecutionTarget[];
  activeTarget?: RemoteAgentExecutionTarget;
  isRunning: boolean;
  disabled?: boolean;
  onChange: (target: RemoteAgentExecutionTarget, options?: SetExecutionTargetOptions) => Promise<void> | void;
  onError?: (error: Error, operation: MemeLoopChatOperation) => void;
  onObserverError?: MemeLoopObserverErrorHandler;
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

function TargetIcon({ kind }: { kind: RemoteAgentExecutionTarget['kind'] }) {
  return kind === 'remote' ? <HubIcon fontSize='small' /> : <ComputerIcon fontSize='small' />;
}

export function ExecutionTargetSelector({
  targets,
  activeTarget,
  isRunning,
  disabled,
  onChange,
  onError,
  onObserverError,
  labels: labelOverrides,
}: ExecutionTargetSelectorProps) {
  const labels = { ...defaultLabels, ...labelOverrides };
  const [pendingTarget, setPendingTarget] = React.useState<AgentExecutionTarget | null>(null);
  const [switching, setSwitching] = React.useState(false);
  const [error, setError] = React.useState<Error>();
  const active = targets.find(target => targetsEqual(target.value, activeTarget)) ?? targets[0] ?? null;

  if (targets.length <= 1) return null;

  const requestChange = (target: AgentExecutionTarget) => {
    if (target === active) return;
    if (isRunning) {
      setPendingTarget(target);
      return;
    }
    setSwitching(true);
    setError(undefined);
    void (async () => {
      try {
        await onChange(target.value);
      } catch (error_) {
        const normalized = normalizeMemeLoopChatError(error_);
        setError(normalized);
        notifyMemeLoopObserver(
          () => onError?.(normalized, 'set-execution-target'),
          'execution-target.onError',
          'set-execution-target',
          onObserverError,
        );
      } finally {
        setSwitching(false);
      }
    })();
  };

  const confirmRestart = async () => {
    if (!pendingTarget) return;
    setSwitching(true);
    try {
      await onChange(pendingTarget.value, { restartCurrentTurn: true });
      setPendingTarget(null);
      setError(undefined);
    } catch (error_) {
      const normalized = normalizeMemeLoopChatError(error_);
      setError(normalized);
      notifyMemeLoopObserver(
        () => onError?.(normalized, 'set-execution-target'),
        'execution-target.onError',
        'set-execution-target',
        onObserverError,
      );
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
          if (value) requestChange(value as AgentExecutionTarget);
        }}
        aria-label={labels.executionTarget}
      >
        {targets.map(target => (
          <ToggleButton
            key={executionTargetKey(target.value)}
            value={target}
            disabled={disabled || target.disabled}
            aria-label={labels.runOnTarget(target.label)}
          >
            <Tooltip title={target.description ?? target.label}>
              <Box component='span' sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                <TargetIcon kind={target.value.kind} />
                {target.label}
              </Box>
            </Tooltip>
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      <Dialog
        open={pendingTarget !== null}
        onClose={() => {
          setPendingTarget(null);
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
              setPendingTarget(null);
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

function targetsEqual(left: RemoteAgentExecutionTarget, right: RemoteAgentExecutionTarget | undefined): boolean {
  if (!right || left.kind !== right.kind) return false;
  return left.kind === 'local' || (right.kind === 'remote' && left.peerId === right.peerId);
}

function executionTargetKey(target: RemoteAgentExecutionTarget): string {
  return target.kind === 'local' ? 'local' : target.peerId;
}
