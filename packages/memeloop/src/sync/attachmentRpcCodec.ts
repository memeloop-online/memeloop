/**
 * 将节点 RPC `memeloop.storage.getAttachmentBlob` 的返回值解码为同步引擎可用的 BLOB。
 */

export function decodeAttachmentBlobRpc(
  result: unknown,
): { data: Uint8Array; filename: string; mimeType: string; size: number } | null {
  if (result == null || typeof result !== 'object') return null;
  const r = result as {
    found?: boolean;
    error?: string;
    dataBase64?: string;
    filename?: string;
    mimeType?: string;
    size?: number;
  };
  if (r.error || !r.found || typeof r.dataBase64 !== 'string') return null;
  let data: Uint8Array;
  try {
    data = decodeBase64(r.dataBase64, { variant: 'standard', padding: 'required', allowEmpty: false });
  } catch {
    return null;
  }
  return {
    data,
    filename: typeof r.filename === 'string' ? r.filename : 'attachment',
    mimeType: typeof r.mimeType === 'string' ? r.mimeType : 'application/octet-stream',
    size: typeof r.size === 'number' && r.size > 0 ? r.size : data.byteLength,
  };
}
import { decodeBase64 } from '../encoding/base64.js';
