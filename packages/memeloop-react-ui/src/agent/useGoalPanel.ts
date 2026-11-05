import type { AgentGoal } from 'memeloop';
import { useEffect, useRef, useState } from 'react';
import type { GoalPanelProps } from './goals.js';

/** Poll only while the panel is mounted; mutations supersede in-flight reads. */
export function useGoalPanel({ client, conversationId, definitionId }: GoalPanelProps) {
  const [goal, setGoal] = useState<AgentGoal | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [objective, setObjective] = useState('');
  const [evidence, setEvidence] = useState('');
  const [completing, setCompleting] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const mutating = useRef(false);

  useEffect(() => {
    setEvidence('');
    setCompleting(false);
  }, [goal?.id]);

  useEffect(() => {
    setGoal(null);
    setLoading(true);
    setBusy(false);
    setFailed(false);
    setObjective('');
    setEvidence('');
    setCompleting(false);
  }, [client, conversationId]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    generation.current += 1;
    mutating.current = false;
    const refresh = async () => {
      if (!mutating.current) {
        const readGeneration = generation.current;
        try {
          const next = await client.get(conversationId);
          if (active && readGeneration === generation.current) {
            setGoal(current => current?.id === next?.id && current?.revision === next?.revision ? current : next);
            setFailed(false);
          }
        } catch {
          if (active && readGeneration === generation.current) setFailed(true);
        } finally {
          if (active && readGeneration === generation.current) setLoading(false);
        }
      }
      if (active) timer = setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
      // Invalidate mutations still awaiting this conversation's response.
      generation.current += 1;
    };
  }, [client, conversationId, reload]);

  const mutate = async (operation: () => Promise<AgentGoal>) => {
    const request = ++generation.current;
    mutating.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const next = await operation();
      if (request !== generation.current) return;
      setGoal(next);
      setCompleting(false);
      setEvidence('');
      setObjective('');
    } catch {
      if (request === generation.current) setFailed(true);
    } finally {
      if (request === generation.current) {
        mutating.current = false;
        setBusy(false);
        setLoading(false);
      }
    }
  };
  const scope = goal && { conversationId, expectedRevision: goal.revision };
  return {
    goal,
    loading,
    busy,
    failed,
    objective,
    evidence,
    completing,
    setObjective,
    setEvidence,
    setCompleting,
    retry: () => {
      setReload(value => value + 1);
    },
    start: () => mutate(() => client.start({ conversationId, definitionId, objective: objective.trim() })),
    pause: () => scope && mutate(() => client.pause(scope)),
    resume: () => scope && mutate(() => client.resume(scope)),
    complete: () => scope && mutate(() => client.complete({ ...scope, evidence: evidence.trim() })),
  };
}
