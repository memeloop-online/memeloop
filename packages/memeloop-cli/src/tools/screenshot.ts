/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */

/**
 * Screenshot tool: Capture screenshots of local applications or URLs
 * Inspired by Cursor 3's demo/screenshot feature for result verification
 */

import type { IToolRegistry } from 'memeloop';
import { MEMELOOP_STRUCTURED_TOOL_KEY } from 'memeloop';

export interface ScreenshotParameters {
  url: string;
  selector?: string;
  fullPage?: boolean;
  waitForSelector?: string;
  timeout?: number;
}

export interface ScreenshotResult {
  success: boolean;
  imageBase64?: string;
  contentHash?: string;
  width?: number;
  height?: number;
  bytes?: number;
  error?: string;
}

export const screenshotToolSchema = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      minLength: 1,
      description: 'HTTP(S) URL to capture',
    },
    selector: { type: 'string', minLength: 1 },
    fullPage: { type: 'boolean' },
    waitForSelector: { type: 'string', minLength: 1 },
    timeout: { type: 'integer', minimum: 1, maximum: 120_000 },
  },
  required: ['url'],
  additionalProperties: false,
} as const;

/**
 * Take a screenshot using puppeteer (headless Chrome)
 * Returns base64-encoded PNG image
 */
export async function takeScreenshot(parameters: ScreenshotParameters): Promise<ScreenshotResult> {
  try {
    // Dynamic import to avoid bundling puppeteer if not used
    const puppeteerModule = await import('puppeteer').catch(() => null);
    const puppeteer = puppeteerModule && typeof puppeteerModule === 'object' && 'launch' in puppeteerModule
      ? puppeteerModule
      : puppeteerModule &&
          typeof puppeteerModule === 'object' &&
          puppeteerModule.default &&
          typeof puppeteerModule.default === 'object' &&
          'launch' in puppeteerModule.default
      ? puppeteerModule.default
      : puppeteerModule &&
          typeof puppeteerModule === 'object' &&
          puppeteerModule.default &&
          typeof puppeteerModule.default === 'object' &&
          'default' in puppeteerModule.default &&
          puppeteerModule.default.default &&
          typeof puppeteerModule.default.default === 'object' &&
          'launch' in puppeteerModule.default.default
      ? puppeteerModule.default.default
      : null;

    if (!puppeteer) {
      return {
        success: false,
        error: 'puppeteer not installed. Run: npm install puppeteer',
      };
    }

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });

      // Navigate to URL
      await page.goto(parameters.url, {
        waitUntil: 'networkidle2',
        timeout: parameters.timeout ?? 30000,
      });

      // Wait for specific selector if provided
      if (parameters.waitForSelector) {
        await page.waitForSelector(parameters.waitForSelector, {
          timeout: parameters.timeout ?? 30000,
        });
      }

      // Take screenshot
      let screenshotBuffer: Buffer;
      if (parameters.selector) {
        // Screenshot specific element
        const element = await page.$(parameters.selector);
        if (!element) {
          return {
            success: false,
            error: `Selector not found: ${parameters.selector}`,
          };
        }
        screenshotBuffer = (await element.screenshot({ type: 'png' })) as Buffer;
      } else {
        // Screenshot full page or viewport
        screenshotBuffer = (await page.screenshot({
          type: 'png',
          fullPage: parameters.fullPage ?? false,
        })) as Buffer;
      }

      // Convert to base64
      const imageBase64 = screenshotBuffer.toString('base64');

      // Calculate content hash for deduplication
      const crypto = await import('node:crypto');
      const contentHash = crypto.createHash('sha256').update(screenshotBuffer).digest('hex');

      return {
        success: true,
        imageBase64,
        contentHash,
        width: 1920,
        height: 1080,
        bytes: screenshotBuffer.length,
      };
    } finally {
      await browser.close();
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Register screenshot tool in the tool registry
 */
export function registerScreenshotTool(registry: IToolRegistry): void {
  registry.registerTool(
    'screenshot',
    async (arguments_: Record<string, unknown>) => {
      const url = typeof arguments_.url === 'string' ? arguments_.url.trim() : '';
      if (!url) {
        return { error: "Missing required 'url' parameter" };
      }

      const typedParameters: ScreenshotParameters = {
        url,
        selector: typeof arguments_.selector === 'string' ? arguments_.selector : undefined,
        fullPage: typeof arguments_.fullPage === 'boolean' ? arguments_.fullPage : undefined,
        waitForSelector: typeof arguments_.waitForSelector === 'string'
          ? arguments_.waitForSelector
          : undefined,
        timeout: typeof arguments_.timeout === 'number' ? arguments_.timeout : undefined,
      };

      const result = await takeScreenshot(typedParameters);

      if (!result.success) {
        return {
          error: result.error,
          suggestion: 'Make sure the URL is accessible and puppeteer is installed',
        };
      }

      return {
        ok: true,
        success: true,
        message: `Screenshot captured successfully (${result.width}x${result.height})`,
        contentHash: result.contentHash,
        width: result.width,
        height: result.height,
        bytes: result.bytes,
        imageBase64: result.imageBase64,
        [MEMELOOP_STRUCTURED_TOOL_KEY]: {
          summary: `Screenshot captured for ${typedParameters.url} ` +
            `(${result.width ?? '?'}x${result.height ?? '?'}, ` +
            `${result.bytes ?? 0} bytes, hash=${result.contentHash ?? 'unknown'})`,
        },
      };
    },
    screenshotToolSchema,
  );
}
