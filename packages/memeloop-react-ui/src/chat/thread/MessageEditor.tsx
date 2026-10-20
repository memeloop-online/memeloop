import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { Box, Button, IconButton, TextField, Tooltip, Typography } from '@mui/material';
import type { ConversationEditingAdapter } from 'memeloop';
import React from 'react';
import { defaultMessageEditorLabels, type MessageEditorLabels, useMessageEditor } from '../useMessageEditor.js';
import { MessageToolbar } from './MessageToolbar.js';

export { defaultMessageEditorLabels, type MessageEditorLabels } from '../useMessageEditor.js';

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
  const editor = useMessageEditor(messageId, adapter, onError);
  const { editing, busy, text, conflict, branch } = editor;
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
                  if (!busy) editor.close();
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
                  editor.change(event.target.value);
                }}
              />
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
                <Button variant='contained' data-testid='message-edit-send' disabled={busy || !text.trim()} onClick={editor.submit}>{labels.send}</Button>
                <Button color='inherit' data-testid='message-edit-discard' disabled={busy} onClick={editor.discard}>{labels.discard}</Button>
                <Button color='inherit' data-testid='message-edit-save' disabled={busy} onClick={editor.close}>{labels.saveDraft}</Button>
              </Box>
              {conflict && (
                <Box role='alert'>
                  <Typography>{labels.conflict}</Typography>
                  <Button disabled={busy} onClick={editor.reload}>{labels.reloadDraft}</Button>
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
              <IconButton size='small' aria-label={labels.edit} data-testid='message-edit' disabled={busy || disabled} onClick={editor.open}>
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
                editor.switchBranch(branch.selected - 1);
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
                editor.switchBranch(branch.selected + 1);
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
