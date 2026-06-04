/**
 * TidGi `schemaToToolContent.ts` 迁移：无 i18n，英文标签；使用 zod-to-json-schema。
 */
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export function schemaToToolContent(schema: z.ZodType) {
  // zod-to-json-schema 的 target 字面量随版本变化；运行时与 Desktop 行为一致即可
  const schemaUnknown: unknown = zodToJsonSchema(schema as z.ZodTypeAny);

  let parameterLines = '';
  let schemaTitle = '';
  let schemaDescription = '';

  if (schemaUnknown && typeof schemaUnknown === 'object' && schemaUnknown !== null) {
    const s = schemaUnknown as Record<string, unknown>;
    schemaTitle = s.title && typeof s.title === 'string' ? s.title : '';
    schemaDescription = s.description && typeof s.description === 'string' ? s.description : '';
    const props = s.properties as Record<string, unknown> | undefined;
    const requiredArray = Array.isArray(s.required) ? (s.required as string[]) : [];
    if (props) {
      parameterLines = Object.keys(props)
        .map((key) => {
          const property = props[key] as Record<string, unknown> | undefined;
          let type = property && typeof property.type === 'string' ? property.type : 'string';
          let desc = '';
          if (property) {
            if (typeof property.description === 'string') {
              desc = property.description;
            } else if (property.title && typeof property.title === 'string') {
              desc = property.title;
            }
            if (property.enum && Array.isArray(property.enum)) {
              const enumValues = property.enum.map((value) => `"${String(value)}"`).join(', ');
              desc = desc ? `${desc} (${enumValues})` : `Options: ${enumValues}`;
              type = 'enum';
            }
          }
          const required = requiredArray.includes(key) ? 'required' : 'optional';
          return `- ${key} (${type}, ${required}): ${desc}`;
        })
        .join('\n');
    }
  }

  const toolId = schemaUnknown && typeof schemaUnknown === 'object' && schemaUnknown !== null && (schemaUnknown as Record<string, unknown>).title
    ? String((schemaUnknown as Record<string, unknown>).title)
    : 'tool';

  let exampleSection = '';
  if (schemaUnknown && typeof schemaUnknown === 'object' && schemaUnknown !== null) {
    const s = schemaUnknown as Record<string, unknown>;
    const ex = s.examples;
    if (Array.isArray(ex)) {
      exampleSection = ex
        .map((exampleItem) => `- <tool_use name="${toolId}">${JSON.stringify(exampleItem)}</tool_use>`)
        .join('\n');
    }
  }

  const finalDescription = schemaDescription || schemaTitle;
  const content = `\n## ${toolId}\n**Description**: ${finalDescription}\n**Parameters**:\n${parameterLines}\n\n**Examples**:\n${exampleSection}\n`;
  return content;
}
