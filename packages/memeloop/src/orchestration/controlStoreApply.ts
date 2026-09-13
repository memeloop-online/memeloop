import type { OrchestrationResource, OrchestrationResourceManifest } from './client.js';
import type { ControlStoreActor, ControlStoreApplyOptions } from './controlStore.js';
import { canonicalControlStoreValue } from './controlStore.js';
import { OrchestrationError } from './errors.js';

/** One persisted field ownership claim used by every ControlStore backend. */
export interface ControlStoreApplyOwnership {
  fieldPath: string;
  manager: string;
}

export const MAX_CONTROL_STORE_APPLY_OWNERSHIP_FIELDS = 4_096;

/** Canonical request payload used by every backend's idempotency digest. */
export function controlStoreApplyRequestPayload(
  actor: ControlStoreActor,
  manifest: OrchestrationResourceManifest,
  options: ControlStoreApplyOptions,
): Record<string, unknown> {
  return {
    actor,
    manifest,
    fieldManager: options.fieldManager,
    force: options.force,
    preconditions: options.preconditions,
  };
}

/** Validate options and return the effective CAS resourceVersion. */
export function validateControlStoreApplyOptions(options: ControlStoreApplyOptions): string | undefined {
  if (options.fieldManager !== undefined && (options.fieldManager.trim().length === 0 || options.fieldManager.length > 128)) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'apply fieldManager must be a non-empty string of at most 128 characters',
      retryable: false,
    });
  }
  if (options.force !== undefined && options.fieldManager === undefined) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'apply force requires fieldManager',
      retryable: false,
    });
  }
  const preconditionResourceVersion = options.preconditions?.resourceVersion;
  if (options.resourceVersion !== undefined && preconditionResourceVersion !== undefined && options.resourceVersion !== preconditionResourceVersion) {
    throw new OrchestrationError({
      code: 'CONFLICT',
      message: 'apply resourceVersion options disagree',
      retryable: false,
    });
  }
  return preconditionResourceVersion ?? options.resourceVersion;
}

export function hasControlStoreApplyPreconditions(options: ControlStoreApplyOptions): boolean {
  return options.resourceVersion !== undefined ||
    options.preconditions?.uid !== undefined ||
    options.preconditions?.resourceVersion !== undefined ||
    options.preconditions?.generation !== undefined;
}

/** Check uid, generation, and resourceVersion predicates before apply matching. */
export function assertControlStoreApplyPreconditions(
  current: OrchestrationResource | null,
  options: ControlStoreApplyOptions,
  expectedResourceVersion: string | undefined,
): void {
  if (!current) {
    if (hasControlStoreApplyPreconditions(options)) {
      throw new OrchestrationError({
        code: 'CONFLICT',
        message: 'apply precondition failed because the resource does not exist',
        retryable: true,
      });
    }
    return;
  }
  const preconditions = options.preconditions;
  if (preconditions?.uid !== undefined && current.metadata.uid !== preconditions.uid) {
    throw new OrchestrationError({
      code: 'CONFLICT',
      message: 'apply uid precondition failed',
      retryable: true,
      details: { expected: preconditions.uid, current: current.metadata.uid },
    });
  }
  if (preconditions?.generation !== undefined && current.metadata.generation !== preconditions.generation) {
    throw new OrchestrationError({
      code: 'CONFLICT',
      message: 'apply generation precondition failed',
      retryable: true,
      details: { expected: preconditions.generation, current: current.metadata.generation },
    });
  }
  if (expectedResourceVersion !== undefined && current.metadata.resourceVersion !== expectedResourceVersion) {
    throw new OrchestrationError({
      code: 'CONFLICT',
      message: 'apply resourceVersion precondition failed',
      retryable: true,
      details: { expected: expectedResourceVersion, current: current.metadata.resourceVersion },
    });
  }
}

const APPLY_METADATA_FIELDS = ['labels', 'annotations', 'ownerReferences', 'finalizers'] as const;

function managedPathSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('.', '~1');
}

interface ManagedFieldValues {
  values: Map<string, string>;
  leaves: string[];
}

function managedFieldValues(resource: OrchestrationResource | OrchestrationResourceManifest): ManagedFieldValues {
  const values = new Map<string, string>();
  const leaves: string[] = [];
  const collect = (value: unknown, path: string): void => {
    if (value === undefined) return;
    values.set(path, canonicalControlStoreValue(value));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      leaves.push(path);
      return;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      leaves.push(path);
      return;
    }
    for (const [key, child] of entries) collect(child, `${path}.${managedPathSegment(key)}`);
  };
  collect(resource.spec, 'spec');
  for (const field of APPLY_METADATA_FIELDS) collect(resource.metadata[field], `metadata.${field}`);
  return { values, leaves };
}

function managedPathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

/**
 * Pure server-side-apply ownership decision. Backends persist the returned
 * claims in their native transaction/CAS mechanism; no backend reimplements
 * conflict or force-transfer semantics.
 */
export function decideControlStoreApplyOwnership(
  current: OrchestrationResource | null,
  manifest: OrchestrationResourceManifest,
  options: ControlStoreApplyOptions,
  owners: readonly ControlStoreApplyOwnership[],
): ControlStoreApplyOwnership[] {
  const manager = options.fieldManager;
  if (manager === undefined) return owners.map((owner) => ({ ...owner }));
  const desired = managedFieldValues(manifest);
  if (desired.leaves.length > MAX_CONTROL_STORE_APPLY_OWNERSHIP_FIELDS) {
    throw new OrchestrationError({
      code: 'EXHAUSTED',
      message: 'apply field ownership set exceeded its bounded size',
      retryable: false,
    });
  }
  const next = owners.map((owner) => ({ ...owner }));
  const currentValues = current ? managedFieldValues(current).values : new Map<string, string>();
  for (const path of desired.leaves) {
    for (const owner of next) {
      if (owner.manager === manager || !managedPathsOverlap(path, owner.fieldPath)) continue;
      const currentValue = currentValues.get(owner.fieldPath) ?? 'undefined';
      const proposedValue = desired.values.get(owner.fieldPath) ?? desired.values.get(path) ?? 'undefined';
      if (currentValue !== proposedValue && !options.force) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: `apply field '${path}' is owned by fieldManager '${owner.manager}'`,
          retryable: true,
          details: { fieldPath: path, owner: owner.manager, fieldManager: manager },
        });
      }
      if (options.force) owner.manager = manager;
    }
    const existing = next.find((owner) => owner.fieldPath === path);
    if (existing) existing.manager = manager;
    else next.push({ fieldPath: path, manager });
  }
  if (next.length > MAX_CONTROL_STORE_APPLY_OWNERSHIP_FIELDS) {
    throw new OrchestrationError({
      code: 'EXHAUSTED',
      message: 'apply field ownership set exceeded its bounded size',
      retryable: false,
    });
  }
  return next;
}
