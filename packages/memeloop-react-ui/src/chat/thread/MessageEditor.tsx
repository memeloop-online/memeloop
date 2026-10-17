import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { Box, Button, IconButton, TextField, Tooltip, Typography } from '@mui/material';
import type { ConversationEditingAdapter } from 'memeloop';
import React, { useEffect, useRef, useState } from 'react';
import { MessageToolbar } from './MessageToolbar.js';

export interface MessageEditorLabels {
  edit: string;
  input: string;
  send: string;
  discard: string;
  saveDraft: string;
  reloadDraft: string;
  conflict: string;
  previousBranch: string;
  nextBranch: string;
}

export const defaultMessageEditorLabels: MessageEditorLabels = {
  edit: 'Edit and branch',
  input: 'Edit message',
  send: 'Send',
  discard: 'Discard',
  saveDraft: 'Save draft',
  reloadDraft: 'Load saved draft',
  conflict: 'This draft changed in another window. Your text remains here; load the saved draft to resolve the conflict.',
  previousBranch: 'Previous history',
  nextBranch: 'Next history',
};

/** Draft writes are serialized; discard and submit flush/fence pending autosaves. */
export function MessageEditor({
  messageId,
  adapter,
  disabled,
  labels: overrides,
  onError,
  children,
  renderSurface = content => content,
  actions,
}: {
  messageId: string;
  adapter: ConversationEditingAdapter;
  disabled?: boolean;
  labels?: Partial<MessageEditorLabels>;
  onError: (error: unknown, operation: 'edit-message' | 'save-draft' | 'switch-branch') => void;
  children: React.ReactNode;
  renderSurface?: (content: React.ReactNode, editing: boolean) => React.ReactNode;
  actions?: React.ReactNode;
}) {
  const labels = { ...defaultMessageEditorLabels, ...overrides };
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [conflict, setConflict] = useState(false);
  const sourceRevision = useRef('');
  const draftRevision = useRef(0);
  const queue = useRef(Promise.resolve());
  const writeError = useRef<Error | undefined>(undefined);
  const pending = useRef<string | undefined>(undefined);
  const pendingVersion = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const latest = useRef({ adapter, onError });
  latest.current = { adapter, onError };

  const persist = (value: string | null, version?: number): Promise<void> => {
    const operation = queue.current.then(async () => {
      draftRevision.current = await latest.current.adapter.saveDraft(messageId, value, draftRevision.current);
      if (version !== undefined && pendingVersion.current === version) pending.current = undefined;
      writeError.current = undefined;
    });
    // Keep the queue usable after a failed write while returning the actual
    // rejection to save/send callers. A CAS conflict cannot overwrite newer text.
    queue.current = operation.catch((error: unknown) => {
      writeError.current = error instanceof Error ? error : new Error('conversation_draft_write_failed');
      if (mounted.current && writeError.current.message.includes('conflict')) setConflict(true);
    });
    return operation;
  };
  const flush = (): Promise<void> => {
    clearTimeout(timer.current);
    const value = pending.current;
    return value === undefined
      ? queue.current.then(() => {
        if (writeError.current) throw writeError.current;
      })
      : persist(value, pendingVersion.current);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void flush().catch((error: unknown) => {
        latest.current.onError(error, 'save-draft');
      });
    };
  }, []);

  const run = (operation: 'edit-message' | 'save-draft' | 'switch-branch', action: () => Promise<void>) => {
    setBusy(true);
    void action().catch((error: unknown) => {
      latest.current.onError(error, operation);
    }).finally(() => {
      if (mounted.current) setBusy(false);
    });
  };
  const close = () => {
    run('save-draft', async () => {
      await flush();
      if (mounted.current) setEditing(false);
    });
  };
  const branch = adapter.branches.find(item => item.messageId === messageId);
  const switchBranch = (index: number) => {
    const target = branch?.alternatives[index];
    if (target) {
      run('switch-branch', async () => {
        await flush();
        await adapter.switchBranch(target.conversationId, target.messageId);
      });
    }
  };

  return (
    <Box sx={{ minWidth: 0 }}>
      {renderSurface(
        editing
          ? (
            <Box
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!busy) close();
                }
              }}
            >
              <TextField
                autoFocus
                multiline
                fullWidth
                minRows={2}
                value={text}
                disabled={busy}
                slotProps={{ htmlInput: { 'aria-label': labels.input, 'data-testid': 'message-edit-input' } }}
                onChange={event => {
                  const value = event.target.value;
                  setText(value);
                  pending.current = value;
                  pendingVersion.current += 1;
                  clearTimeout(timer.current);
                  timer.current = setTimeout(() => {
                    void flush().catch((error: unknown) => {
                      latest.current.onError(error, 'save-draft');
                    });
                  }, 200);
                }}
              />
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
                <Button
                  variant='contained'
                  data-testid='message-edit-send'
                  disabled={busy || !text.trim()}
                  onClick={() => {
                    run('edit-message', async () => {
                      await flush();
                      await adapter.submit(messageId, text, sourceRevision.current, draftRevision.current);
                      if (mounted.current) setEditing(false);
                    });
                  }}
                >
                  {labels.send}
                </Button>
                <Button
                  color='inherit'
                  data-testid='message-edit-discard'
                  disabled={busy}
                  onClick={() => {
                    run('save-draft', async () => {
                      clearTimeout(timer.current);
                      await persist(null);
                      pending.current = undefined;
                      setConflict(false);
                      if (mounted.current) setEditing(false);
                    });
                  }}
                >
                  {labels.discard}
                </Button>
                <Button color='inherit' data-testid='message-edit-save' disabled={busy} onClick={close}>{labels.saveDraft}</Button>
              </Box>
              {conflict && (
                <Box role='alert'>
                  <Typography>{labels.conflict}</Typography>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      run('save-draft', async () => {
                        await queue.current;
                        const source = await adapter.loadSource(messageId);
                        sourceRevision.current = source.sourceRevision;
                        draftRevision.current = source.draft?.revision ?? 0;
                        pending.current = undefined;
                        writeError.current = undefined;
                        setText(source.draft?.text ?? source.text);
                        setConflict(false);
                      });
                    }}
                  >
                    {labels.reloadDraft}
                  </Button>
                </Box>
              )}
            </Box>
          )
          : children,
        editing,
      )}
      <MessageToolbar>
        {!editing && (
          <Tooltip title={labels.edit}>
            <span>
              <IconButton
                size='small'
                aria-label={labels.edit}
                data-testid='message-edit'
                disabled={busy || disabled}
                onClick={() => {
                  run('edit-message', async () => {
                    await flush();
                    const source = await adapter.loadSource(messageId);
                    if (!mounted.current) return;
                    sourceRevision.current = source.sourceRevision;
                    draftRevision.current = source.draft?.revision ?? 0;
                    setText(source.draft?.text ?? source.text);
                    setEditing(true);
                  });
                }}
              >
                <EditOutlinedIcon fontSize='small' />
              </IconButton>
            </span>
          </Tooltip>
        )}
        {branch && branch.alternatives.length > 1 && (
          <Box data-testid='message-branches' sx={{ display: 'flex', alignItems: 'center', color: 'secondary.main' }}>
            <IconButton
              size='small'
              aria-label={labels.previousBranch}
              data-testid='message-branch-previous'
              disabled={busy || disabled || branch.selected <= 0}
              onClick={() => {
                switchBranch(branch.selected - 1);
              }}
            >
              <ChevronLeftIcon fontSize='small' />
            </IconButton>
            <Typography variant='caption'>{branch.selected + 1} / {branch.alternatives.length}</Typography>
            <IconButton
              size='small'
              aria-label={labels.nextBranch}
              data-testid='message-branch-next'
              disabled={busy || disabled || branch.selected >= branch.alternatives.length - 1}
              onClick={() => {
                switchBranch(branch.selected + 1);
              }}
            >
              <ChevronRightIcon fontSize='small' />
            </IconButton>
          </Box>
        )}
        {!editing && actions}
      </MessageToolbar>
    </Box>
  );
}
