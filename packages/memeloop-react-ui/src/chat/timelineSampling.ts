import type { MemeLoopTimelineEntry } from './coreTypes.js';

export const MAX_RESIDENT_TIMELINE_ENTRIES = 50;
export const MEMELOOP_TIMELINE_PAGE_LIMIT = 50;
export const MEMELOOP_TIMELINE_PAGE_MAX_BYTES = 256 * 1024;
export const TIMELINE_MARKER_HEIGHT = 24;
export const MAX_TIMELINE_SCROLL_HEIGHT = 8_000_000;

export function boundedTimelinePageItems(
  items: readonly MemeLoopTimelineEntry[],
): readonly MemeLoopTimelineEntry[] {
  if (items.length > MAX_RESIDENT_TIMELINE_ENTRIES) {
    throw new RangeError('timeline page exceeds the shared resident limit');
  }
  return items;
}

export function timelineScrollHeight(totalEntries: number): number {
  return Math.max(TIMELINE_MARKER_HEIGHT, Math.min(MAX_TIMELINE_SCROLL_HEIGHT, totalEntries * TIMELINE_MARKER_HEIGHT));
}

export function timelineEntryOffset(entryIndex: number, totalEntries: number): number {
  const scrollHeight = timelineScrollHeight(totalEntries);
  if (totalEntries <= 1) return 0;
  return Math.round(Math.max(0, Math.min(totalEntries - 1, entryIndex)) / (totalEntries - 1) * (scrollHeight - TIMELINE_MARKER_HEIGHT));
}

/**
 * Resolve the currently resident marker hitboxes without overlap. Browsers
 * cannot expose an unbounded physical scroll height, so a million-entry ruler
 * is denser than a 24px pointer target. The bounded resident page is spread
 * around its ideal absolute coordinates while preserving order and endpoints.
 */
export function timelineMarkerOffsets(
  items: readonly MemeLoopTimelineEntry[],
  totalEntries: number,
): readonly number[] {
  if (items.length === 0) return Object.freeze([]);
  const maximumOffset = timelineScrollHeight(totalEntries) - TIMELINE_MARKER_HEIGHT;
  const offsets = items.map(item => timelineEntryOffset(item.entryIndex, totalEntries));
  for (let index = 1; index < offsets.length; index += 1) {
    offsets[index] = Math.max(offsets[index], offsets[index - 1] + TIMELINE_MARKER_HEIGHT);
  }
  for (let index = offsets.length - 1; index >= 0; index -= 1) {
    const latest = maximumOffset - (offsets.length - 1 - index) * TIMELINE_MARKER_HEIGHT;
    offsets[index] = Math.min(offsets[index], latest);
  }
  for (let index = 0; index < offsets.length; index += 1) {
    const earliest = index * TIMELINE_MARKER_HEIGHT;
    offsets[index] = Math.max(earliest, offsets[index]);
  }
  return Object.freeze(offsets);
}
