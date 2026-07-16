import { matchPattern } from '../permission/engine.js';
import type { PermissionAction } from '../permission/types.js';

import type { NodeTrustClass, SecurityProfileResource, ToolAdmissionAction, ToolAdmissionPolicy, ToolAdmissionRule, ToolOperationResource } from './resources.js';

export type { NodeTrustClass, ToolAdmissionAction, ToolAdmissionPolicy, ToolAdmissionRule } from './resources.js';

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
 * Resolve the effective trusted admission policy for a workload from its
 * SecurityProfile and the node's trust class. Profile rules are evaluated
 * first (they can allow specific tools on restricted nodes); the trust-class
 * default applies after. For restricted/quarantine the resolved default is
 * forced to `deny` — a profile cannot override it.
 */
export function resolveAdmissionPolicy(
  profile: Pick<SecurityProfileResource, 'spec'> | undefined,
  trustClass: NodeTrustClass,
): ToolAdmissionPolicy {
  const base = defaultAdmissionPolicyForTrustClass(trustClass);
  const overlay = profile?.spec.toolAdmission;
  if (!overlay) return base;
  const defaultAction = trustClass === 'trusted' ? overlay.defaultAction ?? base.defaultAction : 'deny';
  return {
    defaultAction,
    rules: [...(overlay.rules ?? []), ...(base.rules ?? [])],
  };
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
