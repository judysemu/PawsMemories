/**
 * Envelope encryption for customer-supplied provider API keys.
 *
 * AES-256-GCM, not CBC: GCM is authenticated, so a tampered ciphertext fails to
 * decrypt rather than silently yielding garbage that would then be sent to a
 * provider as if it were the customer's key.
 *
 * The plaintext key exists only inside decryptApiKey's return value. It is
 * never persisted, never logged, and never returned over HTTP — callers get
 * key_last4 instead, which is enough to recognise a key but not to use it.
 */
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
/** GCM's standard nonce length. 12 bytes is the size the mode is defined for. */
const IV_BYTES = 12;

export class KeyVaultError extends Error {
  constructor(message: string, public readonly code: "NOT_CONFIGURED" | "BAD_SECRET" | "DECRYPT_FAILED") {
    super(message);
    this.name = "KeyVaultError";
  }
}

/**
 * Derives the 32-byte AES key from KEY_ENCRYPTION_SECRET.
 *
 * Hashed rather than used raw so any secret length works, and read per call
 * rather than cached so rotating the env var takes effect on restart without a
 * stale key lingering in module state.
 */
function encryptionKey(): Buffer {
  const secret = String(process.env.KEY_ENCRYPTION_SECRET || "");
  if (!secret) {
    throw new KeyVaultError("KEY_ENCRYPTION_SECRET is not configured.", "NOT_CONFIGURED");
  }
  // A short secret is worse than none, because it looks configured while being
  // trivially brute-forceable. Refuse rather than quietly accept it.
  if (secret.length < 32) {
    throw new KeyVaultError("KEY_ENCRYPTION_SECRET must be at least 32 characters.", "BAD_SECRET");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export interface SealedKey {
  ciphertext: string;
  iv: string;
  authTag: string;
  last4: string;
}

/** Encrypts a provider key for storage. A fresh IV per call is mandatory in
 *  GCM — reusing one across encryptions breaks the mode's security entirely. */
export function encryptApiKey(plaintext: string): SealedKey {
  const value = String(plaintext || "").trim();
  if (!value) throw new KeyVaultError("Cannot encrypt an empty key.", "BAD_SECRET");
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    last4: value.slice(-4),
  };
}

/** Decrypts a stored key. Throws on any tampering, since GCM authentication
 *  fails closed rather than returning corrupted plaintext. */
export function decryptApiKey(sealed: { ciphertext: string; iv: string; authTag: string }): string {
  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      encryptionKey(),
      Buffer.from(sealed.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (err) {
    if (err instanceof KeyVaultError) throw err;
    // Deliberately opaque: the failure reason (wrong secret vs tampered data)
    // is not something a caller should be able to distinguish.
    throw new KeyVaultError("Stored key could not be decrypted.", "DECRYPT_FAILED");
  }
}

/** Shape check only — a real check costs a provider round trip, which the
 *  connect route does separately. Catches paste errors before that. */
export function looksLikeGoogleApiKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{30,80}$/.test(String(value || "").trim());
}
