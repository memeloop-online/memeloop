import { describe, expect, it } from 'vitest';

import { assertPromptPreviewGeneratedResult } from '../PromptPreviewAudit.js';

function generatedResult(text: string, caption?: string): unknown {
  return {
    flatPrompts: [{ role: 'system', content: text }],
    processedPrompts: [{
      id: 'generated-tool-prompt',
      text,
      ...(caption === undefined ? {} : { caption }),
      role: 'system',
    }],
  };
}

describe('prompt preview generated-result audit', () => {
  it('accepts Markdown tabs and line endings in generated prompt text', () => {
    expect(() => {
      assertPromptPreviewGeneratedResult(generatedResult(
        '# Tools\r\n\r\n\t- **Description**\n\t  Run safely',
      ));
    }).not.toThrow();
  });

  it.each(['\u0000', '\u0008', '\u000b', '\u000c', '\u001f', '\u007f'])(
    'rejects non-Markdown control character %j in generated prompt text',
    control => {
      expect(() => {
        assertPromptPreviewGeneratedResult(generatedResult(`before${control}after`));
      }).toThrowError(
        expect.objectContaining({ code: 'invalid_response' }),
      );
    },
  );

  it('keeps non-prompt labels control-character free', () => {
    expect(() => {
      assertPromptPreviewGeneratedResult(generatedResult('valid text', 'invalid\ncaption'));
    }).toThrowError(
      expect.objectContaining({ code: 'invalid_response' }),
    );
  });

  it('keeps the generated prompt text length bound', () => {
    expect(() => {
      assertPromptPreviewGeneratedResult(generatedResult('x'.repeat(1_000_001)));
    }).toThrowError(
      expect.objectContaining({ code: 'invalid_response' }),
    );
  });
});
