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

function legacyUnderscoreSegments(raw: string): string[] {
  const segments: string[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === "_") {
      i++;
      continue;
    }
    const rest = raw.slice(i);
    const numMatch = /^(\d+)(?=_|$)/.exec(rest);
    if (numMatch) {
      segments.push(numMatch[1]);
      i += numMatch[0].length;
      continue;
    }
    const boundary = rest.search(/_(?=\d+(?:_|$))/);
    const len = boundary === -1 ? rest.length : boundary;
    const chunk = rest.slice(0, len);
    if (chunk.length) {
      segments.push(chunk);
    }
    i += len;
  }
  return segments;
}

/**
 * 在已知表单数据上解析路径：按当前对象的键名做最长前缀匹配（解决 model_config 与 max_tokens 等歧义）。
 */
function underscoreSegmentsWithFormData(
  raw: string,
  rootFormData: Record<string, unknown>,
): string[] {
  const segments: string[] = [];
  let rest = raw;
  let cur: unknown = rootFormData;
  while (rest.length) {
    if (Array.isArray(cur)) {
      const numMatch = /^(\d+)(?:_|$)/.exec(rest);
      if (numMatch) {
        segments.push(numMatch[1]);
        rest = rest.slice(numMatch[0].length).replace(/^_/, "");
        cur = cur[Number(numMatch[1])];
        continue;
      }
      segments.push(rest);
      break;
    }
    if (cur != null && typeof cur === "object") {
      const keys = Object.keys(cur as Record<string, unknown>).sort((a, b) => b.length - a.length);
      let matched = false;
      for (const k of keys) {
        if (rest === k) {
          segments.push(k);
          rest = "";
          matched = true;
          break;
        }
        if (rest.startsWith(`${k}_`)) {
          segments.push(k);
          rest = rest.slice(k.length + 1);
          cur = (cur as Record<string, unknown>)[k];
          matched = true;
          break;
        }
      }
      if (matched) {
        continue;
      }
    }
    segments.push(rest);
    break;
  }
  return segments;
}

/**
 * RJSF `fieldPathId` 下划线路径拆成段：整型段为数组下标；属性名可含下划线（如 model_config）。
 * 亦支持点分路径 `root.model_config.max`（若上游传入）。
 * 若传入 `rootFormData`，对下划线路径用对象键做消歧（推荐）。
 */
export function rjsfFieldPathToSegments(
  fieldPath: string,
  rootFormData?: Record<string, unknown>,
): string[] {
  const trimmed = fieldPath.trim();
  if (trimmed.includes(".")) {
    return trimmed
      .replace(/^root\.?/, "")
      .split(".")
      .filter(Boolean);
  }
  const raw = trimmed.replace(/^root_?/, "");
  if (rootFormData) {
    return underscoreSegmentsWithFormData(raw, rootFormData);
  }
  return legacyUnderscoreSegments(raw);
}

function getAtPath(root: unknown, segments: string[]): unknown {
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur == null || typeof cur !== "object") {
      return undefined;
    }
    if (/^\d+$/.test(seg) && Array.isArray(cur)) {
      cur = cur[Number(seg)];
    } else {
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

/**
 * Resolves a field path to the parent object in rootFormData and the dependent field value.
 */
function getParentAndDependentValue(
  rootFormData: Record<string, unknown>,
  fieldPath: string,
  dependsOn: string,
): unknown {
  const segments = rjsfFieldPathToSegments(fieldPath, rootFormData);
  const parentSegments = segments.slice(0, -1);
  const parent = getAtPath(rootFormData, parentSegments);
  if (parent == null || typeof parent !== "object") {
    return undefined;
  }
  return (parent as Record<string, unknown>)[dependsOn];
}

/**
 * Computes whether a conditional field should be visible.
 *
 * @param condition - ui:condition from uiSchema
 * @param rootFormData - full form data (from formContext)
 * @param fieldPathId - RJSF field path (e.g. from fieldPathId.$id)
 * @returns true if the field should be shown
 */
export function shouldShowConditionalField(
  condition: ConditionalFieldConfig | undefined,
  rootFormData: Record<string, unknown> | undefined,
  fieldPathId: string | undefined,
): boolean {
  if (!condition) return true;
  if (!rootFormData) return true;

  const { dependsOn, showWhen, hideWhen = false } = condition;
  const fieldPath = typeof fieldPathId === "string" ? fieldPathId : "";

  const dependentValue = getParentAndDependentValue(rootFormData, fieldPath, dependsOn);
  let conditionMet: boolean;

  if (Array.isArray(showWhen)) {
    conditionMet = showWhen.includes(String(dependentValue));
  } else {
    conditionMet = dependentValue === showWhen;
  }

  return hideWhen ? !conditionMet : conditionMet;
}
