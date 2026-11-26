import type {
  DeviceAuthorizer,
  DeviceConnectionGrant,
  DeviceNetworkService,
  DeviceStreamOptions,
  DeviceSyncOptions,
  FullAgentStorage,
  SyncResult,
} from 'memeloop/device-network/portable';
import { type ChatSyncEngine, createAgentDeviceRpcRequestId, isLibp2pRpcResponse, JsonFrameError, LIBP2P_RPC_REQUEST_TYPE } from 'memeloop/device-network/portable';
import { DEVICE_SYNC_MAX_PASSES, RPC_PROTOCOL, SYNC_TOTAL_TIMEOUT_MS } from './protocolConstants.js';
import { abortSignalError, elapsedMilliseconds, linkedTimeoutController, raceWithAbortSignal, readStreamJson, writeStreamJson } from './streamIO.js';
import { requestedConversationIdsForGrant } from './syncParameters.js';

interface PeerSyncHost {
  authorizer: DeviceAuthorizer;
  storage: FullAgentStorage | undefined;
  createDeviceSyncEngine(peerId: string, grant: DeviceConnectionGrant | undefined, conversationIds: string[] | undefined): ChatSyncEngine;
}

export async function sendRpc<T>(
  host: Pick<DeviceNetworkService, 'openStream'>,
  peerId: string,
  method: string,
  parameters: unknown,
  options: DeviceStreamOptions = {},
): Promise<T> {
  const { presentedGrant } = options;
  const stream = await host.openStream(peerId, RPC_PROTOCOL, options);
  const request = {
    type: LIBP2P_RPC_REQUEST_TYPE,
    id: createAgentDeviceRpcRequestId(),
    method,
    params: parameters,
    grant: presentedGrant,
  };
  try {
    await writeStreamJson(stream, request);
    const response = await readStreamJson(stream);
    if (!isLibp2pRpcResponse(response)) throw new Error('invalid_rpc_response');
    if (response.id !== request.id) throw new Error('rpc_response_id_mismatch');
    if (!response.ok) throw new Error(response.error.code);
    return response.result as T;
  } catch (error) {
    if (options.signal?.aborted) {
      const abortError = abortSignalError(options.signal);
      await stream.abort(abortError);
      throw abortError;
    }
    if (error instanceof JsonFrameError) await stream.abort(error);
    throw error;
  } finally {
    await stream.close().catch(() => undefined);
  }
}

export async function syncWithDevice(host: PeerSyncHost, peerId: string, options: DeviceSyncOptions = {}): Promise<SyncResult> {
  const startedAt = Date.now();
  const externalSignal = options.signal ?? new AbortController().signal;
  externalSignal.throwIfAborted();
  const overall = linkedTimeoutController(
    externalSignal,
    SYNC_TOTAL_TIMEOUT_MS,
    'sync_total_timeout',
  );
  const progress = {
    passes: 0,
    peers: 0,
    frontierPages: 0,
    pages: 0,
    events: 0,
    bytes: 0,
    elapsedMs: 0,
  };
  const { presentedGrant } = options;
  try {
    const authorized = await raceWithAbortSignal(
      host.authorizer.canOpenProtocol({
        remotePeerId: peerId,
        protocol: '/memeloop/sync/2.0.0',
        direction: 'outbound',
        presentedGrant,
      }),
      overall.signal,
    );
    if (!authorized) throw new Error('device_not_trusted');
    externalSignal.throwIfAborted();
    if (!host.storage) throw new Error('sync_storage_not_configured');
    const conversationIds = requestedConversationIdsForGrant(
      presentedGrant,
      options.conversationIds,
    );
    // A call owns its engine and AbortSignal. Reusing an in-flight engine across
    // Cloud configuration generations would make the first caller's signal win
    // ChatSyncEngine's pass coalescing and could let stale work outlive its
    // generation. Durable frontiers plus bounded discovery make a fresh engine
    // safe after cancellation or process restart.
    const engine = host.createDeviceSyncEngine(peerId, presentedGrant, conversationIds);
    while (progress.passes < DEVICE_SYNC_MAX_PASSES) {
      externalSignal.throwIfAborted();
      overall.signal.throwIfAborted();
      const pass = await raceWithAbortSignal(
        engine.syncOnce({ signal: overall.signal }),
        overall.signal,
      );
      progress.passes += 1;
      progress.peers += pass.progress.peers;
      progress.frontierPages += pass.progress.frontierPages;
      progress.pages += pass.progress.pages;
      progress.events += pass.progress.events;
      progress.bytes += pass.progress.bytes;
      if (pass.complete) {
        progress.elapsedMs = elapsedMilliseconds(startedAt);
        return {
          ok: true,
          peerId,
          syncedAt: Date.now(),
          complete: true,
          progress,
        };
      }
      if (!pass.continuation) throw new Error(`event_sync_incomplete:${peerId}`);
    }
    progress.elapsedMs = elapsedMilliseconds(startedAt);
    return {
      ok: true,
      peerId,
      syncedAt: Date.now(),
      complete: false,
      progress,
      continuation: {
        reason: 'pass-limit',
        resumeFrom: 'durable-frontier',
      },
    };
  } catch (error) {
    externalSignal.throwIfAborted();
    if (overall.signal.aborted) {
      progress.elapsedMs = elapsedMilliseconds(startedAt);
      return {
        ok: true,
        peerId,
        syncedAt: Date.now(),
        complete: false,
        progress,
        continuation: {
          reason: 'time-limit',
          resumeFrom: 'durable-frontier',
        },
      };
    }
    throw error;
  } finally {
    overall.dispose();
  }
}
