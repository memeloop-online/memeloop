/**
 * Explicit host-test helpers. Production browser and React Native entrypoints
 * intentionally do not retain conformance runners in their runtime graphs.
 */
export { assertStorageConformance, runStorageConformance, STORAGE_CONFORMANCE_CHECKS } from './storage/conformance.js';
export type { StorageConformanceCheck, StorageConformanceFailure, StorageConformanceReport } from './storage/conformance.js';
