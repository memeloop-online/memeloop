import { beforeEach, describe, expect, it } from 'vitest';
import { executeCommand, getCommand, listCommands, registerCommand } from '../commands.js';
import type { TUIMessage } from '../tui/types.js';

describe('commands', () => {
  const emptyCtx = { messages: [], mode: 'chat' as const, statusText: '' };

  beforeEach(() => {
    // Re-register builtins (they're registered at module load)
    // Built-ins: help, clear, compact, context, mode, cost, exit, quit
  });

  describe('built-in commands', () => {
    it('/help returns usage text', async () => {
      const result = await executeCommand('/help', emptyCtx);
      expect(result).not.toBeNull();
      expect(result!.messages![0].content).toContain('/help');
      expect(result!.messages![0].content).toContain('/clear');
    });

    it('/clear returns clearMessages flag', async () => {
      const result = await executeCommand('/clear', emptyCtx);
      expect(result).not.toBeNull();
      expect(result!.clearMessages).toBe(true);
    });

    it('/context shows message stats', async () => {
      const msgs: TUIMessage[] = [
        { messageId: '1', role: 'user', content: 'hi', timestamp: new Date() },
        { messageId: '2', role: 'assistant', content: 'hello', timestamp: new Date() },
        { messageId: '3', role: 'tool', content: 'result', timestamp: new Date() },
      ];
      const result = await executeCommand('/context', {
        messages: msgs,
        mode: 'chat',
        statusText: '',
      });
      expect(result).not.toBeNull();
      expect(result!.messages![0].content).toContain('3');
      expect(result!.messages![0].content).toContain('1 user');
    });

    it('/mode chat switches to chat', async () => {
      const result = await executeCommand('/mode chat', emptyCtx);
      expect(result).not.toBeNull();
      expect(result!.mode).toBe('chat');
      expect(result!.messages![0].content).toContain('CHAT');
    });

    it('/mode plan switches to plan', async () => {
      const result = await executeCommand('/mode plan', emptyCtx);
      expect(result!.mode).toBe('plan');
    });

    it('/mode autopilot switches to autopilot', async () => {
      const result = await executeCommand('/mode autopilot', emptyCtx);
      expect(result!.mode).toBe('autopilot');
    });

    it('/mode invalid shows error', async () => {
      const result = await executeCommand('/mode invalid', emptyCtx);
      expect(result).not.toBeNull();
      expect(result!.messages![0].content).toContain('Usage');
    });

    it('/compact shows compaction message', async () => {
      const msgs = Array.from({ length: 10 }, (_, i) => ({
        messageId: String(i),
        role: 'user' as const,
        content: 'msg',
        timestamp: new Date(),
      }));
      const result = await executeCommand('/compact', {
        messages: msgs,
        mode: 'chat',
        statusText: '',
      });
      expect(result).not.toBeNull();
      expect(result!.messages![0].content).toContain('10 messages');
    });

    it('/cost estimates tokens', async () => {
      const msgs: TUIMessage[] = [
        { messageId: '1', role: 'user', content: 'hello world test', timestamp: new Date() },
      ];
      const result = await executeCommand('/cost', {
        messages: msgs,
        mode: 'chat',
        statusText: '',
      });
      expect(result!.messages![0].content).toContain('Estimated tokens');
      expect(result!.messages![0].content).toContain('~4'); // ~17 chars / 4
    });

    it('/exit returns exit flag', async () => {
      const result = await executeCommand('/exit', emptyCtx);
      expect(result!.exit).toBe(true);
    });

    it('/quit is alias for /exit', async () => {
      const result = await executeCommand('/quit', emptyCtx);
      expect(result!.exit).toBe(true);
    });

    it('plain text returns null (not a command)', async () => {
      const result = await executeCommand('hello world', emptyCtx);
      expect(result).toBeNull();
    });

    it('unknown command returns error message', async () => {
      const result = await executeCommand('/unknown', emptyCtx);
      expect(result).not.toBeNull();
      expect(result!.messages![0].content).toContain('Unknown command');
    });
  });

  describe('custom command registration', () => {
    it('registerCommand and getCommand', () => {
      const handler = () => ({ clearMessages: true });
      registerCommand('test-cmd', handler);
      expect(getCommand('test-cmd')).toBe(handler);
    });

    it('listCommands includes builtins', () => {
      const cmds = listCommands();
      expect(cmds).toContain('help');
      expect(cmds).toContain('exit');
    });

    it('custom command is executable', async () => {
      registerCommand('greet', (_args, _ctx) => ({
        messages: [
          {
            messageId: 'greet-1',
            role: 'system',
            content: 'Hi there!',
            timestamp: new Date(),
          },
        ],
      }));

      const result = await executeCommand('/greet', emptyCtx);
      expect(result).not.toBeNull();
      expect(result!.messages![0].content).toBe('Hi there!');
    });

    it('command with args receives them', async () => {
      registerCommand('echo', (args, _ctx) => ({
        messages: [
          {
            messageId: 'echo-1',
            role: 'system',
            content: args.join(' '),
            timestamp: new Date(),
          },
        ],
      }));

      const result = await executeCommand('/echo hello world', emptyCtx);
      expect(result!.messages![0].content).toBe('hello world');
    });
  });
});
