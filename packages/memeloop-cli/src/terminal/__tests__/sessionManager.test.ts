import { describe, expect, it } from 'vitest';

import { TerminalSessionManager } from '../sessionManager.js';

describe('TerminalSessionManager follow', () => {
  it('streams chunks with seq and supports follow from seq', async () => {
    const manager = new TerminalSessionManager({ maxChunksPerSession: 2000 });
    const { sessionId } = await manager.start({
      command: 'node',
      args: ['-e', "console.log('a'); console.log('b');"],
    });

    const first = await manager.follow(sessionId, { fromSeq: 1, untilExit: true, maxWaitMs: 10_000 });
    expect(first.done).toBe(true);
    expect(first.chunks.length).toBeGreaterThan(0);
    expect(first.chunks[0]?.seq).toBeGreaterThanOrEqual(1);

    const next = await manager.follow(sessionId, { fromSeq: first.nextSeq, untilExit: false, maxWaitMs: 10 });
    expect(next.chunks).toEqual([]);
  });

  it('waits for initial chunks when untilExit=false', async () => {
    const manager = new TerminalSessionManager({ maxChunksPerSession: 2000 });
    const { sessionId } = await manager.start({
      command: 'node',
      args: ['-e', "console.log('hello-fast')"],
    });

    const r = await manager.follow(sessionId, { fromSeq: 1, untilExit: false, maxWaitMs: 5000 });
    expect(r.chunks.map((c) => c.data).join('')).toContain('hello-fast');
  });

  it('supports timeout follow and later resume', async () => {
    const manager = new TerminalSessionManager({ maxChunksPerSession: 2000 });
    const { sessionId } = await manager.start({
      command: 'node',
      args: ['-e', "setTimeout(()=>console.log('late'), 1200);"],
    });
    const early = await manager.follow(sessionId, { fromSeq: 1, untilExit: false, maxWaitMs: 200 });
    expect(early.chunks).toEqual([]);
    const late = await manager.follow(sessionId, { fromSeq: early.nextSeq, untilExit: true, maxWaitMs: 5000 });
    expect(late.done).toBe(true);
    expect(late.chunks.map((c) => c.data).join('')).toContain('late');
  });

  it('supports cancel and status transition', async () => {
    const manager = new TerminalSessionManager({ maxChunksPerSession: 2000 });
    const { sessionId } = await manager.start({
      command: 'node',
      args: ['-e', "setInterval(()=>console.log('tick'), 100);"],
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await manager.cancel(sessionId);
    const info = manager.get(sessionId);
    expect(info?.status).toBe('killed');
  });

  it('isolates concurrent sessions', async () => {
    const manager = new TerminalSessionManager({ maxChunksPerSession: 2000 });
    const s1 = await manager.start({ command: 'node', args: ['-e', "console.log('S1');"] });
    const s2 = await manager.start({ command: 'node', args: ['-e', "console.log('S2');"] });
    const r1 = await manager.follow(s1.sessionId, { untilExit: true, maxWaitMs: 5000 });
    const r2 = await manager.follow(s2.sessionId, { untilExit: true, maxWaitMs: 5000 });
    expect(r1.chunks.map((c) => c.data).join('')).toContain('S1');
    expect(r1.chunks.map((c) => c.data).join('')).not.toContain('S2');
    expect(r2.chunks.map((c) => c.data).join('')).toContain('S2');
    expect(r2.chunks.map((c) => c.data).join('')).not.toContain('S1');
  });

  it('throws on missing session for follow/respond and returns empty chunks for unknown session', async () => {
    const manager = new TerminalSessionManager();
    await expect(manager.follow('missing', { untilExit: false, maxWaitMs: 10 })).rejects.toThrow('Session not found');
    await expect(manager.respond('missing', 'x')).rejects.toThrow('Session not found');
    expect(manager.getChunksSince('missing', 1)).toEqual([]);
  });

  it('emits prompt via regex and idle timeout', async () => {
    const manager = new TerminalSessionManager();
    const prompts: string[] = [];
    const off = manager.onInteractionPrompt((p) => prompts.push(p.promptText));

    const { sessionId } = await manager.start({
      command: 'node',
      args: ['-e', "console.log('Password:'); setTimeout(()=>process.exit(0), 120);"],
      promptPatterns: [{ name: 'pw', regex: /Password:/ }],
      idleTimeoutMs: 80,
    });

    await manager.follow(sessionId, { untilExit: true, maxWaitMs: 2000 });
    expect(prompts.length).toBeGreaterThan(0);
    off();
    await manager.cancel(sessionId);
  });

  it('respond throws when session is not writable (status != running)', async () => {
    const manager = new TerminalSessionManager();
    const { sessionId } = await manager.start({
      command: 'node',
      args: ['-e', "console.log('done-now');"],
    });
    await manager.follow(sessionId, { untilExit: true, maxWaitMs: 5000 });
    await expect(manager.respond(sessionId, 'x')).rejects.toThrow('Session not writable');
  });

  it('cancel clears idleTimer when scheduled', async () => {
    const manager = new TerminalSessionManager();
    const { sessionId } = await manager.start({
      command: 'node',
      args: ['-e', 'setTimeout(()=>{}, 5000);'],
      idleTimeoutMs: 2000,
    });
    // Cancel before idle timeout fires: should clear idleTimer branch.
    await new Promise((r) => setTimeout(r, 100));
    await manager.cancel(sessionId);
    const info = manager.get(sessionId);
    expect(info?.status).toBe('killed');
  });

  it('covers listener registration/unregistration helpers', async () => {
    const manager = new TerminalSessionManager();
    const offOut = manager.onOutput((_c) => {});
    offOut();
    const offStatus = manager.onStatusUpdate((_u) => {});
    offStatus();
    const offPrompt = manager.onInteractionPrompt((_p) => {});
    offPrompt();
  });
});
