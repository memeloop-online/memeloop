import AttachFileIcon from '@mui/icons-material/AttachFile';
import LibraryBooksIcon from '@mui/icons-material/LibraryBooks';
import { Autocomplete, Box, Button, CircularProgress, IconButton, ListItemIcon, ListItemText, Popover, TextField, Tooltip, Typography } from '@mui/material';
import type { ConversationMessageListProjection } from 'memeloop';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { MessageContent } from '../chat/content/MessageContent.js';
import { normalizeMemeLoopChatError } from '../chat/coreTypes.js';
import type { MemeLoopChatOperation } from '../chat/coreTypes.js';
import type { MemeLoopChatErrorPresentation } from '../chat/coreTypes.js';
import { notifyMemeLoopObserver } from '../chat/observerErrors.js';
import type { MemeLoopObserverErrorHandler } from '../chat/observerErrors.js';
import type { AttachmentPickerControls, WikiTiddlerAttachment } from '../chat/types.js';
import { AgentChatView, type AgentChatViewProps } from './AgentChatView.js';

export interface AgentChatHeaderProps {
  title: string;
  navigation?: React.ReactNode;
  actions?: React.ReactNode;
  subtitle?: React.ReactNode;
  editTitleLabel?: string;
  onTitleChange?: (title: string) => Promise<void>;
  onError?: (error: Error) => void;
  onObserverError?: MemeLoopObserverErrorHandler;
}

export function AgentChatHeader({
  title,
  navigation,
  actions,
  subtitle,
  editTitleLabel = 'Edit title',
  onTitleChange,
  onError,
  onObserverError,
}: AgentChatHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const inputReference = useRef<HTMLInputElement>(null);
  const saveInFlightReference = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [editing, title]);

  useEffect(() => {
    if (editing) inputReference.current?.select();
  }, [editing]);

  const save = useCallback(async () => {
    if (saveInFlightReference.current) return;
    const next = draft.trim();
    setEditing(false);
    if (!onTitleChange || !next || next === title) return;
    saveInFlightReference.current = true;
    setSaving(true);
    try {
      await onTitleChange(next);
    } catch (error) {
      notifyMemeLoopObserver(
        () => onError?.(normalizeMemeLoopChatError(error)),
        'header.onError',
        'rename-conversation',
        onObserverError,
      );
    } finally {
      saveInFlightReference.current = false;
      setSaving(false);
    }
  }, [draft, onError, onTitleChange, title]);

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1.5, borderBottom: 1, borderColor: 'divider', minWidth: 0 }}>
      {navigation}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        {editing
          ? (
            <TextField
              inputRef={inputReference}
              value={draft}
              size='small'
              fullWidth
              slotProps={{ htmlInput: { 'aria-label': editTitleLabel } }}
              onChange={event => {
                setDraft(event.target.value);
              }}
              onBlur={() => {
                void save();
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void save();
                } else if (event.key === 'Escape') setEditing(false);
              }}
            />
          )
          : (
            <Typography
              variant='h6'
              noWrap
              onClick={onTitleChange
                ? () => {
                  setEditing(true);
                }
                : undefined}
              sx={{ cursor: onTitleChange ? 'text' : undefined }}
            >
              {title}
            </Typography>
          )}
        {subtitle && <Typography component='div' variant='caption' color='text.secondary' noWrap>{subtitle}</Typography>}
      </Box>
      {saving && <CircularProgress size={18} />}
      {actions}
    </Box>
  );
}

export interface AgentChatToolbarProps {
  primary?: React.ReactNode;
  secondary?: React.ReactNode;
  status?: React.ReactNode;
  loading?: boolean;
}

export function AgentChatToolbar({ primary, secondary, status, loading }: AgentChatToolbarProps) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1,
        flex: 1,
        minWidth: 0,
        '@container memeloop-chat (max-width: 480px)': { flexWrap: 'wrap' },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flex: 1, minWidth: 0 }}>{primary}</Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
        {status}
        {loading && <CircularProgress size={18} />}
        {secondary}
      </Box>
    </Box>
  );
}

export type AgentChatErrorPresentation = MemeLoopChatErrorPresentation;

export interface AgentChatConfigErrorProps extends AgentChatErrorPresentation {
  onAction?: (actionId?: string) => Promise<void>;
  onError?: (error: Error) => void;
  onObserverError?: MemeLoopObserverErrorHandler;
  diagnosticLabel?: (diagnosticId: string) => React.ReactNode;
}

export function AgentChatConfigError({ title, message, actionLabel, actionId, diagnosticId, onAction, onError, onObserverError, diagnosticLabel }: AgentChatConfigErrorProps) {
  const [acting, setActing] = useState(false);
  return (
    <Box data-testid='error-message' sx={{ textAlign: 'center', p: 2 }}>
      <Typography color='error.main' variant='h6' gutterBottom>{title}</Typography>
      <Typography color='text.secondary' sx={{ mb: 1.5 }}>{message}</Typography>
      {diagnosticId && (
        <Typography data-testid='agent-error-diagnostic-id' variant='caption' color='text.secondary' sx={{ display: 'block', mb: 1 }}>
          {diagnosticLabel?.(diagnosticId) ?? diagnosticId}
        </Typography>
      )}
      {actionLabel && onAction && (
        <Button
          variant='outlined'
          size='small'
          disabled={acting}
          onClick={() => {
            setActing(true);
            void Promise.resolve().then(() => onAction(actionId)).catch((error: unknown) => {
              notifyMemeLoopObserver(
                () => onError?.(normalizeMemeLoopChatError(error)),
                'config-error.onError',
                'configure-error',
                onObserverError,
              );
            }).finally(() => {
              setActing(false);
            });
          }}
        >
          {actionLabel}
        </Button>
      )}
    </Box>
  );
}

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
  const [loaded, setLoaded] = useState(false);
  const abortControllerReference = useRef<AbortController | undefined>(undefined);
  const requestGenerationReference = useRef(0);

  const open = !!anchorElement;
  const fileAttachmentOption: FileAttachmentOption = {
    id: FILE_ATTACHMENT_OPTION_ID,
    kind: 'file',
    workspaceName: '',
    tiddlerTitle: labels.addFile,
  };
  const attachmentOptions: readonly AttachmentOption[] = [fileAttachmentOption, ...options];

  useEffect(() => {
    if (!open || loaded) return;
    abortControllerReference.current?.abort();
    const controller = new AbortController();
    const generation = requestGenerationReference.current + 1;
    requestGenerationReference.current = generation;
    abortControllerReference.current = controller;
    setLoading(true);
    void loadOptions(controller.signal).then(items => {
      if (!controller.signal.aborted && requestGenerationReference.current === generation) {
        setOptions(items);
        setLoaded(true);
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && requestGenerationReference.current === generation) {
        notifyMemeLoopObserver(
          () => onError?.(normalizeMemeLoopChatError(error), 'load-attachment-options'),
          'attachment-selector.onError',
          'load-attachment-options',
          onObserverError,
        );
      }
    }).finally(() => {
      if (!controller.signal.aborted && requestGenerationReference.current === generation) setLoading(false);
    });
    return () => {
      controller.abort();
    };
  }, [loadOptions, loaded, onError, onObserverError, open]);

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
              setAnchorElement(current => current ? undefined : event.currentTarget);
            }}
          >
            <AttachFileIcon data-testid='attach-icon' />
          </IconButton>
        </span>
      </Tooltip>
      <Popover
        open={open}
        anchorEl={anchorElement}
        onClose={() => {
          setAnchorElement(undefined);
        }}
        anchorOrigin={{ horizontal: 'left', vertical: 'bottom' }}
      >
        <Autocomplete<AttachmentOption>
          open
          autoFocus
          size='small'
          loading={loading}
          options={attachmentOptions}
          sx={{ width: 'min(360px, calc(100vw - 24px))', p: 1.5 }}
          getOptionLabel={option => option.tiddlerTitle}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          noOptionsText={labels.noOptions}
          onChange={(_event, option) => {
            if (!option) return;
            setAnchorElement(undefined);
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

export interface AgentChatShellProps extends
  Omit<
    AgentChatViewProps,
    'composerToolbar' | 'header' | 'renderAttachmentPicker' | 'renderError' | 'renderMessageContent' | 'renderOperationError'
  >
{
  header: AgentChatHeaderProps;
  toolbar?: AgentChatToolbarProps;
  attachmentSelector?: Omit<WikiAttachmentSelectorProps, keyof AttachmentPickerControls | 'onSelect'>;
  /** Maps only typed, durable error metadata. Implementations must not parse English text. */
  resolveErrorPresentation: (value: Error | ConversationMessageListProjection) => AgentChatErrorPresentation | null;
  /** Fully localized fail-closed presentation for unknown errors. */
  genericErrorPresentation: AgentChatErrorPresentation;
  diagnosticLabel?: (diagnosticId: string) => React.ReactNode;
  onErrorAction?: (presentation: AgentChatErrorPresentation) => Promise<void>;
  onShellError?: (error: Error, operation: MemeLoopChatOperation) => void;
  renderMessageContent?: AgentChatViewProps['renderMessageContent'];
  dialogs?: React.ReactNode;
}

export function AgentChatShell({
  header,
  toolbar,
  attachmentSelector,
  resolveErrorPresentation,
  genericErrorPresentation,
  diagnosticLabel,
  onErrorAction,
  onShellError,
  renderMessageContent,
  toolResultRenderers,
  dialogs,
  ...chatProps
}: AgentChatShellProps) {
  const reportShellError = useCallback((error: Error, operation: MemeLoopChatOperation) => {
    notifyMemeLoopObserver(
      () => onShellError?.(error, operation),
      'shell.onShellError',
      operation,
      chatProps.adapter.onObserverError,
    );
    notifyMemeLoopObserver(
      () => chatProps.adapter.onError?.(error, operation),
      'adapter.onError',
      operation,
      chatProps.adapter.onObserverError,
    );
  }, [chatProps.adapter, onShellError]);

  const renderPresentation = useCallback((presentation: AgentChatErrorPresentation) => (
    <AgentChatConfigError
      {...presentation}
      diagnosticLabel={diagnosticLabel}
      onObserverError={chatProps.adapter.onObserverError}
      onAction={onErrorAction
        ? async () => {
          await onErrorAction(presentation);
        }
        : undefined}
      onError={error => {
        reportShellError(error, 'configure-error');
      }}
    />
  ), [diagnosticLabel, onErrorAction, reportShellError]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <AgentChatView
        {...chatProps}
        toolResultRenderers={toolResultRenderers}
        header={
          <AgentChatHeader
            {...header}
            onError={error => {
              notifyMemeLoopObserver(
                () => header.onError?.(error),
                'header.onError',
                'rename-conversation',
                chatProps.adapter.onObserverError,
              );
              reportShellError(error, 'rename-conversation');
            }}
          />
        }
        composerToolbar={toolbar ? <AgentChatToolbar {...toolbar} /> : undefined}
        renderAttachmentPicker={attachmentSelector
          ? controls => (
            <WikiAttachmentSelector
              {...attachmentSelector}
              {...controls}
              onSelect={controls.selectWikiTiddler}
              onObserverError={chatProps.adapter.onObserverError}
              onError={(error, operation) => {
                notifyMemeLoopObserver(
                  () => attachmentSelector.onError?.(error, operation),
                  'attachment-selector.onError',
                  operation,
                  chatProps.adapter.onObserverError,
                );
                reportShellError(error, operation);
              }}
            />
          )
          : undefined}
        renderError={error => {
          const presentation = resolveErrorPresentation(error) ?? genericErrorPresentation;
          return renderPresentation(presentation);
        }}
        renderOperationError={error => renderPresentation(resolveErrorPresentation(error) ?? genericErrorPresentation)}
        renderMessageContent={(message, isUser) => {
          const presentation = resolveErrorPresentation(message);
          if (presentation) return renderPresentation(presentation);
          if (message.role === 'error') return renderPresentation(genericErrorPresentation);
          return renderMessageContent
            ? renderMessageContent(message, isUser)
            : (
              <MessageContent
                message={message}
                labels={chatProps.messageLabels}
                toolResultRenderers={toolResultRenderers}
              />
            );
        }}
      />
      {dialogs}
    </Box>
  );
}
