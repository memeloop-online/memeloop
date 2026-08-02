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

export interface DeviceCloudConnectionSnapshot {
  status: DeviceCloudConnectionStatus;
  generation: number;
  components: Record<DeviceCloudConnectionComponent, DeviceCloudComponentStatus>;
  lastError?: unknown;
  nextRetryAt?: number;
}

/**
 * A step performs remote or otherwise reversible work first. Durable host
 * state must only be changed by commit(), which the coordinator invokes after
 * confirming that the configuration generation is still current.
 */
export interface DeviceCloudStepResult {
  commit?: () => Promise<unknown>;
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
  classifyError?(error: unknown): 'offline' | 'error';
}

export interface DeviceCloudConnectionCoordinatorOptions<Configuration> {
  adapter: DeviceCloudConnectionAdapter<Configuration>;
  configuration?: Configuration;
  heartbeatIntervalMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  jitterRatio?: number;
  now?: () => number;
  random?: () => number;
  onStatus?: (snapshot: DeviceCloudConnectionSnapshot) => void | Promise<void>;
  logWarning?: (message: string, error: unknown) => void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_JITTER_RATIO = 0.2;

function emptyComponents(): DeviceCloudConnectionSnapshot['components'] {
  return {
    authorizer: 'not-run',
    registration: 'not-run',
    relay: 'not-run',
    heartbeat: 'not-run',
    directory: 'not-run',
  };
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
}

/** Portable, generation-safe Cloud lifecycle shared by every MemeLoop host. */
export class DeviceCloudConnectionCoordinator<Configuration> {
  private configuration: Configuration | undefined;
  private generation = 0;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private started = false;
  private consecutiveFailures = 0;
  private snapshotValue: DeviceCloudConnectionSnapshot = {
    status: 'not-configured',
    generation: 0,
    components: emptyComponents(),
  };
  private readonly heartbeatIntervalMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly jitterRatio: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: DeviceCloudConnectionCoordinatorOptions<Configuration>) {
    this.configuration = options.configuration;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    assertNonNegativeFinite(this.heartbeatIntervalMs, 'heartbeatIntervalMs');
    assertNonNegativeFinite(this.initialBackoffMs, 'initialBackoffMs');
    assertNonNegativeFinite(this.maxBackoffMs, 'maxBackoffMs');
    assertNonNegativeFinite(this.jitterRatio, 'jitterRatio');
    if (this.jitterRatio > 1) throw new TypeError('jitterRatio must not exceed 1');
    this.resetSnapshot();
  }

  public get snapshot(): DeviceCloudConnectionSnapshot {
    return {
      ...this.snapshotValue,
      components: { ...this.snapshotValue.components },
    };
  }

  public async start(): Promise<void> {
    if (this.started) return this.runNow();
    this.started = true;
    await this.runNow();
  }

  public async stop(): Promise<void> {
    this.started = false;
    this.clearTimer();
    const stoppedController = this.controller;
    stoppedController.abort(new Error('device cloud coordinator stopped'));
    await this.inFlight?.catch(() => undefined);
    if (this.controller === stoppedController) {
      this.controller = new AbortController();
    }
  }

  public async setConfiguration(configuration: Configuration | undefined): Promise<void> {
    this.configuration = configuration;
    this.generation += 1;
    this.consecutiveFailures = 0;
    this.clearTimer();
    this.controller.abort(new Error('device cloud configuration changed'));
    this.controller = new AbortController();
    this.inFlight = undefined;
    this.resetSnapshot();
    if (this.started && this.options.adapter.isConfigured(configuration)) await this.runNow();
  }

  public runNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.options.adapter.isConfigured(this.configuration)) {
      this.resetSnapshot();
      return Promise.resolve();
    }
    const generation = this.generation;
    const configuration = this.configuration;
    const signal = this.controller.signal;
    const run = this.maintain(configuration, generation, signal);
    const tracked = run.finally(() => {
      if (this.inFlight === tracked) this.inFlight = undefined;
    });
    this.inFlight = tracked;
    return tracked;
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

    try {
      if (this.snapshotValue.components.authorizer !== 'ready') {
        await this.runStep('authorizer', generation, signal, () => this.options.adapter.ensureAuthorizer(configuration, signal));
      }
      if (this.snapshotValue.components.registration !== 'ready') {
        await this.runStep('registration', generation, signal, () => this.options.adapter.registerDevice(configuration, signal));
      }

      let relayError: unknown;
      try {
        await this.runStep('relay', generation, signal, () => this.options.adapter.ensureRelay(configuration, signal));
      } catch (error) {
        relayError = error;
        this.options.logWarning?.('Cloud relay maintenance failed', error);
      }

      await this.runStep('heartbeat', generation, signal, () => this.options.adapter.heartbeat(configuration, signal));

      let directoryError: unknown;
      try {
        await this.runStep('directory', generation, signal, () => this.options.adapter.syncDirectory(configuration, signal));
      } catch (error) {
        directoryError = error;
        this.options.logWarning?.('Cloud directory synchronization failed', error);
      }

      if (!this.isCurrent(generation, signal)) return;
      this.consecutiveFailures = 0;
      const relayRequired = this.options.adapter.relayRequiredForOnline(configuration);
      await this.updateSnapshot(generation, {
        status: directoryError || (relayRequired && relayError) ? 'degraded' : 'online',
        lastError: directoryError ?? relayError,
        nextRetryAt: this.now() + this.heartbeatIntervalMs,
      });
      this.schedule(this.heartbeatIntervalMs, generation);
    } catch (error) {
      if (!this.isCurrent(generation, signal)) return;
      this.consecutiveFailures += 1;
      if (this.snapshotValue.components.heartbeat === 'failed') {
        this.snapshotValue.components.registration = 'not-run';
      }
      const status = this.options.adapter.classifyError?.(error) ?? 'offline';
      const delay = this.backoffDelay();
      await this.updateSnapshot(generation, {
        status,
        lastError: error,
        nextRetryAt: this.now() + delay,
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
      await result?.commit?.();
      if (!this.isCurrent(generation, signal)) return;
      await this.setComponent(component, 'ready', generation);
    } catch (error) {
      if (this.isCurrent(generation, signal)) await this.setComponent(component, 'failed', generation);
      throw error;
    }
  }

  private backoffDelay(): number {
    const exponential = Math.min(
      this.maxBackoffMs,
      this.initialBackoffMs * 2 ** Math.max(0, this.consecutiveFailures - 1),
    );
    const jitter = exponential * this.jitterRatio * (this.random() * 2 - 1);
    return Math.max(0, Math.round(exponential + jitter));
  }

  private schedule(delayMs: number, generation: number): void {
    if (!this.started || generation !== this.generation) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      if (generation !== this.generation) return;
      void this.runNow().catch((error: unknown) => {
        this.options.logWarning?.('Cloud maintenance failed', error);
      });
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private isCurrent(generation: number, signal: AbortSignal): boolean {
    return generation === this.generation && !signal.aborted;
  }

  private async setComponent(
    component: DeviceCloudConnectionComponent,
    status: DeviceCloudComponentStatus,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation) return;
    this.snapshotValue = {
      ...this.snapshotValue,
      components: { ...this.snapshotValue.components, [component]: status },
    };
    await this.emit();
  }

  private async updateSnapshot(
    generation: number,
    update: Partial<Omit<DeviceCloudConnectionSnapshot, 'generation' | 'components'>>,
  ): Promise<void> {
    if (generation !== this.generation) return;
    this.snapshotValue = { ...this.snapshotValue, ...update };
    await this.emit();
  }

  private resetSnapshot(): void {
    this.snapshotValue = {
      status: this.options.adapter.isConfigured(this.configuration)
        ? 'offline'
        : 'not-configured',
      generation: this.generation,
      components: emptyComponents(),
    };
    void this.emit();
  }

  private async emit(): Promise<void> {
    await this.options.onStatus?.(this.snapshot);
  }
}
