import { describe, expect, it, vi } from 'vitest';

import { imSwitchConversation, imToolDefinitions } from '../tools.js';

describe('im tools', () => {
  it('imToolDefinitions exposes basic tool metadata', () => {
    expect(imToolDefinitions.length).toBeGreaterThan(0);
    expect(imToolDefinitions.map((d) => d.name)).toContain('im.switchConversation');
  });

  it('imSwitchConversation delegates to manager.switchConversation', async () => {
    const switchConversation = vi.fn().mockResolvedValue(undefined);
    await imSwitchConversation(
      {
        channelId: 'c1',
        imUserId: 'u1',
        manager: { switchConversation } as any,
        driver: {} as any,
        defaultDefinitionId: 'd1',
      },
      'conv-1',
    );
    expect(switchConversation).toHaveBeenCalledWith('c1', 'u1', 'conv-1');
  });
});
