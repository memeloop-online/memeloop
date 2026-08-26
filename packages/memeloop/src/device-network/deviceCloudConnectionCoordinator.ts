import type { DeviceCloudCommitFence, SyncResult } from './types.js';

export type { DeviceCloudCommitFence } from './types.js';

export type DeviceCloudConnectionStatus =
  | 'not-configured'
  | 'connecting'
  | 'online'
  | 'degraded'
  | 'offline'
  | 'error';

export type DeviceCloudConnectionComponent =
  | 'authorizer'
  | 'registration'
  | 'relay'
  | 'heartbeat'
  | 'directory';

export type DeviceCloudComponentStatus = 'pending' | 'ready' | 'failed' | 'not-run';

export type DeviceCloudErrorClassification = 'offline' | 'error' | 'registration-invalid';

/** A deliberately small, stable error safe to persist, render, and log. */
export interface DeviceCloudConnectionError {
  readonly code:
    | 'DEVICE_CLOUD_STEP_FAILED'
    | 'DEVICE_CLOUD_DISPOSE_FAILED'
    | 'DEVICE_CLOUD_OBSERVER_FAILED';
  readonly classification: DeviceCloudErrorClassification;
  readonly component?: DeviceCloudConnectionComponent;
}

export interface DeviceCloudConnectionSnapshot {
  readonly status: DeviceCloudConnectionStatus;
  readonly generation: number;
  readonly components: Readonly<Record<DeviceCloudConnectionComponent, DeviceCloudComponentStatus>>;
  readonly lastError?: DeviceCloudConnectionError;
  readonly nextRetryAt?: number;
}

export class DeviceCloudStaleGenerationError extends Error {
  public readonly code = 'DEVICE_CLOUD_STALE_GENERATION';

  constructor() {
    super('Device Cloud generation is stale');
    this.name = 'DeviceCloudStaleGenerationError';
  }
}

export interface DeviceCloudStepResult {
  commit?: (fence: DeviceCloudCommitFence) => Promise<unknown>;
}

export interface DeviceCloudConnectionAdapter<Configuration> {
  isConfigured(configuration: Configuration | undefined): configuration is Configuration;
  relayRequiredForOnline(configuration: Configuration): boolean;
  ensureAuthorizer(
    configuration: Configuration,
    signal: AbortSignal,
  ): Promise<DeviceCloudStepResult | undefined>;
  registerDevice(
    configuration: Configuration,
    signal: AbortSignal,
  ): Promise<DeviceCloudStepResult | undefined>;
  ensureRelay(
    configuration: Configuration,
    signal: AbortSignal,
  ): Promise<DeviceCloudStepResult | undefined>;
  heartbeat(
    configuration: Configuration,
    signal: AbortSignal,
  ): Promise<DeviceCloudStepResult | undefined>;
  syncDirectory(
    configuration: Configuration,
    signal: AbortSignal,
  ): Promise<DeviceCloudStepResult | undefined>;
  /**
   * Optional background anti-entropy hooks. The coordinator keeps one run per
   * peer and generation, retries incomplete bounded results, and aborts every
   * old-generation run before activating replacement configuration.
   */
  listBackgroundSyncPeerIds?(
    configuration: Configuration,
    signal: AbortSignal,
  ): readonly string[] | Promise<readonly string[]>;
  syncDevice?(
    configuration: Configuration,
    peerId: string,
    signal: AbortSignal,
  ): Promise<SyncResult>;
  /** Clear every generation-scoped authorizer, relay, token, trust, and address effect. */
  dispose?(configuration: Configuration, signal: AbortSignal): Promise<void>;
  classifyError?(error: unknown): DeviceCloudErrorClassification;
}

export interface DeviceCloudConnectionCoordinatorOptions<Configuration> {
  adapter: DeviceCloudConnectionAdapter<Configuration>;
  configuration?: Configuration;
  heartbeatIntervalMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  jitterRatio?: number;
  backgroundSyncInitialBackoffMs?: number;
  backgroundSyncMaxBackoffMs?: number;
  now?: () => number;
  random?: () => number;
  /** Async status persistence must use the fence at its final write point. */
  onStatus?: (
    snapshot: DeviceCloudConnectionSnapshot,
    fence: DeviceCloudCommitFence,
  ) => void | Promise<void>;
  logWarning?: (message: string, error: DeviceCloudConnectionError) => void | Promise<void>;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_BACKGROUND_SYNC_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_BACKGROUND_SYNC_MAX_BACKOFF_MS = 60_000;
const MAX_BACKGROUND_SYNC_PEERS = 1_024;
const MAX_BACKGROUND_SYNC_PEER_ID_CHARACTERS = 512;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function emptyComponents(): Readonly<Record<DeviceCloudConnectionComponent, DeviceCloudComponentStatus>> {
  return Object.freeze({
    authorizer: 'not-run',
    registration: 'not-run',
    relay: 'not-run',
    heartbeat: 'not-run',
    directory: 'not-run',
  });
}

function assertPositiveFiniteDelay(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`${name} must be a finite integer between 1 and ${MAX_TIMER_DELAY_MS}`);
  }
}

function normalizeBackgroundSyncPeerIds(peerIds: unknown): string[] {
  if (!Array.isArray(peerIds) || peerIds.length > MAX_BACKGROUND_SYNC_PEERS) {
    throw new TypeError('invalid_background_sync_peer_ids');
  }
  const normalized: unknown[] = [...new Set<unknown>(peerIds)];
  if (
    normalized.some(peerId =>
      typeof peerId !== 'string' || peerId.length === 0 ||
      peerId.length > MAX_BACKGROUND_SYNC_PEER_ID_CHARACTERS || peerId !== peerId.trim()
    )
  ) {
    throw new TypeError('invalid_background_sync_peer_ids');
  }
  return normalized.map(peerId => String(peerId)).sort();
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error('operation_aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  signal.throwIfAborted();
}

function safeError(
  code: DeviceCloudConnectionError['code'],
  classification: DeviceCloudErrorClassification,
  component?: DeviceCloudConnectionComponent,
): DeviceCloudConnectionError {
  return Object.freeze(
    component === undefined
      ? { code, classification }
      : { code, classification, component },
  );
}

function freezeSnapshot(snapshot: DeviceCloudConnectionSnapshot): DeviceCloudConnectionSnapshot {
  return Object.freeze({
    ...snapshot,
    components: Object.freeze({ ...snapshot.components }),
    ...(snapshot.lastError === undefined ? {} : { lastError: Object.freeze({ ...snapshot.lastError }) }),
  });
}

/** Portable, generation-safe Cloud lifecycle shared by every MemeLoop host. */
export class DeviceCloudConnectionCoordinator<Configuration> {
  private configuration: Configuration | undefined;
  private desiredConfiguration: Configuration | undefined;
  private generation = 0;
  private requestedGeneration = 0;
  private transition?: Promise<void>;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private readonly backgroundSyncRuns = new Map<string, {
    generation: number;
    promise: Promise<void>;
  }>();
  private started = false;
  private generationActivated = false;
  private consecutiveFailures = 0;
  private snapshotValue: DeviceCloudConnectionSnapshot = freezeSnapshot({
    status: 'not-configured',
    generation: 0,
    components: emptyComponents(),
  });
  private readonly heartbeatIntervalMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly jitterRatio: number;
  private readonly backgroundSyncInitialBackoffMs: number;
  private readonly backgroundSyncMaxBackoffMs: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: DeviceCloudConnectionCoordinatorOptions<Configuration>) {
    this.configuration = options.configuration;
    this.desiredConfiguration = options.configuration;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    this.backgroundSyncInitialBackoffMs = options.backgroundSyncInitialBackoffMs ??
      DEFAULT_BACKGROUND_SYNC_INITIAL_BACKOFF_MS;
    this.backgroundSyncMaxBackoffMs = options.backgroundSyncMaxBackoffMs ??
      DEFAULT_BACKGROUND_SYNC_MAX_BACKOFF_MS;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    assertPositiveFiniteDelay(this.heartbeatIntervalMs, 'heartbeatIntervalMs');
    assertPositiveFiniteDelay(this.initialBackoffMs, 'initialBackoffMs');
    assertPositiveFiniteDelay(this.maxBackoffMs, 'maxBackoffMs');
    assertPositiveFiniteDelay(
      this.backgroundSyncInitialBackoffMs,
      'backgroundSyncInitialBackoffMs',
    );
    assertPositiveFiniteDelay(
      this.backgroundSyncMaxBackoffMs,
      'backgroundSyncMaxBackoffMs',
    );
    if (this.maxBackoffMs < this.initialBackoffMs) {
      throw new TypeError('maxBackoffMs must be greater than or equal to initialBackoffMs');
    }
    if (this.backgroundSyncMaxBackoffMs < this.backgroundSyncInitialBackoffMs) {
      throw new TypeError(
        'backgroundSyncMaxBackoffMs must be greater than or equal to backgroundSyncInitialBackoffMs',
      );
    }
    if (!Number.isFinite(this.jitterRatio) || this.jitterRatio < 0 || this.jitterRatio > 1) {
      throw new TypeError('jitterRatio must be a finite number between 0 and 1');
    }
    this.resetSnapshot();
  }

  public get snapshot(): DeviceCloudConnectionSnapshot {
    return this.snapshotValue;
  }

  public async start(): Promise<void> {
    if (this.started) return this.runNow();
    this.started = true;
    const transition = this.transition;
    if (transition) {
      await transition;
      return;
    }
    await this.runCurrent();
  }

  public stop(): Promise<void> {
    if (
      !this.started && !this.inFlight && !this.transition && !this.generationActivated &&
      this.backgroundSyncRuns.size === 0
    ) {
      return Promise.resolve();
    }
    this.started = false;
    return this.requestTransition('device cloud coordinator stopped');
  }

  public setConfiguration(configuration: Configuration | undefined): Promise<void> {
    this.desiredConfiguration = configuration;
    return this.requestTransition('device cloud configuration changed');
  }

  public runNow(): Promise<void> {
    if (this.transition) {
      return this.started ? this.transition : this.transition.then(() => this.runCurrent());
    }
    return this.runCurrent();
  }

  private runCurrent(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.options.adapter.isConfigured(this.configuration)) {
      this.resetSnapshot();
      return Promise.resolve();
    }
    const generation = this.generation;
    const configuration = this.configuration;
    const signal = this.controller.signal;
    this.generationActivated = true;
    const run = this.maintain(configuration, generation, signal);
    const tracked = run.finally(() => {
      if (this.inFlight === tracked) this.inFlight = undefined;
    });
    this.inFlight = tracked;
    return tracked;
  }

  private requestTransition(reason: string): Promise<void> {
    this.requestedGeneration += 1;
    this.clearTimer();
    this.controller.abort(new Error(reason));
    if (!this.transition) {
      const transition = this.drainTransitions().finally(() => {
        if (this.transition === transition) this.transition = undefined;
      });
      this.transition = transition;
    }
    return this.transition;
  }

  private async drainTransitions(): Promise<void> {
    while (this.generation !== this.requestedGeneration) {
      const previousConfiguration = this.configuration;
      const previousRun = this.inFlight;
      await previousRun?.catch(() => undefined);
      await this.drainBackgroundSyncGeneration(this.generation);

      if (
        this.generationActivated &&
        this.options.adapter.isConfigured(previousConfiguration)
      ) {
        try {
          await this.options.adapter.dispose?.(previousConfiguration, new AbortController().signal);
        } catch {
          this.warn(
            'Device Cloud generation cleanup failed',
            safeError('DEVICE_CLOUD_DISPOSE_FAILED', 'error'),
          );
        }
      }
      this.generationActivated = false;

      // Requests arriving while cleanup was in progress are deliberately
      // coalesced: only the newest desired configuration is ever activated.
      this.configuration = this.desiredConfiguration;
      this.generation = this.requestedGeneration;
      this.consecutiveFailures = 0;
      this.controller = new AbortController();
      if (this.inFlight === previousRun) this.inFlight = undefined;
      this.resetSnapshot();

      if (this.started && this.options.adapter.isConfigured(this.configuration)) {
        await this.runCurrent().catch((error: unknown) => {
          if (this.isCurrent(this.generation, this.controller.signal)) throw error;
        });
      }
    }
  }

  private async maintain(
    configuration: Configuration,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.isCurrent(generation, signal)) return;
    await this.updateSnapshot(generation, {
      status: 'connecting',
      lastError: undefined,
      nextRetryAt: undefined,
    });

    let activeComponent: DeviceCloudConnectionComponent = 'authorizer';
    try {
      if (this.snapshotValue.components.authorizer !== 'ready') {
        activeComponent = 'authorizer';
        await this.runStep(activeComponent, generation, signal, () => this.options.adapter.ensureAuthorizer(configuration, signal));
      }
      if (this.snapshotValue.components.registration !== 'ready') {
        activeComponent = 'registration';
        await this.runStep(activeComponent, generation, signal, () => this.options.adapter.registerDevice(configuration, signal));
      }

      let relayFailure: DeviceCloudConnectionError | undefined;
      try {
        activeComponent = 'relay';
        await this.runStep(activeComponent, generation, signal, () => this.options.adapter.ensureRelay(configuration, signal));
      } catch (error) {
        const classification = this.classify(error);
        if (classification === 'registration-invalid') throw error;
        relayFailure = safeError('DEVICE_CLOUD_STEP_FAILED', classification, 'relay');
        this.warn('Device Cloud relay maintenance failed', relayFailure);
      }

      activeComponent = 'heartbeat';
      await this.runStep(activeComponent, generation, signal, () => this.options.adapter.heartbeat(configuration, signal));

      let directoryFailure: DeviceCloudConnectionError | undefined;
      try {
        activeComponent = 'directory';
        await this.runStep(activeComponent, generation, signal, () => this.options.adapter.syncDirectory(configuration, signal));
      } catch (error) {
        const classification = this.classify(error);
        if (classification === 'registration-invalid') throw error;
        directoryFailure = safeError('DEVICE_CLOUD_STEP_FAILED', classification, 'directory');
        this.warn('Device Cloud directory synchronization failed', directoryFailure);
      }

      if (!directoryFailure) this.startBackgroundSync(configuration, generation, signal);

      if (!this.isCurrent(generation, signal)) return;
      this.consecutiveFailures = 0;
      const relayRequired = this.options.adapter.relayRequiredForOnline(configuration);
      const nextRetryAt = this.retryAt(this.heartbeatIntervalMs);
      await this.updateSnapshot(generation, {
        status: directoryFailure || (relayRequired && relayFailure) ? 'degraded' : 'online',
        lastError: directoryFailure ?? relayFailure,
        nextRetryAt,
      });
      this.schedule(this.heartbeatIntervalMs, generation);
    } catch (error) {
      if (!this.isCurrent(generation, signal)) return;
      this.consecutiveFailures += 1;
      const classification = this.classify(error);
      if (classification === 'registration-invalid') {
        await this.setComponent('registration', 'not-run', generation);
      }
      const status = classification === 'error' ? 'error' : 'offline';
      const delay = this.backoffDelay();
      await this.updateSnapshot(generation, {
        status,
        lastError: safeError('DEVICE_CLOUD_STEP_FAILED', classification, activeComponent),
        nextRetryAt: this.retryAt(delay),
      });
      this.schedule(delay, generation);
      throw error;
    }
  }

  private async runStep(
    component: DeviceCloudConnectionComponent,
    generation: number,
    signal: AbortSignal,
    operation: () => Promise<DeviceCloudStepResult | undefined>,
  ): Promise<void> {
    if (!this.isCurrent(generation, signal)) return;
    await this.setComponent(component, 'pending', generation);
    try {
      const result = await operation();
      if (!this.isCurrent(generation, signal)) return;
      const fence = this.createCommitFence(generation, signal);
      await result?.commit?.(fence);
      if (!this.isCurrent(generation, signal)) return;
      await this.setComponent(component, 'ready', generation);
    } catch (error) {
      if (this.isCurrent(generation, signal)) await this.setComponent(component, 'failed', generation);
      throw error;
    }
  }

  private createCommitFence(generation: number, signal: AbortSignal): DeviceCloudCommitFence {
    return Object.freeze({
      generation,
      signal,
      isCurrent: () => this.isCurrent(generation, signal),
      throwIfStale: () => {
        if (!this.isCurrent(generation, signal)) throw new DeviceCloudStaleGenerationError();
      },
      commitSynchronous: <Result>(
        operation: () => Result extends PromiseLike<unknown> ? never : Result,
      ) => {
        if (!this.isCurrent(generation, signal)) return false;
        operation();
        return true;
      },
    });
  }

  private classify(error: unknown): DeviceCloudErrorClassification {
    try {
      const classification = this.options.adapter.classifyError?.(error) ?? 'offline';
      return classification === 'offline' || classification === 'error' || classification === 'registration-invalid'
        ? classification
        : 'error';
    } catch {
      return 'error';
    }
  }

  private backoffDelay(): number {
    const exponential = Math.min(
      this.maxBackoffMs,
      this.initialBackoffMs * 2 ** Math.max(0, this.consecutiveFailures - 1),
    );
    const random = this.random();
    if (!Number.isFinite(random) || random < 0 || random > 1) {
      throw new TypeError('random() must return a finite number between 0 and 1');
    }
    const jitter = exponential * this.jitterRatio * (random * 2 - 1);
    return Math.max(1, Math.min(MAX_TIMER_DELAY_MS, Math.round(exponential + jitter)));
  }

  private startBackgroundSync(
    configuration: Configuration,
    generation: number,
    signal: AbortSignal,
  ): void {
    const listBackgroundSyncPeerIds = this.options.adapter.listBackgroundSyncPeerIds?.bind(
      this.options.adapter,
    );
    const syncDevice = this.options.adapter.syncDevice?.bind(this.options.adapter);
    if (!listBackgroundSyncPeerIds || !syncDevice || !this.isCurrent(generation, signal)) return;
    void Promise.resolve()
      .then(async () => {
        const rawPeerIds = await listBackgroundSyncPeerIds(configuration, signal);
        if (!this.isCurrent(generation, signal)) return;
        const peerIds = normalizeBackgroundSyncPeerIds(rawPeerIds);
        for (const peerId of peerIds) {
          if (!this.isCurrent(generation, signal)) return;
          const existing = this.backgroundSyncRuns.get(peerId);
          if (existing?.generation === generation) continue;
          const run = this.runBackgroundSyncDevice(
            configuration,
            peerId,
            generation,
            signal,
            syncDevice,
          );
          const record = { generation, promise: run };
          this.backgroundSyncRuns.set(peerId, record);
          const release = (): void => {
            if (this.backgroundSyncRuns.get(peerId) === record) {
              this.backgroundSyncRuns.delete(peerId);
            }
          };
          void run.then(release, release);
        }
      })
      .catch((error: unknown) => {
        if (!this.isCurrent(generation, signal)) return;
        this.warn(
          'Device Cloud background sync discovery failed',
          safeError('DEVICE_CLOUD_STEP_FAILED', this.classify(error)),
        );
      });
  }

  private async runBackgroundSyncDevice(
    configuration: Configuration,
    peerId: string,
    generation: number,
    signal: AbortSignal,
    syncDevice: NonNullable<DeviceCloudConnectionAdapter<Configuration>['syncDevice']>,
  ): Promise<void> {
    let attempt = 0;
    while (this.isCurrent(generation, signal)) {
      try {
        const result = await syncDevice(configuration, peerId, signal);
        if (!this.isCurrent(generation, signal) || result.complete) return;
        attempt = 0;
      } catch (error) {
        if (!this.isCurrent(generation, signal)) return;
        attempt += 1;
        this.warn(
          'Device Cloud background sync failed',
          safeError('DEVICE_CLOUD_STEP_FAILED', this.classify(error)),
        );
      }
      const delay = this.backgroundSyncBackoffDelay(attempt);
      try {
        await abortableDelay(delay, signal);
      } catch {
        return;
      }
    }
  }

  private backgroundSyncBackoffDelay(attempt: number): number {
    const exponential = Math.min(
      this.backgroundSyncMaxBackoffMs,
      this.backgroundSyncInitialBackoffMs * 2 ** Math.max(0, attempt - 1),
    );
    const random = this.random();
    if (!Number.isFinite(random) || random < 0 || random > 1) {
      return this.backgroundSyncInitialBackoffMs;
    }
    const jitter = exponential * this.jitterRatio * (random * 2 - 1);
    return Math.max(1, Math.min(MAX_TIMER_DELAY_MS, Math.round(exponential + jitter)));
  }

  private async drainBackgroundSyncGeneration(generation: number): Promise<void> {
    const runs = [...this.backgroundSyncRuns.values()]
      .filter(run => run.generation === generation)
      .map(run => run.promise.catch(() => undefined));
    await Promise.all(runs);
  }

  private readNow(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('now() must return a finite non-negative safe integer timestamp');
    }
    return value;
  }

  private retryAt(delayMs: number): number {
    const now = this.readNow();
    if (now > Number.MAX_SAFE_INTEGER - delayMs) {
      throw new TypeError('now() plus delay must remain a safe integer timestamp');
    }
    return now + delayMs;
  }

  private schedule(delayMs: number, generation: number): void {
    if (!this.started || !this.isCurrent(generation, this.controller.signal)) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      if (!this.isCurrent(generation, this.controller.signal)) return;
      void this.runNow().catch(() => {
        this.warn(
          'Device Cloud scheduled maintenance failed',
          safeError('DEVICE_CLOUD_STEP_FAILED', 'offline'),
        );
      });
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private isCurrent(generation: number, signal: AbortSignal): boolean {
    return generation === this.generation && generation === this.requestedGeneration && !signal.aborted;
  }

  private async setComponent(
    component: DeviceCloudConnectionComponent,
    status: DeviceCloudComponentStatus,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation || generation !== this.requestedGeneration) return;
    this.snapshotValue = freezeSnapshot({
      ...this.snapshotValue,
      components: { ...this.snapshotValue.components, [component]: status },
    });
    this.emit();
  }

  private async updateSnapshot(
    generation: number,
    update: Partial<Omit<DeviceCloudConnectionSnapshot, 'generation' | 'components'>>,
  ): Promise<void> {
    if (generation !== this.generation || generation !== this.requestedGeneration) return;
    const next: DeviceCloudConnectionSnapshot = {
      ...this.snapshotValue,
      ...update,
      ...(update.lastError === undefined ? { lastError: undefined } : {}),
    };
    this.snapshotValue = freezeSnapshot(next);
    this.emit();
  }

  private resetSnapshot(): void {
    this.snapshotValue = freezeSnapshot({
      status: this.options.adapter.isConfigured(this.configuration)
        ? 'offline'
        : 'not-configured',
      generation: this.generation,
      components: emptyComponents(),
    });
    this.emit();
  }

  /** Status observers are telemetry only: never part of a network transition. */
  private emit(): void {
    const snapshot = this.snapshotValue;
    const signal = this.controller.signal;
    void Promise.resolve()
      .then(async () => {
        if (!this.isCurrent(snapshot.generation, signal)) return;
        await this.options.onStatus?.(
          snapshot,
          this.createCommitFence(snapshot.generation, signal),
        );
      })
      .catch(() => {
        this.warn(
          'Device Cloud status observer failed',
          safeError('DEVICE_CLOUD_OBSERVER_FAILED', 'error'),
        );
      });
  }

  private warn(message: string, error: DeviceCloudConnectionError): void {
    const boundedMessage = message.slice(0, 160);
    void Promise.resolve()
      .then(() => this.options.logWarning?.(boundedMessage, error))
      .catch(() => undefined);
  }
}
