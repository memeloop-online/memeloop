import { it } from 'vitest';

it('imports re-export/index modules for coverage', async () => {
  // These modules are mostly re-exports; importing them ensures they get counted by coverage.
  await import('../index.js');
  await import('../auth/index.js');
  await import('../knowledge/index.js');
  await import('../terminal/index.js');
});
