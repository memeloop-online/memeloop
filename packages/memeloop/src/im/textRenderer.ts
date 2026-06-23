import type { IIMMessageRenderer } from './interface.js';

/** 通用文本/Markdown 友好输出（IM 端以纯文本展示） */
export class TextMessageRenderer implements IIMMessageRenderer {
  renderPlainText(content: string): string {
    return content.trim();
  }

  renderToolCallSummary(toolName: string, arguments_: unknown): string {
    const s = (() => {
      try {
        const index = JSON.stringify(arguments_);
        if (!index || index === '{}') return '';
        return index.length > 120 ? `${index.slice(0, 117)}…` : index;
      } catch {
        return '';
      }
    })();
    return s ? `🔧 ${toolName}: ${s}` : `🔧 ${toolName}`;
  }

  renderToolResultSummary(toolName: string, result: unknown): string | null {
    // IM 默认隐藏工具结果细节：只给一个轻量摘要，避免刷屏。
    if (result == null) return `✅ ${toolName}: done`;
    if (typeof result === 'string') {
      const t = result.trim();
      if (!t) return `✅ ${toolName}: done`;
      return `✅ ${toolName}: ${t.length > 120 ? `${t.slice(0, 117)}…` : t}`;
    }
    if (typeof result === 'object') {
      const keys = Object.keys(result as Record<string, unknown>);
      if (keys.length === 0) return `✅ ${toolName}: done`;
      return `✅ ${toolName}: {${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', …' : ''}}`;
    }
    if (typeof result === 'symbol') return `✅ ${toolName}: ${result.toString()}`;
    if (typeof result === 'function') return `✅ ${toolName}: [function]`;
    if (typeof result === 'number' || typeof result === 'boolean' || typeof result === 'bigint') {
      return `✅ ${toolName}: ${String(result)}`;
    }
    return `✅ ${toolName}: done`;
  }

  renderToolApproval(toolName: string, arguments_: unknown): string {
    return `⏸ 需要审批执行工具：${toolName}\n参数：\n\`\`\`json\n${JSON.stringify(arguments_, null, 2)}\n\`\`\`\n回复 Y 同意 / N 拒绝`;
  }

  renderAskQuestion(question: string, options?: string[]): string {
    const lines = options?.length
      ? [`❓ ${question}`, ...options.map((o, index) => `${index + 1}. ${o}`)]
      : [`❓ ${question}`];
    return lines.join('\n');
  }

  renderThinking(_content: string): string | null {
    return null;
  }

  renderError(error: string): string {
    return `⚠️ 错误：${error}`;
  }

  renderTodoList(todos: Array<{ id: string; text: string; done?: boolean }>): string {
    return ['📋 Todo', ...todos.map((t) => `${t.done ? '[x]' : '[ ]'} ${t.text}`)].join('\n');
  }
}
