import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ChatMessage } from 'memeloop';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Import from the source entry so vitest resolves through tsconfig paths.
import { AskQuestionContent, MemeLoopRuntimeProvider } from '../chat/index';

const mockAdapter = {
  conversationId: 'conv-1',
  messages: [],
  isRunning: false,
  isLoading: false,
  error: null,
  sendMessage: vi.fn(),
  cancel: vi.fn(),
  deleteTurn: vi.fn(),
  retryTurn: vi.fn(),
  resolveAskQuestion: vi.fn(),
  updateMessage: vi.fn(),
};

function makeMessage(data: Record<string, unknown>): ChatMessage {
  return {
    messageId: 'msg-1',
    turnId: 'turn-1',
    conversationId: 'conv-1',
    originNodeId: 'test',
    originSequence: 1,
    timestamp: Date.now(),
    lamportClock: Date.now(),
    role: 'tool',
    content: `<functions_result>\nTool: ask-question\nParameters: {}\nResult: ${JSON.stringify(data)}\n</functions_result>`,
  };
}

function renderWithProvider(children: React.ReactNode) {
  return render(
    <MemeLoopRuntimeProvider adapter={mockAdapter}>{children}</MemeLoopRuntimeProvider>,
  );
}

describe('AskQuestionContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('single-select (default)', () => {
    it('renders question text and options', () => {
      const message = makeMessage({
        type: 'ask-question',
        question: 'Which workspace?',
        options: [{ label: 'Wiki A' }, { label: 'Wiki B' }],
      });
      renderWithProvider(<AskQuestionContent message={message} agentId='agent-1' />);
      expect(screen.getByText('Which workspace?')).toBeInTheDocument();
      expect(screen.getByText('Wiki A')).toBeInTheDocument();
      expect(screen.getByText('Wiki B')).toBeInTheDocument();
    });

    it('calls resolveAskQuestion with option label when clicked', () => {
      const message = makeMessage({
        type: 'ask-question',
        questionId: 'q-1',
        question: 'Pick one',
        options: [{ label: 'Option 1' }],
      });
      renderWithProvider(<AskQuestionContent message={message} agentId='agent-1' />);
      fireEvent.click(screen.getByText('Option 1'));
      expect(mockAdapter.resolveAskQuestion).toHaveBeenCalledWith('q-1', 'Option 1');
    });

    it('marks question as answered after selecting an option', () => {
      const message = makeMessage({
        type: 'ask-question',
        questionId: 'q-1',
        question: 'Pick one',
        options: [{ label: 'A' }],
      });
      renderWithProvider(<AskQuestionContent message={message} agentId='agent-1' />);
      fireEvent.click(screen.getByText('A'));
      expect(screen.getByText('Answered')).toBeInTheDocument();
      expect(mockAdapter.updateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ askQuestionAnswered: true }),
        }),
      );
    });

    it('shows freeform input when allowFreeform is true', () => {
      const message = makeMessage({
        type: 'ask-question',
        question: 'Pick or type',
        options: [{ label: 'X' }],
        allowFreeform: true,
      });
      renderWithProvider(<AskQuestionContent message={message} agentId='agent-1' />);
      expect(screen.getByPlaceholderText('Your answer...')).toBeInTheDocument();
    });

    it('does not show freeform input when allowFreeform is false', () => {
      const message = makeMessage({
        type: 'ask-question',
        question: 'Only options',
        options: [{ label: 'X' }],
        allowFreeform: false,
      });
      renderWithProvider(<AskQuestionContent message={message} agentId='agent-1' />);
      expect(screen.queryByPlaceholderText('Your answer...')).not.toBeInTheDocument();
    });
  });

  describe('multi-select', () => {
    it('renders checkboxes for options', () => {
      const message = makeMessage({
        type: 'ask-question',
        question: 'Select tags',
        inputType: 'multi-select',
        options: [{ label: 'journal' }, { label: 'important' }],
      });
      renderWithProvider(<AskQuestionContent message={message} agentId='agent-1' />);
      expect(screen.getByText('journal')).toBeInTheDocument();
      expect(screen.getByText('important')).toBeInTheDocument();
      expect(screen.getByText('Confirm selection')).toBeInTheDocument();
    });

    it('submits comma-separated values when confirmed', () => {
      const message = makeMessage({
        type: 'ask-question',
        questionId: 'q-2',
        question: 'Select tags',
        inputType: 'multi-select',
        options: [{ label: 'journal' }, { label: 'important' }, { label: 'todo' }],
      });
      renderWithProvider(<AskQuestionContent message={message} agentId='agent-1' />);
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);
      fireEvent.click(checkboxes[2]);
      fireEvent.click(screen.getByText('Confirm selection'));
      expect(mockAdapter.resolveAskQuestion).toHaveBeenCalledWith('q-2', 'journal, todo');
    });
  });

  describe('text input', () => {
    it('shows only text input with no options', () => {
      const message = makeMessage({
        type: 'ask-question',
        question: 'Describe changes',
        inputType: 'text',
      });
      renderWithProvider(<AskQuestionContent message={message} agentId='agent-1' />);
      expect(screen.getByPlaceholderText('Your answer...')).toBeInTheDocument();
      expect(screen.queryByText('Confirm selection')).not.toBeInTheDocument();
    });

    it('submits freeform text', () => {
      const message = makeMessage({
        type: 'ask-question',
        questionId: 'q-3',
        question: 'Describe changes',
        inputType: 'text',
      });
      renderWithProvider(<AskQuestionContent message={message} agentId='agent-1' />);
      fireEvent.change(screen.getByPlaceholderText('Your answer...'), {
        target: { value: 'my answer' },
      });
      fireEvent.click(screen.getByText('Submit'));
      expect(mockAdapter.resolveAskQuestion).toHaveBeenCalledWith('q-3', 'my answer');
    });
  });

  describe('answered state persistence', () => {
    it('initializes answered=true from metadata', () => {
      const message = makeMessage({
        type: 'ask-question',
        question: 'Already answered',
        options: [{ label: 'A' }],
      });
      message.metadata = { askQuestionAnswered: true };
      renderWithProvider(<AskQuestionContent message={message} agentId='agent-1' />);
      expect(screen.getByText('Answered')).toBeInTheDocument();
    });
  });

  describe('fallback', () => {
    it('returns null when JSON is unparseable', () => {
      const message: ChatMessage = makeMessage({});
      message.content = 'not json content';
      const { container } = renderWithProvider(
        <AskQuestionContent message={message} agentId='agent-1' />,
      );
      expect(container.firstChild).toBeNull();
    });
  });
});
