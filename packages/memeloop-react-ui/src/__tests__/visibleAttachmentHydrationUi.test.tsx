import { act, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ChatMessage } from 'memeloop';
import React, { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemeLoopMessage } from '../chat/thread/MemeLoopMessage.js';
import type { MemeLoopVisibleAttachmentLoader } from '../chat/visibleAttachmentHydration.js';

const hash = `sha256:${'a'.repeat(64)}`;

function projectedMessage(messageId = 'image-message'): ChatMessage {
  return {
    messageId,
    turnId: messageId,
    conversationId: 'conversation',
    originNodeId: 'node',
    originSequence: 1,
    timestamp: 2,
    lamportClock: 3,
    role: 'user',
    content: 'durable image',
    metadata: {
      displayTruncation: {
        truncated: true,
        originalCharacterCount: 13,
        originalEstimatedBytes: 13,
        originalEstimatedRenderRows: 1,
        contentTruncated: false,
        omittedFields: ['attachments'],
        capability: 'detail',
      },
    },
  };
}

function successfulLoader(): MemeLoopVisibleAttachmentLoader {
  return vi.fn(async (request: Parameters<MemeLoopVisibleAttachmentLoader>[0]) => ({
    identity: request.identity,
    revision: request.revision,
    attachments: [{
      reference: { contentHash: hash, filename: 'visible.png', mimeType: 'image/png', size: 3 },
      source: { kind: 'bytes' as const, data: new Uint8Array([1, 2, 3]) },
    }],
  }));
}

type ObserverCallback = ConstructorParameters<typeof IntersectionObserver>[0];

class TestIntersectionObserver {
  public static readonly instances: TestIntersectionObserver[] = [];
  private readonly targets = new Set<Element>();

  public constructor(private readonly callback: ObserverCallback) {
    TestIntersectionObserver.instances.push(this);
  }

  public observe(target: Element) {
    this.targets.add(target);
  }

  public disconnect() {
    this.targets.clear();
  }

  public show(visible: boolean) {
    const entries = [...this.targets].map(target => ({ isIntersecting: visible, target }) as IntersectionObserverEntry);
    this.callback(entries, this as unknown as IntersectionObserver);
  }

  public unobserve(target: Element) {
    this.targets.delete(target);
  }

  public readonly root = null;
  public readonly rootMargin = '0px';
  public readonly thresholds = [0];
  public takeRecords = () => [];
}

async function showAll(visible = true) {
  await act(async () => {
    for (const observer of TestIntersectionObserver.instances) observer.show(visible);
  });
}

beforeEach(() => {
  TestIntersectionObserver.instances.length = 0;
  vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:visible-image') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('visible durable image hydration UI', () => {
  it('does not read an offscreen message and renders it after visibility', async () => {
    const loader = successfulLoader();
    render(<MemeLoopMessage message={projectedMessage()} loadVisibleAttachments={loader} />);
    await act(async () => Promise.resolve());
    expect(loader).not.toHaveBeenCalled();

    await showAll();
    const image = await screen.findByRole('img', { name: 'Attachment: visible.png' });
    expect(image).toHaveAttribute('src', 'blob:visible-image');
    expect(image).toHaveStyle({ cursor: 'default' });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    image.click();
    expect(open).not.toHaveBeenCalled();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith(expect.objectContaining({
      maxCount: 8,
      maxBytes: 16 * 1024 * 1024,
      references: [],
      referencesOmitted: true,
      signal: expect.any(AbortSignal),
    }));
  });

  it('deduplicates StrictMode and duplicate visible consumers', async () => {
    let resolve!: (value: Awaited<ReturnType<MemeLoopVisibleAttachmentLoader>>) => void;
    const loader = vi.fn((request: Parameters<MemeLoopVisibleAttachmentLoader>[0]) =>
      new Promise<Awaited<ReturnType<MemeLoopVisibleAttachmentLoader>>>(done => {
        resolve = value => {
          done(value);
        };
      }).then(() => ({
        identity: request.identity,
        revision: request.revision,
        attachments: [{
          reference: { contentHash: hash, filename: 'visible.png', mimeType: 'image/png', size: 3 },
          source: { kind: 'bytes' as const, data: new Uint8Array([1, 2, 3]) },
        }],
      }))
    );
    render(
      <StrictMode>
        <MemeLoopMessage message={projectedMessage()} loadVisibleAttachments={loader} />
        <MemeLoopMessage message={projectedMessage()} loadVisibleAttachments={loader} />
      </StrictMode>,
    );
    await showAll();
    await waitFor(() => {
      expect(loader).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      resolve(null);
    });
    expect(await screen.findAllByRole('img', { name: 'Attachment: visible.png' })).toHaveLength(2);
  });

  it('aborts exactly one shared request after the final consumer unmounts', async () => {
    let signal: AbortSignal | undefined;
    const loader = vi.fn((request: Parameters<MemeLoopVisibleAttachmentLoader>[0]) => {
      signal = request.signal;
      return new Promise<null>(() => {});
    });
    const view = render(
      <>
        <MemeLoopMessage message={projectedMessage()} loadVisibleAttachments={loader} />
        <MemeLoopMessage message={projectedMessage()} loadVisibleAttachments={loader} />
      </>,
    );
    await showAll();
    await waitFor(() => {
      expect(loader).toHaveBeenCalledTimes(1);
    });
    let abortCount = 0;
    signal?.addEventListener('abort', () => {
      abortCount += 1;
    });
    expect(signal?.aborted).toBe(false);
    view.unmount();
    await act(async () => Promise.resolve());
    expect(signal?.aborted).toBe(true);
    expect(abortCount).toBe(1);
  });

  it('revokes Web object URLs on unmount', async () => {
    const view = render(<MemeLoopMessage message={projectedMessage()} loadVisibleAttachments={successfulLoader()} />);
    await showAll();
    expect(await screen.findByTestId('message-image-attachment')).toBeInTheDocument();
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:visible-image');
  });

  it('revokes a partial Blob URL transaction and reports creation failure', async () => {
    const createObjectUrl = vi.mocked(URL.createObjectURL);
    createObjectUrl
      .mockReturnValueOnce('blob:first-image')
      .mockImplementationOnce(() => {
        throw new Error('object URL allocation failed');
      });
    const onError = vi.fn();
    const loader: MemeLoopVisibleAttachmentLoader = vi.fn(async (request: Parameters<MemeLoopVisibleAttachmentLoader>[0]) => ({
      identity: request.identity,
      revision: request.revision,
      attachments: [
        {
          reference: { contentHash: hash, filename: 'first.png', mimeType: 'image/png', size: 3 },
          source: { kind: 'bytes' as const, data: new Uint8Array([1, 2, 3]) },
        },
        {
          reference: { contentHash: `sha256:${'b'.repeat(64)}`, filename: 'second.png', mimeType: 'image/png', size: 3 },
          source: { kind: 'bytes' as const, data: new Uint8Array([4, 5, 6]) },
        },
      ],
    }));
    render(<MemeLoopMessage message={projectedMessage()} loadVisibleAttachments={loader} onAttachmentHydrationError={onError} />);
    await showAll();

    expect(await screen.findByText('Attachment preview could not be loaded.')).toBeInTheDocument();
    expect(createObjectUrl).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first-image');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'object URL allocation failed' }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('releases and revokes when hidden, then performs a fresh read when visible again', async () => {
    const loader = successfulLoader();
    render(<MemeLoopMessage message={projectedMessage()} loadVisibleAttachments={loader} />);
    await showAll();
    expect(await screen.findByRole('img', { name: 'Attachment: visible.png' })).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(1);

    await showAll(false);
    await waitFor(() => {
      expect(screen.queryByRole('img', { name: 'Attachment: visible.png' })).not.toBeInTheDocument();
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:visible-image');
    await act(async () => Promise.resolve());

    await showAll();
    expect(await screen.findByRole('img', { name: 'Attachment: visible.png' })).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it('rejects over-limit pages without creating a URL', async () => {
    const loader: MemeLoopVisibleAttachmentLoader = vi.fn(async (request: Parameters<MemeLoopVisibleAttachmentLoader>[0]) => ({
      identity: request.identity,
      revision: request.revision,
      attachments: Array.from({ length: request.maxCount + 1 }, (_, index) => ({
        reference: {
          contentHash: `sha256:${index.toString(16).padStart(64, '0')}`,
          filename: `${index}.png`,
          mimeType: 'image/png',
          size: 1,
        },
        source: { kind: 'bytes' as const, data: new Uint8Array([index]) },
      })),
    }));
    render(<MemeLoopMessage message={projectedMessage()} loadVisibleAttachments={loader} />);
    await showAll();
    expect(await screen.findByText('Attachment preview could not be loaded.')).toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
