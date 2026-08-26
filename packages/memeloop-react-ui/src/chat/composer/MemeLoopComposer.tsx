import { ComposerPrimitive, useAui, useAuiState } from '@assistant-ui/react';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import CloseIcon from '@mui/icons-material/Close';
import LibraryBooksIcon from '@mui/icons-material/LibraryBooks';
import SendIcon from '@mui/icons-material/Send';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import { Box, Chip, IconButton, Paper, styled, Tooltip } from '@mui/material';
import React, { useEffect, useRef } from 'react';

import { useMemeLoopChatContext } from '../runtime/MemeLoopChatContext.js';
import type { MemeLoopComposerLabels, MemeLoopComposerProps } from '../types.js';

const defaultLabels: MemeLoopComposerLabels = {
  input: 'Message',
  send: 'Send message',
  cancel: 'Stop generating',
  addFile: 'Add file',
  removeFile: fileName => `Remove ${fileName}`,
  removeTiddler: (workspaceName, tiddlerTitle) => `Remove ${workspaceName}: ${tiddlerTitle}`,
};

const Root = styled(Paper)`
  display: flex;
  flex-direction: column;
  padding: 12px 16px;
  gap: 8px;
  border-radius: 0;
`;

const Row = styled(Box)`
  display: flex;
  align-items: center;
  gap: 12px;

  @container memeloop-chat (max-width: 480px) {
    gap: 4px;
    flex-wrap: wrap;
  }
`;

const InputContainer = styled(Box)`
  flex: 1;
  min-width: 0;
  .assistant-ui-composer-input {
    width: 100%;
    min-height: 40px;
    max-height: 150px;
    padding: 10px 14px;
    border-radius: 20px;
    border: 1px solid ${(props) => props.theme.palette.divider};
    background-color: ${(props) => props.theme.palette.background.paper};
    color: ${(props) => props.theme.palette.text.primary};
    font-family: inherit;
    font-size: 0.9375rem;
    line-height: 1.5;
    resize: none;
    outline: none;

    &:focus {
      border-color: ${(props) => props.theme.palette.primary.main};
    }
  }

  @container memeloop-chat (max-width: 480px) {
    .assistant-ui-composer-input {
      min-height: 36px;
      padding: 8px 10px;
      border-radius: 12px;
    }
  }
`;

export const MemeLoopComposer: React.FC<MemeLoopComposerProps> = ({
  onFileSelect,
  onWikiTiddlerSelect,
  selectedFile,
  selectedWikiTiddlers = [],
  onClearFile,
  onClearAttachments,
  onRemoveWikiTiddler,
  renderAttachmentActions,
  renderAttachmentPicker,
  renderComposerToolbar,
  labels: labelOverrides,
  placeholder = 'Type a message...',
  disabled = false,
}) => {
  const labels = { ...defaultLabels, ...labelOverrides };
  const { attachmentsRef } = useMemeLoopChatContext();
  const aui = useAui();
  const fileInputReference = useRef<HTMLInputElement>(null);
  const isRunning = useAuiState(state => state.thread.isRunning);

  // Sync host-controlled attachments into the ref that onNew reads.
  useEffect(() => {
    attachmentsRef.current = {
      file: selectedFile,
      wikiTiddlers: selectedWikiTiddlers,
      restoreComposerDraft: text => {
        aui.composer().setText(text);
      },
      clearHostAttachments: onClearAttachments ?? (() => {
        onClearFile?.();
        for (let index = selectedWikiTiddlers.length - 1; index >= 0; index -= 1) {
          onRemoveWikiTiddler?.(index);
        }
      }),
    };
  }, [attachmentsRef, onClearAttachments, onClearFile, onRemoveWikiTiddler, selectedFile, selectedWikiTiddlers]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && onFileSelect) {
      onFileSelect(file);
    }
    if (event.target) {
      event.target.value = '';
    }
  };

  return (
    <ComposerPrimitive.Root asChild>
      <form
        style={{ display: 'contents' }}
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <Root elevation={0}>
          <InputContainer>
            <ComposerPrimitive.Input
              aria-label={labels.input}
              disabled={disabled}
              placeholder={placeholder}
              className='assistant-ui-composer-input'
              data-testid='agent-message-input'
              onKeyDown={event => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                const composerState = aui.composer().getState();
                const threadState = aui.thread().getState();
                if (composerState.canSend && !threadState.isRunning) {
                  event.preventDefault();
                  event.stopPropagation();
                  aui.composer().send();
                }
              }}
            />
          </InputContainer>

          <Row>
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              {(onFileSelect || renderAttachmentPicker) && (
                <>
                  {onFileSelect && (
                    <input
                      ref={fileInputReference}
                      type='file'
                      accept='image/*'
                      style={{ display: 'none' }}
                      aria-label={labels.addFile}
                      data-testid='agent-file-input'
                      onChange={handleFileChange}
                    />
                  )}
                  {renderAttachmentPicker
                    ? renderAttachmentPicker({
                      disabled,
                      openFilePicker: () => fileInputReference.current?.click(),
                      selectWikiTiddler: tiddler => onWikiTiddlerSelect?.(tiddler),
                    })
                    : (
                      <Tooltip title={labels.addFile} disableInteractive>
                        <span>
                          <IconButton
                            size='small'
                            onClick={() => fileInputReference.current?.click()}
                            disabled={disabled}
                            data-testid='agent-attach-button'
                            aria-label={labels.addFile}
                          >
                            <AttachFileIcon data-testid='attach-icon' />
                          </IconButton>
                        </span>
                      </Tooltip>
                    )}
                </>
              )}
              {renderAttachmentActions}
            </Box>

            <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}>
              {renderComposerToolbar}
            </Box>

            {isRunning
              ? (
                <Tooltip title={labels.cancel} disableInteractive>
                  <span>
                    <ComposerPrimitive.Cancel asChild>
                      <IconButton size='small' color='primary' data-testid='agent-send-button' aria-label={labels.cancel}>
                        <StopCircleIcon data-testid='cancel-icon' />
                      </IconButton>
                    </ComposerPrimitive.Cancel>
                  </span>
                </Tooltip>
              )
              : (
                <Tooltip title={labels.send} disableInteractive>
                  <span>
                    <ComposerPrimitive.Send asChild>
                      <IconButton size='small' color='primary' data-testid='agent-send-button' aria-label={labels.send}>
                        <SendIcon data-testid='send-icon' />
                      </IconButton>
                    </ComposerPrimitive.Send>
                  </span>
                </Tooltip>
              )}
          </Row>

          {(selectedFile || selectedWikiTiddlers.length > 0) && (
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              {selectedFile && (
                <Chip
                  size='small'
                  label={selectedFile.name}
                  onDelete={onClearFile}
                  deleteIcon={<CloseIcon aria-label={labels.removeFile(selectedFile.name)} />}
                  aria-label={labels.removeFile(selectedFile.name)}
                  title={labels.removeFile(selectedFile.name)}
                  data-testid='attachment-preview'
                />
              )}
              {selectedWikiTiddlers.map((tiddler, index) => (
                <Chip
                  key={`${tiddler.workspaceName}-${tiddler.tiddlerTitle}-${index}`}
                  size='small'
                  icon={<LibraryBooksIcon />}
                  label={`${tiddler.workspaceName}: ${tiddler.tiddlerTitle}`}
                  onDelete={() => onRemoveWikiTiddler?.(index)}
                  aria-label={labels.removeTiddler(tiddler.workspaceName, tiddler.tiddlerTitle)}
                  title={labels.removeTiddler(tiddler.workspaceName, tiddler.tiddlerTitle)}
                  data-testid={`wiki-tiddler-chip-${index}`}
                />
              ))}
            </Box>
          )}
        </Root>
      </form>
    </ComposerPrimitive.Root>
  );
};
