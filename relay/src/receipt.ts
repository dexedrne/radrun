// Ed25519 receipts cover the canonical result and transcript digest. Verifiers must pin the relay's public key.
export type Receipt = { payload: string; signature: string };
const bytes = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
export async function receiptSigner(pkcs8: string): Promise<(payload: string) => Promise<Receipt>> {
  const key = await crypto.subtle.importKey('pkcs8', bytes(pkcs8), 'Ed25519', false, ['sign']);
  return async payload => ({ payload, signature: b64(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(payload))) });
}
export async function verifyReceipt(receipt: Receipt, pinnedPublicKey: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('spki', bytes(pinnedPublicKey), 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, bytes(receipt.signature), new TextEncoder().encode(receipt.payload));
  } catch { return false; }
}
export async function transcriptDigest(words: [Float64Array, Float64Array]): Promise<string> {
  // Encode explicit little-endian doubles, independent of host endianness.
  const data = new Uint8Array(words[0].length * 16), view = new DataView(data.buffer);
  for (let s = 0; s < words[0].length; s++) for (let k = 0; k < 2; k++) view.setFloat64(s * 16 + k * 8, words[k][s], true);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(n => n.toString(16).padStart(2, '0')).join('');
}
