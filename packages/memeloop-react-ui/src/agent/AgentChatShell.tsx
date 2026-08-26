import AttachFileIcon from '@mui/icons-material/AttachFile';
import LibraryBooksIcon from '@mui/icons-material/LibraryBooks';
import { Autocomplete, Box, Button, CircularProgress, IconButton, ListItemIcon, ListItemText, Popover, TextField, Tooltip, Typography } from '@mui/material';
import type { ChatMessage } from 'memeloop';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { MessageContent } from '../chat/content/MessageContent.js';
import { normalizeMemeLoopChatError } from '../chat/coreTypes.js';
import type { MemeLoopChatOperation } from '../chat/coreTypes.js';
import type { MemeLoopChatErrorPresentation } from '../chat/coreTypes.js';
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
}

export function AgentChatHeader({
  title,
  navigation,
  actions,
  subtitle,
  editTitleLabel = 'Edit title',
  onTitleChange,
  onError,
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
      try {
        onError?.(normalizeMemeLoopChatError(error));
      } catch {
        // Error observers are notifications and must not reject UI events.
      }
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
  diagnosticLabel?: (diagnosticId: string) => React.ReactNode;
}

export function AgentChatConfigError({ title, message, actionLabel, actionId, diagnosticId, onAction, onError, diagnosticLabel }: AgentChatConfigErrorProps) {
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
              try {
                onError?.(normalizeMemeLoopChatError(error));
              } catch {
                // Error observers are notifications and must not reject UI events.
              }
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
}

export function WikiAttachmentSelector({
  disabled,
  openFilePicker,
  loadOptions,
  onSelect,
  labels,
  onError,
}: WikiAttachmentSelectorProps) {
  const [anchorElement, setAnchorElement] = useState<HTMLElement>();
  const [options, setOptions] = useState<readonly WikiAttachmentOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const abortControllerReference = useRef<AbortController | undefined>(undefined);
  const requestGenerationReference = useRef(0);

  const open = !!anchorElement;
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
        try {
          onError?.(normalizeMemeLoopChatError(error), 'load-attachment-options');
        } catch {
          // Error observers are notifications and must not reject UI events.
        }
      }
    }).finally(() => {
      if (!controller.signal.aborted && requestGenerationReference.current === generation) setLoading(false);
    });
    return () => {
      controller.abort();
    };
  }, [loadOptions, loaded, onError, open]);

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
        <Autocomplete<WikiAttachmentOption | { id: '__file__'; workspaceName: ''; tiddlerTitle: string }>
          open
          autoFocus
          size='small'
          loading={loading}
          options={[{ id: '__file__', workspaceName: '', tiddlerTitle: labels.addFile }, ...options]}
          sx={{ width: 'min(360px, calc(100vw - 24px))', p: 1.5 }}
          getOptionLabel={option => option.tiddlerTitle}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          noOptionsText={labels.noOptions}
          onChange={(_event, option) => {
            if (!option) return;
            setAnchorElement(undefined);
            try {
              if (option.id === '__file__') openFilePicker();
              else onSelect({ workspaceName: option.workspaceName, tiddlerTitle: option.tiddlerTitle });
            } catch (error) {
              try {
                onError?.(normalizeMemeLoopChatError(error), 'select-attachment');
              } catch {
                // Error observers are notifications and must not reject UI events.
              }
            }
          }}
          renderInput={parameters => <TextField {...parameters} placeholder={labels.searchPlaceholder} />}
          renderOption={(properties, option) => {
            const { key, ...rest } = properties;
            return (
              <Box component='li' key={key} {...rest}>
                <ListItemIcon>
                  <LibraryBooksIcon fontSize='small' />
                </ListItemIcon>
                <ListItemText primary={option.tiddlerTitle} secondary={option.workspaceName || undefined} />
              </Box>
            );
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
  resolveErrorPresentation: (value: Error | ChatMessage) => AgentChatErrorPresentation | null;
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
  dialogs,
  ...chatProps
}: AgentChatShellProps) {
  const reportShellError = useCallback((error: Error, operation: MemeLoopChatOperation) => {
    try {
      onShellError?.(error, operation);
    } catch {
      // Error observers are notifications and must not reject UI events.
    }
    try {
      chatProps.adapter.onError?.(error, operation);
    } catch {
      // Adapter error observers follow the same rule.
    }
  }, [chatProps.adapter, onShellError]);

  const renderPresentation = useCallback((presentation: AgentChatErrorPresentation) => (
    <AgentChatConfigError
      {...presentation}
      diagnosticLabel={diagnosticLabel}
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
        header={
          <AgentChatHeader
            {...header}
            onError={error => {
              try {
                header.onError?.(error);
              } catch {
                // Error observers are notifications and must not reject UI events.
              }
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
              onError={(error, operation) => {
                try {
                  attachmentSelector.onError?.(error, operation);
                } catch {
                  // Error observers are notifications and must not reject UI events.
                }
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
            : <MessageContent message={message} labels={chatProps.messageLabels} />;
        }}
      />
      {dialogs}
    </Box>
  );
}
