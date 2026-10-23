import {
  MAX_PROMPT_PREVIEW_AUDIT_DETAIL_CHUNK_BYTES,
  MAX_PROMPT_PREVIEW_AUDIT_PAGE_BYTES,
  MAX_PROMPT_PREVIEW_AUDIT_PAGE_ENTRIES,
  type PromptPreviewAuditDetailTarget,
} from 'memeloop';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PromptExecutionInspectorProps } from './promptInspection.js';

export function usePromptExecutionInspection({ audit, controller }: PromptExecutionInspectorProps) {
  const [page, setPage] = useState(audit.initialPage);
  const [detail, setDetail] = useState<{
    target: PromptPreviewAuditDetailTarget;
    text: string;
    nextCursor?: string;
  }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setPage(audit.initialPage);
    setDetail(undefined);
    setLoading(false);
    setError(false);
    return () => {
      generation.current += 1;
    };
  }, [audit]);

  const closeDetail = useCallback(() => {
    generation.current += 1;
    setDetail(undefined);
    setLoading(false);
    setError(false);
  }, []);

  const loadPage = useCallback(async (direction: 'before' | 'after') => {
    const cursor = direction === 'before' ? page.previousCursor : page.nextCursor;
    if (!cursor) return;
    const current = ++generation.current;
    setLoading(true);
    setError(false);
    try {
      const next = await controller.getAuditPage({
        mode: direction,
        cursor,
        sessionId: audit.sessionId,
        expectedRevision: audit.revision,
        limit: MAX_PROMPT_PREVIEW_AUDIT_PAGE_ENTRIES,
        maxBytes: MAX_PROMPT_PREVIEW_AUDIT_PAGE_BYTES,
      });
      if (current !== generation.current) return;
      setPage(next);
      setDetail(undefined);
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [audit, controller, page]);

  const loadDetail = useCallback(async (target: PromptPreviewAuditDetailTarget, cursor?: string) => {
    const current = ++generation.current;
    setLoading(true);
    setError(false);
    // Keep the list and scroll position available for a local, immediate Back.
    setDetail(previous => cursor ? previous : { target, text: '' });
    try {
      const chunk = await controller.getAuditDetail({
        sessionId: audit.sessionId,
        expectedRevision: audit.revision,
        target,
        ...(cursor === undefined ? {} : { cursor }),
        maxBytes: MAX_PROMPT_PREVIEW_AUDIT_DETAIL_CHUNK_BYTES,
      });
      if (current !== generation.current) return;
      setDetail({
        target,
        text: new TextDecoder().decode(chunk.canonicalUtf8),
        nextCursor: chunk.nextCursor,
      });
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [audit, controller]);

  return { page, detail, loading, error, loadPage, loadDetail, closeDetail };
}
