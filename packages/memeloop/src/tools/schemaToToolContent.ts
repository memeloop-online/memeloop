/** Generate tool description for prompt injection from a portable tool schema. */

import type { ToolSchemaInput } from './defineToolTypes.js';
import { toolSchemaToJsonSchema } from './schemaRegistry.js';

export function schemaToToolContent(schema: ToolSchemaInput) {
  const jsonSchema = toolSchemaToJsonSchema(schema);

  // zod v4 stores title/description/examples in .meta()
  const meta = schemaMetadata(schema);
  const title = firstText(meta?.title, jsonSchema.title) || 'tool';
  const description = firstText(meta?.description, readDataProperty(schema, 'description'), jsonSchema.description) ||
    '';
  const examples = arrayOfRecords(meta?.examples ?? jsonSchema.examples);

  const props = recordValue(jsonSchema.properties);
  const requiredArray = stringArray(jsonSchema.required);

  let parameterLines = '';
  if (props) {
    parameterLines = Object.entries(props)
      .map(([key, value]) => {
        const p = recordValue(value);
        const type = firstText(p?.type) || 'string';
        const desc = firstText(p?.description, p?.title) || '';
        const required = requiredArray.includes(key) ? 'required' : 'optional';
        return `- ${key} (${type}, ${required}): ${desc}`;
      })
      .join('\n');
  }

  const exampleSection = examples
    .map((example) => `- <tool_use name="${title}">${JSON.stringify(example)}</tool_use>`)
    .join('\n');

  return `\n## ${title}\n**Description**: ${description}\n**Parameters**:\n${parameterLines}\n\n**Examples**:\n${exampleSection}\n`;
}

function schemaMetadata(schema: ToolSchemaInput): Record<string, unknown> | undefined {
  const candidate = readDataProperty(schema, 'meta');
  let value: unknown = candidate;
  if (typeof candidate === 'function') {
    try {
      value = Reflect.apply(candidate, schema, []);
    } catch (error) {
      throw new TypeError('Tool schema metadata lookup failed', { cause: error });
    }
  }
  if (isRecord(value)) return value;
  return Array.isArray(value) && isRecord(value[0]) ? value[0] : undefined;
}

function readDataProperty(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return undefined;
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch (error) {
    throw new TypeError('Tool schema metadata lookup failed', { cause: error });
  }
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
