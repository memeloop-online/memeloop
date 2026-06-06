declare module 'sodium-universal' {
  export const crypto_aead_chacha20poly1305_ietf_KEYBYTES: number;
  export const crypto_aead_chacha20poly1305_ietf_NPUBBYTES: number;
  export const crypto_aead_chacha20poly1305_ietf_ABYTES: number;

  export function crypto_aead_chacha20poly1305_ietf_encrypt(
    ciphertext: Uint8Array,
    message: Uint8Array,
    additionalData: Uint8Array | null,
    secretNonce: Uint8Array | null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): void;

  export function crypto_aead_chacha20poly1305_ietf_decrypt(
    message: Uint8Array,
    secretNonce: Uint8Array | null,
    ciphertext: Uint8Array,
    additionalData: Uint8Array | null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): number;
}
