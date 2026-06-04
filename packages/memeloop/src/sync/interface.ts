export interface IChatSyncAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
}
