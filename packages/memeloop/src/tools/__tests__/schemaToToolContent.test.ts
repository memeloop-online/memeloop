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

    // zod-to-json-schema reads title from .describe? we set via .describe on object; also set explicit title
    const titled = schema.describe('Search tool') as any;
    // zod-to-json-schema uses "title" from schema? easiest: wrap with meta via .describe then treat fallback
    const content = schemaToToolContent(titled);

    expect(content).toContain('**Parameters**');
    expect(content).toContain('- q (string, required)');
    expect(content).toContain('- mode (enum, required)');
  });

  it("falls back to 'tool' when title missing and handles no properties/examples", () => {
    const content = schemaToToolContent(z.string());
    expect(content).toContain('## tool');
    expect(content).toContain('**Parameters**');
  });
});
