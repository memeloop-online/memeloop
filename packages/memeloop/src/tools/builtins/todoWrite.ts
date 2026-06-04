/**
 * TodoWrite Tool — Manage structured todo lists stored in conversation context.
 *
 * Supports operations: create, update, complete, list, remove.
 * Todo state is stored in-memory per conversation, keyed by conversationId.
 */
import { z } from 'zod';

import type { BuiltinToolContext } from './types.js';

export const todoWriteConfigSchema = z.object({
  action: z
    .enum(['create', 'update', 'complete', 'list', 'remove'])
    .describe('Action: create, update, complete, list, or remove'),
  id: z.string().min(1).optional().describe('Todo item ID (required for update/complete/remove)'),
  content: z.string().min(1).optional().describe('Todo item content (required for create/update)'),
  status: z
    .enum(['pending', 'in_progress', 'completed', 'cancelled'])
    .optional()
    .describe("Status (defaults to 'pending' for create)"),
  priority: z
    .enum(['high', 'medium', 'low'])
    .optional()
    .default('medium')
    .describe('Priority level'),
});

export const TODO_WRITE_TOOL_ID = 'todoWrite';

interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
  createdAt: number;
  updatedAt: number;
}

/**
 * In-memory per-conversation todo store.
 * In production this could be backed by IAgentStorage for persistence.
 */
const conversationTodos = new Map<string, Map<string, TodoItem>>();

/** Exported for test cleanup. */
export function __clearTodoStore(): void {
  conversationTodos.clear();
}

function getConversationTodos(
  conversationId: string,
): Map<string, TodoItem> {
  let todos = conversationTodos.get(conversationId);
  if (!todos) {
    todos = new Map<string, TodoItem>();
    conversationTodos.set(conversationId, todos);
  }
  return todos;
}

function formatTodoList(todos: Map<string, TodoItem>): string {
  if (todos.size === 0) {
    return '(No todos)';
  }

  const statusOrder: Record<string, number> = {
    in_progress: 0,
    pending: 1,
    completed: 2,
    cancelled: 3,
  };

  const sorted = [...todos.values()].sort(
    (a, b) =>
      (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99) ||
      b.updatedAt - a.updatedAt,
  );

  const statusIcons: Record<string, string> = {
    pending: '○',
    in_progress: '◉',
    completed: '✓',
    cancelled: '✗',
  };

  return sorted
    .map(
      (t) => `${statusIcons[t.status] ?? '?'} [${t.priority}] ${t.content} (id: ${t.id})`,
    )
    .join('\n');
}

function getConversationId(context: BuiltinToolContext): string {
  return context.agent?.id ?? context.activeToolConversationId ?? 'default';
}

export async function todoWriteImpl(
  arguments_: Record<string, unknown>,
  context: BuiltinToolContext,
): Promise<{ result: string } | { error: string }> {
  const parsed = todoWriteConfigSchema.safeParse(arguments_);
  if (!parsed.success) {
    return { error: `invalid_todoWrite_args: ${parsed.error.message}` };
  }

  const { action, id, content, status, priority } = parsed.data;
  const conversationId = getConversationId(context);
  const todos = getConversationTodos(conversationId);
  const now = Date.now();

  switch (action) {
    case 'create': {
      if (!content) {
        return { error: 'content is required for create action' };
      }
      const newId = id ?? crypto.randomUUID();
      if (todos.has(newId)) {
        return { error: `Todo with id '${newId}' already exists. Use update action.` };
      }
      const item: TodoItem = {
        id: newId,
        content,
        status: status ?? 'pending',
        priority,
        createdAt: now,
        updatedAt: now,
      };
      todos.set(newId, item);
      return {
        result: `Todo created: [${item.priority}] ${item.content} (id: ${item.id})\n\n${formatTodoList(todos)}`,
      };
    }

    case 'update': {
      if (!id) {
        return { error: 'id is required for update action' };
      }
      const existing = todos.get(id);
      if (!existing) {
        return { error: `Todo with id '${id}' not found` };
      }
      if (content !== undefined) existing.content = content;
      if (status !== undefined) existing.status = status;
      existing.priority = priority ?? existing.priority;
      existing.updatedAt = now;
      return {
        result: `Todo updated: [${existing.priority}] ${existing.content} (id: ${existing.id}, status: ${existing.status})\n\n${formatTodoList(todos)}`,
      };
    }

    case 'complete': {
      if (!id) {
        return { error: 'id is required for complete action' };
      }
      const existing = todos.get(id);
      if (!existing) {
        return { error: `Todo with id '${id}' not found` };
      }
      existing.status = 'completed';
      existing.updatedAt = now;
      return {
        result: `Todo completed: [${existing.priority}] ${existing.content} (id: ${existing.id})\n\n${formatTodoList(todos)}`,
      };
    }

    case 'remove': {
      if (!id) {
        // Remove all completed/cancelled todos
        let removed = 0;
        for (const [key, item] of todos) {
          if (item.status === 'completed' || item.status === 'cancelled') {
            todos.delete(key);
            removed++;
          }
        }
        return {
          result: `Removed ${removed} completed/cancelled todo(s)\n\n${formatTodoList(todos)}`,
        };
      }
      const removed = todos.delete(id);
      return {
        result: removed
          ? `Todo removed: ${id}\n\n${formatTodoList(todos)}`
          : `Todo with id '${id}' not found\n\n${formatTodoList(todos)}`,
      };
    }

    case 'list':
    default: {
      return {
        result: `Todo list (${todos.size} items):\n\n${formatTodoList(todos)}`,
      };
    }
  }
}
