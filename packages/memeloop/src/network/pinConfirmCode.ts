/**
 * LAN PIN 确认码：双方对静态公钥排序后 SHA256，取 6 位十进制（计划 §8.3 / §7.5.3）。
 * 公钥为 Base64URL 字符串（与 keypair 存储一致）。
 * 使用 Web Crypto API（globalThis.crypto.subtle）实现跨环境兼容。
 */

/** 6 位数字字符串，前导零保留。 */
export async function computePinConfirmCode(staticPublicKeyA: string, staticPublicKeyB: string): Promise<string> {
  const sorted = [staticPublicKeyA, staticPublicKeyB].sort();
  const data = new TextEncoder().encode(`${sorted[0]}\n${sorted[1]}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const n = new DataView(digest).getUint32(0, false) % 1_000_000;
  return n.toString().padStart(6, '0');
}

/** 用户输入可与 `computePinConfirmCode` 结果比较（仅比较数字字符串）。 */
export async function verifyPinConfirmCode(
  staticPublicKeyA: string,
  staticPublicKeyB: string,
  userInput: string,
): Promise<boolean> {
  const normalized = userInput.replace(/\D/g, '').slice(0, 6).padStart(6, '0');
  return normalized === await computePinConfirmCode(staticPublicKeyA, staticPublicKeyB);
}
