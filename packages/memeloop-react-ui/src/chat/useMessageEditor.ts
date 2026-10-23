import type { ConversationEditingAdapter } from 'memeloop';
import { useEffect, useRef, useState } from 'react';

export interface MessageEditorLabels {
  edit: string;
  input: string;
  send: string;
  discard: string;
  saveDraft: string;
  reloadDraft: string;
  conflict: string;
  previousBranch: string;
  nextBranch: string;
}

export const defaultMessageEditorLabels: MessageEditorLabels = {
  edit: 'Edit and branch',
  input: 'Edit message',
  send: 'Send',
  discard: 'Discard',
  saveDraft: 'Save draft',
  reloadDraft: 'Load saved draft',
  conflict: 'This draft changed in another window. Your text remains here; load the saved draft to resolve the conflict.',
  previousBranch: 'Previous history',
  nextBranch: 'Next history',
};

/** Shared web/native editor lifecycle. Serialize CAS writes and flush before navigation. */
export function useMessageEditor(
  messageId: string,
  adapter: ConversationEditingAdapter,
  onError: (error: unknown, operation: 'edit-message' | 'save-draft' | 'switch-branch') => void,
) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [conflict, setConflict] = useState(false);
  const sourceRevision = useRef('');
  const draftRevision = useRef(0);
  const queue = useRef(Promise.resolve());
  const writeError = useRef<Error | undefined>(undefined);
  const pending = useRef<string | undefined>(undefined);
  const pendingVersion = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const latest = useRef({ adapter, onError });
  latest.current = { adapter, onError };

  const persist = (value: string | null, version?: number): Promise<void> => {
    const operation = queue.current.then(async () => {
      draftRevision.current = await latest.current.adapter.saveDraft(messageId, value, draftRevision.current);
      if (version !== undefined && pendingVersion.current === version) pending.current = undefined;
      writeError.current = undefined;
    });
    queue.current = operation.catch((error: unknown) => {
      writeError.current = error instanceof Error ? error : new Error('conversation_draft_write_failed');
      if (mounted.current && writeError.current.message.includes('conflict')) setConflict(true);
    });
    return operation;
  };
  const flush = (): Promise<void> => {
    clearTimeout(timer.current);
    const value = pending.current;
    return value === undefined
      ? queue.current.then(() => {
        if (writeError.current) throw writeError.current;
      })
      : persist(value, pendingVersion.current);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void flush().catch((error: unknown) => {
        latest.current.onError(error, 'save-draft');
      });
    };
  }, []);
  const run = (operation: 'edit-message' | 'save-draft' | 'switch-branch', action: () => Promise<void>) => {
    setBusy(true);
    void action().catch((error: unknown) => {
      latest.current.onError(error, operation);
    }).finally(() => {
      if (mounted.current) setBusy(false);
    });
  };
  const close = () => {
    run('save-draft', async () => {
      await flush();
      if (mounted.current) setEditing(false);
    });
  };
  const branch = adapter.branches.find(item => item.messageId === messageId);
  const switchBranch = (index: number) => {
    const target = branch?.alternatives[index];
    if (target) {
      run('switch-branch', async () => {
        await flush();
        await adapter.switchBranch(target.conversationId, target.messageId);
      });
    }
  };
  const change = (value: string) => {
    setText(value);
    pending.current = value;
    pendingVersion.current += 1;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void flush().catch((error: unknown) => {
        latest.current.onError(error, 'save-draft');
      });
    }, 200);
  };
  const load = async () => {
    const source = await adapter.loadSource(messageId);
    if (!mounted.current) return;
    sourceRevision.current = source.sourceRevision;
    draftRevision.current = source.draft?.revision ?? 0;
    pending.current = undefined;
    writeError.current = undefined;
    setText(source.draft?.text ?? source.text);
    setConflict(false);
  };
  const open = () => {
    run('edit-message', async () => {
      await flush();
      await load();
      if (mounted.current) setEditing(true);
    });
  };
  const reload = () => {
    run('save-draft', async () => {
      clearTimeout(timer.current);
      await queue.current;
      await load();
    });
  };
  const submit = () => {
    run('edit-message', async () => {
      await flush();
      await adapter.submit(messageId, text, sourceRevision.current, draftRevision.current);
      if (mounted.current) setEditing(false);
    });
  };
  const discard = () => {
    run('save-draft', async () => {
      clearTimeout(timer.current);
      await persist(null);
      pending.current = undefined;
      setConflict(false);
      if (mounted.current) setEditing(false);
    });
  };
  return { editing, busy, text, conflict, branch, change, close, open, reload, submit, discard, switchBranch };
}
