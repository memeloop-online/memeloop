import ComputerIcon from '@mui/icons-material/Computer';
import HubIcon from '@mui/icons-material/Hub';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import React from 'react';

import type { AgentExecutionTarget, SetExecutionTargetOptions } from '../chat/types.js';

export interface ExecutionTargetSelectorProps {
  targets: readonly AgentExecutionTarget[];
  activeTargetId?: string;
  isRunning: boolean;
  disabled?: boolean;
  onChange: (targetId: string, options?: SetExecutionTargetOptions) => Promise<void> | void;
}

function TargetIcon({ kind }: { kind?: AgentExecutionTarget['kind'] }) {
  return kind === 'remote' ? <HubIcon fontSize='small' /> : <ComputerIcon fontSize='small' />;
}

export function ExecutionTargetSelector({
  targets,
  activeTargetId,
  isRunning,
  disabled,
  onChange,
}: ExecutionTargetSelectorProps) {
  const [pendingTargetId, setPendingTargetId] = React.useState<string | null>(null);
  const [switching, setSwitching] = React.useState(false);
  const active = activeTargetId ?? targets[0]?.id;
  const pendingTarget = targets.find(target => target.id === pendingTargetId);

  if (targets.length <= 1) return null;

  const requestChange = (targetId: string) => {
    if (!targetId || targetId === active) return;
    if (isRunning) {
      setPendingTargetId(targetId);
      return;
    }
    void onChange(targetId);
  };

  const confirmRestart = async () => {
    if (!pendingTargetId) return;
    setSwitching(true);
    try {
      await onChange(pendingTargetId, { restartCurrentTurn: true });
      setPendingTargetId(null);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1, borderBottom: 1, borderColor: 'divider' }}>
      <Typography variant='caption' color='text.secondary'>Run on</Typography>
      <ToggleButtonGroup
        exclusive
        size='small'
        value={active}
        onChange={(_event, value) => {
          if (typeof value === 'string') requestChange(value);
        }}
        aria-label='Execution target'
      >
        {targets.map(target => (
          <ToggleButton
            key={target.id}
            value={target.id}
            disabled={disabled || target.disabled}
            aria-label={`Run on ${target.label}`}
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
        <DialogTitle>Switch execution target?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            The current turn is still running. Switching to {pendingTarget?.label ?? 'another target'} will stop it and restart the latest user turn there.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setPendingTargetId(null);
            }}
            disabled={switching}
          >
            Keep running
          </Button>
          <Button
            onClick={() => {
              void confirmRestart();
            }}
            disabled={switching}
            variant='contained'
          >
            Stop and restart
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
