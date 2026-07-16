import { matchPattern } from '../permission/engine.js';
import type { PermissionAction } from '../permission/types.js';

import type { ToolOperationEffect, ToolOperationResource } from './resources.js';

/**
 * Host-asserted trust classification of the node executing a workload.
 *
 * The trust class is bound by the host that assembles the runtime; it is never
 * self-reported by the workload, the model, or a `.mjs` script. `restricted`
 * and `quarantine` nodes are deny-by-default at both the model-facing
 * permission layer (UX, defense in depth) and the trusted admission layer
 * (non-overridable).
 */
export type NodeTrustClass = 'trusted' | 'restricted' | 'quarantine';

export type ToolAdmissionAction = 'allow' | 'deny' | 'require-approval';

/**
 * Trusted admission rule evaluated by the executor/manager, not by the model.
 * Rules are evaluated in order; the first matching rule wins (firewall
 * semantics). A rule matches when `toolPattern` matches the tool reference name
 * and either `effects` is omitted (all effects) or contains the operation
 * effect.
 */
export interface ToolAdmissionRule {
  toolPattern: string;
  effects?: ToolOperationEffect[];
  action: ToolAdmissionAction;
  reason?: string;
}

export interface ToolAdmissionPolicy {
  /** Applied when no rule matches. Restricted/quarantine profiles must use `deny`. */
  defaultAction: ToolAdmissionAction;
  rules?: ToolAdmissionRule[];
}

export interface ToolAdmissionDecision {
  action: ToolAdmissionAction;
  source: 'rule' | 'default';
  reason?: string;
  matchedRule?: ToolAdmissionRule;
}

/**
 * Default trusted admission posture per node trust class. Trusted nodes keep
 * the historical allow-by-default posture; restricted and quarantine nodes
 * deny everything unless an explicit rule allows it.
 */
export function defaultAdmissionPolicyForTrustClass(trustClass: NodeTrustClass): ToolAdmissionPolicy {
  switch (trustClass) {
    case 'restricted':
    case 'quarantine':
      return { defaultAction: 'deny', rules: [] };
    default:
      return { defaultAction: 'allow', rules: [] };
  }
}

/**
 * Model-facing implied permission default for a trust class. Used by the
 * AgentToolLoop permission gate when no explicit wildcard rule exists.
 */
export function defaultPermissionActionForTrustClass(trustClass: NodeTrustClass | undefined): PermissionAction {
  return trustClass === 'restricted' || trustClass === 'quarantine' ? 'deny' : 'allow';
}

export function evaluateToolAdmission(
  policy: ToolAdmissionPolicy,
  operation: Pick<ToolOperationResource, 'spec'>,
): ToolAdmissionDecision {
  const toolName = operation.spec.toolRef.name;
  const effect = operation.spec.effect;
  for (const rule of policy.rules ?? []) {
    if (!matchPattern(toolName, rule.toolPattern)) continue;
    if (rule.effects && !rule.effects.includes(effect)) continue;
    return {
      action: rule.action,
      source: 'rule',
      reason: rule.reason,
      matchedRule: rule,
    };
  }
  return { action: policy.defaultAction, source: 'default' };
}
