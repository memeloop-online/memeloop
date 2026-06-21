import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import QuestionMarkIcon from '@mui/icons-material/HelpOutlineOutlined';
import SendIcon from '@mui/icons-material/Send';
import { Box, Button, ButtonBase, Checkbox, FormGroup, Paper, styled, TextField, Tooltip, Typography } from '@mui/material';
import type { ChatMessage } from 'memeloop';
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

function parseAskQuestionData(content: string): AskQuestionData | null {
  const resultMatch = /Result:\s*(.+?)\s*(?:<\/functions_result>|$)/s.exec(content);
  if (!resultMatch) return null;

  try {
    const data = JSON.parse(resultMatch[1]) as AskQuestionData;
    if (data.type === 'ask-question' && data.question) return data;
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
}

export const AskQuestionContent: React.FC<AskQuestionContentProps> = memo(
  ({ message, agentId }) => {
    const { adapter } = useMemeLoopChatContext();
    const [freeformText, setFreeformText] = useState('');
    const [checkedOptions, setCheckedOptions] = useState(new Set<string>());
    const [answered, setAnswered] = useState(() => {
      return !!message.metadata?.askQuestionAnswered;
    });

    const data = parseAskQuestionData(message.content);
    const inputType = data?.inputType ?? 'single-select';
    const questionId = data?.questionId;

    const submitAnswer = useCallback(
      (answer: string) => {
        if (questionId && agentId && adapter.resolveAskQuestion) {
          void adapter.resolveAskQuestion(questionId, answer);
        }
      },
      [questionId, agentId, adapter],
    );

    const markAnswered = useCallback(() => {
      setAnswered(true);
      if (adapter.updateMessage) {
        void adapter.updateMessage({
          ...message,
          metadata: { ...message.metadata, askQuestionAnswered: true },
        });
      }
    }, [adapter, message]);

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
      <QuestionContainer elevation={0}>
        <QuestionHeader>
          <QuestionMarkIcon color='info' fontSize='small' />
          <Typography variant='subtitle2'>{data.question}</Typography>
        </QuestionHeader>

        {data.options && data.options.length > 0 && inputType !== 'text' && (
          <OptionsStack>
            {data.options.map((option) => (
              <OptionWithTooltip key={option.label} description={option.description}>
                {inputType === 'single-select'
                  ? (
                    <OptionButton
                      disabled={answered}
                      onClick={() => {
                        handleOptionClick(option.label);
                      }}
                    >
                      <Typography variant='body2'>{option.label}</Typography>
                    </OptionButton>
                  )
                  : (
                    <FormGroup>
                      <Checkbox
                        disabled={answered}
                        checked={checkedOptions.has(option.label)}
                        onChange={() => {
                          handleToggleOption(option.label);
                        }}
                      />
                      <Typography variant='body2'>{option.label}</Typography>
                    </FormGroup>
                  )}
              </OptionWithTooltip>
            ))}
          </OptionsStack>
        )}

        {(data.allowFreeform || inputType === 'text') && (
          <FreeformContainer>
            <TextField
              fullWidth
              size='small'
              disabled={answered}
              value={freeformText}
              onChange={(event) => {
                setFreeformText(event.target.value);
              }}
              placeholder='Your answer...'
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
              variant='contained'
              size='small'
              disabled={answered || !freeformText.trim()}
              onClick={inputType === 'multi-select' ? handleMultiSelectSubmit : handleFreeformSubmit}
              endIcon={<SendIcon />}
            >
              Submit
            </Button>
          </FreeformContainer>
        )}

        {inputType === 'multi-select' && data.options && data.options.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <Button
              size='small'
              disabled={answered || checkedOptions.size === 0}
              onClick={handleMultiSelectSubmit}
              endIcon={<CheckCircleOutlineIcon />}
            >
              Confirm selection
            </Button>
          </Box>
        )}

        {answered && (
          <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
            <CheckCircleOutlineIcon color='success' fontSize='small' />
            <Typography variant='caption' color='success.main'>
              Answered
            </Typography>
          </Box>
        )}
      </QuestionContainer>
    );
  },
);

AskQuestionContent.displayName = 'AskQuestionContent';
