export const MEMELOOP_MESSAGE_DETAIL_LIMIT = 50;
export const MEMELOOP_MESSAGE_DETAIL_MAX_BYTES = 256 * 1024;
export const MEMELOOP_MESSAGE_DETAIL_DISPLAY_CHARACTERS = 32 * 1024;

export interface MemeLoopMessageDetailRequest {
  limit: typeof MEMELOOP_MESSAGE_DETAIL_LIMIT;
  maxBytes: typeof MEMELOOP_MESSAGE_DETAIL_MAX_BYTES;
  cursor?: string;
  signal: AbortSignal;
}

/** A host-formatted, bounded detail fragment. Complete content stays in export. */
export interface MemeLoopMessageDetailPage {
  text: string;
  itemCount: number;
  truncated: boolean;
  nextCursor?: string;
}

export type MemeLoopMessageDetailLoader = (
  message: ChatMessage,
  request: MemeLoopMessageDetailRequest,
) => Promise<MemeLoopMessageDetailPage | null>;

export interface AgentRunLogDetailItem {
  /** Already-localized bounded role/event label. */
  label: string;
  content: string;
}

export interface AgentRunLogDetailPullPage {
  items: readonly AgentRunLogDetailItem[];
  truncated: boolean;
  nextCursor?: string;
}

export interface AgentRunLogDetailPullRequest extends MemeLoopMessageDetailRequest {
  message: ChatMessage;
}

export interface AgentRunLogDetailLoaderOptions {
  /** Pull exactly one bounded host/transport page. This helper never follows nextCursor. */
  pull: (request: AgentRunLogDetailPullRequest) => Promise<unknown>;
  formatItem?: (item: Readonly<AgentRunLogDetailItem>) => string;
}

type OwnDescriptors = Record<string, PropertyDescriptor>;

function ownDescriptors(value: unknown): OwnDescriptors {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('message detail page must be an object');
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('message detail page must be a plain object');
    }
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) throw new TypeError('message detail page cannot contain symbol keys');
    return Object.getOwnPropertyDescriptors(value) as OwnDescriptors;
  } catch {
    throw new TypeError('message detail page descriptors are unavailable');
  }
}

function data(descriptors: OwnDescriptors, key: string, required = true): unknown {
  const descriptor = descriptors[key];
  if (!descriptor) {
    if (required) throw new TypeError(`message detail page is missing ${key}`);
    return undefined;
  }
  if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError(`message detail page ${key} must be enumerable data`);
  return descriptor.value;
}

function utf8Bytes(value: string, maximum: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xDC00 && low <= 0xDFFF)) throw new TypeError('message detail page contains invalid Unicode');
      bytes += 4;
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      throw new TypeError('message detail page contains invalid Unicode');
    } else bytes += codeUnit <= 0x7F ? 1 : codeUnit <= 0x7FF ? 2 : 3;
    if (bytes > maximum) throw new RangeError('message detail page exceeds its byte budget');
  }
  return bytes;
}

function opaqueCursor(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048 || value !== value.trim()) {
    throw new TypeError('message detail cursor is invalid');
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) throw new TypeError('message detail cursor contains a control character');
  }
  utf8Bytes(value, MEMELOOP_MESSAGE_DETAIL_MAX_BYTES);
  return value;
}

/** Validates and clones an untrusted detail response without reading accessors. */
export function validateMessageDetailPage(
  value: unknown,
  maximumBytes = MEMELOOP_MESSAGE_DETAIL_MAX_BYTES,
): MemeLoopMessageDetailPage {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MEMELOOP_MESSAGE_DETAIL_MAX_BYTES) {
    throw new RangeError('message detail maximum byte budget is invalid');
  }
  const descriptors = ownDescriptors(value);
  const allowed = ['text', 'itemCount', 'truncated', 'nextCursor'];
  if (Object.keys(descriptors).some(key => !allowed.includes(key))) throw new TypeError('message detail page contains an unexpected field');
  const text = data(descriptors, 'text');
  const itemCount = data(descriptors, 'itemCount');
  const truncated = data(descriptors, 'truncated');
  const rawNextCursor = data(descriptors, 'nextCursor', false);
  if (typeof text !== 'string') throw new TypeError('message detail text must be a string');
  if (!Number.isSafeInteger(itemCount) || (itemCount as number) < 0 || (itemCount as number) > MEMELOOP_MESSAGE_DETAIL_LIMIT) {
    throw new RangeError('message detail item count exceeds its limit');
  }
  if (typeof truncated !== 'boolean') throw new TypeError('message detail truncated must be boolean');
  const nextCursor = rawNextCursor === undefined ? undefined : opaqueCursor(rawNextCursor);
  if (!truncated && nextCursor !== undefined) throw new TypeError('complete message detail cannot contain a continuation cursor');
  utf8Bytes(text, maximumBytes);
  const result = {
    text,
    itemCount: itemCount as number,
    truncated,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
  utf8Bytes(JSON.stringify(result), maximumBytes);
  return Object.freeze(result);
}

export function formatMessageDetailPage(page: MemeLoopMessageDetailPage): { text: string; displayTruncated: boolean } {
  if (page.text.length <= MEMELOOP_MESSAGE_DETAIL_DISPLAY_CHARACTERS) {
    return { text: page.text, displayTruncated: page.truncated };
  }
  let text = page.text.slice(0, MEMELOOP_MESSAGE_DETAIL_DISPLAY_CHARACTERS);
  const final = text.charCodeAt(text.length - 1);
  if (final >= 0xD800 && final <= 0xDBFF) text = text.slice(0, -1);
  return { text, displayTruncated: true };
}

/**
 * Portable one-page adapter for agent-run detail transports.
 *
 * Hosts only map their RPC result to `{items,truncated,nextCursor}`. Count,
 * Unicode, byte limits, cancellation and standardized UI output stay shared.
 */
export function createAgentRunLogDetailLoader(
  options: AgentRunLogDetailLoaderOptions,
): MemeLoopMessageDetailLoader {
  return async (message, request) => {
    if (!isAgentRunMessage(message)) return null;
    if (request.limit !== MEMELOOP_MESSAGE_DETAIL_LIMIT || request.maxBytes !== MEMELOOP_MESSAGE_DETAIL_MAX_BYTES) {
      throw new RangeError('agent run detail request must use shared UI bounds');
    }
    request.signal.throwIfAborted();
    const raw = await options.pull({ ...request, message });
    request.signal.throwIfAborted();
    const page = validateAgentRunLogDetailPullPage(raw, request.maxBytes);
    const formatItem = options.formatItem ?? ((item: Readonly<AgentRunLogDetailItem>) => item.label ? `${item.label}: ${item.content}` : item.content);
    const lines = page.items.map(item => formatItem(item));
    if (lines.some(line => typeof line !== 'string')) throw new TypeError('agent run detail formatter must return text');
    return validateMessageDetailPage({
      text: lines.join('\n\n'),
      itemCount: page.items.length,
      truncated: page.truncated,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    }, request.maxBytes);
  };
}

function isAgentRunMessage(message: ChatMessage): boolean {
  try {
    const detailReference = propertyData(Object.getOwnPropertyDescriptor(message, 'detailRef'));
    if (detailReference === null || typeof detailReference !== 'object' || Array.isArray(detailReference)) return false;
    return propertyData(Object.getOwnPropertyDescriptor(detailReference, 'type')) === 'agent-run';
  } catch {
    return false;
  }
}

function propertyData(descriptor: PropertyDescriptor | undefined): unknown {
  return descriptor && 'value' in descriptor
    ? (descriptor as PropertyDescriptor & { value: unknown }).value
    : undefined;
}

function validateAgentRunLogDetailPullPage(value: unknown, maximumBytes: number): Readonly<AgentRunLogDetailPullPage> {
  const descriptors = ownDescriptors(value);
  const allowed = ['items', 'truncated', 'nextCursor'];
  if (Object.keys(descriptors).some(key => !allowed.includes(key))) throw new TypeError('agent run detail page contains an unexpected field');
  const rawItems = data(descriptors, 'items');
  const truncated = data(descriptors, 'truncated');
  const rawNextCursor = data(descriptors, 'nextCursor', false);
  if (!Array.isArray(rawItems)) throw new TypeError('agent run detail items must be an array');
  if (rawItems.length > MEMELOOP_MESSAGE_DETAIL_LIMIT) throw new RangeError('agent run detail item count exceeds its limit');
  if (typeof truncated !== 'boolean') throw new TypeError('agent run detail truncated must be boolean');
  const arrayDescriptors = Object.getOwnPropertyDescriptors(rawItems) as Record<string, PropertyDescriptor>;
  const items: Readonly<AgentRunLogDetailItem>[] = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const item = propertyData(arrayDescriptors[String(index)]);
    const itemDescriptors = ownDescriptors(item);
    if (Object.keys(itemDescriptors).some(key => key !== 'label' && key !== 'content')) throw new TypeError('agent run detail item contains an unexpected field');
    const label = data(itemDescriptors, 'label');
    const content = data(itemDescriptors, 'content');
    if (typeof label !== 'string' || typeof content !== 'string') throw new TypeError('agent run detail item must contain text');
    utf8Bytes(label, maximumBytes);
    utf8Bytes(content, maximumBytes);
    items.push(Object.freeze({ label, content }));
  }
  const nextCursor = rawNextCursor === undefined ? undefined : opaqueCursor(rawNextCursor);
  if (!truncated && nextCursor !== undefined) throw new TypeError('complete agent run detail cannot contain a continuation cursor');
  return Object.freeze({ items: Object.freeze(items), truncated, ...(nextCursor === undefined ? {} : { nextCursor }) });
}
import type { ChatMessage } from 'memeloop';
