/** Storage for customer-supplied provider keys. Every read returns the sealed
 *  form; decryption is a separate, deliberate step at the point of use. */
import type mysql from "mysql2/promise";
import { encryptApiKey, decryptApiKey } from "./keyVault";

export interface StoredKeyRow {
  ciphertext: string;
  iv: string;
  auth_tag: string;
  key_last4: string;
  status: string;
  created_at: string;
  last_used_at: string | null;
}

/** Upsert: reconnecting replaces the existing key rather than adding a second,
 *  so there is never ambiguity about which key a generation used. */
export async function saveUserApiKey(
  pool: mysql.Pool,
  userPhone: string,
  provider: string,
  plaintextKey: string,
): Promise<{ last4: string }> {
  const sealed = encryptApiKey(plaintextKey);
  await pool.query(
    `INSERT INTO user_api_keys (user_phone, provider, ciphertext, iv, auth_tag, key_last4, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')
     ON DUPLICATE KEY UPDATE
       ciphertext = VALUES(ciphertext), iv = VALUES(iv), auth_tag = VALUES(auth_tag),
       key_last4 = VALUES(key_last4), status = 'active', last_used_at = NULL`,
    [userPhone, provider, sealed.ciphertext, sealed.iv, sealed.authTag, sealed.last4],
  );
  return { last4: sealed.last4 };
}

/** Safe for API responses: no ciphertext, no IV, no tag — only the last 4. */
export async function getUserKeyStatus(
  pool: mysql.Pool,
  userPhone: string,
  provider: string,
): Promise<{ connected: boolean; last4?: string; createdAt?: string; lastUsedAt?: string | null }> {
  const [rows] = await pool.query(
    `SELECT key_last4, created_at, last_used_at FROM user_api_keys
      WHERE user_phone = ? AND provider = ? AND status = 'active' LIMIT 1`,
    [userPhone, provider],
  ) as any;
  if (!rows?.length) return { connected: false };
  return {
    connected: true,
    last4: rows[0].key_last4,
    createdAt: rows[0].created_at,
    lastUsedAt: rows[0].last_used_at,
  };
}

/**
 * Returns the plaintext key for immediate use. The only function that ever
 * produces it — treat the return value as sensitive: never log it, never put
 * it in an error message, never return it over HTTP.
 */
export async function useUserApiKey(
  pool: mysql.Pool,
  userPhone: string,
  provider: string,
): Promise<string | null> {
  const [rows] = await pool.query(
    `SELECT ciphertext, iv, auth_tag FROM user_api_keys
      WHERE user_phone = ? AND provider = ? AND status = 'active' LIMIT 1`,
    [userPhone, provider],
  ) as any;
  if (!rows?.length) return null;
  const plaintext = decryptApiKey({
    ciphertext: rows[0].ciphertext,
    iv: rows[0].iv,
    authTag: rows[0].auth_tag,
  });
  // Best-effort usage stamp; a failure here must not block the generation the
  // customer is paying their own provider for.
  pool.query(
    `UPDATE user_api_keys SET last_used_at = NOW() WHERE user_phone = ? AND provider = ?`,
    [userPhone, provider],
  ).catch(() => undefined);
  return plaintext;
}

/** Hard delete rather than a status flag: "disconnect" should mean the key is
 *  gone, not merely hidden. */
export async function deleteUserApiKey(
  pool: mysql.Pool,
  userPhone: string,
  provider: string,
): Promise<boolean> {
  const [result] = await pool.query(
    `DELETE FROM user_api_keys WHERE user_phone = ? AND provider = ?`,
    [userPhone, provider],
  ) as any;
  return result.affectedRows > 0;
}
