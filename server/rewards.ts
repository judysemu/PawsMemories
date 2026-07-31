import crypto from "node:crypto";
import type mysql from "mysql2/promise";
import { applyWalletClaimOnce, type WalletClaimResult } from "./wallet";

export const ACHIEVEMENT_REWARDS = {
  pioneer: 25,
  creation: 20,
} as const;

export type ClaimableAchievementId = keyof typeof ACHIEVEMENT_REWARDS;
export type RewardClaimErrorCode = "UNKNOWN_ACHIEVEMENT" | "NOT_ELIGIBLE" | "ALREADY_CLAIMED";

export class RewardClaimError extends Error {
  constructor(public readonly code: RewardClaimErrorCode) {
    super(code);
    this.name = "RewardClaimError";
  }
}

function ownerDigest(ownerId: string): string {
  return crypto.createHash("sha256").update(ownerId).digest("hex");
}

function normalizeAchievements(value: unknown): string[] {
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** Claim a server-valued achievement after proving eligibility from DB state. */
export async function claimAchievementReward(
  pool: mysql.Pool,
  ownerId: string,
  requestedId: string,
): Promise<WalletClaimResult> {
  if (!Object.prototype.hasOwnProperty.call(ACHIEVEMENT_REWARDS, requestedId)) {
    throw new RewardClaimError("UNKNOWN_ACHIEVEMENT");
  }
  const achievementId = requestedId as ClaimableAchievementId;
  return applyWalletClaimOnce(pool, {
    ownerId,
    correlationId: `reward:achievement:${ownerDigest(ownerId)}:${achievementId}`,
    expected: {
      delta: ACHIEVEMENT_REWARDS[achievementId],
      reason: `achievement_${achievementId}`,
    },
    resolve: async ({ connection }) => {
      const [userRows] = await connection.query(
        `SELECT profile_complete, achievements_json
           FROM users WHERE phone = ? LIMIT 1`,
        [ownerId],
      ) as any;
      if (!Array.isArray(userRows) || userRows.length !== 1) {
        throw new RewardClaimError("NOT_ELIGIBLE");
      }
      const achievements = normalizeAchievements(userRows[0].achievements_json);
      if (achievements.includes(achievementId)) {
        throw new RewardClaimError("ALREADY_CLAIMED");
      }

      let eligible = achievementId === "pioneer" && Number(userRows[0].profile_complete) === 1;
      if (achievementId === "creation") {
        const [creationRows] = await connection.query(
          `SELECT 1 FROM creations WHERE user_phone = ? LIMIT 1`,
          [ownerId],
        ) as any;
        eligible = Array.isArray(creationRows) && creationRows.length > 0;
      }
      if (!eligible) throw new RewardClaimError("NOT_ELIGIBLE");

      return {
        delta: ACHIEVEMENT_REWARDS[achievementId],
        reason: `achievement_${achievementId}`,
        mutate: async (domainConnection) => {
          achievements.push(achievementId);
          const [updated] = await domainConnection.query(
            `UPDATE users SET achievements_json = ? WHERE phone = ?`,
            [JSON.stringify(achievements), ownerId],
          ) as any;
          if (updated?.affectedRows !== 1) throw new Error("Achievement state update failed.");
        },
      };
    },
  });
}

function requireCalendarDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error("Invalid server calendar date.");
  }
  return value;
}

/** Claim one UTC calendar streak reward from a server-derived date. */
export async function claimDailyStreakReward(
  pool: mysql.Pool,
  ownerId: string,
  serverDate: string,
): Promise<WalletClaimResult> {
  const today = requireCalendarDate(serverDate);
  return applyWalletClaimOnce(pool, {
    ownerId,
    correlationId: `reward:streak:${ownerDigest(ownerId)}:${today}`,
    resolve: async ({ connection }) => {
      const [rows] = await connection.query(
        `SELECT daily_streak, last_streak_claim
           FROM users WHERE phone = ? LIMIT 1`,
        [ownerId],
      ) as any;
      if (!Array.isArray(rows) || rows.length !== 1) throw new RewardClaimError("NOT_ELIGIBLE");
      const rawClaimedDate: unknown = rows[0].last_streak_claim;
      const claimedDate = rawClaimedDate instanceof Date
        ? rawClaimedDate.toISOString().slice(0, 10)
        : rawClaimedDate ? String(rawClaimedDate).slice(0, 10) : null;
      if (claimedDate === today) throw new RewardClaimError("ALREADY_CLAIMED");

      const yesterday = new Date(`${today}T00:00:00.000Z`);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const newStreak = claimedDate === yesterday.toISOString().slice(0, 10)
        ? Number(rows[0].daily_streak || 0) + 1
        : 1;
      const streakBundle = newStreak % 3 === 0 ? 15 : 0;
      const reward = 5 + streakBundle;
      return {
        delta: reward,
        reason: streakBundle ? "daily_bonus_streak_bundle" : "daily_bonus",
        mutate: async (domainConnection) => {
          const [updated] = await domainConnection.query(
            `UPDATE users
                SET daily_streak = ?, last_streak_claim = ?, treats = treats + 1
              WHERE phone = ?`,
            [newStreak, today, ownerId],
          ) as any;
          if (updated?.affectedRows !== 1) throw new Error("Daily streak state update failed.");
        },
      };
    },
  });
}
