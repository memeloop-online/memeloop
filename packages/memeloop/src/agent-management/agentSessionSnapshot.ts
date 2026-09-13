import { agentRunErrorFromUnknown, AgentRunFailure } from '../runState.js';
import type { ConversationMessageCursor } from '../storage/ports.js';
import type { AgentConversationMessageProjection, AgentRuntimeView } from './types.js';

const SNAPSHOT_CLONE_MAX_DEPTH = 64;
const SNAPSHOT_CLONE_MAX_NODES = 100_000;

/** Read-only snapshot of one active, bounded agent session. */
export interface AgentSessionSnapshot {
  readonly agent: Readonly<AgentRuntimeView> | null;
  readonly loading: boolean;
  readonly loadingMoreBefore: boolean;
  readonly loadingMoreAfter: boolean;
  readonly error: Error | null;
  readonly messages: ReadonlyArray<Readonly<AgentConversationMessageProjection>>;
  readonly orderedMessageIds: readonly string[];
  readonly streamingMessageIds: ReadonlySet<string>;
  readonly hasMoreBefore?: boolean;
  readonly hasMoreAfter?: boolean;
  readonly startCursor?: Readonly<ConversationMessageCursor>;
  readonly endCursor?: Readonly<ConversationMessageCursor>;
  readonly previousCursor?: string;
  readonly nextCursor?: string;
  readonly revision?: string;
  readonly windowAnchorTurnId?: string;
  readonly windowAnchorMessageId?: string;
  readonly pendingNewMessageCount: number;
}

export type AgentSessionListener = (snapshot: AgentSessionSnapshot) => void;

/** Read-only Set facade: Object.freeze(new Set()) still leaves add/delete mutable. */
interface ImmutableSetLike<T> {
  readonly size: number;
  has(value: T): boolean;
  keys(): Iterator<T>;
}

class ImmutableReadonlySet<T> implements ReadonlySet<T> {
  readonly #values: Set<T>;

  constructor(values: Iterable<T>) {
    this.#values = new Set(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get [Symbol.toStringTag](): string {
    return 'Set';
  }

  has(value: T): boolean {
    return this.#values.has(value);
  }

  entries(): SetIterator<[T, T]> {
    return this.#values.entries();
  }

  keys(): SetIterator<T> {
    return this.#values.keys();
  }

  values(): SetIterator<T> {
    return this.#values.values();
  }

  [Symbol.iterator](): SetIterator<T> {
    return this.#values[Symbol.iterator]();
  }

  forEach(
    callback: (value: T, value2: T, set: ReadonlySet<T>) => void,
    thisArgument?: unknown,
  ): void {
    for (const value of this.#values) callback.call(thisArgument, value, value, this);
  }

  union<U>(other: ImmutableSetLike<U>): Set<T | U> {
    const result = new Set<T | U>(this.#values);
    for (const value of iteratorValues(other.keys())) result.add(value);
    return result;
  }

  intersection<U>(other: ImmutableSetLike<U>): Set<T & U> {
    const result = new Set<T & U>();
    for (const value of iteratorValues(other.keys())) {
      if (iterableContains(this.#values, value)) result.add(value);
    }
    return result;
  }

  difference<U>(other: ImmutableSetLike<U>): Set<T> {
    const result = new Set<T>();
    for (const value of this.#values) {
      if (!iteratorContains(other.keys(), value)) result.add(value);
    }
    return result;
  }

  symmetricDifference<U>(other: ImmutableSetLike<U>): Set<T | U> {
    const result = new Set<T | U>(this.difference(other));
    for (const value of iteratorValues(other.keys())) {
      if (!iterableContains(this.#values, value)) result.add(value);
    }
    return result;
  }

  isSubsetOf(other: ImmutableSetLike<unknown>): boolean {
    for (const value of this.#values) {
      if (!other.has(value)) return false;
    }
    return true;
  }

  isSupersetOf(other: ImmutableSetLike<unknown>): boolean {
    for (const value of iteratorValues(other.keys())) {
      if (!iterableContains(this.#values, value)) return false;
    }
    return true;
  }

  isDisjointFrom(other: ImmutableSetLike<unknown>): boolean {
    for (const value of this.#values) {
      if (other.has(value)) return false;
    }
    return true;
  }
}

function* iteratorValues<T>(iterator: Iterator<T>): Generator<T> {
  for (;;) {
    const item = iterator.next();
    if (item.done) return;
    yield item.value;
  }
}

function iterableContains<T>(values: Iterable<T>, value: unknown): value is T {
  return iteratorContains(values[Symbol.iterator](), value);
}

function iteratorContains<T>(iterator: Iterator<T>, value: unknown): value is T {
  for (const candidate of iteratorValues(iterator)) {
    if (candidate === value || Object.is(candidate, value)) return true;
  }
  return false;
}

interface SnapshotCloneState {
  nodes: number;
  readonly clones: WeakMap<object, object>;
}

const DATE_MUTATOR_NAMES = new Set<PropertyKey>([
  'setDate',
  'setFullYear',
  'setHours',
  'setMilliseconds',
  'setMinutes',
  'setMonth',
  'setSeconds',
  'setTime',
  'setUTCDate',
  'setUTCFullYear',
  'setUTCHours',
  'setUTCMilliseconds',
  'setUTCMinutes',
  'setUTCMonth',
  'setUTCSeconds',
  'setYear',
]);

function immutableSnapshotDate(value: Date): Date {
  const timestamp = value.getTime();
  if (!Number.isFinite(timestamp)) throw new Error('invalid_agent_session_snapshot');
  const target = Object.freeze(new Date(timestamp));
  return new Proxy(target, {
    defineProperty: () => false,
    deleteProperty: () => false,
    get: (date, property) => {
      if (DATE_MUTATOR_NAMES.has(property)) {
        return () => {
          throw new TypeError('immutable_agent_session_snapshot');
        };
      }
      const result: unknown = date[property as keyof Date];
      if (typeof result !== 'function') return result;
      const method = result as (this: Date, ...arguments_: unknown[]) => unknown;
      return (...arguments_: unknown[]): unknown => method.call(date, ...arguments_);
    },
    set: () => false,
    setPrototypeOf: () => false,
  });
}

export function cloneImmutableSnapshotValue<T>(
  value: T,
  state: SnapshotCloneState = { nodes: 0, clones: new WeakMap() },
  depth = 0,
): T {
  state.nodes += 1;
  if (state.nodes > SNAPSHOT_CLONE_MAX_NODES || depth > SNAPSHOT_CLONE_MAX_DEPTH) {
    throw new Error('invalid_agent_session_snapshot');
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid_agent_session_snapshot');
    return value;
  }
  if (typeof value !== 'object') throw new Error('invalid_agent_session_snapshot');
  const existing = state.clones.get(value);
  if (existing) return existing as T;

  if (value instanceof Date) {
    const clone = immutableSnapshotDate(value);
    state.clones.set(value, clone);
    return clone as T;
  }

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    state.clones.set(value, clone);
    const descriptors = snapshotOwnPropertyDescriptors(value);
    const lengthDescriptor = descriptors.length;
    if (
      !lengthDescriptor ||
      !('value' in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) throw new Error('invalid_agent_session_snapshot');
    const length = lengthDescriptor.value as number;
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        throw new Error('invalid_agent_session_snapshot');
      }
      clone.push(cloneImmutableSnapshotValue(descriptor.value, state, depth + 1));
    }
    if (Reflect.ownKeys(descriptors).length !== length + 1) {
      throw new Error('invalid_agent_session_snapshot');
    }
    return Object.freeze(clone) as T;
  }

  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    throw new Error('invalid_agent_session_snapshot');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('invalid_agent_session_snapshot');
  }
  const clone: Record<string, unknown> = {};
  state.clones.set(value, clone);
  const descriptors = snapshotOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error('invalid_agent_session_snapshot');
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new Error('invalid_agent_session_snapshot');
    }
    Object.defineProperty(clone, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: cloneImmutableSnapshotValue(descriptor.value, state, depth + 1),
    });
  }
  return Object.freeze(clone) as T;
}

function snapshotOwnPropertyDescriptors(value: object): PropertyDescriptorMap {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error('invalid_agent_session_snapshot');
  }
}

function cloneImmutableSnapshotError(error: Error): Error {
  if (error instanceof AgentRunFailure) {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'agentRunError');
    if (descriptor && 'value' in descriptor) {
      return Object.freeze(new AgentRunFailure(agentRunErrorFromUnknown(error)));
    }
  }
  const messageDescriptor = Object.getOwnPropertyDescriptor(error, 'message');
  const nameDescriptor = Object.getOwnPropertyDescriptor(error, 'name');
  const clone = new Error(
    messageDescriptor && 'value' in messageDescriptor && typeof messageDescriptor.value === 'string'
      ? messageDescriptor.value
      : 'agent_session_error',
  );
  if (nameDescriptor && 'value' in nameDescriptor && typeof nameDescriptor.value === 'string') {
    clone.name = nameDescriptor.value;
  }
  return Object.freeze(clone);
}

export function createImmutableSessionSnapshot(
  previous: AgentSessionSnapshot | undefined,
  partial: Partial<AgentSessionSnapshot>,
): AgentSessionSnapshot {
  const changed = (key: keyof AgentSessionSnapshot): boolean => Object.prototype.hasOwnProperty.call(partial, key);
  const read = <K extends keyof AgentSessionSnapshot>(key: K): AgentSessionSnapshot[K] => {
    if (changed(key)) return partial[key] as AgentSessionSnapshot[K];
    if (previous) return previous[key];
    throw new Error('invalid_agent_session_snapshot');
  };
  const agent = read('agent');
  const error = read('error');
  const startCursor = read('startCursor');
  const endCursor = read('endCursor');
  return Object.freeze({
    agent: previous && !changed('agent')
      ? previous.agent
      : agent === null
      ? null
      : cloneImmutableSnapshotValue(agent),
    loading: read('loading'),
    loadingMoreBefore: read('loadingMoreBefore'),
    loadingMoreAfter: read('loadingMoreAfter'),
    error: previous && !changed('error')
      ? previous.error
      : error === null
      ? null
      : cloneImmutableSnapshotError(error),
    messages: previous && !changed('messages')
      ? previous.messages
      : Object.freeze(read('messages').map(message => cloneImmutableSnapshotValue(message))),
    orderedMessageIds: previous && !changed('orderedMessageIds')
      ? previous.orderedMessageIds
      : Object.freeze([...read('orderedMessageIds')]),
    streamingMessageIds: previous && !changed('streamingMessageIds')
      ? previous.streamingMessageIds
      : new ImmutableReadonlySet(read('streamingMessageIds')),
    hasMoreBefore: read('hasMoreBefore'),
    hasMoreAfter: read('hasMoreAfter'),
    startCursor: previous && !changed('startCursor')
      ? previous.startCursor
      : startCursor === undefined
      ? undefined
      : cloneImmutableSnapshotValue(startCursor),
    endCursor: previous && !changed('endCursor')
      ? previous.endCursor
      : endCursor === undefined
      ? undefined
      : cloneImmutableSnapshotValue(endCursor),
    previousCursor: read('previousCursor'),
    nextCursor: read('nextCursor'),
    revision: read('revision'),
    windowAnchorTurnId: read('windowAnchorTurnId'),
    windowAnchorMessageId: read('windowAnchorMessageId'),
    pendingNewMessageCount: read('pendingNewMessageCount'),
  });
}
