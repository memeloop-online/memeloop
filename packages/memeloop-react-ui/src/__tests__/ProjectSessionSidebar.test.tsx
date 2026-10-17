import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';

import { ProjectSessionSidebar } from '../components/ProjectSessionSidebar';

describe('ProjectSessionSidebar responsive width', () => {
  it('uses an explicit host width without leaking the styling prop to the DOM', () => {
    render(<ProjectSessionSidebar projects={[]} sidebarWidth={240} />);

    const sidebar = screen.getByTestId('main-sidebar');
    expect(sidebar).not.toHaveAttribute('$sidebarWidth');
    expect(globalThis.getComputedStyle(sidebar).width).toBe('240px');
    expect(globalThis.getComputedStyle(sidebar).maxWidth).toBe('100%');
    expect(globalThis.getComputedStyle(sidebar).minWidth).toBe('0');
  });

  it('defaults to a 200 pixel preferred width', () => {
    render(<ProjectSessionSidebar projects={[]} />);
    expect(globalThis.getComputedStyle(screen.getByTestId('main-sidebar')).width).toBe('200px');
  });
});

afterEach(() => {
  cleanup();
});
