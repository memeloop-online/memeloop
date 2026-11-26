import { useEffect, useRef, useState } from 'react';

export type WikiTextRenderer = (text: string, signal: AbortSignal) => Promise<string | undefined>;

const WIKITEXT_PREVIEW_INTERVAL_MS = 220;

interface PreviewInput {
  text: string;
  revision: number;
  streaming: boolean;
}

function sameSource(previous: PreviewInput | undefined, current: PreviewInput) {
  return previous?.text === current.text && previous.revision === current.revision;
}

function createPreviewQueue(
  render: WikiTextRenderer,
  publish: (html: string | undefined) => void,
  reportError: (error: unknown) => void,
) {
  const lifetime = new AbortController();
  let latest: PreviewInput | undefined;
  let processed: PreviewInput | undefined;
  let succeeded = false;
  let nextStart = 0;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function drain() {
    if (running || !latest || lifetime.signal.aborted) return;
    if (sameSource(processed, latest) && (succeeded || processed?.streaming === latest.streaming)) return;
    const wait = latest.streaming ? nextStart - Date.now() : 0;
    if (wait > 0) {
      timer = setTimeout(drain, wait);
      return;
    }
    const input = latest;
    processed = input;
    succeeded = false;
    running = true;
    nextStart = Date.now() + WIKITEXT_PREVIEW_INTERVAL_MS;
    void (async () => {
      try {
        const html = await render(input.text, lifetime.signal);
        succeeded = html !== undefined;
        if (!lifetime.signal.aborted) publish(html);
      } catch (error) {
        if (!lifetime.signal.aborted) {
          publish(undefined);
          reportError(error);
        }
      } finally {
        running = false;
        drain();
      }
    })();
  }

  return {
    update(input: PreviewInput) {
      clearTimeout(timer);
      latest = input;
      drain();
    },
    close() {
      lifetime.abort();
      clearTimeout(timer);
    },
  };
}

export function useWikiTextPreview(
  render: WikiTextRenderer | undefined,
  text: string,
  streaming: boolean,
  revision: number,
  onError: ((error: unknown) => void) | undefined,
) {
  const queue = useRef<ReturnType<typeof createPreviewQueue> | undefined>(undefined);
  const errorHandler = useRef(onError);
  const [preview, setPreview] = useState<{ renderer: WikiTextRenderer; html: string | undefined }>();

  useEffect(() => {
    errorHandler.current = onError;
  }, [onError]);

  useEffect(() => {
    if (!render) return;
    const active = createPreviewQueue(
      render,
      html => {
        setPreview(previous => html === undefined && previous?.renderer === render ? previous : { renderer: render, html });
      },
      (error: unknown) => errorHandler.current?.(error),
    );
    queue.current = active;
    return () => {
      queue.current = undefined;
      active.close();
    };
  }, [render]);

  useEffect(() => {
    queue.current?.update({ text, streaming, revision });
  }, [render, revision, streaming, text]);

  return preview?.renderer === render ? preview : undefined;
}
