/**
 * Synmerco Confidential — X25519 + HKDF-SHA256 + AES-256-GCM (ECIES) helper
 *
 * Turnkey crypto for the multi-recipient confidential escrow flow shipped
 * 2026-05-09. Same pattern Signal, age, and HPKE use; modern primitives
 * with forward secrecy via per-message ephemeral keys.
 *
 * Works in:
 *   - Browser (Web Crypto API, native X25519 in modern browsers)
 *   - Node.js >= 19 (Web Crypto via globalThis.crypto)
 *
 * Multi-recipient pattern matches the Synmerco escrow_recipient_envelopes
 * schema:
 *   1. Generate one random AES-256 content key per payload
 *   2. Encrypt payload once with that content key (AES-256-GCM)
 *   3. For each authorized recipient: encrypt the content key separately
 *      using their X25519 public key (ECIES per-recipient envelope)
 *   4. POST each envelope to /v1/escrows/:id/recipients
 *
 * Each recipient's private key stays on their own device. Synmerco never
 * sees the plaintext content key. Recipients added later don't require
 * re-encrypting the payload.
 *
 * Usage:
 *   import {
 *     generateRecipientKeyPair,
 *     generateContentKey,
 *     encryptPayload,
 *     encryptContentKeyForRecipient,
 *     decryptContentKeyAsRecipient,
 *     decryptPayload,
 *   } from "@/lib/crypto/synmerco-confidential";
 *
 *   // === Recipient (run once, store privateKey securely) ===
 *   const { publicKey, privateKey } = await generateRecipientKeyPair();
 *   // -> publish publicKey on listing, save privateKey on device
 *
 *   // === Sender (per confidential payload) ===
 *   const contentKey = await generateContentKey();
 *   const { ciphertext, iv } = await encryptPayload(contentKey, plaintext);
 *   // upload ciphertext to your storage of choice (IPFS, S3, etc)
 *
 *   const envelope = await encryptContentKeyForRecipient(
 *     contentKey,
 *     recipientPublicKey
 *   );
 *   // POST envelope.encryptedContentKey + envelope.ephemeralPublicKey
 *   // to /v1/escrows/:id/recipients along with recipientDid + recipientPublicKey
 *
 *   // === Recipient (when fetching their envelope) ===
 *   const contentKey = await decryptContentKeyAsRecipient(
 *     privateKey,
 *     envelope.ephemeralPublicKey,
 *     envelope.encryptedContentKey
 *   );
 *   const plaintext = await decryptPayload(contentKey, ciphertext, iv);
 */

const ENCRYPTION_METHOD = "X25519-HKDF-SHA256-AES256GCM" as const;

// ============================================================
// Encoding helpers (browser + Node share these)
// ============================================================

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let str = "";
    for (const b of bytes) str += String.fromCharCode(b);
    return btoa(str);
  }
  // Node.js fallback
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(b64: string): Uint8Array {
  // Returns a Uint8Array backed by a fresh ArrayBuffer (not SharedArrayBuffer).
  // The explicit copy makes TypeScript treat the result as BufferSource-compatible
  // for Web Crypto API calls under strict typing (TS 5.7+ tightened ArrayBufferLike).
  let raw: Uint8Array;
  if (typeof atob === "function") {
    const str = atob(b64);
    raw = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) raw[i] = str.charCodeAt(i);
  } else {
    raw = new Uint8Array(Buffer.from(b64, "base64"));
  }
  // Copy into a fresh ArrayBuffer to satisfy strict BufferSource typing
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  return new Uint8Array(buf);
}

// ============================================================
// Key generation
// ============================================================

export interface RecipientKeyPair {
  /** Base64 X25519 public key. Publish this on the agent's Synmerco listing. */
  publicKey: string;
  /** Base64 X25519 private key. KEEP SECRET. Store on the agent's device only. */
  privateKey: string;
}

/**
 * Generate a fresh X25519 keypair for a recipient agent. Run once per
 * agent identity. Publish publicKey on the listing's x25519_public_key
 * field. Store privateKey securely (e.g. localStorage with user-pin
 * encryption, OS keystore, or HSM for high-security use cases).
 */
export async function generateRecipientKeyPair(): Promise<RecipientKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "X25519" } as any,
    true,
    ["deriveKey", "deriveBits"]
  );

  const publicKey = await crypto.subtle.exportKey("raw", (keyPair as any).publicKey);
  const privateKey = await crypto.subtle.exportKey("pkcs8", (keyPair as any).privateKey);

  return {
    publicKey: bytesToBase64(new Uint8Array(publicKey)),
    privateKey: bytesToBase64(new Uint8Array(privateKey)),
  };
}

/**
 * Generate a random 256-bit AES content key. One per confidential payload.
 * Return type is the CryptoKey itself (so it can be passed to encryptPayload
 * without re-importing).
 */
export async function generateContentKey(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

// ============================================================
// Payload encrypt / decrypt with content key
// ============================================================

export interface EncryptedPayload {
  /** Base64 ciphertext (auth tag is appended by AES-GCM). */
  ciphertext: string;
  /** Base64 12-byte IV. */
  iv: string;
}

/**
 * Encrypt a plaintext payload with an AES-256-GCM content key. The content
 * key was generated by generateContentKey(). Returns base64-encoded
 * ciphertext + IV that you upload to your storage of choice.
 */
export async function encryptPayload(
  contentKey: CryptoKey,
  plaintext: Uint8Array | string
): Promise<EncryptedPayload> {
  const data = typeof plaintext === "string" ? new TextEncoder().encode(plaintext) : plaintext;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    contentKey,
    data as BufferSource
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

/**
 * Decrypt a payload using the recipient's recovered content key (from
 * decryptContentKeyAsRecipient()). Returns the raw bytes; caller can
 * TextDecoder().decode() if it was originally a string.
 */
export async function decryptPayload(
  contentKey: CryptoKey,
  ciphertextB64: string,
  ivB64: string
): Promise<Uint8Array> {
  const ciphertext = base64ToBytes(ciphertextB64);
  const iv = base64ToBytes(ivB64);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    contentKey,
    ciphertext as BufferSource
  );
  return new Uint8Array(plaintext);
}

// ============================================================
// ECIES envelope: encrypt content key for a specific recipient
// ============================================================

export interface RecipientEnvelope {
  /** Base64 ephemeral X25519 public key (from sender's per-message keypair). */
  ephemeralPublicKey: string;
  /** Base64 encrypted content key (AES-256-GCM with HKDF-derived key). */
  encryptedContentKey: string;
  /** Base64 12-byte IV used for the AES-GCM wrapping. */
  iv: string;
  /** Constant: which crypto method was used. POST this with the envelope. */
  encryptionMethod: typeof ENCRYPTION_METHOD;
}

/**
 * Encrypt the content key for one specific recipient.
 *
 * Steps (industry-standard ECIES):
 *   1. Generate ephemeral X25519 keypair (forward secrecy)
 *   2. ECDH(ephemeral_priv, recipient_pub) -> shared secret
 *   3. HKDF-SHA256(shared_secret, salt=ephemeral_pub) -> 32-byte AES key
 *   4. AES-256-GCM(aes_key, content_key) -> encrypted_content_key + iv
 *   5. Return ephemeral_pub + encrypted_content_key + iv
 *
 * The recipient uses their static private key + the ephemeral_pub to
 * recover the same shared secret -> same AES key -> decrypts content key.
 */
export async function encryptContentKeyForRecipient(
  contentKey: CryptoKey,
  recipientPublicKeyB64: string
): Promise<RecipientEnvelope> {
  // 1. Ephemeral X25519 keypair
  const ephemeralKeyPair = await crypto.subtle.generateKey(
    { name: "X25519" } as any,
    true,
    ["deriveKey", "deriveBits"]
  );
  const ephemeralPublicKeyBytes = await crypto.subtle.exportKey(
    "raw",
    (ephemeralKeyPair as any).publicKey
  );

  // 2. Import recipient public key
  const recipientPublicKey = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(recipientPublicKeyB64) as BufferSource,
    { name: "X25519" } as any,
    false,
    []
  );

  // 3. Derive shared secret + HKDF -> AES wrapping key
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: "X25519", public: recipientPublicKey } as any,
    (ephemeralKeyPair as any).privateKey,
    { name: "HKDF" },
    false,
    ["deriveKey"]
  );
  const aesWrappingKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(ephemeralPublicKeyBytes) as BufferSource,
      info: new TextEncoder().encode("synmerco-confidential-v1") as BufferSource,
    },
    wrappingKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  // 4. Export the content key as raw bytes, then encrypt those bytes
  //    with the wrapping key.
  const contentKeyRaw = await crypto.subtle.exportKey("raw", contentKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedContentKey = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    aesWrappingKey,
    contentKeyRaw
  );

  return {
    ephemeralPublicKey: bytesToBase64(new Uint8Array(ephemeralPublicKeyBytes)),
    encryptedContentKey: bytesToBase64(new Uint8Array(encryptedContentKey)),
    iv: bytesToBase64(iv),
    encryptionMethod: ENCRYPTION_METHOD,
  };
}

/**
 * Recipient side: recover the content key using their static private
 * key + the ephemeral public key from the envelope.
 *
 * Returns a CryptoKey ready to pass to decryptPayload().
 */
export async function decryptContentKeyAsRecipient(
  recipientPrivateKeyB64: string,
  ephemeralPublicKeyB64: string,
  encryptedContentKeyB64: string,
  ivB64: string
): Promise<CryptoKey> {
  // 1. Import the recipient's static private key
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    base64ToBytes(recipientPrivateKeyB64) as BufferSource,
    { name: "X25519" } as any,
    false,
    ["deriveKey", "deriveBits"]
  );

  // 2. Import the ephemeral public key from the envelope
  const ephemeralPublicKey = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(ephemeralPublicKeyB64) as BufferSource,
    { name: "X25519" } as any,
    false,
    []
  );

  // 3. Re-derive the same shared secret -> HKDF -> AES wrapping key
  const sharedKey = await crypto.subtle.deriveKey(
    { name: "X25519", public: ephemeralPublicKey } as any,
    privateKey,
    { name: "HKDF" },
    false,
    ["deriveKey"]
  );
  const aesWrappingKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: base64ToBytes(ephemeralPublicKeyB64) as BufferSource,
      info: new TextEncoder().encode("synmerco-confidential-v1") as BufferSource,
    },
    sharedKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  // 4. Decrypt the wrapped content key bytes
  const contentKeyRaw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivB64) as BufferSource },
    aesWrappingKey,
    base64ToBytes(encryptedContentKeyB64) as BufferSource
  );

  // 5. Re-import as an AES-GCM CryptoKey for use with decryptPayload
  return await crypto.subtle.importKey(
    "raw",
    contentKeyRaw,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
}

// ============================================================
// Convenience: high-level send + receive
// ============================================================

/**
 * Convenience helper for the buyer's primary agent: encrypt a payload
 * for N recipients in one call. Returns the shared payload ciphertext
 * + one envelope per recipient.
 *
 * The caller POSTs each envelope to /v1/escrows/:id/recipients along
 * with the recipient_did + recipient_public_key. The shared
 * payload ciphertext goes to whatever storage the buyer chose
 * (referenced via proof_uri on the escrow's proof_submission).
 */
export async function encryptForMultipleRecipients(
  plaintext: Uint8Array | string,
  recipients: { did: string; publicKey: string }[]
): Promise<{
  payload: EncryptedPayload;
  envelopes: { recipientDid: string; recipientPublicKey: string; envelope: RecipientEnvelope }[];
}> {
  const contentKey = await generateContentKey();
  const payload = await encryptPayload(contentKey, plaintext);

  const envelopes = await Promise.all(
    recipients.map(async (r) => ({
      recipientDid: r.did,
      recipientPublicKey: r.publicKey,
      envelope: await encryptContentKeyForRecipient(contentKey, r.publicKey),
    }))
  );

  return { payload, envelopes };
}

export { ENCRYPTION_METHOD };

// ============================================================
// (2026-10-29) Confidential escrow v2 helpers
// ============================================================

async function sha256HexBytes(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SealedForSynmerco {
  /** The exact file to host at proofUri: JSON {"ciphertext","iv"}. */
  fileText: string;
  /** SHA-256 of fileText (submit as proofHash). */
  proofHash: string;
  /** SHA-256 of the plaintext (submit as contentHash). */
  contentHash: string;
  /** The content key wrapped to Synmerco's witness key (submit as witnessEnvelope). */
  witnessEnvelope: RecipientEnvelope & { recipientPublicKey: string };
}

/**
 * Seller side, if you seal it yourself: encrypt your deliverable for a confidential escrow. Host `fileText` at a public
 * https URL and call submit-proof with { proofHash, proofUri, contentHash, witnessEnvelope }. Synmerco checks every hash,
 * opens it with the witness key, and makes the buyer's envelope itself. Easier: client.submitSealed(escrowId, text).
 * witnessPublicKey: GET /v1/synmerco -> protectedDelivery.witnessX25519PublicKey.
 */
export async function sealForSynmerco(plaintext: string, witnessPublicKeyB64: string): Promise<SealedForSynmerco> {
  const bytes = new TextEncoder().encode(plaintext);
  const contentKey = await generateContentKey();
  const enc = await encryptPayload(contentKey, bytes);
  const fileText = JSON.stringify({ ciphertext: enc.ciphertext, iv: enc.iv });
  const env = await encryptContentKeyForRecipient(contentKey, witnessPublicKeyB64);
  return {
    fileText,
    proofHash: await sha256HexBytes(new TextEncoder().encode(fileText)),
    contentHash: await sha256HexBytes(bytes),
    witnessEnvelope: { ...env, recipientPublicKey: witnessPublicKeyB64 },
  };
}

/**
 * Buyer side (after release) or seller side (a brief re-wrapped to your key): open a sealed payload with your private
 * key. `payload` is the JSON {ciphertext, iv} (the file at proofUri, or the brief response); `envelope` is yours
 * (GET /v1/escrows/<id>/recipients after release, or the brief's envelope). Checks the content hash when given.
 */
export async function openSealed(
  payload: { ciphertext: string; iv: string },
  envelope: { ephemeralPublicKey: string; encryptedContentKey: string; iv: string },
  privateKeyB64: string,
  expectedContentHash?: string
): Promise<string> {
  const key = await decryptContentKeyAsRecipient(privateKeyB64, envelope.ephemeralPublicKey, envelope.encryptedContentKey, envelope.iv);
  const plain = await decryptPayload(key, payload.ciphertext, payload.iv);
  if (expectedContentHash) {
    const h = await sha256HexBytes(plain);
    if (h !== expectedContentHash.toLowerCase()) throw new Error("content hash mismatch: the decrypted content is not the content Synmerco verified");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(plain);
}
