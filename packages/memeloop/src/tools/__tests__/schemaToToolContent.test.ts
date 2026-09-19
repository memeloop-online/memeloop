import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { schemaToToolContent } from '../schemaToToolContent.js';

describe('schemaToToolContent', () => {
  it('renders tool content with parameters and examples', () => {
    const schema = z
      .object({
        q: z.string().describe('Query'),
        mode: z.enum(['a', 'b']).describe('Mode'),
        n: z.number().optional(),
      })
      .describe('Search tool')
      .refine((x) => x.q.length > 0, { message: 'q required' });

    // The JSON Schema converter reads title from .describe? We set it on the
    // object and keep the fallback path covered below.
    const titled = schema.describe('Search tool') as z.ZodType;
    // `.describe()` metadata is intentionally optional at the portable boundary.
    const content = schemaToToolContent(titled);

    expect(content).toContain('**Parameters**');
    expect(content).toContain('- q (string, required)');
    expect(content).toContain('- mode (string, required)');
  });

  it("falls back to 'tool' when title missing and handles no properties/examples", () => {
    const content = schemaToToolContent(z.string());
    expect(content).toContain('## tool');
    expect(content).toContain('**Parameters**');
  });
});
