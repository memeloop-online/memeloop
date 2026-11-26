import type { AgentModelParameters, ModelCatalogModel } from 'memeloop';

export type ReasoningEffortLabels = Record<NonNullable<AgentModelParameters['reasoningEffort']>, string>;

const reasoningEffortLabels: Record<string, ReasoningEffortLabels> = {
  en: { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High' },
  'zh-Hans': { minimal: '最低', low: '低', medium: '中', high: '高' },
  'zh-Hant': { minimal: '最低', low: '低', medium: '中', high: '高' },
  ja: { minimal: '最小', low: '低', medium: '中', high: '高' },
  fr: { minimal: 'Minimal', low: 'Faible', medium: 'Moyen', high: 'Élevé' },
  ru: { minimal: 'Минимальный', low: 'Низкий', medium: 'Средний', high: 'Высокий' },
};

/** Display labels only; parameter values remain provider-compatible enum values. */
export function getReasoningEffortLabels(locale = 'en'): ReasoningEffortLabels {
  if (/^zh(?:-|_|$)/i.test(locale)) {
    return reasoningEffortLabels[/hant|tw|hk|mo/i.test(locale) ? 'zh-Hant' : 'zh-Hans'];
  }
  return reasoningEffortLabels[locale.split(/[-_]/)[0].toLowerCase()] ?? reasoningEffortLabels.en;
}

export interface ModelParameterLabels {
  reasoningEffort: string;
  temperature: string;
  maxOutputTokens: string;
  defaultValue: string;
  unavailable: string;
}

export const defaultModelParameterLabels: ModelParameterLabels = {
  reasoningEffort: 'Reasoning effort',
  temperature: 'Temperature',
  maxOutputTokens: 'Maximum output tokens',
  defaultValue: 'Model default',
  unavailable: 'No adjustable parameters available for this model.',
};

export interface ModelParameterFieldsProps {
  model?: ModelCatalogModel;
  value: AgentModelParameters;
  onChange: (value: AgentModelParameters) => void;
  disabled?: boolean;
  labels?: Partial<ModelParameterLabels>;
  reasoningEffortLabels?: Partial<ReasoningEffortLabels>;
}

export type ModelParameterField =
  | { key: 'reasoningEffort'; options: NonNullable<ModelCatalogModel['reasoningEfforts']> }
  | { key: 'temperature'; min: number; max: number; step: number }
  | { key: 'maxOutputTokens'; min: number; max: number; step: number };

/** Optional controls require positive catalog evidence; unknown capabilities stay hidden. */
export function getModelParameterFields(model?: ModelCatalogModel): ModelParameterField[] {
  if (!model) return [];
  const fields: ModelParameterField[] = [];
  if (model.reasoning && model.reasoningEfforts?.length) {
    fields.push({ key: 'reasoningEffort', options: model.reasoningEfforts });
  }
  if (model.temperature === true) fields.push({ key: 'temperature', min: 0, max: 2, step: 0.1 });
  if (model.limit?.output && Number.isSafeInteger(model.limit.output) && model.limit.output > 0) {
    fields.push({ key: 'maxOutputTokens', min: 1, max: model.limit.output, step: 1 });
  }
  return fields;
}

/** A field edit preserves all other settings, including settings not exposed by this catalog. */
export function updateModelParameter(
  value: AgentModelParameters,
  field: ModelParameterField,
  raw: string,
): AgentModelParameters {
  const next = { ...value };
  if (raw === '') {
    delete next[field.key];
  } else if (field.key === 'reasoningEffort') {
    const effort = field.options.find(option => option === raw);
    if (effort === undefined) return value;
    next.reasoningEffort = effort;
  } else {
    const number = Number(raw);
    if (!Number.isFinite(number) || number < field.min || number > field.max) return value;
    if (field.key === 'maxOutputTokens' && !Number.isSafeInteger(number)) return value;
    next[field.key] = number;
  }
  return next;
}
