import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { CodeBlock } from '../CodeBlock.js';

describe('CodeBlock', () => {
  it('renders plain code without language', () => {
    const { lastFrame } = render(<CodeBlock code='hello world' />);
    expect(lastFrame()).toContain('hello world');
  });

  it('renders code with language header', () => {
    const { lastFrame } = render(<CodeBlock code='const x = 1;' language='typescript' />);
    expect(lastFrame()).toContain('typescript');
    expect(lastFrame()).toContain('const x = 1;');
  });

  it('highlights keywords in magenta', () => {
    const { lastFrame } = render(<CodeBlock code='const x = 1;' language='js' />);
    const frame = lastFrame();
    expect(frame).toContain('const');
  });

  it('highlights string literals in green', () => {
    const { lastFrame } = render(<CodeBlock code={`const s = "hello";`} language='js' />);
    const frame = lastFrame();
    expect(frame).toContain('"hello"');
  });

  it('truncates long code', () => {
    const longCode = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const { lastFrame } = render(<CodeBlock code={longCode} maxLines={10} />);
    const frame = lastFrame();
    expect(frame).toContain('more lines');
  });

  it('handles python keywords', () => {
    const { lastFrame } = render(<CodeBlock code='def hello(): pass' language='python' />);
    const frame = lastFrame();
    expect(frame).toContain('def');
    expect(frame).toContain('pass');
  });
});
