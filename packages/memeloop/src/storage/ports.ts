import type { AgentDefinition, AgentInstanceMeta } from '../agent/types.js';
import type { AttachmentReference, ChatMessage, ConversationCompactionEvent, ConversationEvent, ConversationEventCursor, ConversationEventDraft } from '../conversation/index.js';
import type { CanonicalJsonValue } from '../encoding/canonicalJson.js';
import type { IMChannelBinding } from '../im/protocol.js';
import type { ConversationMeta } from '../sync/protocol.js';

/**
 * Narrow logical storage ports (plan 24.41).
 *
 * Loop/runtime code depends on these small portable interfaces instead of a
 * monolithic storage facade. Hosts (CLI SQLite, Desktop repositories, browser
 * IndexedDB, remote adapters) implement any combination; binary payloads are
 * `Uint8Array` only, keeping the ports usable in browsers and edge runtimes.
 */

export interface ConversationListQuery {
  definitionId?: string;
  /**
   * Authorization-scoped collection predicate. Apply before ordering and
   * cursor evaluation; an empty array selects no conversations.
   */
  definitionIds?: readonly string[];
  /**
   * Authorization-scoped collection predicate. Apply before ordering and
   * cursor evaluation; an empty array selects no conversations.
   */
  conversationIds?: readonly string[];
  sourceChannelId?: string;
  isUserInitiated?: boolean;
}

export interface GetConversationListPageOptions {
  /** Required hard row ceiling; callers and hosts enforce 1..100. */
  limit: number;
  /** Strict canonical JSON page budget; callers and hosts cap this at 1 MiB. */
  maxBytes: number;
  /** Exact bounded filter scope committed into every opaque cursor. */
  query?: ConversationListQuery;
  /** Nearest older conversations, strictly excluding this cursor. */
  beforeCursor?: string;
  /** Earliest newer conversations, strictly excluding this cursor. */
  afterCursor?: string;
  /** Required with either cursor; a mismatch returns reset. */
  expectedRevision?: string;
}

export interface ConversationListPageSuccess {
  reset: false;
  items: ConversationMeta[];
  revision: string;
  total: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  startCursor?: string;
  endCursor?: string;
}

export interface ConversationListPageReset {
  reset: true;
  revision: string;
}

export type ConversationListPage = ConversationListPageSuccess | ConversationListPageReset;

export interface ConversationListPageCallOptions {
  signal?: AbortSignal;
}

/**
 * Stable keyset used by every paged conversation reader.
 *
 * `timestamp` is the primary display order. The Lamport/origin/message fields
 * make equal timestamps deterministic without relying on database row ids.
 */
export interface ConversationMessageCursor {
  timestamp: number;
  lamportClock: number;
  originNodeId: string;
  messageId: string;
}

export interface MessageVersionFrontier {
  conversationId: string;
  originNodeId: string;
  maxContiguousOriginSequence: number;
}

export interface MessageVersionFrontierCursor {
  conversationId: string;
  originNodeId: string;
}

export interface MessageVersionFrontierPage {
  items: MessageVersionFrontier[];
  nextCursor?: MessageVersionFrontierCursor;
}

export interface GetCompactionCandidatePageOptions {
  afterCoveredVersion: Readonly<Record<string, number>>;
  /** Undefined means no recent display window; every causally eligible event is old. */
  beforeDisplayCursor?: ConversationMessageCursor;
  /** Hard visible-message ceiling; interactive hosts reject values outside 1..50. */
  maxMessages: number;
  /** Strict UTF-8 canonical message payload budget. */
  maxBytes: number;
}

export interface CompactionCandidatePage {
  messages: ChatMessage[];
  nextCoveredVersion: Record<string, number>;
  newlyCoveredMessageCountByOrigin: Record<string, number>;
  newlyCoveredUserTurnCountByOrigin: Record<string, number>;
  hasMore: boolean;
}

export interface GetConversationEventPageOptions {
  limit: number;
  after?: ConversationEventCursor;
  direction?: 'forward' | 'backward';
  ranges?: readonly {
    originNodeId: string;
    fromExclusive: number;
    toInclusive: number;
  }[];
  signal?: AbortSignal;
}

export interface ConversationEventPage {
  items: ConversationEvent[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  startCursor?: ConversationEventCursor;
  endCursor?: ConversationEventCursor;
}

/** Bounded list row; structured detail and private reasoning are lazy ranges. */
export interface ConversationMessageReasoningProjection {
  text: string;
  totalBytes: number;
  hasMore: boolean;
}

/**
 * Bounded, renderer-facing affordance carried by a list row.  The canonical
 * message parts remain detail-only; this detached projection lets clients
 * render an interactive tool result (for example `ask-question`) without
 * parsing free-form result text or receiving the complete tool payload.
 */
export interface ConversationMessagePresentationProjection {
  kind: 'tool-result';
  toolName: string;
  payload?: CanonicalJsonValue;
  /** True only when the serving adapter explicitly exposes a detail reader. */
  detailAvailable: boolean;
  /** Set only when a source payload was omitted because it exceeded the cap. */
  truncated?: true;
}

/** Explicit opt-in renderer adapter; unknown tools never leak payloads. */
export interface ConversationMessagePresentationProjector {
  readonly toolName: string;
  project(payload: unknown): unknown;
}

export type ConversationMessageListProjection =
  & Omit<ChatMessage, 'parts' | 'toolCalls' | 'attachments' | 'reasoning_content'>
  & {
    parts?: never;
    toolCalls?: never;
    attachments?: never;
    reasoning_content?: never;
    reasoning?: ConversationMessageReasoningProjection;
    presentations?: readonly ConversationMessagePresentationProjection[];
  };

/** Interactive/API pages are always bounded lightweight projections. */
export interface GetMessagePageOptions {
  /** Hard upper bound for returned rows. Hosts should also enforce their own ceiling. */
  limit: number;
  /** Strict UTF-8 canonical message payload budget for the whole page. */
  maxBytes: number;
  /** Return rows strictly older than this cursor. */
  before?: ConversationMessageCursor;
  /** Return rows strictly newer than this cursor. */
  after?: ConversationMessageCursor;
  /** `backward` reads the latest/older page; `forward` reads earliest/newer rows. */
  direction?: 'backward' | 'forward';
  /** Exclude messages already covered by the retained compaction frontier. */
  afterCoveredVersion?: Readonly<Record<string, number>>;
  /**
   * Restrict the bounded page to one durable turn. Persistent stores apply
   * this predicate before keyset evaluation; it is used by remote turn detail
   * reads so hosts never need an RPC-specific adapter.
   */
  turnId?: string;
  /** Required with before/after keysets; mismatch returns reset. */
  expectedRevision?: string;
}

export interface GetRetainedCompactionControlsOptions {
  /** Hard safety ceiling; values above 32 are rejected. */
  limit: number;
  /** Strict UTF-8 canonical event budget for the whole page. */
  maxBytes: number;
  /** Deterministic causal keyset cursor. */
  after?: ConversationEventCursor;
}

export interface RetainedCompactionControlPage {
  /** Pareto-retained summary and coverage-only controls. */
  items: ConversationCompactionEvent[];
  hasMore: boolean;
  nextCursor?: ConversationEventCursor;
  /** At least one non-tombstoned control omits a later tombstone covering compacted content. */
  invalidated: boolean;
}

export interface ConversationMessagePageSuccess {
  reset: false;
  conversationId: string;
  revision: string;
  /** Always sorted oldest to newest, including when reading the tail/older page. */
  items: ConversationMessageListProjection[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  startCursor?: ConversationMessageCursor;
  endCursor?: ConversationMessageCursor;
}

export interface ConversationMessagePageReset {
  reset: true;
  conversationId: string;
  revision: string;
}

export type ConversationMessagePage =
  | ConversationMessagePageSuccess
  | ConversationMessagePageReset;

/** Explicit trusted full-content page; never exposed by interactive message APIs. */
export interface GetFullContentMessagePageOptions {
  limit: number;
  maxBytes: number;
  before?: ConversationMessageCursor;
  after?: ConversationMessageCursor;
  direction?: 'backward' | 'forward';
  afterCoveredVersion?: Readonly<Record<string, number>>;
  expectedRevision?: string;
}

export interface ConversationFullContentMessagePageSuccess {
  reset: false;
  conversationId: string;
  revision: string;
  items: ChatMessage[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  startCursor?: ConversationMessageCursor;
  endCursor?: ConversationMessageCursor;
}

export type ConversationFullContentMessagePage =
  | ConversationFullContentMessagePageSuccess
  | ConversationMessagePageReset;

export interface ConversationMessageIdentity {
  messageId: string;
  timestamp: number;
  lamportClock: number;
  originNodeId: string;
}

export type ConversationMessageDetailRange =
  | { found: false }
  | {
    found: true;
    offset: number;
    totalBytes: number;
    bytes: Uint8Array;
  };

export type ConversationMessageWindowFocus =
  | {
    kind: 'message';
    messageId: string;
    turnId: string;
    /** Optional opaque timeline cursor used to detect a stale message marker. */
    cursor?: string;
  }
  | {
    kind: 'timeline-entry';
    entryId: string;
    cursor: string;
  };

export interface GetConversationMessageWindowAroundOptions {
  focus: ConversationMessageWindowFocus;
  /** Required timeline snapshot revision; mismatch returns reset atomically. */
  expectedRevision: string;
  /** Hard ceiling for the complete atomically selected message window. */
  maxMessages: number;
  /** Strict UTF-8 canonical JSON budget for the complete response. */
  maxBytes: number;
}

interface ConversationTimelineEntryBase {
  /** Stable entry identity: visible messageId, or compaction eventId for summaries. */
  entryId: string;
  conversationId: string;
  timestamp: number;
  lamportClock: number;
  originNodeId: string;
  /** Stable opaque display key supplied back to beforeCursor/afterCursor unchanged. */
  cursor: string;
  /** Absolute position across both message and summary-compaction entries. */
  entryIndex: number;
}

export type ConversationTimelineMessageRole = 'user' | 'assistant' | 'agent';

/** One exact, bounded navigation marker for every visible conversational message. */
export interface ConversationTimelineMessageEntry extends ConversationTimelineEntryBase {
  kind: 'message';
  messageId: string;
  turnId: string;
  /** Zero-based index of the matching user root; absent while that root is not present. */
  turnIndex?: number;
  role: ConversationTimelineMessageRole;
  actorId: string;
  actorLabel: string;
  preview: string;
}

/** A visible semantic compaction summary; coverage-only checkpoints never appear. */
export interface ConversationTimelineCompactionEntry extends ConversationTimelineEntryBase {
  kind: 'compaction';
  /** Number of visible user-root turns strictly before this summary marker. */
  turnIndex: number;
  summaryPreview: string;
  compactedMessageCount: number;
  compactedTurnCount: number;
}

export type ConversationTimelineEntry =
  | ConversationTimelineMessageEntry
  | ConversationTimelineCompactionEntry;

export interface ConversationMessageWindowMessageFocus {
  kind: 'message';
  messageId: string;
  turnId: string;
  /** Present when a timeline entry, rather than a direct message, resolved the focus. */
  entryId?: string;
  cursor?: string;
}

export type ConversationMessageWindowCompactionFocus =
  & {
    kind: 'compaction';
    /** Real compaction detail; implementations never synthesize a turn identity. */
    entry: ConversationTimelineCompactionEntry;
  }
  & (
    | { nearestPosition: 'none'; nearestMessageId?: never; nearestTurnId?: never }
    | { nearestPosition: 'before' | 'after'; nearestMessageId: string; nearestTurnId: string }
  );

export type ConversationMessageWindowResolvedFocus =
  | ConversationMessageWindowMessageFocus
  | ConversationMessageWindowCompactionFocus;

/** Exact message to preserve at the viewport centre after an atomic window replacement. */
export interface ConversationMessageWindowRecenterAnchor {
  messageId: string;
  turnId: string;
}

export interface ConversationMessageWindowSuccess {
  reset: false;
  conversationId: string;
  revision: string;
  focus: ConversationMessageWindowResolvedFocus;
  /** Always names the exact focused/nearest resident message; absent only when none exists. */
  recenterAnchor?: ConversationMessageWindowRecenterAnchor;
  /** Always sorted oldest to newest and bounded by the request. */
  items: ConversationMessageListProjection[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  startCursor?: ConversationMessageCursor;
  endCursor?: ConversationMessageCursor;
}

export interface ConversationMessageWindowReset {
  reset: true;
  conversationId: string;
  revision: string;
}

export type ConversationMessageWindowResult =
  | ConversationMessageWindowSuccess
  | ConversationMessageWindowReset;

export interface GetConversationTimelinePageOptions {
  /** Required hard row ceiling. Portable callers reject values outside 1..50. */
  limit: number;
  /** Strict UTF-8 canonical JSON budget for the complete response; at most 256 KiB. */
  maxBytes: number;
  /** Maximum UTF-16 code units retained in each persisted preview. */
  previewLength?: number;
  /** Read nearest older entries, strictly excluding this opaque display cursor. */
  beforeCursor?: string;
  /** Read earliest newer entries, strictly excluding this opaque display cursor. */
  afterCursor?: string;
  /** Center and edge-fill around this absolute entry position. */
  aroundEntryIndex?: number;
  /** Return reset instead of mixing entries when the current revision differs. */
  expectedRevision?: string;
}

export interface ConversationTimelinePageSuccess {
  reset: false;
  /** Always sorted by unique absolute entryIndex, oldest to newest. */
  items: ConversationTimelineEntry[];
  /** Opaque monotonic snapshot revision shared by every cursor in this page. */
  revision: string;
  /** All visible messages, including non-navigable tool/error detail rows. */
  totalMessages: number;
  totalTurns: number;
  totalEntries: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  startEntryIndex?: number;
  endEntryIndex?: number;
  startCursor?: string;
  endCursor?: string;
}

/** A stale revision or cursor must reset; it never carries a partial item page. */
export interface ConversationTimelinePageReset {
  reset: true;
  revision: string;
}

export type ConversationTimelinePage =
  | ConversationTimelinePageSuccess
  | ConversationTimelinePageReset;

export interface ConversationTimelinePageCallOptions {
  signal?: AbortSignal;
}

export interface ConversationReadCallOptions {
  signal?: AbortSignal;
}

/** Append-only conversation event log. */
export interface ConversationEventStore {
  listConversationsPage(
    options: GetConversationListPageOptions,
    callOptions?: ConversationListPageCallOptions,
  ): Promise<ConversationListPage>;
  /**
   * Keyset-paged display/sync reader. New persistent hosts should implement
   * this so opening a long conversation never materializes its complete log.
   * Portable callers never fall back to getMessages.
   */
  getMessagePage(
    conversationId: string,
    options: GetMessagePageOptions,
    callOptions?: ConversationReadCallOptions,
  ): Promise<ConversationMessagePage>;
  /** Trusted bounded full-content reader for model context, compaction, and export only. */
  getFullContentMessagePage(
    conversationId: string,
    options: GetFullContentMessagePageOptions,
    callOptions?: ConversationReadCallOptions,
  ): Promise<ConversationFullContentMessagePage>;
  /**
   * Single revision-consistent absolute seek. Persistent hosts execute focus
   * resolution and bounded message selection in one read transaction.
   */
  getMessageWindowAround(
    conversationId: string,
    options: GetConversationMessageWindowAroundOptions,
    callOptions?: ConversationReadCallOptions,
  ): Promise<ConversationMessageWindowResult>;
  /**
   * Required revisioned message/summary projection for timeline navigation.
   * Persistent hosts query indexed projected columns and never scan full logs.
   */
  getConversationTimelinePage(
    conversationId: string,
    options: GetConversationTimelinePageOptions,
    callOptions?: ConversationTimelinePageCallOptions,
  ): Promise<ConversationTimelinePage>;
  /** Optimized point read used by detail/on-demand RPCs. */
  getMessageById?(
    conversationId: string,
    messageId: string,
    callOptions?: ConversationReadCallOptions,
  ): Promise<ChatMessage | null>;
  /** Indexed identity-only point read; never materializes message content. */
  getMessageIdentity?(
    conversationId: string,
    messageId: string,
    callOptions?: ConversationReadCallOptions,
  ): Promise<ConversationMessageIdentity | null>;
  /** Bounded persisted canonical-JSON byte range for detail/export streaming. */
  readMessageDetailRange?(
    conversationId: string,
    messageId: string,
    offset: number,
    maxBytes: number,
    callOptions?: ConversationReadCallOptions,
  ): Promise<ConversationMessageDetailRange>;
  /** Raw append-only audit page. Tombstones and metadata/compaction controls are included. */
  getConversationEventPage(
    conversationId: string,
    options: GetConversationEventPageOptions,
  ): Promise<ConversationEventPage>;
  /** Atomically allocate causal identity and append/project a local event. */
  appendLocalEvent(draft: ConversationEventDraft): Promise<ConversationEvent>;
  /**
   * Atomically allocate and project an ordered local event batch. Either every
   * draft is durable or none is; returned events preserve draft order.
   */
  appendLocalEventsAtomic(
    drafts: readonly ConversationEventDraft[],
  ): Promise<ConversationEvent[]>;
  /** Idempotent remote merge; same eventId with a different canonical payload is a conflict. */
  insertEventsIfAbsent(events: readonly ConversationEvent[]): Promise<void>;
  /** Bounded keyset frontier scan used by v2 anti-entropy. */
  getEventVersionFrontierPage(options: {
    limit: number;
    after?: MessageVersionFrontierCursor;
    conversationIds?: readonly string[];
    signal?: AbortSignal;
  }): Promise<MessageVersionFrontierPage>;
  /** Bounded indexed point lookup; callers pass at most one frontier page. */
  getEventVersionFrontiersForKeys(
    keys: readonly MessageVersionFrontierCursor[],
    options?: { signal?: AbortSignal },
  ): Promise<MessageVersionFrontier[]>;
  getCompactionCandidatePage(
    conversationId: string,
    options: GetCompactionCandidatePageOptions,
    callOptions?: ConversationReadCallOptions,
  ): Promise<CompactionCandidatePage>;
  getRetainedCompactionControls(
    conversationId: string,
    options: GetRetainedCompactionControlsOptions,
    callOptions?: ConversationReadCallOptions,
  ): Promise<RetainedCompactionControlPage>;
  /** Optional optimization: `SELECT MAX(lamportClock)` instead of scanning. */
  getMaxLamportClockForConversation?(conversationId: string): Promise<number>;
}

/** Conversation directory/metadata rows (sync and peer metadata). */
export interface ConversationDirectoryStore {
  upsertConversationMetadata(meta: ConversationMeta): Promise<void>;
  /** Read the conversation metadata row used to resolve `definitionId`. */
  getConversationMeta(
    conversationId: string,
    callOptions?: ConversationReadCallOptions,
  ): Promise<ConversationMeta | null>;
}

/** Content-addressed binary storage. Bytes are `Uint8Array` on every path. */
export interface BlobStore {
  getAttachment(
    contentHash: string,
    options?: ConversationReadCallOptions,
  ): Promise<AttachmentReference | null>;
  saveAttachment(reference: AttachmentReference, data: Uint8Array): Promise<void>;
  /** Read persisted attachment bytes (cross-node blob transfer). */
  readAttachmentData?(
    contentHash: string,
    options?: ConversationReadCallOptions,
  ): Promise<Uint8Array | null>;
  /** Bounded byte-range read; sync never materializes a complete attachment. */
  readAttachmentRange?(
    contentHash: string,
    offset: number,
    maxBytes: number,
    options?: { signal?: AbortSignal },
  ): Promise<Uint8Array | null>;
  /** Idempotently stage exactly the next contiguous chunk (or an identical retry). */
  stageAttachmentChunk?(
    reference: AttachmentReference,
    offset: number,
    data: Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<number>;
  /** Atomically hash-check and publish a complete staged attachment. */
  commitStagedAttachment?(
    contentHash: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  /** Streaming verification against the canonical content hash and stored size. */
  verifyAttachment?(
    contentHash: string,
    options?: { signal?: AbortSignal },
  ): Promise<boolean>;
  /** A guessed global hash never grants cross-conversation blob access. */
  conversationReferencesAttachment(
    conversationId: string,
    contentHash: string,
    options?: ConversationReadCallOptions,
  ): Promise<boolean>;
}

/** Agent definition lookup. */
export interface DefinitionStore {
  getAgentDefinition(id: string): Promise<AgentDefinition | null>;
}

/** Agent run/instance state. */
export interface AgentInstanceStore {
  saveAgentInstance(meta: AgentInstanceMeta): Promise<void>;
}

/** IM user-to-conversation binding persistence. */
export interface ImBindingStore {
  getImBinding?(channelId: string, imUserId: string): Promise<IMChannelBinding | null>;
  setImBinding?(record: IMChannelBinding): Promise<void>;
}

export interface ConversationAuditExportOptions {
  /** Hard row ceiling for every yielded raw-event page. */
  pageSize: number;
  /** Optional inclusive causal ranges for a scoped export. */
  ranges?: GetConversationEventPageOptions['ranges'];
  signal?: AbortSignal;
}

/**
 * Explicit operator-facing export capability. It is deliberately absent from
 * the runtime event port and streams bounded pages instead of a full array.
 */
export interface ConversationAuditExportStore {
  streamConversationEventPages(
    conversationId: string,
    options: ConversationAuditExportOptions,
  ): AsyncIterable<ConversationEventPage>;
}

/**
 * Convenience composition for hosts that provide every storage port. New
 * consumers should depend on the narrow port they actually use.
 */
export interface FullAgentStorage extends ConversationEventStore, ConversationDirectoryStore, BlobStore, DefinitionStore, AgentInstanceStore, ImBindingStore {}

/** Host composition for an explicitly mounted audit/export surface. */
export interface AuditableAgentStorage extends FullAgentStorage, ConversationAuditExportStore {}
