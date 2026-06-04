/**
 * LAN PIN 确认码：双方对静态公钥排序后 SHA256，取 6 位十进制（计划 §8.3 / §7.5.3）。
 * 公钥为 Base64URL 字符串（与 keypair 存储一致）。
 */

import { createHash } from 'node:crypto';

/** 6 位数字字符串，前导零保留。 */
export function computePinConfirmCode(staticPublicKeyA: string, staticPublicKeyB: string): string {
  const sorted = [staticPublicKeyA, staticPublicKeyB].sort();
  const digest = createHash('sha256').update(`${sorted[0]}\n${sorted[1]}`).digest();
  const n = digest.readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, '0');
}

/** 用户输入可与 `computePinConfirmCode` 结果比较（仅比较数字字符串）。 */
export function verifyPinConfirmCode(
  staticPublicKeyA: string,
  staticPublicKeyB: string,
  userInput: string,
): boolean {
  const normalized = userInput.replace(/\D/g, '').slice(0, 6).padStart(6, '0');
  return normalized === computePinConfirmCode(staticPublicKeyA, staticPublicKeyB);
}
