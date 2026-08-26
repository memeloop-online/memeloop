import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import QuestionMarkIcon from '@mui/icons-material/HelpOutlineOutlined';
import SendIcon from '@mui/icons-material/Send';
import { Box, Button, ButtonBase, Checkbox, FormGroup, Paper, styled, TextField, Tooltip, Typography } from '@mui/material';
import { type ChatMessage, getChatMessageParts, isToolResultPart } from 'memeloop/conversation';
import React, { memo, useCallback, useState } from 'react';

import { useMemeLoopChatContext } from '../runtime/MemeLoopChatContext.js';

const QuestionContainer = styled(Paper)`
  width: 100%;
  padding: 12px;
  background: ${(props) => props.theme.palette.action.hover};
  border-radius: 8px;
  border-left: 3px solid ${(props) => props.theme.palette.info.main};
`;

const QuestionHeader = styled(Box)`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
`;

const OptionButton = styled(ButtonBase, {
  shouldForwardProp: (property) => property !== '$selected',
})<{ $selected?: boolean; disabled?: boolean }>`
  display: flex;
  align-items: flex-start;
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid
    ${(props) => (props.$selected ? props.theme.palette.primary.main : props.theme.palette.divider)};
  background: ${(props) =>
  props.$selected
    ? props.theme.palette.primary.main + '14'
    : props.theme.palette.background.paper};
  transition:
    background 0.15s,
    border-color 0.15s;
  cursor: ${(props) => (props.disabled ? 'default' : 'pointer')};
  opacity: ${(props) => (props.disabled ? 0.6 : 1)};

  &:hover:not(:disabled) {
    background: ${(props) => props.$selected ? props.theme.palette.primary.main + '22' : props.theme.palette.action.hover};
    border-color: ${(props) => props.theme.palette.primary.main};
  }
`;

const OptionsStack = styled(Box)`
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
`;

const FreeformContainer = styled(Box)`
  display: flex;
  gap: 8px;
  margin-top: 12px;
  align-items: flex-end;
`;

interface AskQuestionData {
  type: 'ask-question';
  questionId?: string;
  question: string;
  inputType?: 'single-select' | 'multi-select' | 'text';
  options?: Array<{ label: string; description?: string }>;
  allowFreeform?: boolean;
}

function isAskQuestionData(data: unknown): data is AskQuestionData {
  return !!data && typeof data === 'object' && (data as { type?: string }).type === 'ask-question' && typeof (data as { question?: string }).question === 'string';
}

function parseAskQuestionData(message: ChatMessage): AskQuestionData | null {
  const toolResult = getChatMessageParts(message).find(isToolResultPart);
  if (toolResult) {
    if (isAskQuestionData(toolResult.payload)) return toolResult.payload;
    try {
      const parsed = JSON.parse(toolResult.result) as unknown;
      if (isAskQuestionData(parsed)) return parsed;
    } catch {
      // Not parseable
    }
  }

  const resultMatch = /Result:\s*(.+?)\s*(?:<\/functions_result>|$)/s.exec(message.content);
  if (!resultMatch) return null;

  try {
    const data = JSON.parse(resultMatch[1]) as AskQuestionData;
    if (isAskQuestionData(data)) return data;
  } catch {
    // Not parseable
  }
  return null;
}

const OptionWithTooltip: React.FC<{ description?: string; children: React.ReactElement }> = ({
  description,
  children,
}) => {
  if (!description) return children;
  return (
    <Tooltip title={description} placement='top' arrow enterDelay={300}>
      {children}
    </Tooltip>
  );
};

export interface AskQuestionContentProps {
  message: ChatMessage;
  agentId?: string;
  labels?: Partial<AskQuestionContentLabels>;
}

export interface AskQuestionContentLabels {
  answerPlaceholder: string;
  submit: string;
  confirmSelection: string;
  answered: string;
}

const defaultLabels: AskQuestionContentLabels = {
  answerPlaceholder: 'Your answer...',
  submit: 'Submit',
  confirmSelection: 'Confirm selection',
  answered: 'Answered',
};

export const AskQuestionContent: React.FC<AskQuestionContentProps> = memo(
  ({ message, agentId: _agentId, labels: labelOverrides }) => {
    const labels = { ...defaultLabels, ...labelOverrides };
    const { adapter, reportOperationError } = useMemeLoopChatContext();
    const [freeformText, setFreeformText] = useState('');
    const [checkedOptions, setCheckedOptions] = useState(new Set<string>());
    const [answered, setAnswered] = useState(() => {
      return !!message.metadata?.askQuestionAnswered;
    });

    const data = parseAskQuestionData(message);
    const inputType = data?.inputType ?? 'single-select';
    const questionId = data?.questionId;

    const submitAnswer = useCallback(
      (answer: string) => {
        if (questionId && adapter.resolveAskQuestion) {
          try {
            void Promise.resolve(adapter.resolveAskQuestion(questionId, answer)).catch((error: unknown) => {
              setAnswered(false);
              reportOperationError(error, 'resolve-question');
            });
          } catch (error) {
            setAnswered(false);
            reportOperationError(error, 'resolve-question');
          }
        }
      },
      [questionId, adapter, reportOperationError],
    );

    const markAnswered = useCallback(() => {
      setAnswered(true);
      if (adapter.updateMessage) {
        try {
          void Promise.resolve(adapter.updateMessage({
            ...message,
            metadata: { ...message.metadata, askQuestionAnswered: true },
          })).catch((error: unknown) => {
            setAnswered(false);
            reportOperationError(error, 'update-message');
          });
        } catch (error) {
          setAnswered(false);
          reportOperationError(error, 'update-message');
        }
      }
    }, [adapter, message, reportOperationError]);

    const handleOptionClick = useCallback(
      (label: string) => {
        if (answered) return;
        markAnswered();
        submitAnswer(label);
      },
      [answered, markAnswered, submitAnswer],
    );

    const handleToggleOption = useCallback((label: string) => {
      setCheckedOptions((previous) => {
        const next = new Set(previous);
        if (next.has(label)) {
          next.delete(label);
        } else {
          next.add(label);
        }
        return next;
      });
    }, []);

    const handleMultiSelectSubmit = useCallback(() => {
      if (answered) return;
      const parts: string[] = [...checkedOptions];
      if (freeformText.trim()) parts.push(freeformText.trim());
      if (parts.length === 0) return;
      markAnswered();
      submitAnswer(parts.join(', '));
    }, [answered, checkedOptions, freeformText, markAnswered, submitAnswer]);

    const handleFreeformSubmit = useCallback(() => {
      if (!freeformText.trim() || answered) return;
      markAnswered();
      submitAnswer(freeformText.trim());
    }, [freeformText, answered, markAnswered, submitAnswer]);

    if (!data) return null;

    return (
      <QuestionContainer elevation={0} data-testid='ask-question-container'>
        <QuestionHeader>
          <QuestionMarkIcon color='info' fontSize='small' />
          <Typography variant='subtitle2'>{data.question}</Typography>
        </QuestionHeader>

        {data.options && data.options.length > 0 && inputType !== 'text' && (
          <OptionsStack>
            {data.options.map((option, index) => (
              <OptionWithTooltip key={option.label} description={option.description}>
                {inputType === 'single-select'
                  ? (
                    <OptionButton
                      data-testid={answered ? undefined : `ask-question-option-${index}`}
                      disabled={answered}
                      onClick={() => {
                        handleOptionClick(option.label);
                      }}
                    >
                      <Typography variant='body2'>{option.label}</Typography>
                    </OptionButton>
                  )
                  : (
                    <OptionButton
                      data-testid={answered ? undefined : `ask-question-option-${index}`}
                      disabled={answered}
                      onClick={() => {
                        handleToggleOption(option.label);
                      }}
                    >
                      <FormGroup>
                        <Checkbox
                          disabled={answered}
                          checked={checkedOptions.has(option.label)}
                          onClick={(event) => {
                            event.stopPropagation();
                          }}
                          onChange={() => {
                            handleToggleOption(option.label);
                          }}
                        />
                        <Typography variant='body2'>{option.label}</Typography>
                      </FormGroup>
                    </OptionButton>
                  )}
              </OptionWithTooltip>
            ))}
          </OptionsStack>
        )}

        {(data.allowFreeform || inputType === 'text') && (
          <FreeformContainer>
            <TextField
              data-testid={answered ? undefined : 'ask-question-text-input'}
              fullWidth
              multiline
              maxRows={4}
              size='small'
              disabled={answered}
              value={freeformText}
              onChange={(event) => {
                setFreeformText(event.target.value);
              }}
              placeholder={labels.answerPlaceholder}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (inputType === 'multi-select') {
                    handleMultiSelectSubmit();
                  } else {
                    handleFreeformSubmit();
                  }
                }
              }}
            />
            <Button
              data-testid={answered ? undefined : 'ask-question-submit'}
              variant='contained'
              size='small'
              disabled={answered || !freeformText.trim()}
              onClick={inputType === 'multi-select' ? handleMultiSelectSubmit : handleFreeformSubmit}
              endIcon={<SendIcon />}
            >
              {labels.submit}
            </Button>
          </FreeformContainer>
        )}

        {inputType === 'multi-select' && data.options && data.options.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <Button
              data-testid={answered ? undefined : 'ask-question-multiselect-submit'}
              size='small'
              disabled={answered || checkedOptions.size === 0}
              onClick={handleMultiSelectSubmit}
              endIcon={<CheckCircleOutlineIcon />}
            >
              {labels.confirmSelection}
            </Button>
          </Box>
        )}

        {answered && (
          <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
            <CheckCircleOutlineIcon color='success' fontSize='small' />
            <Typography variant='caption' color='success.main'>
              {labels.answered}
            </Typography>
          </Box>
        )}
      </QuestionContainer>
    );
  },
);

AskQuestionContent.displayName = 'AskQuestionContent';
