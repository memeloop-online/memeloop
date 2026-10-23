/**
 * Conditional field visibility logic.
 * Platform-agnostic: pure function used by ConditionalField component.
 */

/**
 * Configuration for conditional field display.
 * Used with ConditionalField to show/hide fields based on sibling field values.
 */
export interface ConditionalFieldConfig {
  dependsOn: string;
  showWhen: string | string[];
  hideWhen?: boolean;
}

/** The only path representations accepted at this boundary. */
export type RjsfFieldPath = readonly (string | number)[] | string;

/**
 * Normalize a public RJSF field path to object/array segments.
 *
 * RJSF exposes `fieldPathId.path` as the canonical segment array. A dotted
 * string is accepted for callers that use the public `SchemaFieldPath` form;
 * underscore-delimited DOM ids are deliberately not parsed because they are
 * ambiguous when property names themselves contain underscores.
 */
function parseCanonicalFieldPath(fieldPath: RjsfFieldPath | undefined): string[] | undefined {
  if (Array.isArray(fieldPath)) {
    const segments: string[] = [];
    for (const segment of fieldPath) {
      if (typeof segment === 'string') {
        if (segment.length === 0) return undefined;
        segments.push(segment);
      } else if (Number.isSafeInteger(segment) && segment >= 0) {
        segments.push(String(segment));
      } else {
        return undefined;
      }
    }
    return segments;
  }

  if (typeof fieldPath !== 'string') return undefined;
  const trimmed = fieldPath.trim();
  if (trimmed.length === 0) return undefined;
  const parts = trimmed.split('.');
  if (parts[0] === 'root') parts.shift();
  if (parts.some(part => part.length === 0)) return undefined;
  return parts;
}

/**
 * Convert a canonical RJSF path into string segments for data traversal.
 * Invalid paths return an empty array; visibility evaluation uses the
 * internal parser below so malformed paths fail closed rather than being
 * mistaken for the root object.
 */
export function rjsfFieldPathToSegments(fieldPath: RjsfFieldPath | undefined): string[] {
  return parseCanonicalFieldPath(fieldPath) ?? [];
}

function getAtPath(root: unknown, segments: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

/**
 * Resolves a field path to the parent object in rootFormData and the dependent field value.
 */
function getParentAndDependentValue(
  rootFormData: Record<string, unknown>,
  fieldPath: RjsfFieldPath | undefined,
  dependsOn: string,
): unknown {
  const segments = parseCanonicalFieldPath(fieldPath);
  if (!segments || dependsOn.length === 0) return undefined;
  const parent = getAtPath(rootFormData, segments.slice(0, -1));
  if (parent === null || typeof parent !== 'object') return undefined;
  return (parent as Record<string, unknown>)[dependsOn];
}

/**
 * Computes whether a conditional field should be visible.
 *
 * @param condition - ui:condition from uiSchema
 * @param rootFormData - full form data (from formContext)
 * @param fieldPathId - canonical RJSF field path (`fieldPathId.path` or a dotted path)
 * @returns true if the field should be shown
 */
export function shouldShowConditionalField(
  condition: ConditionalFieldConfig | undefined,
  rootFormData: Record<string, unknown> | undefined,
  fieldPathId: RjsfFieldPath | undefined,
): boolean {
  if (!condition) return true;
  if (!rootFormData) return true;
  if (typeof condition.dependsOn !== 'string' || condition.dependsOn.length === 0) return false;
  if (!parseCanonicalFieldPath(fieldPathId)) return false;

  const { dependsOn, showWhen, hideWhen = false } = condition;
  const dependentValue = getParentAndDependentValue(rootFormData, fieldPathId, dependsOn);
  const conditionMet = Array.isArray(showWhen)
    ? showWhen.includes(String(dependentValue))
    : dependentValue === showWhen;

  return hideWhen ? !conditionMet : conditionMet;
}
