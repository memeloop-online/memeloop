/**
 * TidGi `approval.ts` 逐行迁移（pending 队列 + UI 监听）。
 */
import type { ApprovalDecision, ToolApprovalConfig, ToolApprovalRequest } from './types.js';

const pendingApprovals = new Map<
  string,
  {
    request: ToolApprovalRequest;
    resolve: (decision: 'allow' | 'deny') => void;
  }
>();

const approvalListeners = new Set<(request: ToolApprovalRequest) => void>();

export function onApprovalRequest(listener: (request: ToolApprovalRequest) => void): () => void {
  approvalListeners.add(listener);
  return () => {
    approvalListeners.delete(listener);
  };
}

export function evaluateApproval(
  approval: ToolApprovalConfig | undefined,
  toolName: string,
  parameters: Record<string, unknown>,
): ApprovalDecision {
  if (!approval || approval.mode === 'auto') {
    return 'allow';
  }

  const callContent = JSON.stringify({ tool: toolName, parameters });

  if (approval.denyPatterns?.length) {
    for (const pattern of approval.denyPatterns) {
      try {
        if (new RegExp(pattern, 'i').test(callContent)) {
          return 'deny';
        }
      } catch {
        /* invalid regex */
      }
    }
  }

  if (approval.allowPatterns?.length) {
    for (const pattern of approval.allowPatterns) {
      try {
        if (new RegExp(pattern, 'i').test(callContent)) {
          return 'allow';
        }
      } catch {
        /* invalid regex */
      }
    }
  }

  return 'pending';
}

export function requestApproval(request: ToolApprovalRequest, timeoutMs: number = 60_000): Promise<'allow' | 'deny'> {
  return new Promise<'allow' | 'deny'>((resolve) => {
    pendingApprovals.set(request.approvalId, { request, resolve });

    for (const listener of approvalListeners) {
      try {
        listener(request);
      } catch {
        /* ignore listener errors */
      }
    }

    if (timeoutMs > 0) {
      setTimeout(() => {
        if (pendingApprovals.has(request.approvalId)) {
          pendingApprovals.delete(request.approvalId);
          resolve('deny');
        }
      }, timeoutMs);
    }
  });
}

export function resolveApproval(approvalId: string, decision: 'allow' | 'deny'): void {
  const pending = pendingApprovals.get(approvalId);
  if (pending) {
    pendingApprovals.delete(approvalId);
    pending.resolve(decision);
  }
}

export function getPendingApprovals(): ToolApprovalRequest[] {
  return [...pendingApprovals.values()].map((p) => p.request);
}

export function cancelPendingApprovals(agentId: string): void {
  for (const [id, pending] of pendingApprovals) {
    if (pending.request.agentId === agentId) {
      pendingApprovals.delete(id);
      pending.resolve('deny');
    }
  }
}
