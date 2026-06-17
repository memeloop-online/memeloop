/**
 * Generate tool description for prompt injection from zod v4 schema definitions.
 */
import type { z } from 'zod';

export function schemaToToolContent(schema: z.ZodType) {
  const jsonSchema = (schema as unknown as { toJSONSchema?: () => Record<string, unknown> }).toJSONSchema?.() ??
    ({} as Record<string, unknown>);

  // zod v4 stores title/description/examples in .meta()
  const meta = Array.isArray((schema as unknown as { meta?: Array<Record<string, unknown>> }).meta)
    ? (schema as unknown as { meta?: Array<Record<string, unknown>> }).meta?.[0]
    : undefined;

  const title = (meta?.title as string) || (jsonSchema.title as string) || 'tool';
  const description = (meta?.description as string) || (jsonSchema.description as string) || '';
  const examples = (meta?.examples as Array<Record<string, unknown>>) ||
    (jsonSchema.examples as Array<Record<string, unknown>>) ||
    [];

  const props = jsonSchema.properties as Record<string, unknown> | undefined;
  const requiredArray = Array.isArray(jsonSchema.required) ? (jsonSchema.required as string[]) : [];

  let parameterLines = '';
  if (props) {
    parameterLines = Object.entries(props)
      .map(([key, value]) => {
        const p = value as Record<string, unknown> | undefined;
        const type = (p?.type as string) || 'string';
        const desc = (p?.description as string) || (p?.title as string) || '';
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
