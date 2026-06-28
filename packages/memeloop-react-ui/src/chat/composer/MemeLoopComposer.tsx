import { ComposerPrimitive } from '@assistant-ui/react';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import CloseIcon from '@mui/icons-material/Close';
import LibraryBooksIcon from '@mui/icons-material/LibraryBooks';
import SendIcon from '@mui/icons-material/Send';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import { Box, Chip, IconButton, Paper, styled } from '@mui/material';
import React, { useEffect, useRef } from 'react';

import { useMemeLoopChatContext } from '../runtime/MemeLoopChatContext.js';
import type { MemeLoopComposerProps } from '../types.js';

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
`;

const InputContainer = styled(Box)`
  flex: 1;
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
`;

export const MemeLoopComposer: React.FC<MemeLoopComposerProps> = ({
  onFileSelect,
  selectedFile,
  selectedWikiTiddlers = [],
  onClearFile,
  onRemoveWikiTiddler,
  renderAttachmentActions,
  placeholder = 'Type a message...',
  disabled = false,
}) => {
  const { attachmentsRef } = useMemeLoopChatContext();
  const fileInputReference = useRef<HTMLInputElement>(null);

  // Sync host-controlled attachments into the ref that onNew reads.
  useEffect(() => {
    attachmentsRef.current = {
      file: selectedFile,
      wikiTiddlers: selectedWikiTiddlers,
    };
  }, [attachmentsRef, selectedFile, selectedWikiTiddlers]);

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
              disabled={disabled}
              placeholder={placeholder}
              className='assistant-ui-composer-input'
              data-testid='agent-message-input'
            />
          </InputContainer>

          <Row>
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              {onFileSelect && (
                <>
                  <input
                    ref={fileInputReference}
                    type='file'
                    accept='image/*'
                    style={{ display: 'none' }}
                    onChange={handleFileChange}
                  />
                  <IconButton
                    size='small'
                    onClick={() => fileInputReference.current?.click()}
                    disabled={disabled}
                    data-testid='agent-attach-button'
                  >
                    <AttachFileIcon data-testid='attach-icon' />
                  </IconButton>
                </>
              )}
              {renderAttachmentActions}
            </Box>

            <Box sx={{ flex: 1 }} />

            <ComposerPrimitive.Cancel asChild>
              <IconButton size='small' data-testid='agent-cancel-button'>
                <StopCircleIcon data-testid='cancel-icon' />
              </IconButton>
            </ComposerPrimitive.Cancel>

            <ComposerPrimitive.Send asChild>
              <IconButton size='small' color='primary' data-testid='agent-send-button'>
                <SendIcon data-testid='send-icon' />
              </IconButton>
            </ComposerPrimitive.Send>
          </Row>

          {(selectedFile || selectedWikiTiddlers.length > 0) && (
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              {selectedFile && (
                <Chip
                  size='small'
                  label={selectedFile.name}
                  onDelete={onClearFile}
                  deleteIcon={<CloseIcon />}
                />
              )}
              {selectedWikiTiddlers.map((tiddler, index) => (
                <Chip
                  key={`${tiddler.workspaceName}-${tiddler.tiddlerTitle}-${index}`}
                  size='small'
                  icon={<LibraryBooksIcon />}
                  label={`${tiddler.workspaceName}: ${tiddler.tiddlerTitle}`}
                  onDelete={() => onRemoveWikiTiddler?.(index)}
                />
              ))}
            </Box>
          )}
        </Root>
      </form>
    </ComposerPrimitive.Root>
  );
};
