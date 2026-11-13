import type { Stream } from '@libp2p/interface';
import type { DeviceAuthorizer, FullAgentStorage } from 'memeloop/device-network/portable';
import { isLibp2pSyncRequest, LIBP2P_SYNC_RESPONSE_TYPE } from 'memeloop/device-network/portable';
import { SYNC_IDLE_TIMEOUT_MS, SYNC_MESSAGE_MAX_BYTES, SYNC_PROTOCOL, SYNC_TOTAL_TIMEOUT_MS } from './protocolConstants.js';
import { syncErrorCode } from './protocolErrors.js';
import { readJsonMessage, writeJsonMessage } from './streamIO.js';
import { handleSyncRequest } from './syncRequestHandler.js';

export async function handleSyncStream(host: { authorizer: DeviceAuthorizer; storage: FullAgentStorage | undefined }, stream: Stream, remotePeerId: string): Promise<void> {
  const requestAbort = new AbortController();
  let responseFinished = false;
  const onStreamClose = (event: Event): void => {
    if (responseFinished || requestAbort.signal.aborted) return;
    const closeEvent = event as Event & { error?: Error };
    requestAbort.abort(closeEvent.error ?? new Error('sync_stream_closed'));
  };
  stream.addEventListener?.('close', onStreamClose, { once: true });
  let requestId = 'unknown';
  try {
    // Cloud authorization needs request.grant, which v2 carries inside this bounded frame.
    const request = await readJsonMessage<unknown>(
      stream,
      SYNC_MESSAGE_MAX_BYTES,
      SYNC_IDLE_TIMEOUT_MS,
      SYNC_TOTAL_TIMEOUT_MS,
    );
    requestAbort.signal.throwIfAborted();
    if (!isLibp2pSyncRequest(request)) throw new Error('invalid_sync_request');
    requestId = request.id;
    const authorized = await host.authorizer.canOpenProtocol({
      remotePeerId,
      protocol: SYNC_PROTOCOL,
      direction: 'inbound',
      presentedGrant: request.grant,
    });
    if (!authorized) throw new Error('device_not_trusted');
    const result = await handleSyncRequest(host.storage, request, requestAbort.signal);
    requestAbort.signal.throwIfAborted();
    await writeJsonMessage(
      stream,
      {
        type: LIBP2P_SYNC_RESPONSE_TYPE,
        id: request.id,
        ok: true,
        result,
      },
      SYNC_MESSAGE_MAX_BYTES,
    );
  } catch (error) {
    if (!requestAbort.signal.aborted) {
      await writeJsonMessage(
        stream,
        {
          type: LIBP2P_SYNC_RESPONSE_TYPE,
          id: requestId,
          ok: false,
          error: { code: syncErrorCode(error) },
        },
        SYNC_MESSAGE_MAX_BYTES,
      ).catch(() => undefined);
    }
  } finally {
    responseFinished = true;
    stream.removeEventListener?.('close', onStreamClose);
    await stream.close().catch(() => undefined);
  }
}
