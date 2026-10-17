import { describe, expect, it } from 'vitest';
import { sanitizedSdkStreamError, translateSdkFullStream } from '../sdkStreamTranslator.js';

describe('SDK stream failure classification', () => {
  it.each([401, 403, 404, 429, 503])('preserves HTTP %i from error chunks without retaining sensitive data', async statusCode => {
    async function* source() {
      yield { type: 'error', error: { lastError: { statusCode, message: 'private prompt', responseBody: 'secret' } } };
    }
    let failure: unknown;
    try {
      for await (const _part of translateSdkFullStream(source())) { /* drain */ }
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ statusCode, message: 'The model stream failed' });
    expect(JSON.stringify(failure)).not.toMatch(/private|secret/);
    expect(failure).not.toHaveProperty('cause');
  });

  it('does not call getters or follow cycles', () => {
    const error = {
      cause: undefined as unknown,
      get statusCode(): number {
        throw new Error('getter called');
      },
    };
    error.cause = error;
    expect(sanitizedSdkStreamError(error)).not.toHaveProperty('statusCode');
  });
});
