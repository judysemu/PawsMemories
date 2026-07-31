import { createHash } from "node:crypto";
import type mysql from "mysql2/promise";

/** Maximum value representable by the signed MySQL INT wallet columns. */
export const MAX_CREDIT_BALANCE = 2_147_483_647;

export interface WalletClaimResolution {
  delta: number;
  reason: string;
  mutate?: (connection: mysql.PoolConnection) => Promise<void>;
}

export interface WalletClaimInput {
  ownerId: string;
  correlationId: string;
  expected?: { delta: number; reason: string };
  resolve: (context: {
    connection: mysql.PoolConnection;
    balance: number;
  }) => Promise<WalletClaimResolution>;
}

export interface WalletClaimResult {
  applied: boolean;
  balance: number;
  delta: number;
  reason: string;
}

export interface WalletDebitInput {
  ownerId: string;
  correlationId: string;
  amount: number;
  reason: string;
  mutate?: (connection: mysql.PoolConnection) => Promise<void>;
}

export interface WalletDebitResult {
  applied: boolean;
  authorized: boolean;
  balance: number;
}

export interface WalletDebitRefundResult extends WalletClaimResult {
  debitCorrelationId: string;
}

function validateIdentity(ownerId: string, correlationId: string): void {
  if (typeof ownerId !== "string" || ownerId.length === 0 || ownerId.length > 190) {
    throw new Error("Wallet claim owner is required.");
  }
  if (typeof correlationId !== "string" || correlationId.length === 0 || correlationId.length > 190) {
    throw new Error("A valid wallet claim correlation is required.");
  }
}

function validateResolution(value: WalletClaimResolution): void {
  if (!Number.isSafeInteger(value.delta) || value.delta <= 0 || value.delta > MAX_CREDIT_BALANCE) {
    throw new RangeError("Wallet claim amount must be a positive signed integer.");
  }
  if (typeof value.reason !== "string" || value.reason.length === 0 || value.reason.length > 80) {
    throw new Error("A valid wallet claim reason is required.");
  }
}

/** Apply one replay-safe wallet claim inside a caller-owned transaction. */
export async function applyWalletClaimInTransaction(
  connection: mysql.PoolConnection,
  input: WalletClaimInput,
): Promise<WalletClaimResult> {
  validateIdentity(input.ownerId, input.correlationId);

  const [ownerRows] = await connection.query(
    `SELECT credits FROM users WHERE phone = ? LIMIT 1 FOR UPDATE`,
    [input.ownerId],
  ) as any;
  if (!Array.isArray(ownerRows) || ownerRows.length !== 1) {
    throw new Error("Wallet claim owner was not found.");
  }
  const balance = Number(ownerRows[0].credits);
  if (!Number.isSafeInteger(balance) || balance < 0 || balance > MAX_CREDIT_BALANCE) {
    throw new Error("Wallet balance is invalid.");
  }

  const [existingRows] = await connection.query(
    `SELECT user_phone, delta, reason
       FROM credit_transactions
      WHERE idempotency_key = ?
      LIMIT 1 FOR UPDATE`,
    [input.correlationId],
  ) as any;
  if (Array.isArray(existingRows) && existingRows.length > 0) {
    const existing = existingRows[0];
    if (String(existing.user_phone) !== input.ownerId) {
      throw new Error("Wallet claim correlation is already owned by another account.");
    }
    if (input.expected && (
      Number(existing.delta) !== input.expected.delta
      || String(existing.reason) !== input.expected.reason
    )) {
      throw new Error("Wallet claim correlation is associated with different evidence.");
    }
    return {
      applied: false,
      balance,
      delta: Number(existing.delta),
      reason: String(existing.reason),
    };
  }

  const resolution = await input.resolve({ connection, balance });
  validateResolution(resolution);
  if (input.expected && (
    resolution.delta !== input.expected.delta
    || resolution.reason !== input.expected.reason
  )) {
    throw new Error("Resolved wallet claim does not match its server-owned evidence.");
  }
  const balanceAfter = balance + resolution.delta;
  if (!Number.isSafeInteger(balanceAfter) || balanceAfter > MAX_CREDIT_BALANCE) {
    throw new RangeError("Wallet claim would exceed the signed wallet maximum.");
  }

  const [updated] = await connection.query(
    `UPDATE users SET credits = ? WHERE phone = ?`,
    [balanceAfter, input.ownerId],
  ) as any;
  if (updated?.affectedRows !== 1) throw new Error("Wallet claim balance update failed.");

  await connection.query(
    `INSERT INTO credit_transactions
       (user_phone, delta, reason, balance_after, idempotency_key)
     VALUES (?, ?, ?, ?, ?)`,
    [input.ownerId, resolution.delta, resolution.reason, balanceAfter, input.correlationId],
  );
  if (resolution.mutate) await resolution.mutate(connection);

  return {
    applied: true,
    balance: balanceAfter,
    delta: resolution.delta,
    reason: resolution.reason,
  };
}

/** Start, commit, or roll back one wallet claim and its domain mutation. */
export async function applyWalletClaimOnce(
  pool: mysql.Pool,
  input: WalletClaimInput,
): Promise<WalletClaimResult> {
  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const result = await applyWalletClaimInTransaction(connection, input);
    await connection.commit();
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

/** Apply a replay-safe debit inside a caller-owned transaction. */
export async function applyWalletDebitInTransaction(
  connection: mysql.PoolConnection,
  input: WalletDebitInput,
): Promise<WalletDebitResult> {
  validateIdentity(input.ownerId, input.correlationId);
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > MAX_CREDIT_BALANCE) {
    throw new RangeError("Wallet debit amount must be a positive signed integer.");
  }
  if (typeof input.reason !== "string" || input.reason.length === 0 || input.reason.length > 80) {
    throw new Error("A valid wallet debit reason is required.");
  }

  const [ownerRows] = await connection.query(
    `SELECT credits FROM users WHERE phone = ? LIMIT 1 FOR UPDATE`,
    [input.ownerId],
  ) as any;
  if (!Array.isArray(ownerRows) || ownerRows.length !== 1) {
    return { applied: false, authorized: false, balance: 0 };
  }
  const balance = Number(ownerRows[0].credits);
  if (!Number.isSafeInteger(balance) || balance < 0 || balance > MAX_CREDIT_BALANCE) {
    throw new Error("Wallet debit owner has an invalid balance.");
  }

  const [existingRows] = await connection.query(
    `SELECT user_phone, delta, reason
       FROM credit_transactions WHERE idempotency_key = ? LIMIT 1 FOR UPDATE`,
    [input.correlationId],
  ) as any;
  if (Array.isArray(existingRows) && existingRows.length > 0) {
    const existing = existingRows[0];
    if (
      String(existing.user_phone) !== input.ownerId
      || Number(existing.delta) !== -input.amount
      || String(existing.reason) !== input.reason
    ) throw new Error("Wallet debit correlation is associated with different evidence.");
    return { applied: false, authorized: true, balance };
  }
  if (balance < input.amount) {
    return { applied: false, authorized: false, balance };
  }
  const balanceAfter = balance - input.amount;
  const [updated] = await connection.query(
    `UPDATE users SET credits = ? WHERE phone = ?`,
    [balanceAfter, input.ownerId],
  ) as any;
  if (updated?.affectedRows !== 1) throw new Error("Wallet debit update failed.");
  await connection.query(
    `INSERT INTO credit_transactions
      (user_phone, delta, reason, balance_after, idempotency_key)
     VALUES (?, ?, ?, ?, ?)`,
    [input.ownerId, -input.amount, input.reason, balanceAfter, input.correlationId],
  );
  if (input.mutate) await input.mutate(connection);
  return { applied: true, authorized: true, balance: balanceAfter };
}

/** Atomically reserve/spend wallet value and append its canonical ledger row. */
export async function applyWalletDebitOnce(
  pool: mysql.Pool,
  input: WalletDebitInput,
): Promise<WalletDebitResult> {
  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const result = await applyWalletDebitInTransaction(connection, input);
    await connection.commit();
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

function debitRefundCorrelation(debitCorrelationId: string): string {
  return `wallet-debit-refund:${createHash("sha256").update(debitCorrelationId).digest("hex")}`;
}

/** Refund immutable debit evidence inside a caller-owned transaction. */
export async function refundWalletDebitInTransaction(
  connection: mysql.PoolConnection,
  debitCorrelationId: string,
  expected?: { ownerId: string; amount: number },
): Promise<WalletDebitRefundResult> {
  if (typeof debitCorrelationId !== "string" || debitCorrelationId.length === 0 || debitCorrelationId.length > 190) {
    throw new Error("A valid wallet debit correlation is required for refund.");
  }
  const [sourceRows] = await connection.query(
    `SELECT user_phone, delta, reason
       FROM credit_transactions
      WHERE idempotency_key = ?
      LIMIT 1 FOR UPDATE`,
    [debitCorrelationId],
  ) as any;
  if (!Array.isArray(sourceRows) || sourceRows.length !== 1) {
    throw new Error("Wallet debit evidence was not found.");
  }
  const source = sourceRows[0];
  const ownerId = String(source.user_phone || "");
  const sourceDelta = Number(source.delta);
  if (!ownerId || !Number.isSafeInteger(sourceDelta) || sourceDelta >= 0) {
    throw new Error("Wallet refund source is not a debit.");
  }
  if (expected && (ownerId !== expected.ownerId || -sourceDelta !== expected.amount)) {
    throw new Error("Wallet debit evidence does not match the generation reservation.");
  }
  const refundReason = `refund:${String(source.reason || "spend")}`.slice(0, 80);
  const result = await applyWalletClaimInTransaction(connection, {
    ownerId,
    correlationId: debitRefundCorrelation(debitCorrelationId),
    expected: { delta: -sourceDelta, reason: refundReason },
    resolve: async () => ({ delta: -sourceDelta, reason: refundReason }),
  });
  return { ...result, debitCorrelationId };
}

/**
 * Refund an existing debit using the immutable debit ledger as the sole source
 * of owner and amount. Callers possess only the server-created correlation;
 * they cannot supply value or choose the recipient. Replays converge on the
 * unique refund ledger row without changing the balance twice.
 */
export async function refundWalletDebitOnce(
  pool: mysql.Pool,
  debitCorrelationId: string,
): Promise<WalletDebitRefundResult> {
  const connection = await pool.getConnection();
  let started = false;
  try {
    await connection.beginTransaction();
    started = true;
    const result = await refundWalletDebitInTransaction(connection, debitCorrelationId);
    await connection.commit();
    started = false;
    return result;
  } catch (error) {
    if (started) await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}
