import AttachFileIcon from '@mui/icons-material/AttachFile';
import LibraryBooksIcon from '@mui/icons-material/LibraryBooks';
import { Autocomplete, Box, createFilterOptions, IconButton, ListItemIcon, ListItemText, Popover, TextField, Tooltip } from '@mui/material';
import React, { useEffect, useRef, useState } from 'react';

import { normalizeMemeLoopChatError } from '../chat/coreTypes.js';
import { type MemeLoopObserverErrorHandler, notifyMemeLoopObserver } from '../chat/observerErrors.js';
import type { AttachmentPickerControls, WikiTiddlerAttachment } from '../chat/types.js';

export interface WikiAttachmentOption extends WikiTiddlerAttachment {
  id: string;
  workspaceId?: string;
}

const FILE_ATTACHMENT_OPTION_ID = '__file__' as const;

interface FileAttachmentOption {
  id: typeof FILE_ATTACHMENT_OPTION_ID;
  kind: 'file';
  workspaceName: '';
  tiddlerTitle: string;
}

type AttachmentOption = WikiAttachmentOption | FileAttachmentOption;

const filterAttachmentOptions = createFilterOptions<AttachmentOption>({
  limit: 50,
  stringify: option => `${option.tiddlerTitle} ${option.workspaceName}`,
});

function isFileAttachmentOption(option: AttachmentOption): option is FileAttachmentOption {
  return 'kind' in option && option.kind === 'file';
}

export interface WikiAttachmentSelectorLabels {
  addAttachment: string;
  addFile: string;
  searchPlaceholder: string;
  noOptions: string;
}

export interface WikiAttachmentSelectorProps extends AttachmentPickerControls {
  loadOptions: (signal: AbortSignal) => Promise<readonly WikiAttachmentOption[]>;
  onSelect: (attachment: WikiTiddlerAttachment) => void;
  labels: WikiAttachmentSelectorLabels;
  onError?: (error: Error, operation: 'load-attachment-options' | 'select-attachment') => void;
  onObserverError?: MemeLoopObserverErrorHandler;
}

interface AutocompleteInputCompatibilityProps {
  /** MUI 7 Autocomplete render-input contract. */
  inputProps?: React.ComponentPropsWithRef<'input'>;
  /** MUI 9 Autocomplete render-input contract. */
  slotProps?: {
    htmlInput?: React.ComponentPropsWithRef<'input'>;
  };
}

export function WikiAttachmentSelector({
  disabled,
  openFilePicker,
  loadOptions,
  onSelect,
  labels,
  onError,
  onObserverError,
}: WikiAttachmentSelectorProps) {
  const [anchorElement, setAnchorElement] = useState<HTMLElement>();
  const [options, setOptions] = useState<readonly WikiAttachmentOption[]>([]);
  const [loading, setLoading] = useState(false);
  const requestReference = useRef<AbortController>(null);

  const open = !!anchorElement;
  const fileAttachmentOption: FileAttachmentOption = {
    id: FILE_ATTACHMENT_OPTION_ID,
    kind: 'file',
    workspaceName: '',
    tiddlerTitle: labels.addFile,
  };
  const attachmentOptions: readonly AttachmentOption[] = [fileAttachmentOption, ...options];

  useEffect(() => () => requestReference.current?.abort(), []);

  const close = () => {
    requestReference.current?.abort();
    setAnchorElement(undefined);
  };
  const openPicker = (anchor: HTMLElement) => {
    const controller = new AbortController();
    requestReference.current = controller;
    setAnchorElement(anchor);
    setOptions([]);
    setLoading(true);
    void loadOptions(controller.signal).then(items => {
      if (!controller.signal.aborted) setOptions(items);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        notifyMemeLoopObserver(
          () => onError?.(normalizeMemeLoopChatError(error), 'load-attachment-options'),
          'attachment-selector.onError',
          'load-attachment-options',
          onObserverError,
        );
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
  };

  return (
    <>
      <Tooltip title={labels.addAttachment}>
        <span>
          <IconButton
            size='small'
            disabled={disabled}
            data-testid='agent-attach-button'
            aria-label={labels.addAttachment}
            aria-expanded={open}
            onClick={event => {
              if (open) close();
              else openPicker(event.currentTarget);
            }}
          >
            <AttachFileIcon data-testid='attach-icon' />
          </IconButton>
        </span>
      </Tooltip>
      <Popover
        open={open}
        anchorEl={anchorElement}
        onClose={close}
        anchorOrigin={{ horizontal: 'left', vertical: 'bottom' }}
      >
        <Autocomplete<AttachmentOption>
          open
          autoFocus
          size='small'
          loading={loading}
          options={attachmentOptions}
          sx={{ width: 'min(360px, calc(100vw - 24px))', p: 1.5 }}
          filterOptions={filterAttachmentOptions}
          getOptionKey={option => option.id}
          getOptionLabel={option => option.tiddlerTitle}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          noOptionsText={labels.noOptions}
          onChange={(_event, option) => {
            if (!option) return;
            close();
            try {
              if (isFileAttachmentOption(option)) openFilePicker();
              else onSelect({ workspaceName: option.workspaceName, tiddlerTitle: option.tiddlerTitle });
            } catch (error) {
              notifyMemeLoopObserver(
                () => onError?.(normalizeMemeLoopChatError(error), 'select-attachment'),
                'attachment-selector.onError',
                'select-attachment',
                onObserverError,
              );
            }
          }}
          renderInput={parameters => {
            const compatibilityParameters = parameters as typeof parameters & AutocompleteInputCompatibilityProps;
            const parameterSlotProps = compatibilityParameters.slotProps;
            return (
              <TextField
                {...parameters}
                placeholder={labels.searchPlaceholder}
                slotProps={{
                  ...parameterSlotProps,
                  htmlInput: {
                    ...compatibilityParameters.inputProps,
                    ...parameterSlotProps?.htmlInput,
                    'data-testid': 'attachment-autocomplete-input',
                  },
                }}
              />
            );
          }}
          renderOption={(properties, option) => {
            const { key, ...rest } = properties;
            const testId = isFileAttachmentOption(option)
              ? 'attachment-option-image-AddImage'
              : `attachment-option-tiddler-${option.tiddlerTitle}`;
            return (
              <Box component='li' key={key} {...rest} data-testid={testId}>
                <ListItemIcon>
                  <LibraryBooksIcon fontSize='small' />
                </ListItemIcon>
                <ListItemText primary={option.tiddlerTitle} secondary={option.workspaceName || undefined} />
              </Box>
            );
          }}
          slotProps={{
            listbox: {
              'data-testid': 'attachment-listbox',
            } as React.HTMLAttributes<HTMLUListElement> & { 'data-testid': string },
          }}
        />
      </Popover>
    </>
  );
}
