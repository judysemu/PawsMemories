import mysql from "mysql2/promise";
import { generateUserKey } from "./auth";
import { CREDIT_PRICES } from "./src/pricing";
import type { ModelSpatialMetadata } from "./src/three/spatial/types";
import type {
  PaidEndpoint,
  PaidUsageLimits,
  PaidUsageReservation,
} from "./server/paidApiGuards";
import { runMigrations } from "./server/migrations/runner";
import {
  applyWalletDebitInTransaction,
  applyWalletDebitOnce,
  applyWalletClaimOnce,
  MAX_CREDIT_BALANCE,
  refundWalletDebitInTransaction,
  refundWalletDebitOnce,
} from "./server/wallet";
import {
  RewardClaimError,
  claimAchievementReward,
  claimDailyStreakReward,
} from "./server/rewards";
import { HISTORIC_DIGITAL_TEMPLATES } from "./shared/historicPawprintTemplates";

/** Internal row key for the seeded admin account (not a phone number). */
const ADMIN_KEY = process.env.ADMIN_KEY || process.env.ADMIN_PHONE || "";

/**
 * MySQL-backed user store for Paws & Memories.
 * Connection settings come from environment variables:
 *   DB_HOST, DB_PORT (optional, default 3306), DB_NAME, DB_USER, DB_PASSWORD
 */

let pool: mysql.Pool | null = null;

export { MAX_CREDIT_BALANCE };

function isValidCreditAmount(amount: number): boolean {
  return Number.isSafeInteger(amount) && amount > 0 && amount <= MAX_CREDIT_BALANCE;
}

function boundedEnvInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

/** Pool configuration is exported so deployment settings can be contract-tested. */
export function databasePoolOptions(
  env: NodeJS.ProcessEnv = process.env,
): mysql.PoolOptions {
  const connectionLimit = boundedEnvInt(env.DB_CONNECTION_LIMIT, 10, 1, 50);
  return {
    host: env.DB_HOST || "localhost",
    port: boundedEnvInt(env.DB_PORT, 3306, 1, 65535),
    user: env.DB_USER || "",
    password: env.DB_PASSWORD || "",
    database: env.DB_NAME || "",
    waitForConnections: true,
    connectionLimit,
    maxIdle: boundedEnvInt(env.DB_MAX_IDLE, connectionLimit, 1, connectionLimit),
    idleTimeout: boundedEnvInt(env.DB_IDLE_TIMEOUT_MS, 60_000, 10_000, 900_000),
    queueLimit: boundedEnvInt(env.DB_QUEUE_LIMIT, 0, 0, 10_000),
    connectTimeout: boundedEnvInt(env.DB_CONNECT_TIMEOUT_MS, 10_000, 1_000, 60_000),
    enableKeepAlive: true,
    keepAliveInitialDelay: boundedEnvInt(env.DB_KEEPALIVE_DELAY_MS, 0, 0, 60_000),
  };
}

function databaseExplicitlyDisabledForTests(): boolean {
  return process.env.NODE_ENV === "test" && process.env.DB_DISABLED === "1";
}

export function dbConfigured(): boolean {
  if (databaseExplicitlyDisabledForTests()) return false;
  return !!(process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER);
}

export function setPool(newPool: mysql.Pool) {
  pool = newPool;
}

export function getPool(): mysql.Pool {
  if (databaseExplicitlyDisabledForTests()) {
    throw new Error("Database is disabled for this test process.");
  }
  if (!pool) {
    pool = mysql.createPool(databasePoolOptions());
  }
  return pool;
}

export interface DatabaseHealth {
  configured: boolean;
  healthy: boolean;
  latencyMs: number;
  error?: string;
}

export async function checkDatabaseHealth(timeoutMs = 3_000): Promise<DatabaseHealth> {
  const startedAt = Date.now();
  if (!dbConfigured()) {
    return { configured: false, healthy: false, latencyMs: 0, error: "Database is not configured." };
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      getPool().query("SELECT 1 AS ok"),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Database health check timed out.")), timeoutMs);
      }),
    ]);
    return { configured: true, healthy: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      configured: true,
      healthy: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Database health check failed.",
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function closePool(): Promise<void> {
  const currentPool = pool;
  pool = null;
  if (currentPool) await currentPool.end();
}

export interface UserRow {
  id: number;
  phone: string;
  full_name: string | null;
  email: string | null;
  password_hash: string | null;
  birthdate: string | null;
  city: string | null;
  zip: string | null;
  credits: number;
  treats: number;
  profile_complete: number;
  is_admin?: number;
  is_tester?: number;
  daily_streak?: number;
  last_streak_claim?: string | null;
  achievements_json?: string | null;
  profile_photo_url?: string | null;
  created_at: string;
  // Phase 8
  phone_verified?: number;
  email_verified?: number;
  bio?: string | null;
  notification_prefs?: string | null;
  profile_bonus_granted?: number;
  accepted_terms_version?: string | null;
  accepted_terms_at?: string | null;
  pawprint_tokens?: number;
  referral_code?: string | null;
  referred_by?: string | null;
  free_avatar_available?: number;
}

/** Public-safe shape returned to the client. */
export interface PublicUser {
  id: number;
  fullName: string;
  email: string;
  credits: number;
  freeAvatarAvailable: boolean;
  treats: number;
  city: string;
  zip?: string;
  birthdate: string;
  profileComplete: boolean;
  isAdmin: boolean;
  isTester: boolean;
  dailyStreak: number;
  lastStreakClaim: string | null;
  profilePhotoUrl: string | null;
  achievements: any[];
  // Phase 8
  bio?: string | null;
  phoneVerified?: boolean;
  emailVerified?: boolean;
  referralCode?: string | null;
  profileBonusGranted?: boolean;
  acceptedTermsVersion?: string | null;
  acceptedTermsAt?: string | null;
  currentTermsVersion?: string;
  requiresTermsAcceptance?: boolean;
}

export function toPublicUser(userRow: any, currentTermsVersion?: string): PublicUser {
  let achievements = [];
  if (userRow.achievements_json) {
    try { achievements = JSON.parse(userRow.achievements_json); } catch(e) {}
  }
  
  const acceptedTermsVersion = userRow.accepted_terms_version || null;
  return {
    id: userRow.id,
    fullName: userRow.full_name || "",
    email: userRow.email || "",
    city: userRow.city || "",
    zip: userRow.zip || undefined,
    birthdate: userRow.birthdate || "",
    profileComplete: !!userRow.profile_complete,
    credits: userRow.credits,
    freeAvatarAvailable: !!userRow.free_avatar_available,
    treats: userRow.treats || 0,
    isAdmin: !!userRow.is_admin || (!!ADMIN_KEY && userRow.phone === ADMIN_KEY),
    isTester: !!userRow.is_tester,
    dailyStreak: userRow.daily_streak || 0,
    lastStreakClaim: userRow.last_streak_claim || null,
    profilePhotoUrl: userRow.profile_photo_url || null,
    achievements: achievements,
    bio: userRow.bio || null,
    phoneVerified: !!userRow.phone_verified,
    emailVerified: !!userRow.email_verified,
    referralCode: userRow.referral_code || null,
    profileBonusGranted: !!userRow.profile_bonus_granted,
    acceptedTermsVersion,
    acceptedTermsAt: userRow.accepted_terms_at || null,
    currentTermsVersion,
    requiresTermsAcceptance: !!currentTermsVersion && acceptedTermsVersion !== currentTermsVersion,
  };
}

/** Create the users, creations, and generation_jobs tables if they do not exist. Safe to call on every boot. */
export async function initDb(): Promise<void> {
  if (!dbConfigured()) {
    console.warn("⚠️ Database env vars missing (DB_HOST/DB_NAME/DB_USER). User accounts disabled until configured.");
    return;
  }
  try {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        phone VARCHAR(32) NOT NULL UNIQUE,
        full_name VARCHAR(120) NULL,
        email VARCHAR(190) NULL,
        password_hash VARCHAR(255) NULL,
        birthdate DATE NULL,
        city VARCHAR(120) NULL,
        credits INT NOT NULL DEFAULT 0,
        treats INT NOT NULL DEFAULT 0,
        profile_complete TINYINT(1) NOT NULL DEFAULT 0,
        is_admin TINYINT(1) NOT NULL DEFAULT 0,
        is_operator TINYINT(1) NOT NULL DEFAULT 0,
        daily_streak INT NOT NULL DEFAULT 0,
        last_streak_claim DATE NULL,
        free_avatar_available TINYINT(1) NOT NULL DEFAULT 1,
        achievements_json TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Migration for existing tables
    const dbName = process.env.DB_NAME;
    const [cols] = await getPool().query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'`,
      [dbName]
    ) as any;
    const columnNames = cols.map((c: any) => c.COLUMN_NAME);

    // Robust migration: ensure every expected column exists on legacy tables.
    // (Older deploys created `users` without some of these — e.g. is_admin —
    //  and CREATE TABLE IF NOT EXISTS never alters an existing table.)
    const requiredColumns: { name: string; ddl: string }[] = [
      { name: "email",             ddl: "ADD COLUMN email VARCHAR(190) NULL" },
      { name: "password_hash",     ddl: "ADD COLUMN password_hash VARCHAR(255) NULL" },
      { name: "birthdate",         ddl: "ADD COLUMN birthdate DATE NULL" },
      { name: "city",              ddl: "ADD COLUMN city VARCHAR(120) NULL" },
      { name: "credits",           ddl: "ADD COLUMN credits INT NOT NULL DEFAULT 0" },
      { name: "treats",            ddl: "ADD COLUMN treats INT NOT NULL DEFAULT 0" },
      { name: "profile_complete",  ddl: "ADD COLUMN profile_complete TINYINT(1) NOT NULL DEFAULT 0" },
      { name: "is_admin",          ddl: "ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0" },
      { name: "is_operator",       ddl: "ADD COLUMN is_operator TINYINT(1) NOT NULL DEFAULT 0" },
      { name: "is_tester",         ddl: "ADD COLUMN is_tester TINYINT(1) NOT NULL DEFAULT 0" },
      { name: "daily_streak",      ddl: "ADD COLUMN daily_streak INT NOT NULL DEFAULT 0" },
      { name: "last_streak_claim", ddl: "ADD COLUMN last_streak_claim DATE NULL" },
      { name: "free_avatar_available", ddl: "ADD COLUMN free_avatar_available TINYINT(1) NOT NULL DEFAULT 1" },
      { name: "achievements_json", ddl: "ADD COLUMN achievements_json TEXT NULL" },
      { name: "profile_photo_url", ddl: "ADD COLUMN profile_photo_url TEXT NULL" },
      // Phase 8 columns
      { name: "zip",                ddl: "ADD COLUMN zip VARCHAR(20) NULL" },
      { name: "phone_verified",     ddl: "ADD COLUMN phone_verified TINYINT(1) NOT NULL DEFAULT 0" },
      { name: "email_verified",     ddl: "ADD COLUMN email_verified TINYINT(1) NOT NULL DEFAULT 0" },
      { name: "bio",                ddl: "ADD COLUMN bio TEXT NULL" },
      { name: "notification_prefs", ddl: "ADD COLUMN notification_prefs JSON NULL" },
      { name: "profile_bonus_granted", ddl: "ADD COLUMN profile_bonus_granted TINYINT(1) NOT NULL DEFAULT 0" },
      { name: "accepted_terms_version", ddl: "ADD COLUMN accepted_terms_version VARCHAR(20) NULL" },
      { name: "accepted_terms_at", ddl: "ADD COLUMN accepted_terms_at TIMESTAMP NULL" },
      { name: "pawprint_tokens",    ddl: "ADD COLUMN pawprint_tokens INT NOT NULL DEFAULT 0" },
      { name: "referral_code",      ddl: "ADD COLUMN referral_code VARCHAR(32) NULL" },
      { name: "referred_by",        ddl: "ADD COLUMN referred_by VARCHAR(32) NULL" },
    ];
    for (const col of requiredColumns) {
      if (!columnNames.includes(col.name)) {
        try {
          await getPool().query(`ALTER TABLE users ${col.ddl}`);
          console.log(`✅ Migrated users: added column ${col.name}.`);
        } catch (colErr) {
          console.error(`❌ Required column migration failed for ${col.name}:`, colErr);
          throw colErr;
        }
      }
    }

    // Email is now the login gate, so it must be unique. Add the index if it
    // isn't already present. (MySQL allows multiple NULL emails under a UNIQUE
    // index, so this is safe even if some legacy rows have no email.)
    try {
      const [idx] = await getPool().query(
        `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND INDEX_NAME = 'uniq_email'`,
        [dbName]
      ) as any;
      if (!idx[0] || Number(idx[0].c) === 0) {
        await getPool().query(`ALTER TABLE users ADD UNIQUE INDEX uniq_email (email)`);
        console.log("✅ Added unique index on users.email.");
      }
    } catch (idxErr) {
      console.warn("⚠️ Could not add unique email index (duplicate emails may exist):", idxErr);
    }

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS albums (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_phone VARCHAR(32) NOT NULL,
        name VARCHAR(120) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (user_phone),
        FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS creations (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        user_phone    VARCHAR(32) NOT NULL,
        album_id      INT NULL,
        media_type    ENUM('still','video','model') NOT NULL DEFAULT 'still',
        style         VARCHAR(32) NOT NULL,
        backdrop_kind ENUM('preset','streetview') NOT NULL DEFAULT 'preset',
        preset_name   VARCHAR(32) NULL,
        sv_lat        DECIMAL(10,7) NULL,
        sv_lng        DECIMAL(10,7) NULL,
        sv_heading    SMALLINT NULL,
        sv_pitch      SMALLINT NULL,
        sv_fov        SMALLINT NULL,
        place_label   VARCHAR(190) NULL,
        image_url     TEXT NULL,
        video_url     TEXT NULL,
        model_url     TEXT NULL,
        sort_order    INT NOT NULL DEFAULT 0,
        pet_name      VARCHAR(120) NULL,
        pet_breed     VARCHAR(120) NULL,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (user_phone), 
        INDEX (album_id),
        FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS generation_jobs (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        user_phone      VARCHAR(32) NOT NULL,
        creation_id     INT NULL,
        kind            ENUM('still','video','model') NOT NULL,
        status          ENUM('queued','running','done','failed') NOT NULL DEFAULT 'queued',
        operation_name  VARCHAR(255) NULL,
        credits_reserved INT NOT NULL DEFAULT 0,
        error           VARCHAR(512) NULL,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (user_phone), 
        INDEX (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS print_orders (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_phone VARCHAR(32) NOT NULL,
        source_type ENUM('creation','avatar') NOT NULL,
        source_id INT NOT NULL,
        provider VARCHAR(32) NOT NULL DEFAULT 'slant3d',
        provider_pack_id VARCHAR(64) NULL,
        provider_file_id VARCHAR(128) NULL,
        stl_url TEXT NOT NULL,
        target_height_mm DECIMAL(8,2) NOT NULL,
        dimensions_json JSON NULL,
        topology_json JSON NULL,
        checkout_url TEXT NULL,
        idempotency_key VARCHAR(128) NULL,
        provider_cost_cents INT NULL,
        retail_price_cents INT NULL,
        stripe_session_id VARCHAR(128) NULL,
        provider_payload_json JSON NULL,
        status VARCHAR(40) NOT NULL DEFAULT 'prepared',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (user_phone),
        INDEX (provider_pack_id),
        UNIQUE KEY uniq_print_request (user_phone, idempotency_key),
        FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    try {
      const [printColumns] = await getPool().query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'print_orders'`,
      ) as any;
      const printColumnNames = new Set(printColumns.map((row: any) => String(row.COLUMN_NAME)));
      const printMigrations = [
        ["idempotency_key", "ADD COLUMN idempotency_key VARCHAR(128) NULL AFTER checkout_url"],
        ["provider_file_id", "ADD COLUMN provider_file_id VARCHAR(128) NULL AFTER provider_pack_id"],
        ["provider_cost_cents", "ADD COLUMN provider_cost_cents INT NULL AFTER idempotency_key"],
        ["retail_price_cents", "ADD COLUMN retail_price_cents INT NULL AFTER provider_cost_cents"],
        ["stripe_session_id", "ADD COLUMN stripe_session_id VARCHAR(128) NULL AFTER retail_price_cents"],
        ["provider_payload_json", "ADD COLUMN provider_payload_json JSON NULL AFTER stripe_session_id"],
      ];
      for (const [name, ddl] of printMigrations) {
        if (!printColumnNames.has(name)) await getPool().query(`ALTER TABLE print_orders ${ddl}`);
      }
      await getPool().query(`ALTER TABLE print_orders MODIFY COLUMN provider VARCHAR(32) NOT NULL DEFAULT 'slant3d'`);
      await getPool().query(`ALTER TABLE print_orders MODIFY COLUMN status VARCHAR(40) NOT NULL DEFAULT 'prepared'`);
      const [printIndexes] = await getPool().query(
        `SELECT INDEX_NAME FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'print_orders' AND INDEX_NAME = 'uniq_print_request'`,
      ) as any;
      if (!printIndexes.length) {
        await getPool().query(`ALTER TABLE print_orders ADD UNIQUE INDEX uniq_print_request (user_phone, idempotency_key)`);
      }
    } catch (migrationError) {
      console.warn("⚠️ Could not migrate print_orders idempotency fields:", migrationError);
    }

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS pawprint_print_orders (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_phone VARCHAR(32) NOT NULL,
        creation_id INT NOT NULL,
        provider VARCHAR(32) NOT NULL DEFAULT 'printful',
        product_code VARCHAR(48) NOT NULL,
        provider_order_id VARCHAR(128) NULL,
        print_file_url TEXT NOT NULL,
        recipient_json JSON NOT NULL,
        quantity INT NOT NULL DEFAULT 1,
        price_cents INT NULL,
        provider_cost_cents INT NULL,
        retail_price_cents INT NULL,
        stripe_session_id VARCHAR(128) NULL,
        checkout_url TEXT NULL,
        provider_payload_json JSON NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'draft',
        idempotency_key VARCHAR(128) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_pawprint_print_request (user_phone, idempotency_key),
        INDEX (user_phone),
        INDEX (creation_id),
        INDEX (provider_order_id),
        FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    try {
      const [pawprintOrderColumns] = await getPool().query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pawprint_print_orders'`,
      ) as any;
      const names = new Set(pawprintOrderColumns.map((row: any) => String(row.COLUMN_NAME)));
      const migrations = [
        ["provider_cost_cents", "ADD COLUMN provider_cost_cents INT NULL AFTER price_cents"],
        ["retail_price_cents", "ADD COLUMN retail_price_cents INT NULL AFTER provider_cost_cents"],
        ["stripe_session_id", "ADD COLUMN stripe_session_id VARCHAR(128) NULL AFTER retail_price_cents"],
        ["checkout_url", "ADD COLUMN checkout_url TEXT NULL AFTER stripe_session_id"],
        ["provider_payload_json", "ADD COLUMN provider_payload_json JSON NULL AFTER checkout_url"],
      ];
      for (const [name, ddl] of migrations) {
        if (!names.has(name)) await getPool().query(`ALTER TABLE pawprint_print_orders ${ddl}`);
      }
    } catch (migrationError) {
      console.warn("⚠️ Could not migrate Pawprint print order payment fields:", migrationError);
    }

    // =====================================================================
    // Marketplace (IMPLEMENTATION_SPEC.md §4.3, migration 011_marketplace.sql)
    // =====================================================================

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS marketplace_listings (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        uuid CHAR(36) NOT NULL,
        slug VARCHAR(140) NOT NULL,
        name VARCHAR(160) NOT NULL,
        breed VARCHAR(120) NULL,
        category ENUM('breed','memorial','accessories','seasonal') NOT NULL,
        description TEXT NULL,
        tags_json JSON NULL,
        dimensions_json JSON NULL,
        print_notes TEXT NULL,
        digital_price_cents INT NULL,
        physical_enabled TINYINT(1) NOT NULL DEFAULT 0,
        print_size_min_mm DECIMAL(8,2) NULL,
        print_size_max_mm DECIMAL(8,2) NULL,
        status ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
        sort_order INT NOT NULL DEFAULT 0,
        created_by VARCHAR(32) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_marketplace_uuid (uuid),
        UNIQUE KEY uniq_marketplace_slug (slug),
        INDEX idx_marketplace_status_sort (status, sort_order),
        INDEX idx_marketplace_category (category),
        CONSTRAINT fk_marketplace_creator FOREIGN KEY (created_by) REFERENCES users(phone) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS marketplace_assets (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        listing_id BIGINT NOT NULL,
        asset_uuid CHAR(36) NOT NULL,
        kind ENUM('source_glb','preview_image','stl_derivative') NOT NULL,
        bucket ENUM('public','private') NOT NULL,
        object_key VARCHAR(512) NOT NULL,
        mime_type VARCHAR(120) NOT NULL,
        size_bytes BIGINT NOT NULL,
        sha256 CHAR(64) NOT NULL,
        version INT NOT NULL DEFAULT 1,
        status ENUM('active','superseded') NOT NULL DEFAULT 'active',
        sort_order INT NOT NULL DEFAULT 0,
        derivative_height_mm DECIMAL(8,2) NULL,
        generated_active_height DECIMAL(8,2) GENERATED ALWAYS AS (CASE WHEN kind='stl_derivative' AND status='active' THEN ROUND(derivative_height_mm, 2) ELSE NULL END) STORED,
        source_provider ENUM('original','sketchfab') NOT NULL DEFAULT 'original',
        source_url VARCHAR(512) NULL,
        source_author VARCHAR(190) NULL,
        source_license VARCHAR(40) NULL,
        attribution_text VARCHAR(500) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_marketplace_asset_uuid (asset_uuid),
        UNIQUE KEY uniq_marketplace_object_key (object_key),
        UNIQUE KEY uniq_stl_active_derivative (listing_id, generated_active_height),
        INDEX idx_marketplace_asset_listing (listing_id, kind, status, sort_order),
        CONSTRAINT fk_marketplace_asset_listing FOREIGN KEY (listing_id) REFERENCES marketplace_listings(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS marketplace_digital_orders (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_phone VARCHAR(32) NOT NULL,
        listing_id BIGINT NOT NULL,
        asset_id BIGINT NOT NULL,
        price_cents INT NOT NULL,
        currency CHAR(3) NOT NULL DEFAULT 'usd',
        stripe_session_id VARCHAR(128) NULL,
        stripe_payment_intent VARCHAR(128) NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        status VARCHAR(40) NOT NULL DEFAULT 'awaiting_payment',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_marketplace_digital_idem (user_phone, idempotency_key),
        INDEX idx_marketplace_digital_user (user_phone),
        INDEX idx_marketplace_digital_session (stripe_session_id),
        CONSTRAINT fk_marketplace_digital_user FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE,
        CONSTRAINT fk_marketplace_digital_listing FOREIGN KEY (listing_id) REFERENCES marketplace_listings(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // The UNIQUE key is what makes Stripe webhook replay safe: the handler uses
    // INSERT ... ON DUPLICATE KEY UPDATE id = id, so a redelivered event is a
    // no-op rather than a duplicate grant or a 500 that triggers more retries.
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS marketplace_entitlements (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_phone VARCHAR(32) NOT NULL,
        listing_id BIGINT NOT NULL,
        asset_id BIGINT NOT NULL,
        digital_order_id BIGINT NULL,
        granted_reason ENUM('purchase','admin_grant','refund_reversal') NOT NULL DEFAULT 'purchase',
        revoked_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_marketplace_entitlement (user_phone, listing_id, asset_id),
        INDEX idx_marketplace_entitlement_user (user_phone),
        CONSTRAINT fk_marketplace_ent_user FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE,
        CONSTRAINT fk_marketplace_ent_listing FOREIGN KEY (listing_id) REFERENCES marketplace_listings(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS fidos_projects (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_phone VARCHAR(32) NOT NULL,
        avatar_id INT NULL,
        name VARCHAR(160) NOT NULL,
        prompt TEXT NULL,
        wardrobe_json JSON NULL,
        settings_json JSON NULL,
        quality_tier ENUM('draft','standard','studio') NOT NULL DEFAULT 'standard',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_fidos_user (user_phone, updated_at),
        CONSTRAINT fk_fidos_user FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Widen print_orders.source_type so marketplace listings reuse the existing
    // Slant 3D fulfillment path. Additive: no existing row changes meaning and
    // every current read path filters source_type explicitly. Guarded because
    // this runs on every boot.
    try {
      const [sourceTypeCol] = await getPool().query(
        `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'print_orders' AND COLUMN_NAME = 'source_type'`,
      ) as any;
      const columnType = String(sourceTypeCol?.[0]?.COLUMN_TYPE || "");
      if (columnType && !columnType.includes("marketplace_listing")) {
        await getPool().query(
          `ALTER TABLE print_orders MODIFY COLUMN source_type ENUM('creation','avatar','marketplace_listing') NOT NULL`,
        );
        console.log("✅ Migration: print_orders.source_type now accepts 'marketplace_listing'.");
      }
    } catch (migrationError) {
      console.warn("⚠️ Could not widen print_orders.source_type:", migrationError);
    }

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS pets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_phone VARCHAR(32) NOT NULL,
        name VARCHAR(120) NOT NULL,
        kind ENUM('dog','cat','other') NOT NULL DEFAULT 'dog',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (user_phone),
        FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS avatars (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_phone VARCHAR(32) NOT NULL,
        name VARCHAR(120) NOT NULL,
        image_url TEXT NOT NULL,
        meshy_handle VARCHAR(255) NULL,
        model_url TEXT NULL,
        sprite_sheet_url TEXT NULL,
        animation_data JSON NULL,
        animal_type VARCHAR(50) NULL,
        breed VARCHAR(120) NULL,
        generation_status ENUM('pending','generating_mesh','rigging','baking_sprites','done','failed') NOT NULL DEFAULT 'done',
        generation_error TEXT NULL,
        avatar_type VARCHAR(16) NOT NULL DEFAULT 'dog',
        generation_analysis JSON NULL,
        retry_count INT NOT NULL DEFAULT 0,
        food_level INT NOT NULL DEFAULT 100,
        water_level INT NOT NULL DEFAULT 100,
        last_fed TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_watered TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (user_phone),
        FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Migration for avatars table
    try {
      const [avatarCols] = await getPool().query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'avatars'`,
        [dbName]
      ) as any;
      const avatarColumnNames = avatarCols.map((c: any) => c.COLUMN_NAME);
      if (!avatarColumnNames.includes("meshy_handle")) {
        await getPool().query(`ALTER TABLE avatars ADD COLUMN meshy_handle VARCHAR(255) NULL AFTER image_url`);
        console.log(`✅ Migrated avatars: added column meshy_handle.`);
      }
    } catch (migErr) {
      console.warn(`⚠️ Could not migrate avatars table:`, migErr);
    }

    // Migration: add 3D columns to existing avatars table
    const [avatarCols] = await getPool().query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'avatars'`,
      [dbName]
    ) as any;
    const avatarColumnNames = avatarCols.map((c: any) => c.COLUMN_NAME);

    // --- Idempotent migrations for existing databases ---
    // CREATE TABLE IF NOT EXISTS won't alter pre-existing tables, so explicitly
    // add the 3D-model column + extend enums. Each guarded so reruns are safe.
    try {
      const [cols] = await getPool().query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'creations' AND COLUMN_NAME = 'model_url'`
      );
      if ((cols as any[]).length === 0) {
        await getPool().query(`ALTER TABLE creations ADD COLUMN model_url TEXT NULL AFTER video_url`);
        console.log("✅ Migration: added creations.model_url");
      }
      // Extend enums to include 'model' (safe to run repeatedly).
      await getPool().query(
        `ALTER TABLE creations MODIFY COLUMN media_type ENUM('still','video','model') NOT NULL DEFAULT 'still'`
      );
      await getPool().query(
        `ALTER TABLE generation_jobs MODIFY COLUMN kind ENUM('still','video','model') NOT NULL`
      );
    } catch (migErr) {
      console.warn("⚠️ Schema migration warning (model support):", migErr);
    }

    // Optional rigging on the create pipeline (redress P3/P4): rig-stage job
    // statuses + rigged artifact/report columns on creations. Safe to re-run.
    try {
      const [rigCols] = await getPool().query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'creations' AND COLUMN_NAME IN ('rigged_model_url','rig_report')`,
        [dbName]
      ) as any;
      const rigColNames = (rigCols as any[]).map((c: any) => c.COLUMN_NAME);
      if (!rigColNames.includes("rigged_model_url")) {
        await getPool().query(`ALTER TABLE creations ADD COLUMN rigged_model_url LONGTEXT NULL AFTER model_url`);
        console.log("✅ Migration: added creations.rigged_model_url");
      }
      if (!rigColNames.includes("rig_report")) {
        await getPool().query(`ALTER TABLE creations ADD COLUMN rig_report JSON NULL AFTER rigged_model_url`);
        console.log("✅ Migration: added creations.rig_report");
      }
      await getPool().query(
        `ALTER TABLE generation_jobs MODIFY COLUMN status ENUM('queued','running','rigging','validating','done','done_static_fallback','failed') NOT NULL DEFAULT 'queued'`
      );
    } catch (migErr) {
      console.warn("⚠️ Schema migration warning (optional rigging):", migErr);
    }

    const requiredAvatarColumns: { name: string; ddl: string }[] = [
      { name: "model_url",          ddl: "ADD COLUMN model_url TEXT NULL" },
      { name: "sprite_sheet_url",   ddl: "ADD COLUMN sprite_sheet_url TEXT NULL" },
      { name: "animation_data",     ddl: "ADD COLUMN animation_data JSON NULL" },
      { name: "animal_type",        ddl: "ADD COLUMN animal_type VARCHAR(50) NULL" },
      { name: "breed",              ddl: "ADD COLUMN breed VARCHAR(120) NULL" },
      { name: "generation_status",  ddl: "ADD COLUMN generation_status ENUM('pending','generating_mesh','rigging','baking_sprites','done','failed') NOT NULL DEFAULT 'done'" },
      { name: "generation_error",   ddl: "ADD COLUMN generation_error TEXT NULL" },
      // Living-avatar behavior system (Phase 2): full needs snapshot + last-seen for offline decay.
      { name: "needs_json",         ddl: "ADD COLUMN needs_json JSON NULL" },
      { name: "last_seen",          ddl: "ADD COLUMN last_seen TIMESTAMP NULL" },
      // Rigged skeletal model + clip manifest (Phase 5).
      { name: "rigged_model_url",   ddl: "ADD COLUMN rigged_model_url LONGTEXT NULL" },
      { name: "clips_json",         ddl: "ADD COLUMN clips_json JSON NULL" },
      // Multiview turnaround view URLs ({left,back,right}) so retry/resume can
      // re-run Tripo multiview without regenerating the images.
      { name: "multiview_json",     ddl: "ADD COLUMN multiview_json JSON NULL" },
      { name: "avatar_type",        ddl: "ADD COLUMN avatar_type VARCHAR(16) NOT NULL DEFAULT 'dog'" },
      // Unified triage record (detection + qualification + anatomy) persisted at
      // generation time so the build/rig stage never re-analyzes the image.
      { name: "generation_analysis", ddl: "ADD COLUMN generation_analysis JSON NULL" },
      { name: "retry_count",         ddl: "ADD COLUMN retry_count INT NOT NULL DEFAULT 0" },
      // Soft-hide: removing a model from the roster must not destroy the row.
      // The GLB in object storage outlives a DELETE, so a hard delete leaves
      // orphaned bytes that are still billed and can no longer be reclaimed —
      // and the user can't undo it. See hideAvatar()/unhideAvatar().
      { name: "hidden_at",           ddl: "ADD COLUMN hidden_at TIMESTAMP NULL DEFAULT NULL" },
    ];
    for (const col of requiredAvatarColumns) {
      if (!avatarColumnNames.includes(col.name)) {
        try {
          await getPool().query(`ALTER TABLE avatars ${col.ddl}`);
          console.log(`✅ Migrated avatars: added column ${col.name}.`);
        } catch (colErr) {
          console.warn(`⚠️ Could not add column ${col.name} to avatars:`, colErr);
        }
      }
    }

    // Ensure large data URIs can be saved if object storage is not configured (MySQL TEXT is only 64KB)
    try {
      await getPool().query(`ALTER TABLE avatars MODIFY COLUMN image_url LONGTEXT NOT NULL`);
      await getPool().query(`ALTER TABLE avatars MODIFY COLUMN model_url LONGTEXT NULL`);
      await getPool().query(`ALTER TABLE avatars MODIFY COLUMN sprite_sheet_url LONGTEXT NULL`);
      await getPool().query(`ALTER TABLE avatars MODIFY COLUMN generation_error LONGTEXT NULL`);
      // Extend generation_status with the rigged-clip pipeline stages (Phase 5).
      await getPool().query(
        `ALTER TABLE avatars MODIFY COLUMN generation_status ENUM('pending','generating_mesh','rigging','retargeting','baking_clips','baking_sprites','done','failed') NOT NULL DEFAULT 'done'`
      );
    } catch (alterErr) {
      console.warn("⚠️ Could not modify avatar columns to LONGTEXT:", alterErr);
    }

    // Placed objects for the living-avatar scene / AR (Phase 3).
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS placed_objects (
        id         VARCHAR(64) PRIMARY KEY,
        avatar_id  INT NOT NULL,
        user_phone VARCHAR(32) NOT NULL,
        kind       VARCHAR(40) NOT NULL,
        pos_x      FLOAT NOT NULL DEFAULT 0,
        pos_y      FLOAT NOT NULL DEFAULT 0,
        pos_z      FLOAT NOT NULL DEFAULT 0,
        rot_y      FLOAT NOT NULL DEFAULT 0,
        scale      FLOAT NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (avatar_id),
        INDEX (user_phone)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // --- AR multi-model cast (Phase 5) ---------
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS scene_actors (
        id               VARCHAR(64) PRIMARY KEY,
        owner_phone      VARCHAR(32) NOT NULL,
        scene_avatar_id  INT NOT NULL,
        source_avatar_id INT NOT NULL,
        transform_json   JSON NOT NULL,
        selected_clip    VARCHAR(100) NULL,
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (scene_avatar_id),
        INDEX (owner_phone)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Password reset tokens — only the SHA-256 hash of the token is stored.
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        user_phone  VARCHAR(32) NOT NULL,
        token_hash  VARCHAR(64) NOT NULL,
        expires_at  TIMESTAMP NOT NULL,
        used_at     TIMESTAMP NULL,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (user_phone),
        INDEX (token_hash)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // --- AR virtual-pet simulator (AR_PET_SIM_SPEC §8, milestone AR2) ---------
    // pet_profiles extends an avatar with breed-aware gameplay + persisted brain state.
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS pet_profiles (
        id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
        avatar_id           INT NOT NULL,
        breed               VARCHAR(64) NULL,
        breed_confidence    DOUBLE NULL,
        size_class          VARCHAR(16) NULL,
        build               JSON NULL,
        temperament         JSON NULL,
        personality_weights JSON NULL,
        hormones            JSON NULL,
        drives              JSON NULL,
        life_stage          ENUM('puppy','adult','senior') NOT NULL DEFAULT 'adult',
        aging_mode          ENUM('off','slow','realistic') NOT NULL DEFAULT 'off',
        mortality_enabled   TINYINT(1) NOT NULL DEFAULT 0,
        trainer_score       INT NOT NULL DEFAULT 0,
        rigged_glb_url      LONGTEXT NULL,
        lod_glb_url         LONGTEXT NULL,
        created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_avatar (avatar_id),
        INDEX (avatar_id),
        FOREIGN KEY (avatar_id) REFERENCES avatars(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS pet_commands (
        id              BIGINT AUTO_INCREMENT PRIMARY KEY,
        pet_id          BIGINT NOT NULL,
        phrase          VARCHAR(120) NULL,
        metaphone_keys  JSON NULL,
        action          VARCHAR(48) NULL,
        compliance      DOUBLE NOT NULL DEFAULT 0.5,
        last_reinforced DATETIME NULL,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX (pet_id),
        FOREIGN KEY (pet_id) REFERENCES pet_profiles(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS pet_buttons (
        id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
        pet_id               BIGINT NOT NULL,
        label                VARCHAR(48) NULL,
        audio_url            LONGTEXT NULL,
        linked_action        VARCHAR(48) NULL,
        association_strength DOUBLE NOT NULL DEFAULT 0,
        anchor               JSON NULL,
        created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX (pet_id),
        FOREIGN KEY (pet_id) REFERENCES pet_profiles(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS semantic_scans (
        id          BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_phone  VARCHAR(32) NOT NULL,
        anchor_hash VARCHAR(64) NULL,
        zones       JSON NULL,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX (user_phone),
        INDEX (anchor_hash),
        FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Per-user, per-day usage counter for paid provider endpoints (H2/H7 caps).
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS api_usage_daily (
        user_phone  VARCHAR(32)  NOT NULL,
        endpoint    VARCHAR(32)  NOT NULL,
        day         DATE         NOT NULL,
        count       INT          NOT NULL DEFAULT 0,
        PRIMARY KEY (user_phone, endpoint, day),
        FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Aggregate request and reserved-cost budget for paid provider endpoints. This is
    // separate from the user table so one transaction can lock both counters.
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS api_usage_global_daily (
        endpoint                 VARCHAR(32) NOT NULL,
        day                      DATE        NOT NULL,
        count                    INT         NOT NULL DEFAULT 0,
        reserved_cost_micro_usd  BIGINT      NOT NULL DEFAULT 0,
        PRIMARY KEY (endpoint, day)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Durable process-independent provider-call window for endpoints that have
    // a minute ceiling. One row per endpoint is locked in the same transaction
    // as the daily counters, so concurrent application processes cannot race.
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS api_usage_global_minute (
        endpoint           VARCHAR(32) NOT NULL,
        window_started_at  DATETIME(3) NOT NULL,
        count              INT         NOT NULL DEFAULT 0,
        PRIMARY KEY (endpoint)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS photo_requests (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        user_phone        VARCHAR(32) NOT NULL,
        request_type      ENUM('photo_standard','photo_premium','video_standard','video_premium') NOT NULL,
        comment           TEXT NOT NULL,
        photo_url         TEXT NULL,
        result_url        TEXT NULL,
        creation_id       INT NULL,
        status            ENUM('pending','fulfilled','rejected') NOT NULL DEFAULT 'pending',
        stripe_session_id VARCHAR(255) NULL,
        paid              TINYINT(1) NOT NULL DEFAULT 0,
        amount_paid       DECIMAL(6,2) NULL,
        admin_notes       TEXT NULL,
        created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (user_phone),
        INDEX (status),
        FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Credit ledger: one row per credit change (earn or spend), for spend tracking + history.
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS credit_transactions (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        user_phone    VARCHAR(32) NOT NULL,
        delta         INT NOT NULL,
        reason        VARCHAR(80) NOT NULL,
        balance_after INT NOT NULL,
        idempotency_key VARCHAR(190) NULL,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_credit_transaction_user (user_phone),
        INDEX idx_credit_transaction_created (created_at),
        UNIQUE KEY uniq_credit_transaction_user_identity (id, user_phone),
        UNIQUE KEY uniq_credit_transaction_idempotency (idempotency_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await retireLegacyPawprintTokens();

    // Community memory board: user-uploaded photos shown in the live inspiration loop.
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS community_memories (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        user_phone  VARCHAR(32) NOT NULL,
        image_url   TEXT NOT NULL,
        caption     VARCHAR(200) NULL,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Per-user photo library: profile uploads + photos fed in from the avatar builder.
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS user_photos (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        user_phone  VARCHAR(32) NOT NULL,
        image_url   TEXT NOT NULL,
        source      VARCHAR(32) NOT NULL DEFAULT 'upload',
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (user_phone),
        INDEX (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Per-user wardrobe choices. Geometry remains an immutable catalog derivative;
    // this table stores only stable item IDs selected by the user.
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS wardrobe_selections (
        user_phone VARCHAR(32) NOT NULL,
        item_id    VARCHAR(64) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_phone, item_id),
        INDEX (user_phone)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Migration check for creations table
    const [creationsCols] = await getPool().query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'creations'`,
      [dbName]
    ) as any;
    const creationsColumnNames = creationsCols.map((c: any) => c.COLUMN_NAME);

    const requiredCreationsColumns: { name: string; ddl: string }[] = [
      { name: "pet_name",  ddl: "ADD COLUMN pet_name VARCHAR(120) NULL" },
      { name: "pet_breed", ddl: "ADD COLUMN pet_breed VARCHAR(120) NULL" },
    ];
    for (const col of requiredCreationsColumns) {
      if (!creationsColumnNames.includes(col.name)) {
        try {
          await getPool().query(`ALTER TABLE creations ${col.ddl}`);
          console.log(`✅ Migrated creations: added column ${col.name}.`);
        } catch (colErr) {
          console.warn(`⚠️ Could not add column ${col.name} to creations:`, colErr);
        }
      }
    }

    // Ensure large data URIs can be saved if object storage is not configured
    try {
      await getPool().query(`ALTER TABLE creations MODIFY COLUMN image_url LONGTEXT NULL`);
      await getPool().query(`ALTER TABLE creations MODIFY COLUMN video_url LONGTEXT NULL`);
    } catch (alterErr) {
      console.warn("⚠️ Could not modify creation columns to LONGTEXT:", alterErr);
    }

    console.log("✅ Users, creations, generation_jobs, pets, avatars, and photo_requests tables ready.");

    // Referrals table (Phase 8)
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        referrer_phone  VARCHAR(32) NOT NULL,
        referred_phone  VARCHAR(32) NOT NULL,
        code            VARCHAR(32) NOT NULL,
        credited_at     TIMESTAMP NULL,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_referred (referred_phone),
        INDEX (referrer_phone),
        INDEX (code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Share rewards table (Phase 8)
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS share_rewards (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        user_phone    VARCHAR(32) NOT NULL,
        generation_id INT NULL,
        network       VARCHAR(32) NOT NULL,
        reward_type   ENUM('credits','pawprint') NOT NULL DEFAULT 'credits',
        granted_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_share (user_phone, network),
        INDEX (user_phone)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Storage accounting table (Phase 8): per-user hot/cold storage tracking.
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS user_storage (
        user_phone      VARCHAR(32) NOT NULL PRIMARY KEY,
        bytes_hot       BIGINT NOT NULL DEFAULT 0,
        bytes_cold      BIGINT NOT NULL DEFAULT 0,
        cold_gb_purchased INT NOT NULL DEFAULT 0,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS voice_clone_assets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_phone VARCHAR(32) NOT NULL,
        name VARCHAR(120) NOT NULL,
        audio_url TEXT NOT NULL,
        mime_type VARCHAR(80) NOT NULL,
        bytes BIGINT NOT NULL DEFAULT 0,
        voice_consent TINYINT(1) NOT NULL DEFAULT 0,
        voice_consent_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (user_phone),
        FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS pawprint_assets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_phone VARCHAR(32) NOT NULL,
        idempotency_key VARCHAR(120) NOT NULL,
        template_id VARCHAR(80) NOT NULL,
        category VARCHAR(80) NOT NULL,
        layout_id VARCHAR(80) NOT NULL,
        image_url TEXT NOT NULL,
        creation_id INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_pawprint_request (user_phone, idempotency_key),
        INDEX (user_phone),
        FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Model spatial metadata for authoritative scale & coordinate info (Phase 1 BIM).
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS model_spatial_metadata (
        id                  INT AUTO_INCREMENT PRIMARY KEY,
        user_phone          VARCHAR(32) NOT NULL,
        asset_kind          VARCHAR(24) NOT NULL DEFAULT 'model',
        asset_id            VARCHAR(64) NOT NULL,
        source_unit         VARCHAR(16) NOT NULL DEFAULT 'm',
        meters_per_unit     DOUBLE NOT NULL DEFAULT 1,
        canonical_unit      VARCHAR(8) NOT NULL DEFAULT 'm',
        up_axis             VARCHAR(4) NOT NULL DEFAULT 'Y',
        forward_axis        VARCHAR(4) NOT NULL DEFAULT '+Z',
        handedness          VARCHAR(8) NOT NULL DEFAULT 'right',
        source_bounds_min   JSON NOT NULL,
        source_bounds_max   JSON NOT NULL,
        canonical_bounds_min JSON NOT NULL,
        canonical_bounds_max JSON NOT NULL,
        local_origin        JSON DEFAULT NULL,
        datum_description   VARCHAR(255) DEFAULT NULL,
        source_crs          VARCHAR(64) DEFAULT NULL,
        vertical_datum      VARCHAR(64) DEFAULT NULL,
        calibration_method  VARCHAR(32) NOT NULL DEFAULT 'unknown',
        accuracy_class      VARCHAR(16) NOT NULL DEFAULT 'visual',
        calibration_confidence DOUBLE NOT NULL DEFAULT 0,
        tolerance_m         DOUBLE DEFAULT NULL,
        source_hash         VARCHAR(128) NOT NULL,
        source_filename     VARCHAR(255) DEFAULT NULL,
        source_uri          TEXT DEFAULT NULL,
        parent_derivative_id VARCHAR(64) DEFAULT NULL,
        derivative_id       VARCHAR(64) DEFAULT NULL,
        physical_scale      DOUBLE NOT NULL DEFAULT 1,
        display_scale       DOUBLE NOT NULL DEFAULT 1,
        import_tool         VARCHAR(64) DEFAULT NULL,
        converter_version   VARCHAR(32) DEFAULT NULL,
        created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at          TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_spatial_asset (user_phone, asset_kind, asset_id),
        INDEX (source_hash),
        FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Verified BIM builds persisted to object storage for re-download (Scaled
    // Building Lab "My models"). URLs point at the public Backblaze bucket.
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS bim_builds (
        id            VARCHAR(64) PRIMARY KEY,
        user_phone    VARCHAR(32) NOT NULL,
        name          VARCHAR(160) NOT NULL,
        mode          VARCHAR(8) NOT NULL,
        price         INT NOT NULL DEFAULT 0,
        glb_url       TEXT DEFAULT NULL,
        ifc_url       TEXT DEFAULT NULL,
        sidecar_url   TEXT DEFAULT NULL,
        element_count INT NOT NULL DEFAULT 0,
        size_bytes    BIGINT NOT NULL DEFAULT 0,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (user_phone),
        FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Create pipeline state for guided 3D model generation (Phase 2).
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS create_pipeline_sessions (
        id VARCHAR(64) PRIMARY KEY,
        user_phone VARCHAR(32) NOT NULL,
        species VARCHAR(32) NOT NULL,
        breed VARCHAR(120) NULL,
        pet_name VARCHAR(120) NULL,
        intent VARCHAR(120) NULL,
        style VARCHAR(32) NULL,
        input_photo_url TEXT NULL,
        candidate_image_url TEXT NULL,
        customization_state JSON NULL,
        validation_state JSON NULL,
        status ENUM('draft', 'reference_ready', 'approved', 'customizing', 'validation_failed', 'print_ready', 'building', 'complete', 'failed') NOT NULL DEFAULT 'draft',
        idempotency_key VARCHAR(120) NULL,
        build_job_id INT NULL,
        credits_reserved INT NOT NULL DEFAULT 0,
        credit_debit_correlation_id VARCHAR(190) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (user_phone),
        INDEX (status),
        UNIQUE KEY uniq_pipeline_credit_debit (credit_debit_correlation_id),
        FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Migration: Add build_starting and recovery_required to status enum idempotently
    try {
      const [colRows]: any = await getPool().query(
        "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_NAME = 'create_pipeline_sessions' AND COLUMN_NAME = 'status' AND TABLE_SCHEMA = DATABASE()"
      );
      if (colRows && colRows.length > 0) {
        const colType = colRows[0].COLUMN_TYPE; // e.g. enum('draft','reference_ready',...)
        if (colType.startsWith('enum')) {
          // Extract existing values
          const match = colType.match(/enum\((.*)\)/);
          if (match && match[1]) {
            const existingVals = match[1].split(',').map((s: string) => s.replace(/'/g, ''));
            const toAdd = ['build_starting', 'recovery_required'];
            let needsMigration = false;
            for (const v of toAdd) {
              if (!existingVals.includes(v)) {
                existingVals.push(v);
                needsMigration = true;
              }
            }
            if (needsMigration) {
              const newEnumStr = existingVals.map((v: string) => `'${v}'`).join(',');
              await getPool().query(`ALTER TABLE create_pipeline_sessions MODIFY COLUMN status ENUM(${newEnumStr}) NOT NULL DEFAULT 'draft'`);
              console.log("✅ Migrated create_pipeline_sessions.status enum to include new states.");
            }
          }
        }
      }
    } catch (e: any) {
      console.warn("⚠️ Could not migrate create_pipeline_sessions.status:", e?.message || e);
    }

    // Earlier Phase 2 builds mistakenly created validation_state as
    // VARCHAR(32), truncating the validation JSON and causing every approval
    // to fail as "missing, invalid, or stale". Preserve valid documents,
    // discard only already-truncated values, then enforce a JSON column.
    try {
      const [validationCols]: any = await getPool().query(
        "SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_NAME = 'create_pipeline_sessions' AND COLUMN_NAME = 'validation_state' AND TABLE_SCHEMA = DATABASE()"
      );
      if (validationCols?.[0]?.DATA_TYPE !== 'json') {
        await getPool().query(
          "UPDATE create_pipeline_sessions SET validation_state = NULL WHERE validation_state IS NOT NULL AND JSON_VALID(validation_state) = 0"
        );
        await getPool().query(
          "ALTER TABLE create_pipeline_sessions MODIFY COLUMN validation_state JSON NULL"
        );
        console.log("✅ Migrated create_pipeline_sessions.validation_state to JSON.");
      }
    } catch (e: any) {
      console.warn("⚠️ Could not migrate create_pipeline_sessions.validation_state:", e?.message || e);
    }

    // Migration: Add provider_handle column idempotently
    try {
      await getPool().query("ALTER TABLE create_pipeline_sessions ADD COLUMN provider_handle VARCHAR(255) NULL");
      // Add index for recovery lookup
      await getPool().query("ALTER TABLE create_pipeline_sessions ADD INDEX idx_provider_handle (provider_handle)");
      console.log("✅ Added provider_handle to create_pipeline_sessions.");
    } catch (e: any) {
      if (e?.code === 'ER_DUP_FIELDNAME') {
        // already exists, fine
      } else {
        console.warn("⚠️ Could not add provider_handle column:", e?.message || e);
      }
    }

    // Email hygiene (guarded — must never abort init): normalize to lower-case,
    // then best-effort enforce uniqueness. The UNIQUE index only applies once any
    // legacy duplicate-email rows have been removed; until then it is skipped.
    try {
      await getPool().query("UPDATE users SET email = LOWER(email) WHERE email IS NOT NULL AND email <> LOWER(email)");
    } catch (e) { /* non-fatal */ }
    try {
      await getPool().query("ALTER TABLE users ADD UNIQUE INDEX uniq_users_email (email)");
      console.log("✅ users.email is now UNIQUE.");
    } catch (e: any) {
      if (e?.code === "ER_DUP_KEYNAME") {
        // index already present — fine
      } else if (e?.code === "ER_DUP_ENTRY") {
        console.warn("⚠️ users.email UNIQUE not applied — duplicate emails still exist. Remove duplicates, then redeploy.");
      } else {
        console.warn("⚠️ Could not add users.email UNIQUE index:", e?.message || e);
      }
    }

    // Seed admin account from environment variables — no hardcoded credentials.
    // Upsert keyed on EMAIL (not phone): if an account with this email already
    // exists (under ANY phone key), update it in place instead of inserting a
    // second row. This is what prevents the duplicate-admin / can't-login bug.
    try {
      const adminKey = ADMIN_KEY;
      const adminEmail = process.env.ADMIN_EMAIL;
      const adminPassword = process.env.ADMIN_PASSWORD;

      const missingAdminConfig = [
        ["ADMIN_KEY", adminKey],
        ["ADMIN_EMAIL", adminEmail],
        ["ADMIN_PASSWORD", adminPassword],
      ].filter(([, value]) => !String(value || "").trim()).map(([name]) => name);
      if (process.env.NODE_ENV === "production" && missingAdminConfig.length > 0) {
        throw new Error(`Required admin configuration missing: ${missingAdminConfig.join(", ")}`);
      }

      if (adminKey && adminEmail && adminPassword) {
        const { hashPassword } = await import("./auth");
        const email = String(adminEmail).trim().toLowerCase();
        const passwordHash = hashPassword(adminPassword);

        const [existingRows]: any = await getPool().query(
          "SELECT phone FROM users WHERE LOWER(email) = ? ORDER BY id LIMIT 1",
          [email]
        );
        if (existingRows && existingRows.length) {
          await getPool().query(
            "UPDATE users SET email = ?, password_hash = ?, is_admin = 1, is_operator = 1, profile_complete = 1 WHERE phone = ?",
            [email, passwordHash, existingRows[0].phone]
          );
          console.log("✅ Admin/operator account synced (existing row updated).");
        } else {
          await getPool().query(
            `INSERT INTO users (phone, email, password_hash, is_admin, is_operator, profile_complete, credits, full_name)
             VALUES (?, ?, ?, 1, 1, 1, 9999, 'Admin')
             ON DUPLICATE KEY UPDATE email = VALUES(email), password_hash = VALUES(password_hash), is_admin = 1, is_operator = 1, profile_complete = 1`,
            [adminKey, email, passwordHash]
          );
          console.log("✅ Admin/operator account seeded (new row).");
        }

        const [verifiedRows]: any = await getPool().query(
          "SELECT is_admin, is_operator FROM users WHERE LOWER(email) = ? ORDER BY id LIMIT 1",
          [email],
        );
        if (verifiedRows?.[0]?.is_admin !== 1 || verifiedRows?.[0]?.is_operator !== 1) {
          throw new Error("Admin/operator role verification failed after credential sync");
        }
      }
    } catch (seedErr) {
      if (process.env.NODE_ENV === "production") throw seedErr;
      console.warn("⚠️ Admin seed skipped:", seedErr);
    }
    // ── Fido's Styles: per-user, per-avatar project settings (Phase 6) ─────────
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS fidos_projects (
        id            BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_phone    VARCHAR(32) NOT NULL,
        avatar_id     INT NOT NULL,
        settings_json JSON NOT NULL DEFAULT (JSON_OBJECT()),
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_user_avatar (user_phone, avatar_id),
        INDEX (user_phone),
        FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // ── Wardrobe Wags: subscription, box, and item tables (Wags W1) ──────────
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS wardrobe_wags_subscriptions (
        id                      BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_phone              VARCHAR(32) NOT NULL,
        pet_id                  INT NOT NULL,
        species                 ENUM('dog','cat') NOT NULL,
        tier                    ENUM('basic','plus') NOT NULL DEFAULT 'basic',
        billing_period          ENUM('monthly','annual') NOT NULL DEFAULT 'monthly',
        stripe_subscription_id  VARCHAR(128) NOT NULL,
        stripe_customer_id      VARCHAR(128) NOT NULL,
        status                  ENUM('active','paused','cancelled') NOT NULL DEFAULT 'active',
        current_period_start    DATE NOT NULL,
        current_period_end      DATE NOT NULL,
        annual_bonus_delivered_year INT NULL,
        cancel_at_period_end    TINYINT(1) NOT NULL DEFAULT 0,
        cancelled_at            TIMESTAMP NULL,
        created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_stripe_sub (stripe_subscription_id),
        INDEX (user_phone),
        INDEX (pet_id),
        FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS wardrobe_wags_boxes (
        id              BIGINT AUTO_INCREMENT PRIMARY KEY,
        subscription_id BIGINT NOT NULL,
        user_phone      VARCHAR(32) NOT NULL,
        box_month       CHAR(7) NOT NULL,
        status          ENUM(
          'pending_review','approved','rejected','delivered',
          'delivered_flagged','reviewed_ok','reviewed_issue'
        ) NOT NULL DEFAULT 'pending_review',
        plan_json       JSON NULL,
        admin_notes     TEXT NULL,
        reviewed_by     VARCHAR(32) NULL,
        reviewed_at     TIMESTAMP NULL,
        delivered_at    TIMESTAMP NULL,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_sub_month (subscription_id, box_month),
        INDEX (user_phone),
        INDEX (status),
        FOREIGN KEY (subscription_id) REFERENCES wardrobe_wags_subscriptions(id) ON DELETE CASCADE,
        FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS wardrobe_wags_box_items (
        id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
        box_id                BIGINT NOT NULL,
        slot                  ENUM(
          'accessory','seasonal','minimodel','pawprint',
          'accessory_2','accessory_3',
          'sticker_1','sticker_2','sticker_3','sticker_4','sticker_5',
          'credit_pack','video_gen','restyle',
          'calendar'
        ) NOT NULL,
        listing_id            BIGINT NULL,
        asset_id              BIGINT NULL,
        entitlement_type      VARCHAR(60) NULL,
        credit_amount         INT NULL,
        personalization_note  VARCHAR(200) NULL,
        swapped_by_admin      TINYINT(1) NOT NULL DEFAULT 0,
        created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (box_id),
        FOREIGN KEY (box_id) REFERENCES wardrobe_wags_boxes(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // W3 delivery columns. Guarded because these tables may already exist from
    // the W1/W2 boot before delivery shipped.
    try {
      const [itemCols] = await getPool().query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wardrobe_wags_box_items'`,
      ) as any;
      const itemNames = new Set(itemCols.map((row: any) => String(row.COLUMN_NAME)));
      const itemMigrations: Array<[string, string]> = [
        // Materialized plan copy: the inbox renders from box_items alone, so a
        // later re-plan can never silently rewrite what a user already received.
        ["title", "ADD COLUMN title VARCHAR(160) NULL AFTER entitlement_type"],
        ["description", "ADD COLUMN description VARCHAR(600) NULL AFTER title"],
        // Which renderable wardrobe item this slot unlocked (WAGS_EXCLUSIVE ids).
        ["wardrobe_item_id", "ADD COLUMN wardrobe_item_id VARCHAR(64) NULL AFTER listing_id"],
      ];
      for (const [name, ddl] of itemMigrations) {
        if (!itemNames.has(name)) await getPool().query(`ALTER TABLE wardrobe_wags_box_items ${ddl}`);
      }
      const [boxCols] = await getPool().query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wardrobe_wags_boxes'`,
      ) as any;
      const boxNames = new Set(boxCols.map((row: any) => String(row.COLUMN_NAME)));
      if (!boxNames.has("opened_at")) {
        // Unboxing is a once-per-box reveal; opened_at records it server-side so
        // the animation cannot replay on every visit.
        await getPool().query(`ALTER TABLE wardrobe_wags_boxes ADD COLUMN opened_at TIMESTAMP NULL AFTER delivered_at`);
      }
    } catch (migrationError) {
      console.warn("⚠️ Could not migrate Wags delivery columns:", migrationError);
    }

    // UV8 texture re-bake jobs (migration 012_texture_jobs.sql).
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS texture_jobs (
        id CHAR(36) NOT NULL PRIMARY KEY,
        user_phone VARCHAR(32) NOT NULL,
        avatar_id INT NOT NULL,
        job_type ENUM('rebake','stylize') NOT NULL DEFAULT 'rebake',
        status ENUM('queued','processing','rendering_views','stylizing','baking','completed','failed') NOT NULL DEFAULT 'queued',
        source_model_url TEXT NOT NULL,
        result_model_url TEXT NULL,
        stats_json JSON NULL,
        error VARCHAR(400) NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_texture_idem (user_phone, idempotency_key),
        INDEX idx_texture_user (user_phone, created_at),
        INDEX idx_texture_avatar (avatar_id),
        CONSTRAINT fk_texture_user FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Migrate texture_jobs for UV6/UV7 stylization
    try {
      const [tjCols] = await getPool().query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'texture_jobs'`
      ) as any;
      const tjNames = new Set(tjCols.map((row: any) => String(row.COLUMN_NAME)));

      if (!tjNames.has("prompt")) {
        // Enlarge ENUM types safely
        await getPool().query(`ALTER TABLE texture_jobs MODIFY COLUMN job_type ENUM('rebake','stylize') NOT NULL DEFAULT 'rebake'`);
        await getPool().query(`ALTER TABLE texture_jobs MODIFY COLUMN status ENUM('queued','processing','rendering_views','stylizing','baking','completed','failed') NOT NULL DEFAULT 'queued'`);
        // Add new columns
        await getPool().query(`ALTER TABLE texture_jobs ADD COLUMN prompt VARCHAR(1000) NULL AFTER job_type`);
        await getPool().query(`ALTER TABLE texture_jobs ADD COLUMN tier ENUM('draft','standard','studio') NULL AFTER prompt`);
        await getPool().query(`ALTER TABLE texture_jobs ADD COLUMN identity_strength ENUM('high','medium','stylized') NULL AFTER tier`);
      }
    } catch (err) {
      console.warn("⚠️ Could not migrate texture_jobs stylization columns:", err);
    }

    // Marketplace digital orders — add checkout_url (migration 013).
    //
    // checkoutDigital() has always SELECTed this column to resume an in-flight
    // purchase by Idempotency-Key, but 011_marketplace.sql never created it, so
    // the query failed with ER_BAD_FIELD_ERROR on every call and the route threw
    // before reaching Stripe. Storing the hosted-checkout URL lets a user who
    // closes the tab and retries land back on the SAME Stripe session instead of
    // being charged twice.
    try {
      const [mdCols] = await getPool().query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketplace_digital_orders'`
      ) as any;
      const mdNames = new Set(mdCols.map((row: any) => String(row.COLUMN_NAME)));
      if (mdCols.length > 0 && !mdNames.has("checkout_url")) {
        await getPool().query(
          `ALTER TABLE marketplace_digital_orders ADD COLUMN checkout_url VARCHAR(600) NULL AFTER stripe_session_id`
        );
        console.log("✅ marketplace_digital_orders.checkout_url added.");
      }
    } catch (err) {
      console.warn("⚠️ Could not add marketplace_digital_orders.checkout_url:", err);
    }

    // -----------------------------------------------------------------------
    // Pet Health — H1: persistent health profile per avatar
    // -----------------------------------------------------------------------
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS pet_health_profiles (
        id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
        avatar_id             INT NOT NULL,
        user_phone            VARCHAR(32) NOT NULL,
        birthday              DATE NULL,
        weight_kg             DECIMAL(5,2) NULL,
        weight_unit           ENUM('kg','lb') NOT NULL DEFAULT 'lb',
        target_weight_kg      DECIMAL(5,2) NULL,
        body_condition_score  TINYINT NULL COMMENT '1-9 BCS (5=ideal)',
        sterilized            TINYINT(1) NOT NULL DEFAULT 0,
        microchip_id          VARCHAR(60) NULL,
        vet_name              VARCHAR(120) NULL,
        vet_phone             VARCHAR(30) NULL,
        vet_email             VARCHAR(120) NULL,
        next_vet_visit        DATE NULL,
        next_vaccine_due      DATE NULL,
        insurance_provider    VARCHAR(120) NULL,
        notes                 TEXT NULL,
        created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_health_avatar (avatar_id),
        INDEX idx_health_phone (user_phone),
        FOREIGN KEY (avatar_id) REFERENCES avatars(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Static health profile, one per avatar';
    `);

    // H1: time-series health log entries (weight, vet, meds, symptoms)
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS pet_health_logs (
        id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
        avatar_id             INT NOT NULL,
        user_phone            VARCHAR(32) NOT NULL,
        log_type              ENUM(
          'weight','body_condition','vet_visit','vaccine',
          'medication','symptom','note','dental','grooming'
        ) NOT NULL,
        logged_at             DATE NOT NULL,
        weight_kg             DECIMAL(5,2) NULL,
        body_condition_score  TINYINT NULL,
        value_numeric         DECIMAL(8,2) NULL,
        value_text            VARCHAR(400) NULL,
        notes                 TEXT NULL,
        created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_health_log_avatar (avatar_id, logged_at DESC),
        INDEX idx_health_log_phone  (user_phone, logged_at DESC),
        FOREIGN KEY (avatar_id) REFERENCES avatars(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Time-series health events';
    `);

    console.log("✅ pet_health_profiles and pet_health_logs tables ready.");

    // ── Marketplace Product Customizer P1 (MARKETPLACE_CUSTOMIZER_SPEC.md §3) ──
    // Admin-authored Printful blank templates + buyer order lifecycle.
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS customizable_products (
        id                  BIGINT PRIMARY KEY AUTO_INCREMENT,
        listing_id          BIGINT NOT NULL,
        printful_product_id INT    NOT NULL,
        printful_variant_id INT    NOT NULL,
        placement           VARCHAR(32) NOT NULL DEFAULT 'default',
        printfile_width_px  INT    NOT NULL,
        printfile_height_px INT    NOT NULL,
        printfile_dpi       INT    NOT NULL DEFAULT 150,
        box_x               DECIMAL(6,5) NOT NULL,
        box_y               DECIMAL(6,5) NOT NULL,
        box_w               DECIMAL(6,5) NOT NULL,
        box_h               DECIMAL(6,5) NOT NULL,
        box_shape           ENUM('rect','circle','arch') NOT NULL DEFAULT 'rect',
        overlay_asset_uuid  CHAR(36) NULL,
        retail_price_cents  INT    NOT NULL,
        status              ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
        created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_custprod_listing (listing_id, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS customize_orders (
        id                    BIGINT PRIMARY KEY AUTO_INCREMENT,
        user_phone            VARCHAR(32) NOT NULL,
        customizable_id       BIGINT NOT NULL,
        source_photo_url      TEXT   NOT NULL,
        source_kind           ENUM('upload','furbin') NOT NULL,
        print_file_url        TEXT   NULL,
        recipient_json        JSON   NOT NULL,
        retail_price_cents    INT    NOT NULL,
        checkout_url          TEXT   NULL,
        stripe_session_id     VARCHAR(255) NULL,
        provider_order_id     VARCHAR(64)  NULL,
        provider_payload_json JSON   NULL,
        status ENUM('draft','awaiting_payment','payment_received','submitting',
                    'submitted','failed','refunded') NOT NULL DEFAULT 'draft',
        idempotency_key       VARCHAR(128) NOT NULL,
        created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_custorder_idem (user_phone, idempotency_key),
        INDEX idx_custorder_status (status),
        INDEX idx_custorder_user (user_phone, created_at DESC)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    console.log("✅ customizable_products and customize_orders tables ready.");
    console.log("✅ fidos_projects and wardrobe_wags tables ready.");

    await runMigrations(getPool());
  } catch (err) {
    console.error("Failed to initialize database:", err);
    throw err;
  }
}

/** Look up a user by their opaque internal key (stored in users.phone). */
export async function findUserByPhone(phone: string): Promise<UserRow | null> {
  const [rows] = await getPool().query("SELECT * FROM users WHERE phone = ? LIMIT 1", [phone]);
  const arr = rows as unknown as UserRow[];
  return arr.length ? arr[0] : null;
}

/** Look up a user by email (the login gate). Email is stored lower-cased.
 *  ORDER BY id keeps the result deterministic if legacy duplicate-email rows exist. */
export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const [rows] = await getPool().query("SELECT * FROM users WHERE email = ? ORDER BY id LIMIT 1", [String(email).trim().toLowerCase()]);
  const arr = rows as unknown as UserRow[];
  return arr.length ? arr[0] : null;
}

/** Raised when a sign-up uses an email that already has an account. */
export class EmailTakenError extends Error {
  constructor() {
    super("An account with this email already exists. Please log in instead.");
    this.name = "EmailTakenError";
  }
}

/**
 * Create a fresh (profile-incomplete) account gated by email + password.
 * A synthetic internal key is generated for the users.phone column so the
 * existing foreign-key relationships keep working. New users receive a
 * one-time free-avatar entitlement, not wallet credits.
 */
export async function createUserByEmail(email: string, passwordHash: string, acceptedTermsVersion: string): Promise<UserRow> {
  // Guard against a race / duplicate before insert.
  const existing = await findUserByEmail(email);
  if (existing) throw new EmailTakenError();

  const userKey = generateUserKey();
  try {
    await getPool().query(
      `INSERT INTO users
         (phone, email, password_hash, credits, treats, profile_complete, free_avatar_available, accepted_terms_version, accepted_terms_at)
       VALUES (?, ?, ?, 0, 0, 0, 1, ?, NOW())`,
      [userKey, email, passwordHash, acceptedTermsVersion]
    );
  } catch (err: any) {
    if (err && err.code === "ER_DUP_ENTRY") throw new EmailTakenError();
    throw err;
  }
  const created = await findUserByPhone(userKey);
  if (!created) throw new Error("User creation failed");
  return created;
}

/** Record that the user accepted the currently active legal terms. */
export async function acceptTermsVersion(phone: string, termsVersion: string): Promise<UserRow> {
  await getPool().query(
    `UPDATE users
        SET accepted_terms_version = ?,
            accepted_terms_at = NOW()
      WHERE phone = ?`,
    [termsVersion, phone]
  );
  const updated = await findUserByPhone(phone);
  if (!updated) throw new Error("User not found after terms update");
  return updated;
}

/**
 * Save the required profile details and mark the profile complete.
 * Email + password were already set at sign-up, so they are not touched here.
 * Completes the profile without granting wallet credits. The free-avatar
 * entitlement is consumed later by the avatar generation route.
 */
export async function completeUserProfile(
  phone: string,
  fullName: string,
  birthdate: string,
  city: string
): Promise<UserRow> {
  await getPool().query(
    `UPDATE users
       SET full_name = ?,
           birthdate = ?,
           city = ?,
           profile_complete = 1
     WHERE phone = ?`,
    [fullName, birthdate, city, phone]
  );
  const updated = await findUserByPhone(phone);
  if (!updated) throw new Error("User not found after profile update");
  return updated;
}

/** Read the current credit balance for a phone number from the DB. */
export async function getCreditBalance(phone: string): Promise<number> {
  const user = await findUserByPhone(phone);
  return user ? user.credits : 0;
}

export async function claimFreeAvatar(phone: string): Promise<boolean> {
  const [result] = await getPool().query(
    `UPDATE users SET free_avatar_available = 0
      WHERE phone = ? AND profile_complete = 1 AND free_avatar_available = 1`,
    [phone]
  ) as any;
  return result.affectedRows === 1;
}

export async function releaseFreeAvatar(phone: string): Promise<void> {
  await getPool().query(
    `UPDATE users SET free_avatar_available = 1
      WHERE phone = ? AND free_avatar_available = 0`,
    [phone]
  );
}

/**
 * Atomically deduct credits only if the user has enough.
 * Returns true if the deduction succeeded, false if insufficient balance.
 */
export async function deductCredits(phone: string, amount: number, reason: string = "spend"): Promise<boolean> {
  return (await reserveCredits(phone, amount, reason)) !== null;
}

/**
 * Reserve/spend credits and return the server-created ledger correlation that
 * is required for any later refund. The correlation, not a caller-supplied
 * owner or amount, is the durable source of refund authority.
 */
export async function reserveCredits(
  phone: string,
  amount: number,
  reason: string = "spend",
  debitCorrelationId: string = `debit:${randomUUID()}`,
): Promise<string | null> {
  if (!isValidCreditAmount(amount)) return null;
  const result = await applyWalletDebitOnce(getPool(), {
    ownerId: phone,
    correlationId: debitCorrelationId,
    amount,
    reason: reason.slice(0, 80),
  });
  return result.authorized ? debitCorrelationId : null;
}

/** Refund a prior debit exactly once from its immutable ledger evidence. */
export async function refundReservedCredits(debitCorrelationId: string): Promise<boolean> {
  const result = await refundWalletDebitOnce(getPool(), debitCorrelationId);
  return result.applied;
}

/**
 * Add credits to a user's account (purchases, rewards, webhooks).
 * Safe to call from Stripe webhooks.
 */
export async function addCredits(
  phone: string,
  amount: number,
  reason: string = "credit",
  idempotencyKey: string = `credit:${randomUUID()}`,
): Promise<void> {
  if (!isValidCreditAmount(amount)) {
    throw new RangeError("Credit amount must be a positive safe integer within the signed wallet maximum.");
  }
  await applyWalletClaimOnce(getPool(), {
    ownerId: phone,
    correlationId: idempotencyKey,
    expected: { delta: amount, reason: reason.slice(0, 80) },
    resolve: async () => ({ delta: amount, reason: reason.slice(0, 80) }),
  });
}

export interface PurchasedCreditGrantResult {
  applied: boolean;
  balance: number;
}

/**
 * Atomically grant one paid Stripe Checkout session exactly once.
 * The Stripe session ID is the durable identity; the display reason is not.
 */
export async function grantPurchasedCredits(
  phone: string,
  amount: number,
  stripeSessionId: string,
): Promise<PurchasedCreditGrantResult> {
  if (!isValidCreditAmount(amount)) {
    throw new RangeError("Purchased credit amount must be within the signed wallet maximum.");
  }
  if (typeof phone !== "string" || phone.length === 0 || phone.length > 32) {
    throw new Error("Purchased credit owner is required.");
  }
  if (typeof stripeSessionId !== "string" || stripeSessionId.length === 0 || stripeSessionId.length > 190) {
    throw new Error("A valid Stripe Checkout session ID is required.");
  }
  const result = await applyWalletClaimOnce(getPool(), {
    ownerId: phone,
    correlationId: stripeSessionId,
    expected: { delta: amount, reason: "credit_purchase" },
    resolve: async () => ({ delta: amount, reason: "credit_purchase" }),
  });
  return { applied: result.applied, balance: result.balance };
}

/** Convert the retired Pawprint-token balance once without double-granting on restart. */
async function retireLegacyPawprintTokens(): Promise<void> {
  const lockConnection = await getPool().getConnection();
  try {
    const [lockRows] = await lockConnection.query(
      `SELECT GET_LOCK('retire_pawprint_tokens', 10) AS acquired`
    ) as any;
    if (Number(lockRows?.[0]?.acquired) !== 1) {
      console.warn("[credits] Could not acquire the legacy Pawprint conversion lock.");
      return;
    }
    const [rows] = await getPool().query(
      `SELECT phone, pawprint_tokens FROM users WHERE pawprint_tokens > 0`
    ) as any;
    for (const row of rows as Array<{ phone: string; pawprint_tokens: number }>) {
      const [alreadyConverted] = await getPool().query(
        `SELECT 1 FROM credit_transactions WHERE user_phone = ? AND reason = 'pawprint_token_conversion' LIMIT 1`,
        [row.phone]
      ) as any;
      if (!alreadyConverted?.length) {
        await addCredits(
          row.phone,
          Number(row.pawprint_tokens) * CREDIT_PRICES.PAWPRINT,
          "pawprint_token_conversion",
          `legacy-pawprint-conversion:${row.phone}`,
        );
      }
      await getPool().query(`UPDATE users SET pawprint_tokens = 0 WHERE phone = ?`, [row.phone]);
    }
  } finally {
    try { await lockConnection.query(`SELECT RELEASE_LOCK('retire_pawprint_tokens')`); } catch {}
    lockConnection.release();
  }
}

export interface CreditTransaction {
  id: number;
  delta: number;
  reason: string;
  balance_after: number;
  created_at: string;
}

/** Recent credit transactions for a user, newest first (for spend tracking / history). */
export async function getCreditHistory(phone: string, limit: number = 20): Promise<CreditTransaction[]> {
  const [rows] = await getPool().query(
    `SELECT id, delta, reason, balance_after, created_at
       FROM credit_transactions WHERE user_phone = ? ORDER BY id DESC LIMIT ?`,
    [phone, Math.max(1, Math.min(100, limit))]
  ) as any;
  return rows as CreditTransaction[];
}

/**
 * Whether a Stripe checkout session has already granted credits.
 */
export async function wasSessionCredited(sessionId: string): Promise<boolean> {
  const [rows] = await getPool().query(
    `SELECT 1 FROM credit_transactions WHERE idempotency_key = ? LIMIT 1`,
    [sessionId]
  ) as any;
  return Array.isArray(rows) && rows.length > 0;
}

// ============================================================================
// Community Memory Board
// ============================================================================

export interface CommunityMemory {
  id: number;
  user_phone: string;
  image_url: string;
  caption: string | null;
  created_at: string;
}

export async function addCommunityMemory(phone: string, imageUrl: string, caption: string | null): Promise<number> {
  const [r] = await getPool().query(
    `INSERT INTO community_memories (user_phone, image_url, caption) VALUES (?, ?, ?)`,
    [phone, imageUrl, caption ? caption.slice(0, 200) : null]
  ) as any;
  return r.insertId;
}

/** Recent community memories, newest first, for the live inspiration board. */
export async function getCommunityMemories(limit: number = 30): Promise<CommunityMemory[]> {
  const [rows] = await getPool().query(
    `SELECT id, user_phone, image_url, caption, created_at
       FROM community_memories ORDER BY id DESC LIMIT ?`,
    [Math.max(1, Math.min(60, limit))]
  ) as any;
  return rows as CommunityMemory[];
}

// ============================================================================
// User Photo Library (profile thumbnail + avatar-builder photo persistence)
// ============================================================================

export interface UserPhoto {
  id: number;
  image_url: string;
  source: string;
  created_at: string;
}

export async function setProfilePhoto(phone: string, url: string): Promise<void> {
  await getPool().query(`UPDATE users SET profile_photo_url = ? WHERE phone = ?`, [url, phone]);
}

export async function addUserPhoto(phone: string, url: string, source: string = "upload"): Promise<number> {
  const [r] = await getPool().query(
    `INSERT INTO user_photos (user_phone, image_url, source) VALUES (?, ?, ?)`,
    [phone, url, source.slice(0, 32)]
  ) as any;
  return r.insertId;
}

export async function getUserPhotos(phone: string, limit: number = 60): Promise<UserPhoto[]> {
  const [rows] = await getPool().query(
    `SELECT id, image_url, source, created_at FROM user_photos
      WHERE user_phone = ? ORDER BY id DESC LIMIT ?`,
    [phone, Math.max(1, Math.min(200, limit))]
  ) as any;
  return rows as UserPhoto[];
}

/** Delete a photo the user owns. Returns true if a row was removed. */
export async function deleteUserPhoto(id: number, phone: string): Promise<boolean> {
  const [r] = await getPool().query(
    `DELETE FROM user_photos WHERE id = ? AND user_phone = ?`,
    [id, phone]
  ) as any;
  return r.affectedRows === 1;
}

// ============================================================================
// Albums Helpers
// ============================================================================

export interface AlbumRow {
  id: number;
  user_phone: string;
  name: string;
  created_at: string;
  itemCount?: number; // Aggregated count of creations inside the album
}

export async function createAlbum(phone: string, name: string): Promise<AlbumRow> {
  const [result] = await getPool().query(
    "INSERT INTO albums (user_phone, name) VALUES (?, ?)",
    [phone, name]
  ) as any;
  return {
    id: result.insertId,
    user_phone: phone,
    name,
    created_at: new Date().toISOString(),
    itemCount: 0
  };
}

export async function getAlbums(phone: string): Promise<AlbumRow[]> {
  const [rows] = await getPool().query(`
    SELECT a.*, COUNT(c.id) as itemCount,
      (SELECT image_url FROM creations
       WHERE album_id = a.id
       ORDER BY sort_order ASC, created_at ASC LIMIT 1) as cover_url
    FROM albums a
    LEFT JOIN creations c ON a.id = c.album_id
    WHERE a.user_phone = ?
    GROUP BY a.id
    ORDER BY a.created_at DESC
  `, [phone]) as any;
  return rows;
}

// ============================================================================
// Creations (Album Items) Helpers
// ============================================================================

export interface CreationRow {
  id: number;
  user_phone: string;
  album_id: number | null;
  media_type: 'still' | 'video' | 'model';
  style: string;
  backdrop_kind: 'preset' | 'streetview';
  preset_name: string | null;
  sv_lat: number | null;
  sv_lng: number | null;
  sv_heading: number | null;
  sv_pitch: number | null;
  sv_fov: number | null;
  place_label: string | null;
  image_url: string | null;
  video_url: string | null;
  model_url: string | null;
  sort_order: number;
  created_at: string;
  pet_name?: string | null;
  pet_breed?: string | null;
}

export async function saveCreation(data: {
  user_phone: string;
  album_id?: number | null;
  media_type: 'still' | 'video' | 'model';
  style: string;
  backdrop_kind: 'preset' | 'streetview';
  preset_name?: string | null;
  sv_lat?: number | null;
  sv_lng?: number | null;
  sv_heading?: number | null;
  sv_pitch?: number | null;
  sv_fov?: number | null;
  place_label?: string | null;
  image_url?: string | null;
  video_url?: string | null;
  sort_order?: number;
  pet_name?: string | null;
  pet_breed?: string | null;
}): Promise<number> {
  const [result] = await getPool().query(
    `INSERT INTO creations (
      user_phone, album_id, media_type, style, backdrop_kind, preset_name,
      sv_lat, sv_lng, sv_heading, sv_pitch, sv_fov, place_label, image_url, video_url, sort_order, pet_name, pet_breed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.user_phone,
      data.album_id || null,
      data.media_type,
      data.style,
      data.backdrop_kind,
      data.preset_name || null,
      data.sv_lat || null,
      data.sv_lng || null,
      data.sv_heading || null,
      data.sv_pitch || null,
      data.sv_fov || null,
      data.place_label || null,
      data.image_url || null,
      data.video_url || null,
      data.sort_order || 0,
      data.pet_name || null,
      data.pet_breed || null,
    ]
  ) as any;
  return result.insertId;
}

export async function getCreations(phone: string): Promise<CreationRow[]> {
  const [rows] = await getPool().query(
    `SELECT * FROM creations WHERE user_phone = ? ORDER BY sort_order ASC, created_at DESC`,
    [phone]
  );
  return rows as unknown as CreationRow[];
}

export async function getAllCreations(): Promise<CreationRow[]> {
  const [rows] = await getPool().query(
    `SELECT * FROM creations ORDER BY created_at DESC`
  );
  return rows as unknown as CreationRow[];
}

export async function updateCreation(
  id: number,
  phone: string,
  updates: Partial<{
    media_type: 'still' | 'video';
    style: string;
    backdrop_kind: 'preset' | 'streetview';
    preset_name: string | null;
    sv_lat: number | null;
    sv_lng: number | null;
    sv_heading: number | null;
    sv_pitch: number | null;
    sv_fov: number | null;
    place_label: string | null;
    image_url: string | null;
    video_url: string | null;
    sort_order: number;
  }>
): Promise<boolean> {
  const setClauses: string[] = [];
  const values: any[] = [];

  Object.entries(updates).forEach(([key, value]) => {
    setClauses.push(`${key} = ?`);
    values.push(value);
  });

  if (setClauses.length === 0) return true;

  values.push(id, phone);
  const [result] = await getPool().query(
    `UPDATE creations SET ${setClauses.join(', ')} WHERE id = ? AND user_phone = ?`,
    values
  ) as any;

  return result.affectedRows === 1;
}

// ============================================================================
// Generation Jobs Helpers
// ============================================================================

export interface JobRow {
  id: number;
  user_phone: string;
  creation_id: number | null;
  kind: 'still' | 'video' | 'model';
  status: 'queued' | 'running' | 'rigging' | 'validating' | 'done' | 'done_static_fallback' | 'failed';
  operation_name: string | null;
  credits_reserved: number;
  credit_debit_correlation_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  rig_attempt_count: number;
  recovery_lease_owner: string | null;
  recovery_lease_expires_at: string | null;
  recovery_started_at: string | null;
  recovery_last_heartbeat_at: string | null;
  recovery_reason: string | null;
  rig_source_model_hash: string | null;
  rig_refunded_at: string | null;
  generation_refunded_at: string | null;
}

export type JobKind = 'still' | 'video' | 'model';

export const JOB_KINDS: readonly JobKind[] = ['still', 'video', 'model'] as const;

/**
 * Guard the generation_jobs.kind enum in application code.
 *
 * The production database runs with sql_mode =
 * "IGNORE_SPACE,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION" — note the absence
 * of STRICT_TRANS_TABLES. MariaDB in non-strict mode does not reject an invalid
 * ENUM value; it silently coerces it to the empty string and returns success.
 * Rows 21-23 in generation_jobs carry kind='' for exactly this reason.
 *
 * That makes the column's type declaration decorative: the only place an
 * invalid kind can actually be caught is here, before the INSERT. Callers that
 * pass `jobData: any` (commitPipelineSessionBuild, recoverPipelineSession) have
 * no compile-time protection, so this runtime check is the only backstop.
 */
export function isJobKind(kind: unknown): kind is JobKind {
  return typeof kind === 'string' && JOB_KINDS.includes(kind as JobKind);
}

export function jobKindError(kind: unknown): string {
  return (
    `Invalid generation_jobs.kind: ${JSON.stringify(kind)}. ` +
    `Expected one of ${JOB_KINDS.join(', ')}. Refusing the insert — the database ` +
    `runs non-strict and would silently store '' instead of rejecting this.`
  );
}

/** Throwing form, for callers that return a bare value and have no error channel. */
export function assertJobKind(kind: unknown): asserts kind is JobKind {
  if (!isJobKind(kind)) throw new Error(jobKindError(kind));
}

export async function createJob(data: {
  user_phone: string;
  creation_id?: number | null;
  kind: JobKind;
  credits_reserved: number;
  credit_debit_correlation_id?: string | null;
  operation_name?: string | null;
}): Promise<number> {
  assertJobKind(data.kind);
  if (!Number.isSafeInteger(data.credits_reserved) || data.credits_reserved < 0 || data.credits_reserved > MAX_CREDIT_BALANCE) {
    throw new Error("Generation job has an invalid reserved-credit amount.");
  }
  const debitCorrelationId = data.credit_debit_correlation_id || null;
  if ((data.credits_reserved > 0) !== Boolean(debitCorrelationId)) {
    throw new Error("Paid generation jobs require matching debit evidence; zero-cost jobs must not carry it.");
  }
  if (debitCorrelationId && debitCorrelationId.length > 190) {
    throw new Error("Generation job debit correlation is too long.");
  }
  const [result] = await getPool().query(
    `INSERT INTO generation_jobs
       (user_phone, creation_id, kind, credits_reserved, credit_debit_correlation_id, operation_name, status)
     VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
    [data.user_phone, data.creation_id || null, data.kind, data.credits_reserved,
      debitCorrelationId, data.operation_name || null]
  ) as any;
  return result.insertId;
}

export async function updateJobStatus(
  jobId: number,
  status: 'queued' | 'running' | 'rigging' | 'validating' | 'done' | 'done_static_fallback' | 'failed',
  error?: string | null,
  operationName?: string | null
): Promise<boolean> {
  const [result] = await getPool().query(
    `UPDATE generation_jobs
        SET status = ?, error = ?, operation_name = COALESCE(?, operation_name),
            recovery_lease_owner = CASE WHEN ? IN ('done','done_static_fallback','failed') THEN NULL ELSE recovery_lease_owner END,
            recovery_lease_expires_at = CASE WHEN ? IN ('done','done_static_fallback','failed') THEN NULL ELSE recovery_lease_expires_at END
      WHERE id = ?
        AND (
          ? NOT IN ('done','done_static_fallback','failed')
          OR status NOT IN ('done','done_static_fallback','failed')
          OR status = ?
        )`,
    [status, error || null, operationName || null, status, status, jobId, status, status]
  ) as any;
  return result.affectedRows === 1;
}

export async function getJob(jobId: number, phone: string): Promise<JobRow | null> {
  const [rows] = await getPool().query(
    `SELECT * FROM generation_jobs WHERE id = ? AND user_phone = ? LIMIT 1`,
    [jobId, phone]
  );
  const arr = rows as unknown as JobRow[];
  return arr.length ? arr[0] : null;
}

export async function getRunningJobs(): Promise<JobRow[]> {
  const [rows] = await getPool().query(
    `SELECT * FROM generation_jobs WHERE status IN ('queued', 'running') ORDER BY created_at ASC`
  );
  return rows as unknown as JobRow[];
}

export async function setCreationVideoUrl(creationId: number, phone: string, videoUrl: string): Promise<boolean> {
  const [result] = await getPool().query(
    `UPDATE creations SET video_url = ?, media_type = 'video' WHERE id = ? AND user_phone = ?`,
    [videoUrl, creationId, phone]
  ) as any;
  return result.affectedRows === 1;
}

export async function setCreationModelUrl(creationId: number, phone: string, modelUrl: string): Promise<boolean> {
  const [result] = await getPool().query(
    `UPDATE creations SET model_url = ?, media_type = 'model' WHERE id = ? AND user_phone = ?`,
    [modelUrl, creationId, phone]
  ) as any;
  return result.affectedRows === 1;
}

/** P3 optional rigging: persist the rigged GLB + validation report alongside the static model. */
export async function setCreationRiggedModel(
  creationId: number,
  phone: string,
  riggedModelUrl: string,
  rigReport: unknown
): Promise<boolean> {
  const [result] = await getPool().query(
    `UPDATE creations SET rigged_model_url = ?, rig_report = ? WHERE id = ? AND user_phone = ?`,
    [riggedModelUrl, JSON.stringify(rigReport ?? null), creationId, phone]
  ) as any;
  return result.affectedRows === 1;
}

/** P3 optional rigging: find the create-pipeline session that owns a build job. */
export async function getPipelineSessionByBuildJobId(jobId: number): Promise<CreatePipelineSession | null> {
  const [rows] = await getPool().query(
    `SELECT * FROM create_pipeline_sessions WHERE build_job_id = ? LIMIT 1`,
    [jobId]
  ) as any;
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  let customization_state = null;
  try {
    if (row.customization_state) customization_state = JSON.parse(row.customization_state);
  } catch (e) {}
  return { ...row, customization_state };
}

export async function getDailyVideoCount(phone: string): Promise<number> {
  const [rows] = await getPool().query(
    `SELECT COUNT(*) as count FROM generation_jobs WHERE user_phone = ? AND kind = 'video' AND status NOT IN ('failed') AND DATE(created_at) = CURDATE()`,
    [phone]
  );
  const arr = rows as unknown as { count: string | number }[];
  return Number(arr[0].count);
}

/** @deprecated Paid routes must use reservePaidUsage so aggregate caps stay atomic. */
export async function bumpDailyUsage(phone: string, endpoint: string): Promise<number> {
  await getPool().query(
    `INSERT INTO api_usage_daily (user_phone, endpoint, day, count)
     VALUES (?, ?, CURDATE(), 1)
     ON DUPLICATE KEY UPDATE count = count + 1`,
    [phone, endpoint]
  );
  const [rows] = await getPool().query(
    `SELECT count FROM api_usage_daily WHERE user_phone = ? AND endpoint = ? AND day = CURDATE()`,
    [phone, endpoint]
  );
  const arr = rows as unknown as { count: string | number }[];
  return arr.length ? Number(arr[0].count) : 0;
}

/**
 * Atomically reserve user, aggregate daily/cost, and optional aggregate minute
 * capacity before a paid provider call. Global locks are always acquired before
 * the user lock to keep concurrent requests ordered. A denial changes no counter.
 */
export async function reservePaidUsage(
  phone: string,
  endpoint: PaidEndpoint,
  limits: PaidUsageLimits,
): Promise<PaidUsageReservation> {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();

    await connection.query(
      `INSERT INTO api_usage_global_daily
         (endpoint, day, count, reserved_cost_micro_usd)
       VALUES (?, UTC_DATE(), 0, 0)
       ON DUPLICATE KEY UPDATE endpoint = VALUES(endpoint)`,
      [endpoint],
    );
    if (limits.globalMinuteCallCap != null) {
      await connection.query(
        `INSERT INTO api_usage_global_minute (endpoint, window_started_at, count)
         VALUES (?, UTC_TIMESTAMP(3), 0)
         ON DUPLICATE KEY UPDATE endpoint = VALUES(endpoint)`,
        [endpoint],
      );
    }
    await connection.query(
      `INSERT INTO api_usage_daily (user_phone, endpoint, day, count)
       VALUES (?, ?, UTC_DATE(), 0)
       ON DUPLICATE KEY UPDATE user_phone = VALUES(user_phone)`,
      [phone, endpoint],
    );

    const [globalRows] = await connection.query(
      `SELECT count, reserved_cost_micro_usd
       FROM api_usage_global_daily
       WHERE endpoint = ? AND day = UTC_DATE()
       FOR UPDATE`,
      [endpoint],
    ) as any;
    let globalMinuteCount = 0;
    if (limits.globalMinuteCallCap != null) {
      const [minuteRows] = await connection.query(
        `SELECT count,
                CASE
                  WHEN window_started_at > UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE
                  THEN 1 ELSE 0
                END AS window_active
         FROM api_usage_global_minute
         WHERE endpoint = ?
         FOR UPDATE`,
        [endpoint],
      ) as any;
      const minuteRow = minuteRows?.[0];
      globalMinuteCount = Number(minuteRow?.window_active || 0) === 1
        ? Number(minuteRow?.count || 0)
        : 0;
    }
    const [userRows] = await connection.query(
      `SELECT count
       FROM api_usage_daily
       WHERE user_phone = ? AND endpoint = ? AND day = UTC_DATE()
       FOR UPDATE`,
      [phone, endpoint],
    ) as any;

    const globalCount = Number(globalRows?.[0]?.count || 0);
    const globalReservedCostMicroUsd = Number(globalRows?.[0]?.reserved_cost_micro_usd || 0);
    const userCount = Number(userRows?.[0]?.count || 0);
    const nextCost = globalReservedCostMicroUsd + limits.estimatedCostMicroUsd;

    let reason: PaidUsageReservation["reason"];
    if (userCount >= limits.userDailyCap) reason = "user_cap";
    else if (globalCount >= limits.globalDailyCap) reason = "global_cap";
    else if (
      limits.globalMinuteCallCap != null
      && globalMinuteCount >= limits.globalMinuteCallCap
    ) reason = "global_minute_cap";
    else if (nextCost > limits.globalDailyCostMicroUsd) reason = "global_cost_cap";

    if (reason) {
      await connection.rollback();
      return {
        allowed: false,
        reason,
        userCount,
        globalCount,
        ...(limits.globalMinuteCallCap == null ? {} : { globalMinuteCount }),
        globalReservedCostMicroUsd,
      };
    }

    await connection.query(
      `UPDATE api_usage_global_daily
       SET count = count + 1,
           reserved_cost_micro_usd = reserved_cost_micro_usd + ?
       WHERE endpoint = ? AND day = UTC_DATE()`,
      [limits.estimatedCostMicroUsd, endpoint],
    );
    await connection.query(
      `UPDATE api_usage_daily
       SET count = count + 1
       WHERE user_phone = ? AND endpoint = ? AND day = UTC_DATE()`,
      [phone, endpoint],
    );
    if (limits.globalMinuteCallCap != null) {
      await connection.query(
        `UPDATE api_usage_global_minute
         SET count = CASE
               WHEN window_started_at <= UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE
               THEN 1 ELSE count + 1
             END,
             window_started_at = CASE
               WHEN window_started_at <= UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE
               THEN UTC_TIMESTAMP(3) ELSE window_started_at
             END
         WHERE endpoint = ?`,
        [endpoint],
      );
    }
    await connection.commit();

    return {
      allowed: true,
      userCount: userCount + 1,
      globalCount: globalCount + 1,
      ...(limits.globalMinuteCallCap == null
        ? {}
        : { globalMinuteCount: globalMinuteCount + 1 }),
      globalReservedCostMicroUsd: nextCost,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/** Read today's usage count for (user, endpoint) without incrementing. */
export async function getDailyUsage(phone: string, endpoint: string): Promise<number> {
  const [rows] = await getPool().query(
    `SELECT count FROM api_usage_daily WHERE user_phone = ? AND endpoint = ? AND day = CURDATE()`,
    [phone, endpoint]
  );
  const arr = rows as unknown as { count: string | number }[];
  return arr.length ? Number(arr[0].count) : 0;
}

export async function isUserAdmin(phone: string): Promise<boolean> {
  // Bypass for the seeded admin account (matched by internal row key).
  if (ADMIN_KEY && phone === ADMIN_KEY) return true;

  const [rows] = await getPool().query("SELECT is_admin FROM users WHERE phone = ? LIMIT 1", [phone]);
  const arr = rows as unknown as { is_admin: number }[];
  return arr.length ? arr[0].is_admin === 1 : false;
}

// ============================================================================
// Pets Helpers
// ============================================================================

export interface PetRow {
  id: number;
  user_phone: string;
  name: string;
  kind: 'dog' | 'cat' | 'other';
  created_at: string;
}

export async function addPet(phone: string, name: string, kind: 'dog' | 'cat' | 'other'): Promise<number> {
  const [result] = await getPool().query(
    `INSERT INTO pets (user_phone, name, kind) VALUES (?, ?, ?)`,
    [phone, name, kind]
  ) as any;
  return result.insertId;
}

export async function getPets(phone: string): Promise<PetRow[]> {
  const [rows] = await getPool().query(`SELECT * FROM pets WHERE user_phone = ? ORDER BY created_at ASC`, [phone]);
  return rows as unknown as PetRow[];
}

export async function updatePet(id: number, phone: string, name: string, kind: 'dog' | 'cat' | 'other'): Promise<boolean> {
  const [result] = await getPool().query(
    `UPDATE pets SET name = ?, kind = ? WHERE id = ? AND user_phone = ?`,
    [name, kind, id, phone]
  ) as any;
  return result.affectedRows === 1;
}

export async function deletePet(id: number, phone: string): Promise<boolean> {
  const [result] = await getPool().query(`DELETE FROM pets WHERE id = ? AND user_phone = ?`, [id, phone]) as any;
  return result.affectedRows === 1;
}

// ============================================================================
// Avatars Helpers
// ============================================================================

export interface AvatarRow {
  id: number;
  user_phone: string;
  name: string;
  image_url: string;
  model_url: string | null;
  rigged_model_url: string | null;
  clips_json: string | null;
  multiview_json: string | null;
  sprite_sheet_url: string | null;
  animation_data: any | null;
  meshy_handle: string | null;
  animal_type: string | null;
  breed: string | null;
  generation_status: 'pending' | 'generating_mesh' | 'rigging' | 'retargeting' | 'baking_clips' | 'baking_sprites' | 'done' | 'failed';
  generation_error: string | null;
  avatar_type: 'dog' | 'human' | 'object';
  generation_analysis: any | null;
  food_level: number;
  water_level: number;
  last_fed: string;
  last_watered: string;
  created_at: string;
}

export async function createAvatar(
  phone: string,
  name: string,
  image_url: string,
  meshy_handle: string | null,
  opts?: {
    animal_type?: string;
    breed?: string;
    generation_status?: string;
    avatar_type?: string;
    /** Unified triage record (detection + qualification + anatomy). */
    generation_analysis?: unknown;
  }
): Promise<number> {
  const [result] = await getPool().query(
    `INSERT INTO avatars (user_phone, name, image_url, meshy_handle, animal_type, breed, generation_status, avatar_type, generation_analysis) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      phone,
      name,
      image_url,
      meshy_handle,
      opts?.animal_type || null,
      opts?.breed || null,
      opts?.generation_status || 'pending',
      opts?.avatar_type || 'dog',
      opts?.generation_analysis != null ? JSON.stringify(opts.generation_analysis) : null
    ]
  ) as any;
  return result.insertId;
}

export async function updateAvatarModel(
  id: number,
  phone: string,
  modelUrl: string,
  spriteSheetUrl: string,
  animationData: any
): Promise<boolean> {
  // NOTE: Do NOT set generation_status here — the caller manages status
  // transitions via updateAvatarGenerationStatus to avoid a race condition
  // where the frontend sees a premature 'done' before clip baking finishes.
  const [result] = await getPool().query(
    `UPDATE avatars SET model_url = ?, sprite_sheet_url = ?, animation_data = ? WHERE id = ? AND user_phone = ?`,
    [modelUrl, spriteSheetUrl, JSON.stringify(animationData), id, phone]
  ) as any;
  return result.affectedRows === 1;
}

/**
 * Store the rigged skeletal model + clip manifest produced by the Blender
 * pipeline (Phase 5). Consumed by the 3D/AR scene, which prefers this over
 * the plain mesh model_url.
 */
export async function updateAvatarRiggedModel(
  id: number,
  phone: string,
  riggedModelUrl: string,
  clips: { name: string; loop: boolean; durationSec: number }[]
): Promise<boolean> {
  const [result] = (await getPool().query(
    `UPDATE avatars SET rigged_model_url = ?, clips_json = ? WHERE id = ? AND user_phone = ?`,
    [riggedModelUrl, JSON.stringify(clips || []), id, phone]
  )) as any;
  return result.affectedRows === 1;
}

export interface MultiviewSet {
  left?: string;
  back?: string;
  right?: string;
}

/** Persist the generated turnaround view URLs so retry/resume can reuse them. */
export async function updateAvatarMultiview(
  id: number,
  views: MultiviewSet
): Promise<boolean> {
  const [result] = (await getPool().query(
    `UPDATE avatars SET multiview_json = ? WHERE id = ?`,
    [JSON.stringify(views || {}), id]
  )) as any;
  return result.affectedRows === 1;
}

/** Read persisted turnaround views for an avatar, or null if none/invalid. */
export function parseMultiview(raw: unknown): MultiviewSet | null {
  if (!raw) return null;
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (obj && typeof obj === "object") {
      const out: MultiviewSet = {};
      for (const k of ["left", "back", "right"] as const) {
        if (typeof (obj as any)[k] === "string" && (obj as any)[k]) out[k] = (obj as any)[k];
      }
      return Object.keys(out).length ? out : null;
    }
  } catch { /* ignore */ }
  return null;
}

export async function updateAvatarGenerationStatus(
  id: number,
  status: 'pending' | 'generating_mesh' | 'rigging' | 'retargeting' | 'baking_clips' | 'baking_sprites' | 'done' | 'failed',
  error?: string | null
): Promise<boolean> {
  const [result] = await getPool().query(
    `UPDATE avatars SET generation_status = ?, generation_error = ? WHERE id = ?`,
    [status, error || null, id]
  ) as any;
  return result.affectedRows === 1;
}

export async function getAvatarById(id: number, phone: string): Promise<AvatarRow | null> {
  const [rows] = await getPool().query(
    `SELECT * FROM avatars WHERE id = ? AND user_phone = ? LIMIT 1`,
    [id, phone]
  );
  const arr = rows as unknown as AvatarRow[];
  return arr.length ? arr[0] : null;
}

/**
 * The user's visible model roster. Hidden models are excluded here (and so also
 * excluded from the model-cap count) but remain in the table — see hideAvatar.
 */
export async function getAvatars(phone: string, includeHidden = false): Promise<AvatarRow[]> {
  const [rows] = await getPool().query(
    includeHidden
      ? `SELECT * FROM avatars WHERE user_phone = ? ORDER BY created_at ASC`
      : `SELECT * FROM avatars WHERE user_phone = ? AND hidden_at IS NULL ORDER BY created_at ASC`,
    [phone]
  );
  return rows as unknown as AvatarRow[];
}

/**
 * Remove a model from the user's roster without deleting anything.
 *
 * This is what the UI's "Remove" action calls. The row, the rigged GLB, the pet
 * profile and any marketplace listing all survive; the model just stops showing
 * up and stops occupying a slot. Reversible via unhideAvatar().
 */
export async function hideAvatar(id: number, phone: string): Promise<boolean> {
  const [result] = await getPool().query(
    `UPDATE avatars SET hidden_at = CURRENT_TIMESTAMP WHERE id = ? AND user_phone = ? AND hidden_at IS NULL`,
    [id, phone]
  ) as any;
  return result.affectedRows === 1;
}

/** Restore a hidden model to the roster. */
export async function unhideAvatar(id: number, phone: string): Promise<boolean> {
  const [result] = await getPool().query(
    `UPDATE avatars SET hidden_at = NULL WHERE id = ? AND user_phone = ? AND hidden_at IS NOT NULL`,
    [id, phone]
  ) as any;
  return result.affectedRows === 1;
}

/** Models the user has hidden — the "recently removed" list. */
export async function getHiddenAvatars(phone: string): Promise<AvatarRow[]> {
  const [rows] = await getPool().query(
    `SELECT * FROM avatars WHERE user_phone = ? AND hidden_at IS NOT NULL ORDER BY hidden_at DESC`,
    [phone]
  );
  return rows as unknown as AvatarRow[];
}

/**
 * Delete an avatar row (owner-scoped). Removes the DB record only — it does not
 * touch the GLB in object storage. Used to clear a model from the user's roster
 * (and to free a slot under the Phase 9 model cap, or clean up orphaned rows
 * whose storage files were already deleted).
 */
export async function deleteAvatar(id: number, phone: string): Promise<boolean> {
  const [result] = await getPool().query(
    `DELETE FROM avatars WHERE id = ? AND user_phone = ?`,
    [id, phone]
  ) as any;
  return result.affectedRows === 1;
}

export async function feedAvatar(id: number, phone: string): Promise<boolean> {
  const [result] = await getPool().query(
    `UPDATE avatars SET food_level = 100, last_fed = CURRENT_TIMESTAMP WHERE id = ? AND user_phone = ?`,
    [id, phone]
  ) as any;
  return result.affectedRows === 1;
}

export async function waterAvatar(id: number, phone: string): Promise<boolean> {
  const [result] = await getPool().query(
    `UPDATE avatars SET water_level = 100, last_watered = CURRENT_TIMESTAMP WHERE id = ? AND user_phone = ?`,
    [id, phone]
  ) as any;
  return result.affectedRows === 1;
}

/**
 * Living-avatar needs (Phase 2). Returns the stored needs snapshot, or an
 * initial one derived from legacy food/water columns if none has been saved.
 * The CLIENT applies offline decay from `lastSeen`, so this just returns raw state.
 */
export async function getAvatarNeeds(id: number, phone: string): Promise<any | null> {
  const [rows] = await getPool().query(
    `SELECT needs_json, food_level, water_level, last_seen, last_fed FROM avatars WHERE id = ? AND user_phone = ? LIMIT 1`,
    [id, phone]
  );
  const arr = rows as any[];
  if (!arr.length) return null;
  const row = arr[0];
  if (row.needs_json) {
    try {
      return typeof row.needs_json === "string" ? JSON.parse(row.needs_json) : row.needs_json;
    } catch {
      /* fall through to derived defaults */
    }
  }
  const seenSource = row.last_seen || row.last_fed || new Date();
  return {
    food: row.food_level ?? 80,
    water: row.water_level ?? 80,
    energy: 90,
    bladder: 20,
    bowel: 15,
    happiness: 85,
    lastSeen: new Date(seenSource).toISOString(),
  };
}

/** Persist a needs snapshot; keeps legacy food/water columns in sync for old UI. */
export async function saveAvatarNeeds(id: number, phone: string, needs: any): Promise<boolean> {
  const [result] = (await getPool().query(
    `UPDATE avatars SET needs_json = ?, last_seen = CURRENT_TIMESTAMP, food_level = ?, water_level = ? WHERE id = ? AND user_phone = ?`,
    [
      JSON.stringify(needs || {}),
      Math.round(needs?.food ?? 80),
      Math.round(needs?.water ?? 80),
      id,
      phone,
    ]
  )) as any;
  return result.affectedRows === 1;
}

// --- Placed objects (Phase 3) ---------------------------------------------

export interface PlacedObjectRow {
  id: string;
  kind: string;
  position: [number, number, number];
  rotationY: number;
  scale: number;
  createdAt: string;
}

export async function getPlacedObjects(avatarId: number, phone: string): Promise<PlacedObjectRow[]> {
  const [rows] = await getPool().query(
    `SELECT id, kind, pos_x, pos_y, pos_z, rot_y, scale, created_at
       FROM placed_objects WHERE avatar_id = ? AND user_phone = ? ORDER BY created_at ASC`,
    [avatarId, phone]
  );
  return (rows as any[]).map((r) => ({
    id: r.id,
    kind: r.kind,
    position: [r.pos_x, r.pos_y, r.pos_z],
    rotationY: r.rot_y,
    scale: r.scale,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function addPlacedObject(
  avatarId: number,
  phone: string,
  obj: { id: string; kind: string; position: [number, number, number]; rotationY: number; scale: number }
): Promise<boolean> {
  const [result] = (await getPool().query(
    `INSERT INTO placed_objects (id, avatar_id, user_phone, kind, pos_x, pos_y, pos_z, rot_y, scale)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      obj.id,
      avatarId,
      phone,
      obj.kind,
      obj.position[0],
      obj.position[1],
      obj.position[2],
      obj.rotationY,
      obj.scale,
    ]
  )) as any;
  return result.affectedRows === 1;
}

export async function deletePlacedObject(id: string, phone: string): Promise<boolean> {
  const [result] = (await getPool().query(
    `DELETE FROM placed_objects WHERE id = ? AND user_phone = ?`,
    [id, phone]
  )) as any;
  return result.affectedRows === 1;
}

export interface SceneActorRow {
  id: string;
  sourceAvatarId: number;
  transform: any;
  selectedClip: string | null;
  createdAt: string;
}

export async function getSceneActors(sceneAvatarId: number, phone: string): Promise<SceneActorRow[]> {
  const [rows] = await getPool().query(
    `SELECT id, source_avatar_id, transform_json, selected_clip, created_at
       FROM scene_actors WHERE scene_avatar_id = ? AND owner_phone = ? ORDER BY created_at ASC`,
    [sceneAvatarId, phone]
  );
  return (rows as any[]).map((r) => ({
    id: r.id,
    sourceAvatarId: r.source_avatar_id,
    transform: typeof r.transform_json === "string" ? JSON.parse(r.transform_json) : r.transform_json,
    selectedClip: r.selected_clip,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function addSceneActor(
  sceneAvatarId: number,
  phone: string,
  actor: { id: string; sourceAvatarId: number; transform: any; selectedClip?: string }
): Promise<boolean> {
  const [result] = (await getPool().query(
    `INSERT INTO scene_actors (id, owner_phone, scene_avatar_id, source_avatar_id, transform_json, selected_clip)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      actor.id,
      phone,
      sceneAvatarId,
      actor.sourceAvatarId,
      JSON.stringify(actor.transform),
      actor.selectedClip || null,
    ]
  )) as any;
  return result.affectedRows === 1;
}

export async function updateSceneActor(
  actorId: string,
  phone: string,
  transform: any,
  selectedClip?: string
): Promise<boolean> {
  const [result] = (await getPool().query(
    `UPDATE scene_actors SET transform_json = ?, selected_clip = ? WHERE id = ? AND owner_phone = ?`,
    [JSON.stringify(transform), selectedClip || null, actorId, phone]
  )) as any;
  return result.affectedRows === 1;
}

export async function deleteSceneActor(id: string, phone: string): Promise<boolean> {
  const [result] = (await getPool().query(
    `DELETE FROM scene_actors WHERE id = ? AND owner_phone = ?`,
    [id, phone]
  )) as any;
  return result.affectedRows === 1;
}

export async function giveTreatToAvatar(id: number, phone: string): Promise<boolean> {
  // Deduct 1 treat from user, if successful, feed the avatar by +20 (cap at 100)
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [updateUser] = await connection.query(
      `UPDATE users SET treats = treats - 1 WHERE phone = ? AND treats >= 1`,
      [phone]
    ) as any;
    
    if (updateUser.affectedRows === 0) {
      await connection.rollback();
      return false; // Not enough treats
    }
    
    await connection.query(
      `UPDATE avatars SET food_level = LEAST(food_level + 20, 100) WHERE id = ? AND user_phone = ?`,
      [id, phone]
    );
    
    await connection.commit();
    return true;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

export type AchievementClaimResult = {
  success: boolean;
  reason?: "unknown" | "ineligible" | "already_claimed";
  reward?: number;
};

/** Compatibility wrappers keep route imports stable while the reward module owns all wallet logic. */
export async function claimDailyStreak(
  phone: string,
  serverDate: string = new Date().toISOString().slice(0, 10),
): Promise<{ success: boolean; reward?: number }> {
  try {
    const result = await claimDailyStreakReward(getPool(), phone, serverDate);
    return { success: result.applied, reward: result.applied ? result.delta : undefined };
  } catch (error) {
    if (error instanceof RewardClaimError && error.code === "ALREADY_CLAIMED") return { success: false };
    throw error;
  }
}

export async function claimAchievement(phone: string, id: string): Promise<AchievementClaimResult> {
  try {
    const result = await claimAchievementReward(getPool(), phone, id);
    return result.applied
      ? { success: true, reward: result.delta }
      : { success: false, reason: "already_claimed" };
  } catch (error) {
    if (error instanceof RewardClaimError) {
      if (error.code === "UNKNOWN_ACHIEVEMENT") return { success: false, reason: "unknown" };
      if (error.code === "NOT_ELIGIBLE") return { success: false, reason: "ineligible" };
      if (error.code === "ALREADY_CLAIMED") return { success: false, reason: "already_claimed" };
    }
    throw error;
  }
}

// ============================================================================
// Photo Requests Helpers
// ============================================================================

export interface PhotoRequestRow {
  id: number;
  user_phone: string;
  request_type: 'photo_standard' | 'photo_premium' | 'video_standard' | 'video_premium';
  comment: string;
  photo_url: string | null;
  result_url: string | null;
  creation_id: number | null;
  status: 'pending' | 'fulfilled' | 'rejected';
  stripe_session_id: string | null;
  paid: number; // 0 | 1
  amount_paid: number | null;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields (admin view only)
  user_full_name?: string | null;
  user_email?: string | null;
}

export async function createPhotoRequest(data: {
  user_phone: string;
  request_type: 'photo_standard' | 'photo_premium' | 'video_standard' | 'video_premium';
  comment: string;
  photo_url?: string | null;
  stripe_session_id?: string | null;
  amount_paid?: number | null;
}): Promise<number> {
  const [result] = await getPool().query(
    `INSERT INTO photo_requests (user_phone, request_type, comment, photo_url, stripe_session_id, amount_paid, status, paid)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)`,
    [
      data.user_phone,
      data.request_type,
      data.comment,
      data.photo_url || null,
      data.stripe_session_id || null,
      data.amount_paid || null,
    ]
  ) as any;
  return result.insertId;
}

export async function getPhotoRequests(phone: string): Promise<PhotoRequestRow[]> {
  const [rows] = await getPool().query(
    `SELECT * FROM photo_requests WHERE user_phone = ? ORDER BY created_at DESC`,
    [phone]
  );
  return rows as unknown as PhotoRequestRow[];
}

export async function getAllPhotoRequests(): Promise<PhotoRequestRow[]> {
  const [rows] = await getPool().query(
    `SELECT pr.*, u.full_name as user_full_name, u.email as user_email
     FROM photo_requests pr
     LEFT JOIN users u ON u.phone = pr.user_phone
     ORDER BY pr.created_at DESC`
  );
  return rows as unknown as PhotoRequestRow[];
}

export async function getPhotoRequest(id: number): Promise<PhotoRequestRow | null> {
  const [rows] = await getPool().query(
    `SELECT pr.*, u.full_name as user_full_name, u.email as user_email
     FROM photo_requests pr
     LEFT JOIN users u ON u.phone = pr.user_phone
     WHERE pr.id = ? LIMIT 1`,
    [id]
  );
  const arr = rows as unknown as PhotoRequestRow[];
  return arr.length ? arr[0] : null;
}

export async function markPhotoRequestPaid(
  stripeSessionId: string,
  amountPaid: number
): Promise<PhotoRequestRow | null> {
  await getPool().query(
    `UPDATE photo_requests SET paid = 1, amount_paid = ? WHERE stripe_session_id = ? AND paid = 0`,
    [amountPaid, stripeSessionId]
  );
  return getPhotoRequestByStripeSession(stripeSessionId);
}

export async function fulfillPhotoRequest(
  id: number,
  creationId: number,
  resultUrl: string
): Promise<boolean> {
  const [result] = await getPool().query(
    `UPDATE photo_requests SET status = 'fulfilled', creation_id = ?, result_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [creationId, resultUrl, id]
  ) as any;
  return result.affectedRows === 1;
}

export async function rejectPhotoRequest(
  id: number,
  adminNotes?: string | null
): Promise<boolean> {
  const [result] = await getPool().query(
    `UPDATE photo_requests SET status = 'rejected', admin_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [adminNotes || null, id]
  ) as any;
  return result.affectedRows === 1;
}

export async function getPhotoRequestByStripeSession(sessionId: string): Promise<PhotoRequestRow | null> {
  const [rows] = await getPool().query(
    `SELECT * FROM photo_requests WHERE stripe_session_id = ? LIMIT 1`,
    [sessionId]
  );
  const arr = rows as unknown as PhotoRequestRow[];
  return arr.length ? arr[0] : null;
}

// --- AR virtual-pet simulator (AR_PET_SIM_SPEC §8, milestone AR2) -----------
// Pets are owned transitively: pet_profiles.avatar_id -> avatars.user_phone.
// Every accessor below takes `phone` and joins avatars so a user can only reach
// their own pets (hardening H3).

export interface PetProfileRow {
  id: number;
  avatar_id: number;
  breed: string | null;
  breed_confidence: number | null;
  size_class: string | null;
  build: any;
  temperament: any;
  personality_weights: any;
  hormones: any;
  drives: any;
  life_stage: "puppy" | "adult" | "senior";
  aging_mode: "off" | "slow" | "realistic";
  mortality_enabled: number;
  trainer_score: number;
  rigged_glb_url: string | null;
  lod_glb_url: string | null;
  created_at: string;
  updated_at: string;
}

function parseJsonMaybe(v: any): any {
  if (v == null) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v;
}

/** Return the pet profile for an avatar the user owns, or null. */
export async function getPetProfileByAvatar(
  avatarId: number,
  phone: string
): Promise<PetProfileRow | null> {
  const [rows] = await getPool().query(
    `SELECT p.* FROM pet_profiles p
       JOIN avatars a ON a.id = p.avatar_id
      WHERE p.avatar_id = ? AND a.user_phone = ? LIMIT 1`,
    [avatarId, phone]
  );
  const arr = rows as unknown as PetProfileRow[];
  if (!arr.length) return null;
  const r = arr[0];
  r.build = parseJsonMaybe(r.build);
  r.temperament = parseJsonMaybe(r.temperament);
  r.personality_weights = parseJsonMaybe(r.personality_weights);
  r.hormones = parseJsonMaybe(r.hormones);
  r.drives = parseJsonMaybe(r.drives);
  return r;
}

/** Return a pet profile by its own id, ownership-checked, or null. */
export async function getPetProfileById(
  petId: number,
  phone: string
): Promise<PetProfileRow | null> {
  const [rows] = await getPool().query(
    `SELECT p.* FROM pet_profiles p
       JOIN avatars a ON a.id = p.avatar_id
      WHERE p.id = ? AND a.user_phone = ? LIMIT 1`,
    [petId, phone]
  );
  const arr = rows as unknown as PetProfileRow[];
  if (!arr.length) return null;
  const r = arr[0];
  r.build = parseJsonMaybe(r.build);
  r.temperament = parseJsonMaybe(r.temperament);
  r.personality_weights = parseJsonMaybe(r.personality_weights);
  r.hormones = parseJsonMaybe(r.hormones);
  r.drives = parseJsonMaybe(r.drives);
  return r;
}

export interface PetProfileInput {
  breed?: string | null;
  breed_confidence?: number | null;
  size_class?: string | null;
  build?: any;
  temperament?: any;
  personality_weights?: any;
  hormones?: any;
  drives?: any;
}

/**
 * Create or update the pet profile for an avatar (one profile per avatar).
 * Ownership is enforced up-front. Returns the stored row, or null if the avatar
 * isn't owned by `phone`.
 */
export async function upsertPetProfile(
  avatarId: number,
  phone: string,
  data: PetProfileInput
): Promise<PetProfileRow | null> {
  const owned = await getAvatarById(avatarId, phone);
  if (!owned) return null;
  await getPool().query(
    `INSERT INTO pet_profiles
       (avatar_id, breed, breed_confidence, size_class, build, temperament, personality_weights, hormones, drives)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       breed = VALUES(breed),
       breed_confidence = VALUES(breed_confidence),
       size_class = VALUES(size_class),
       build = VALUES(build),
       temperament = VALUES(temperament),
       personality_weights = COALESCE(VALUES(personality_weights), personality_weights),
       hormones = COALESCE(VALUES(hormones), hormones),
       drives = COALESCE(VALUES(drives), drives)`,
    [
      avatarId,
      data.breed ?? null,
      data.breed_confidence ?? null,
      data.size_class ?? null,
      data.build != null ? JSON.stringify(data.build) : null,
      data.temperament != null ? JSON.stringify(data.temperament) : null,
      data.personality_weights != null ? JSON.stringify(data.personality_weights) : null,
      data.hormones != null ? JSON.stringify(data.hormones) : null,
      data.drives != null ? JSON.stringify(data.drives) : null,
    ]
  );
  return getPetProfileByAvatar(avatarId, phone);
}

// --- AR8: progression + settings (§4.6–4.7 / §7.4) -------------------------

/** Add to a pet's trainer score; returns the new score, or null if not owned. */
export async function incrementTrainerScore(
  petId: number,
  phone: string,
  points: number
): Promise<number | null> {
  const [result] = (await getPool().query(
    `UPDATE pet_profiles p JOIN avatars a ON a.id = p.avatar_id
        SET p.trainer_score = p.trainer_score + ?
      WHERE p.id = ? AND a.user_phone = ?`,
    [Math.max(0, Math.round(points)), petId, phone]
  )) as any;
  if (result.affectedRows < 1) return null;
  const prof = await getPetProfileById(petId, phone);
  return prof ? prof.trainer_score : null;
}

/** Update aging/mortality settings (ownership-checked). */
export async function updatePetSettings(
  petId: number,
  phone: string,
  settings: { aging_mode?: string; mortality_enabled?: boolean; life_stage?: string }
): Promise<boolean> {
  const [result] = (await getPool().query(
    `UPDATE pet_profiles p JOIN avatars a ON a.id = p.avatar_id
        SET p.aging_mode = COALESCE(?, p.aging_mode),
            p.mortality_enabled = COALESCE(?, p.mortality_enabled),
            p.life_stage = COALESCE(?, p.life_stage)
      WHERE p.id = ? AND a.user_phone = ?`,
    [
      settings.aging_mode ?? null,
      settings.mortality_enabled == null ? null : settings.mortality_enabled ? 1 : 0,
      settings.life_stage ?? null,
      petId,
      phone,
    ]
  )) as any;
  return result.affectedRows >= 1;
}

// --- AR7: voice commands + spatial buttons (§7.2–7.3) ----------------------

/** List a pet's learned voice commands (ownership-checked). */
export async function getPetCommands(petId: number, phone: string): Promise<any[]> {
  const [rows] = await getPool().query(
    `SELECT c.* FROM pet_commands c
       JOIN pet_profiles p ON p.id = c.pet_id
       JOIN avatars a ON a.id = p.avatar_id
      WHERE c.pet_id = ? AND a.user_phone = ? ORDER BY c.created_at ASC`,
    [petId, phone]
  );
  return (rows as any[]).map((r) => ({
    ...r,
    metaphone_keys: typeof r.metaphone_keys === "string" ? JSON.parse(r.metaphone_keys) : r.metaphone_keys,
  }));
}

/** Add a learned command. Caller must have verified ownership of `petId`. */
export async function addPetCommand(
  petId: number,
  data: { phrase: string; metaphone_keys: string[]; action: string; compliance?: number }
): Promise<number> {
  const [result] = (await getPool().query(
    `INSERT INTO pet_commands (pet_id, phrase, metaphone_keys, action, compliance, last_reinforced)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [petId, data.phrase, JSON.stringify(data.metaphone_keys || []), data.action, data.compliance ?? 0.5]
  )) as any;
  return result.insertId;
}

/** Update a command's compliance + last_reinforced (reinforcement / forgetting sync). */
export async function setCommandCompliance(
  commandId: number,
  compliance: number
): Promise<void> {
  await getPool().query(
    `UPDATE pet_commands SET compliance = ?, last_reinforced = CURRENT_TIMESTAMP WHERE id = ?`,
    [compliance, commandId]
  );
}

/** List a pet's spatial buttons (ownership-checked). */
export async function getPetButtons(petId: number, phone: string): Promise<any[]> {
  const [rows] = await getPool().query(
    `SELECT b.* FROM pet_buttons b
       JOIN pet_profiles p ON p.id = b.pet_id
       JOIN avatars a ON a.id = p.avatar_id
      WHERE b.pet_id = ? AND a.user_phone = ? ORDER BY b.created_at ASC`,
    [petId, phone]
  );
  return (rows as any[]).map((r) => ({
    ...r,
    anchor: typeof r.anchor === "string" ? JSON.parse(r.anchor) : r.anchor,
  }));
}

/** Add a spatial button. Caller must have verified ownership of `petId`. */
export async function addPetButton(
  petId: number,
  data: { label: string; audio_url: string; linked_action?: string | null; anchor: any }
): Promise<number> {
  const [result] = (await getPool().query(
    `INSERT INTO pet_buttons (pet_id, label, audio_url, linked_action, anchor)
     VALUES (?, ?, ?, ?, ?)`,
    [petId, data.label, data.audio_url, data.linked_action ?? null, JSON.stringify(data.anchor || {})]
  )) as any;
  return result.insertId;
}

/** Cached semantic scan for an anchor (AR6, §6.4). Returns zones JSON or null. */
export async function getSemanticScan(
  userPhone: string,
  anchorHash: string
): Promise<any | null> {
  const [rows] = await getPool().query(
    `SELECT zones FROM semantic_scans WHERE user_phone = ? AND anchor_hash = ?
      ORDER BY created_at DESC LIMIT 1`,
    [userPhone, anchorHash]
  );
  const arr = rows as any[];
  if (!arr.length) return null;
  const z = arr[0].zones;
  return typeof z === "string" ? JSON.parse(z) : z;
}

/** Persist a semantic scan for an anchor (AR6). */
export async function saveSemanticScan(
  userPhone: string,
  anchorHash: string,
  zones: any
): Promise<void> {
  await getPool().query(
    `INSERT INTO semantic_scans (user_phone, anchor_hash, zones) VALUES (?, ?, ?)`,
    [userPhone, anchorHash, JSON.stringify(zones ?? {})]
  );
}

/** Persist rigged + LOD GLB URLs on a pet. Ownership-checked. (AR3) */
export async function savePetRigUrls(
  petId: number,
  phone: string,
  urls: { rigged_glb_url?: string | null; lod_glb_url?: string | null }
): Promise<boolean> {
  const [result] = (await getPool().query(
    `UPDATE pet_profiles p
       JOIN avatars a ON a.id = p.avatar_id
        SET p.rigged_glb_url = COALESCE(?, p.rigged_glb_url),
            p.lod_glb_url = COALESCE(?, p.lod_glb_url)
      WHERE p.id = ? AND a.user_phone = ?`,
    [urls.rigged_glb_url ?? null, urls.lod_glb_url ?? null, petId, phone]
  )) as any;
  return result.affectedRows >= 1;
}

/** Persist drives/hormones/weights + trainer score for a pet. Ownership-checked. */
export async function savePetState(
  petId: number,
  phone: string,
  state: {
    drives?: any;
    hormones?: any;
    personality_weights?: any;
    trainer_score?: number;
  }
): Promise<boolean> {
  const [result] = (await getPool().query(
    `UPDATE pet_profiles p
       JOIN avatars a ON a.id = p.avatar_id
        SET p.drives = COALESCE(?, p.drives),
            p.hormones = COALESCE(?, p.hormones),
            p.personality_weights = COALESCE(?, p.personality_weights),
            p.trainer_score = COALESCE(?, p.trainer_score)
      WHERE p.id = ? AND a.user_phone = ?`,
    [
      state.drives != null ? JSON.stringify(state.drives) : null,
      state.hormones != null ? JSON.stringify(state.hormones) : null,
      state.personality_weights != null ? JSON.stringify(state.personality_weights) : null,
      state.trainer_score ?? null,
      petId,
      phone,
    ]
  )) as any;
  return result.affectedRows >= 1;
}

// ============================================================================
// Phase 8: Storage accounting
// ============================================================================

const FREE_HOT_BYTES = 50 * 1024 * 1024;
const COLD_GB_COST_CR = CREDIT_PRICES.STORAGE_GB_MONTH;

export interface StorageUsage {
  bytesHot: number;
  bytesCold: number;
  freeLimit: number;
  coldGbPurchased: number;
  coldLimit: number;
}

/** Get the user's current storage usage, creating a row if none exists. */
export async function getStorageUsage(phone: string): Promise<StorageUsage> {
  await getPool().query(
    `INSERT IGNORE INTO user_storage (user_phone, bytes_hot, bytes_cold, cold_gb_purchased) VALUES (?, 0, 0, 0)`,
    [phone]
  );
  const [rows] = await getPool().query(
    `SELECT bytes_hot, bytes_cold, cold_gb_purchased FROM user_storage WHERE user_phone = ?`,
    [phone]
  ) as any;
  const row = rows?.[0] || { bytes_hot: 0, bytes_cold: 0, cold_gb_purchased: 0 };
  return {
    bytesHot: Number(row.bytes_hot) || 0,
    bytesCold: Number(row.bytes_cold) || 0,
    freeLimit: FREE_HOT_BYTES,
    coldGbPurchased: Number(row.cold_gb_purchased) || 0,
    coldLimit: (Number(row.cold_gb_purchased) || 0) * (1024 * 1024 * 1024),
  };
}

/** Record that N bytes were added to hot storage. Returns the updated usage. */
export async function recordStorageAddHot(phone: string, bytes: number): Promise<StorageUsage> {
  await getPool().query(
    `INSERT INTO user_storage (user_phone, bytes_hot) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE bytes_hot = bytes_hot + ?`,
    [phone, bytes, bytes]
  );
  return getStorageUsage(phone);
}

/** Record that N bytes were freed from hot storage. */
export async function recordStorageRemoveHot(phone: string, bytes: number): Promise<void> {
  await getPool().query(
    `UPDATE user_storage SET bytes_hot = GREATEST(0, bytes_hot - ?) WHERE user_phone = ?`,
    [bytes, phone]
  );
}

/** Move bytes from hot to cold tier. */
export async function recordStorageMoveToCold(phone: string, bytes: number): Promise<void> {
  await getPool().query(
    `UPDATE user_storage SET bytes_hot = GREATEST(0, bytes_hot - ?), bytes_cold = bytes_cold + ? WHERE user_phone = ?`,
    [bytes, bytes, phone]
  );
}

/** Deduct 4 credits and grant 1 GB of cold storage. Idempotent per requestId. */
export async function purchaseColdStorage(phone: string, requestId: string): Promise<{ success: boolean; error?: string }> {
  const [existing] = await getPool().query(
    `SELECT 1 FROM credit_transactions WHERE reason = ? LIMIT 1`,
    [`storage_purchase:${requestId}`]
  ) as any;
  if (Array.isArray(existing) && existing.length > 0) {
    return { success: true };
  }
  const ok = await deductCredits(phone, COLD_GB_COST_CR, `storage_purchase:${requestId}`);
  if (!ok) {
    return { success: false, error: `Insufficient PupCoins. You need ${COLD_GB_COST_CR} PupCoins for 1 GB of cold storage.` };
  }
  await getPool().query(
    `INSERT INTO user_storage (user_phone, cold_gb_purchased) VALUES (?, 1)
     ON DUPLICATE KEY UPDATE cold_gb_purchased = cold_gb_purchased + 1`,
    [phone]
  );
  return { success: true };
}

// ============================================================================
// Phase 9: Voice clone assets
// ============================================================================

export interface VoiceCloneAsset {
  id: number;
  user_phone: string;
  name: string;
  audio_url: string;
  mime_type: string;
  bytes: number;
  voice_consent: number;
  voice_consent_at: string | null;
  created_at: string;
}

export async function createVoiceCloneAsset(
  phone: string,
  input: { name: string; audioUrl: string; mimeType: string; bytes: number; voiceConsent: true }
): Promise<VoiceCloneAsset> {
  const [result] = await getPool().query(
    `INSERT INTO voice_clone_assets
       (user_phone, name, audio_url, mime_type, bytes, voice_consent, voice_consent_at)
     VALUES (?, ?, ?, ?, ?, 1, NOW())`,
    [phone, input.name.slice(0, 120), input.audioUrl, input.mimeType.slice(0, 80), Math.max(0, input.bytes)]
  ) as any;
  const [rows] = await getPool().query(
    `SELECT * FROM voice_clone_assets WHERE id = ? AND user_phone = ? LIMIT 1`,
    [result.insertId, phone]
  ) as any;
  return rows[0] as VoiceCloneAsset;
}

export async function listVoiceCloneAssets(phone: string): Promise<VoiceCloneAsset[]> {
  const [rows] = await getPool().query(
    `SELECT * FROM voice_clone_assets WHERE user_phone = ? ORDER BY id DESC`,
    [phone]
  ) as any;
  return rows as VoiceCloneAsset[];
}

// ============================================================================
// Phase 8: Profile
// ============================================================================

export async function updateUserProfile(phone: string, fields: {
  fullName?: string;
  bio?: string | null;
  city?: string;
  zip?: string;
  notificationPrefs?: any;
}): Promise<void> {
  const parts: string[] = [];
  const values: any[] = [];
  if (fields.fullName !== undefined) { parts.push("full_name = ?"); values.push(fields.fullName); }
  if (fields.bio !== undefined) { parts.push("bio = ?"); values.push(fields.bio); }
  if (fields.city !== undefined) { parts.push("city = ?"); values.push(fields.city); }
  if (fields.zip !== undefined) { parts.push("zip = ?"); values.push(fields.zip); }
  if (fields.notificationPrefs !== undefined) { parts.push("notification_prefs = ?"); values.push(JSON.stringify(fields.notificationPrefs)); }
  if (parts.length === 0) return;
  values.push(phone);
  await getPool().query(`UPDATE users SET ${parts.join(", ")} WHERE phone = ?`, values);
}

/** Legacy compatibility hook. Signup/profile completion never grants wallet value. */
export async function checkAndGrantProfileBonus(phone: string): Promise<{ granted: boolean }> {
  return { granted: false };
}

export async function verifyUserEmail(phone: string): Promise<void> {
  await getPool().query(`UPDATE users SET email_verified = 1 WHERE phone = ?`, [phone]);
}

export async function verifyUserPhone(phone: string): Promise<void> {
  await getPool().query(`UPDATE users SET phone_verified = 1 WHERE phone = ?`, [phone]);
}

// ============================================================================
// Phase 8: Referral
// ============================================================================

import { createHash, randomBytes, randomUUID } from "crypto";

export async function generateReferralCode(phone: string): Promise<string> {
  const [rows] = await getPool().query(`SELECT referral_code FROM users WHERE phone = ?`, [phone]) as any;
  if (rows?.[0]?.referral_code) return rows[0].referral_code;
  let code: string;
  let isUnique = false;
  do {
    code = randomBytes(4).toString("hex").slice(0, 8);
    const [existing] = await getPool().query(`SELECT 1 FROM users WHERE referral_code = ?`, [code]) as any;
    isUnique = !(Array.isArray(existing) && existing.length > 0);
  } while (!isUnique);
  await getPool().query(`UPDATE users SET referral_code = ? WHERE phone = ?`, [code, phone]);
  return code;
}

export async function recordReferral(referrerCode: string, referredPhone: string): Promise<void> {
  const [refs] = await getPool().query(`SELECT phone FROM users WHERE referral_code = ?`, [referrerCode]) as any;
  if (!refs?.[0]) return;
  const referrerPhone = refs[0].phone;
  if (referrerPhone === referredPhone) return;
  try {
    await getPool().query(
      `INSERT INTO referrals (referrer_phone, referred_phone, code) VALUES (?, ?, ?)`,
      [referrerPhone, referredPhone, referrerCode]
    );
  } catch { /* duplicate */ }
}

export async function creditReferralIfComplete(referredPhone: string): Promise<void> {
  const [rows] = await getPool().query(
    `SELECT r.id, r.referrer_phone
       FROM referrals r JOIN users u ON u.phone = r.referred_phone
      WHERE r.referred_phone = ? AND u.profile_complete = 1
      LIMIT 1`,
    [referredPhone],
  ) as any;
  const ref = rows?.[0];
  if (!ref) return;
  await applyWalletClaimOnce(getPool(), {
    ownerId: String(ref.referrer_phone),
    correlationId: `referral-bonus:${Number(ref.id)}`,
    expected: { delta: 30, reason: "referral_bonus" },
    resolve: async ({ connection }) => {
      const [lockedRows] = await connection.query(
        `SELECT credited_at FROM referrals WHERE id=? AND referred_phone=? LIMIT 1 FOR UPDATE`,
        [Number(ref.id), referredPhone],
      ) as any;
      if (!Array.isArray(lockedRows) || lockedRows.length !== 1) throw new Error("Referral evidence was not found.");
      return {
        delta: 30,
        reason: "referral_bonus",
        mutate: async (domainConnection) => {
          const [updated] = await domainConnection.query(
            `UPDATE referrals SET credited_at=COALESCE(credited_at, NOW()) WHERE id=?`,
            [Number(ref.id)],
          ) as any;
          if (updated?.affectedRows !== 1) throw new Error("Referral evidence update failed.");
        },
      };
    },
  });
}

// ============================================================================
// Phase 8: Pawprint templates
// ============================================================================

export interface PawprintTemplate {
  category: string; layoutId: string; name: string; tone: string;
  sampleCopy: string[];
  fieldSchema: { key: string; type: "text" | "image" | "name" | "message"; label: string; maxLength?: number }[];
  imagePromptTemplate: string;
  sourceUrl?: string;
  sourceLicense?: "CC0-1.0" | "owned-generated";
  sourceName?: string;
}

const PAWPRINT_CATEGORIES = [
  "grieving_loss", "new_puppy", "veterinarian", "holiday_birthday",
  "environment", "postcard_travel", "get_well", "miss_you", "pet_business",
];

const CURATED_PAWPRINT_TEMPLATES: PawprintTemplate[] = [
  { category: "grieving_loss", layoutId: "portrait_card", name: "Portrait Card", tone: "gentle", sampleCopy: ["Forever in our hearts.", "Until we meet again at the Rainbow Bridge."], fieldSchema: [{ key: "petPhoto", type: "image", label: "Pet Photo" }, { key: "petName", type: "name", label: "Pet Name" }], imagePromptTemplate: "A soft watercolor-style memorial portrait of a pet, gentle warm lighting" },
  { category: "grieving_loss", layoutId: "landscape_postcard", name: "Landscape Postcard", tone: "gentle", sampleCopy: ["You left pawprints on our hearts.", "Run free, sweet friend."], fieldSchema: [{ key: "petPhoto", type: "image", label: "Pet Photo" }, { key: "message", type: "message", label: "Your Message", maxLength: 200 }], imagePromptTemplate: "A peaceful meadow scene with a rainbow, soft golden hour" },
  { category: "grieving_loss", layoutId: "photo_top", name: "Photo Top", tone: "warm", sampleCopy: ["Remembering the good times.", "A life well loved."], fieldSchema: [{ key: "petPhoto", type: "image", label: "Pet Photo" }, { key: "petName", type: "name", label: "Pet Name" }], imagePromptTemplate: "A warm-toned photo frame with a sleeping pet, surrounded by soft flowers" },
  { category: "grieving_loss", layoutId: "framed_quote", name: "Framed Quote", tone: "gentle", sampleCopy: ["\"Dogs' lives are too short. Their only fault, really.\" — Agnes Sligh Turnbull", "Gone but never forgotten."], fieldSchema: [{ key: "petName", type: "name", label: "Pet Name" }, { key: "message", type: "message", label: "Your Quote", maxLength: 300 }], imagePromptTemplate: "An elegant framed calligraphy quote with subtle pawprint watermark" },
  { category: "new_puppy", layoutId: "portrait_card", name: "Portrait Card", tone: "excited", sampleCopy: ["Welcome home, little one!", "Our newest family member."], fieldSchema: [{ key: "petPhoto", type: "image", label: "Puppy Photo" }, { key: "petName", type: "name", label: "Puppy Name" }], imagePromptTemplate: "A cute puppy portrait with bright playful colors, confetti" },
  { category: "new_puppy", layoutId: "landscape_postcard", name: "Landscape Postcard", tone: "excited", sampleCopy: ["Pawsitively thrilled to meet you!", "A new chapter begins."], fieldSchema: [{ key: "petPhoto", type: "image", label: "Puppy Photo" }, { key: "message", type: "message", label: "Your Message", maxLength: 200 }], imagePromptTemplate: "A puppy playing in a sunny garden, vibrant colors" },
  { category: "new_puppy", layoutId: "photo_top", name: "Photo Top", tone: "playful", sampleCopy: ["Life just got cuter!", "New best friend alert!"], fieldSchema: [{ key: "petPhoto", type: "image", label: "Puppy Photo" }], imagePromptTemplate: "A puppy with a big smile, surrounded by toys and treats" },
  { category: "new_puppy", layoutId: "framed_quote", name: "Framed Quote", tone: "warm", sampleCopy: ["\"A puppy is the only thing that loves you more than you love yourself.\"", "Small paws, big love."], fieldSchema: [{ key: "petName", type: "name", label: "Puppy Name" }, { key: "message", type: "message", label: "Your Message", maxLength: 200 }], imagePromptTemplate: "A decorative border with puppy pawprints and hearts, warm pastel background" },
  { category: "veterinarian", layoutId: "portrait_card", name: "Portrait Card", tone: "grateful", sampleCopy: ["Thanks for taking such good care of our fur baby!", "You're pawsome!"], fieldSchema: [{ key: "petPhoto", type: "image", label: "Pet Photo" }, { key: "petName", type: "name", label: "Pet Name" }], imagePromptTemplate: "A professional warm-toned thank you card with a pet portrait" },
  { category: "veterinarian", layoutId: "landscape_postcard", name: "Landscape Postcard", tone: "grateful", sampleCopy: ["Our furry friend says thank you!", "Grateful for your care."], fieldSchema: [{ key: "message", type: "message", label: "Your Message", maxLength: 300 }], imagePromptTemplate: "A cozy vet clinic with a happy pet on an exam table" },
  { category: "veterinarian", layoutId: "photo_top", name: "Photo Top", tone: "cheerful", sampleCopy: ["Healthy and happy, thanks to you!", "Best vet ever!"], fieldSchema: [{ key: "petPhoto", type: "image", label: "Pet Photo" }], imagePromptTemplate: "A cheerful pet at the vet, bright clinic lighting" },
  { category: "veterinarian", layoutId: "framed_quote", name: "Framed Quote", tone: "warm", sampleCopy: ["\"The vet is the true hero of every pet's story.\"", "Thank you for your gentle hands."], fieldSchema: [{ key: "petName", type: "name", label: "Pet Name" }, { key: "message", type: "message", label: "Your Message", maxLength: 200 }], imagePromptTemplate: "A stethoscope heart shape with pawprints, clean medical aesthetic" },
  { category: "holiday_birthday", layoutId: "portrait_card", name: "Portrait Card", tone: "festive", sampleCopy: ["Happy Birthday, fur baby!", "Wishing you a tail-wagging celebration!"], fieldSchema: [{ key: "petPhoto", type: "image", label: "Pet Photo" }, { key: "petName", type: "name", label: "Pet Name" }], imagePromptTemplate: "A birthday celebration scene with party hats and balloons" },
  { category: "holiday_birthday", layoutId: "landscape_postcard", name: "Landscape Postcard", tone: "festive", sampleCopy: ["Merry Christmas from our pack to yours!", "Happy Howl-oween!"], fieldSchema: [{ key: "petPhoto", type: "image", label: "Pet Photo" }, { key: "message", type: "message", label: "Your Holiday Message", maxLength: 200 }], imagePromptTemplate: "Seasonal holiday background with pets and decorations" },
  { category: "environment", layoutId: "portrait_card", name: "Portrait Card", tone: "eco_conscious", sampleCopy: ["Love nature, love pets.", "Green paws for a greener planet."], fieldSchema: [{ key: "petPhoto", type: "image", label: "Pet Photo" }], imagePromptTemplate: "A pet in a lush natural setting, eco-friendly aesthetic" },
  { category: "postcard_travel", layoutId: "landscape_postcard", name: "Landscape Postcard", tone: "adventurous", sampleCopy: ["Wish you were here!", "Paws on the go!"], fieldSchema: [{ key: "petPhoto", type: "image", label: "Pet Photo" }, { key: "petName", type: "name", label: "Pet Name" }, { key: "message", type: "message", label: "Travel Message", maxLength: 200 }], imagePromptTemplate: "A scenic travel destination with a happy pet exploring" },
  { category: "get_well", layoutId: "portrait_card", name: "Portrait Card", tone: "caring", sampleCopy: ["Get well soon, sweet one!", "Sending healing vibes!"], fieldSchema: [{ key: "petPhoto", type: "image", label: "Pet Photo" }, { key: "petName", type: "name", label: "Pet Name" }], imagePromptTemplate: "A comforting scene with soft blankets and gentle healing light" },
  { category: "miss_you", layoutId: "portrait_card", name: "Portrait Card", tone: "nostalgic", sampleCopy: ["Missing you from my paws to my heart.", "Wish you were here!"], fieldSchema: [{ key: "petPhoto", type: "image", label: "Pet Photo" }, { key: "message", type: "message", label: "Your Message", maxLength: 200 }], imagePromptTemplate: "A nostalgic sunset with a silhouette of a pet looking into the distance" },
  { category: "pet_business", layoutId: "portrait_card", name: "Portrait Card", tone: "professional", sampleCopy: ["Trust us with your fur babies!", "Pawsitively the best care in town."], fieldSchema: [{ key: "petPhoto", type: "image", label: "Business Logo" }, { key: "message", type: "message", label: "Business Message", maxLength: 300 }], imagePromptTemplate: "Professional pet business branding, clean modern aesthetic" },
  { category: "pet_business", layoutId: "landscape_postcard", name: "Landscape Postcard", tone: "friendly", sampleCopy: ["Your pet's home away from home.", "Pet-sitting with love."], fieldSchema: [{ key: "petPhoto", type: "image", label: "Business Photo" }, { key: "message", type: "message", label: "Offer Details", maxLength: 300 }], imagePromptTemplate: "A welcoming pet care facility with happy animals" },
];

const CC0_CARD_SOURCE = {
  sourceUrl: "https://www.svgrepo.com/svg/23989/greeting-card",
  sourceLicense: "CC0-1.0" as const,
  sourceName: "SVG Repo CC0 Greeting Card",
};

const CATEGORY_COPY: Record<string, { tone: string; subject: string; samples: [string, string] }> = {
  grieving_loss: { tone: "gentle", subject: "a peaceful pet memorial with soft botanicals and a subtle pawprint", samples: ["Always loved, never forgotten.", "Your pawprints remain with us."] },
  new_puppy: { tone: "playful", subject: "a cheerful new-puppy announcement with toys and confetti", samples: ["Our family just grew by four paws!", "Welcome home, little friend!"] },
  veterinarian: { tone: "grateful", subject: "a warm veterinary thank-you design with a heart-shaped stethoscope", samples: ["Thank you for caring with kindness.", "Our whole pack appreciates you!"] },
  holiday_birthday: { tone: "festive", subject: "a pet celebration card with balloons, bunting, and seasonal accents", samples: ["Time to celebrate with extra treats!", "Have a pawsitively wonderful day!"] },
  environment: { tone: "hopeful", subject: "an eco-conscious pet card with leaves, clean water, and a green landscape", samples: ["Small paws can make a greener world.", "Love pets. Protect their planet."] },
  postcard_travel: { tone: "adventurous", subject: "a vintage travel postcard with room for a pet portrait and destination title", samples: ["Adventure looks better with muddy paws.", "Greetings from our latest walk!"] },
  get_well: { tone: "caring", subject: "a comforting get-well card with blankets, flowers, and gentle daylight", samples: ["Sending soft cuddles and healing wishes.", "Rest, recover, and feel better soon."] },
  miss_you: { tone: "nostalgic", subject: "a warm miss-you card with a sunset, envelope, and subtle pawprints", samples: ["Every room misses your happy paws.", "Counting the naps until you are home."] },
  pet_business: { tone: "professional", subject: "a clean pet-business promotion with modern shapes and a photo area", samples: ["Trusted care for every tail and whisker.", "Friendly service for your best friend."] },
};

const STANDARD_LAYOUTS = [
  { id: "portrait_card", name: "Portrait Card", prompt: "vertical portrait layout" },
  { id: "landscape_postcard", name: "Landscape Postcard", prompt: "wide postcard layout" },
  { id: "photo_top", name: "Photo Top", prompt: "large photo area above a message panel" },
  { id: "framed_quote", name: "Framed Quote", prompt: "decorative framed quotation layout" },
] as const;

const generatedTemplates: PawprintTemplate[] = PAWPRINT_CATEGORIES.flatMap((category) => {
  const copy = CATEGORY_COPY[category];
  return STANDARD_LAYOUTS.map((layout) => ({
    category,
    layoutId: layout.id,
    name: layout.name,
    tone: copy.tone,
    sampleCopy: [...copy.samples],
    fieldSchema: layout.id === "framed_quote"
      ? [{ key: "petName", type: "name" as const, label: "Pet Name" }, { key: "message", type: "message" as const, label: "Your Message", maxLength: 260 }]
      : [{ key: "petPhoto", type: "image" as const, label: "Pet Photo" }, { key: "petName", type: "name" as const, label: "Pet Name" }, { key: "message", type: "message" as const, label: "Your Message", maxLength: 220 }],
    imagePromptTemplate: `${copy.subject}, ${layout.prompt}, original editable stationery composition`,
    ...CC0_CARD_SOURCE,
  }));
});

const curatedKeys = new Set(CURATED_PAWPRINT_TEMPLATES.map((template) => `${template.category}:${template.layoutId}`));
const PAWPRINT_TEMPLATES: PawprintTemplate[] = [
  ...HISTORIC_DIGITAL_TEMPLATES,
  ...CURATED_PAWPRINT_TEMPLATES.map((template) => ({ ...CC0_CARD_SOURCE, ...template })),
  ...generatedTemplates.filter((template) => !curatedKeys.has(`${template.category}:${template.layoutId}`)),
];

export function getPawprintCategories(): string[] { return [...PAWPRINT_CATEGORIES, "historic_portraits"]; }

export function getPawprintTemplatesSync(category?: string): PawprintTemplate[] {
  if (category) return PAWPRINT_TEMPLATES.filter(t => t.category === category);
  return PAWPRINT_TEMPLATES;
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/** Store a reset-token hash, invalidating any prior unused tokens for the user. */
export async function createPasswordReset(userPhone: string, tokenHash: string, expiresAt: Date): Promise<void> {
  await getPool().query(
    "UPDATE password_resets SET used_at = NOW() WHERE user_phone = ? AND used_at IS NULL",
    [userPhone]
  );
  await getPool().query(
    "INSERT INTO password_resets (user_phone, token_hash, expires_at) VALUES (?, ?, ?)",
    [userPhone, tokenHash, expiresAt]
  );
}

/**
 * Validate a reset-token hash. If a matching unused, unexpired row exists, mark
 * it used and return the associated user key; otherwise return null.
 */
export async function consumePasswordReset(tokenHash: string): Promise<string | null> {
  const [rows] = await getPool().query(
    "SELECT id, user_phone FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() ORDER BY id DESC LIMIT 1",
    [tokenHash]
  ) as any;
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  await getPool().query("UPDATE password_resets SET used_at = NOW() WHERE id = ?", [row.id]);
  return row.user_phone as string;
}

/** Set a user's password hash by their internal key (users.phone). */
export async function setUserPassword(userPhone: string, passwordHash: string): Promise<void> {
  await getPool().query("UPDATE users SET password_hash = ? WHERE phone = ?", [passwordHash, userPhone]);
}

/** Atomically consume one reset token and replace the associated password. */
export async function resetPasswordWithToken(
  tokenHash: string,
  passwordHash: string,
  pool: Pick<mysql.Pool, "getConnection"> = getPool(),
): Promise<boolean> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT id, user_phone
         FROM password_resets
        WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()
        ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [tokenHash],
    ) as any;
    if (!rows?.length) {
      await connection.rollback();
      return false;
    }
    const row = rows[0];
    const [consume] = await connection.query(
      "UPDATE password_resets SET used_at = NOW() WHERE id = ? AND used_at IS NULL AND expires_at > NOW()",
      [row.id],
    ) as any;
    if (consume.affectedRows !== 1) {
      await connection.rollback();
      return false;
    }
    const [updated] = await connection.query(
      "UPDATE users SET password_hash = ? WHERE phone = ?",
      [passwordHash, row.user_phone],
    ) as any;
    if (updated.affectedRows !== 1) throw new Error("Password reset user no longer exists");
    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// ---------------------------------------------------------------------------
// Model spatial metadata CRUD (Phase 1 BIM)
// ---------------------------------------------------------------------------

export interface ModelSpatialMetadataRow {
  id: number;
  user_phone: string;
  asset_kind: string;
  asset_id: string;
  source_unit: string;
  meters_per_unit: number;
  canonical_unit: string;
  up_axis: string;
  forward_axis: string;
  handedness: string;
  source_bounds_min: string;
  source_bounds_max: string;
  canonical_bounds_min: string;
  canonical_bounds_max: string;
  local_origin: string | null;
  datum_description: string | null;
  source_crs: string | null;
  vertical_datum: string | null;
  calibration_method: string;
  accuracy_class: string;
  tolerance_m: number | null;
  source_hash: string;
  source_filename: string | null;
  source_uri: string | null;
  parent_derivative_id: string | null;
  derivative_id: string | null;
  calibration_confidence: number;
  physical_scale: number;
  display_scale: number;
  import_tool: string | null;
  converter_version: string | null;
  created_at: string;
  updated_at: string | null;
}

export async function upsertSpatialMetadata(
  userPhone: string,
  assetKind: "model" | "avatar" | "ifc" | "derivative",
  assetId: string,
  data: ModelSpatialMetadata
): Promise<void> {
  await getPool().query(
    `INSERT INTO model_spatial_metadata
     (user_phone, asset_kind, asset_id, source_unit, meters_per_unit, canonical_unit,
      up_axis, forward_axis, handedness,
      source_bounds_min, source_bounds_max,
      canonical_bounds_min, canonical_bounds_max,
      local_origin, datum_description, source_crs, vertical_datum,
      calibration_method, calibration_confidence, accuracy_class, tolerance_m,
      source_hash, source_filename, source_uri, parent_derivative_id, derivative_id,
      physical_scale, display_scale, import_tool, converter_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      source_unit = VALUES(source_unit),
      meters_per_unit = VALUES(meters_per_unit),
      calibration_method = VALUES(calibration_method),
      calibration_confidence = VALUES(calibration_confidence),
      accuracy_class = VALUES(accuracy_class),
      tolerance_m = VALUES(tolerance_m),
      source_hash = VALUES(source_hash),
      physical_scale = VALUES(physical_scale),
      display_scale = VALUES(display_scale)`,
    [
      userPhone,
      assetKind,
      assetId,
      data.sourceUnit,
      data.metersPerSourceUnit,
      data.canonicalUnit,
      data.upAxis,
      data.forwardAxis,
      data.handedness,
      JSON.stringify(data.sourceBoundsMin),
      JSON.stringify(data.sourceBoundsMax),
      JSON.stringify(data.canonicalBoundsMin),
      JSON.stringify(data.canonicalBoundsMax),
      data.localOrigin ? JSON.stringify(data.localOrigin) : null,
      data.datumDescription || null,
      data.sourceCRS || null,
      data.verticalDatum || null,
      data.calibrationMethod,
      data.calibrationConfidence,
      data.accuracyClass,
      data.tolerance ?? null,
      data.sourceHash,
      data.sourceFilename || null,
      data.sourceUri || null,
      data.parentDerivativeId || null,
      data.derivativeId || null,
      data.physicalScale,
      data.displayScale,
      data.importTool || null,
      data.converterVersion || null,
    ]
  );
}

export async function getSpatialMetadata(
  userPhone: string,
  assetKind: "model" | "avatar" | "ifc" | "derivative",
  assetId: string
): Promise<ModelSpatialMetadataRow | null> {
  const [rows] = await getPool().query(
    "SELECT * FROM model_spatial_metadata WHERE user_phone = ? AND asset_kind = ? AND asset_id = ? LIMIT 1",
    [userPhone, assetKind, assetId]
  ) as any;
  if (!rows || rows.length === 0) return null;
  return rows[0] as ModelSpatialMetadataRow;
}

export async function getSpatialMetadataByHash(
  userPhone: string,
  sourceHash: string
): Promise<ModelSpatialMetadataRow | null> {
  const [rows] = await getPool().query(
    "SELECT * FROM model_spatial_metadata WHERE user_phone = ? AND source_hash = ? ORDER BY created_at DESC LIMIT 1",
    [userPhone, sourceHash]
  ) as any;
  if (!rows || rows.length === 0) return null;
  return rows[0] as ModelSpatialMetadataRow;
}

export async function deleteSpatialMetadata(userPhone: string, assetKind: string, assetId: string): Promise<void> {
  await getPool().query("DELETE FROM model_spatial_metadata WHERE user_phone = ? AND asset_kind = ? AND asset_id = ?", [userPhone, assetKind, assetId]);
}

// ---------------------------------------------------------------------------
// Verified BIM builds (Scaled Building Lab "My models" re-downloads)
// ---------------------------------------------------------------------------

export interface BimBuildRecord {
  id: string;
  userPhone: string;
  name: string;
  mode: "shell" | "ifc";
  price: number;
  glbUrl: string | null;
  ifcUrl: string | null;
  sidecarUrl: string | null;
  elementCount: number;
  sizeBytes: number;
}

export async function insertBimBuild(record: BimBuildRecord): Promise<void> {
  await getPool().query(
    `INSERT INTO bim_builds (id, user_phone, name, mode, price, glb_url, ifc_url, sidecar_url, element_count, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.id, record.userPhone, record.name, record.mode, record.price,
     record.glbUrl, record.ifcUrl, record.sidecarUrl, record.elementCount, record.sizeBytes]
  );
}

export async function listBimBuilds(userPhone: string, limit = 50): Promise<Array<BimBuildRecord & { createdAt: string }>> {
  const [rows] = await getPool().query(
    "SELECT * FROM bim_builds WHERE user_phone = ? ORDER BY created_at DESC LIMIT ?",
    [userPhone, Math.max(1, Math.min(200, limit))]
  ) as any;
  return (rows || []).map((row: any) => ({
    id: row.id, userPhone: row.user_phone, name: row.name, mode: row.mode, price: row.price,
    glbUrl: row.glb_url || null, ifcUrl: row.ifc_url || null, sidecarUrl: row.sidecar_url || null,
    elementCount: row.element_count || 0, sizeBytes: Number(row.size_bytes) || 0,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}

// ---------------------------------------------------------------------------
// Create Pipeline Sessions (Phase 2)
// ---------------------------------------------------------------------------

export type PipelineStatus = 'draft' | 'reference_ready' | 'approved' | 'customizing' | 'validation_failed' | 'print_ready' | 'build_starting' | 'building' | 'recovery_required' | 'complete' | 'failed';

export interface CreatePipelineSession {
  id: string;
  user_phone: string;
  species: string;
  breed: string | null;
  pet_name: string | null;
  intent: string | null;
  style: string | null;
  input_photo_url: string | null;
  candidate_image_url: string | null;
  customization_state: any | null;
  validation_state: string | null;
  status: PipelineStatus;
  idempotency_key: string | null;
  build_job_id: number | null;
  credits_reserved?: number;
  credit_debit_correlation_id?: string | null;
  provider_handle?: string | null;
  created_at?: string;
  updated_at?: string;
}

export async function upsertCreatePipelineSession(session: CreatePipelineSession): Promise<void> {
  await getPool().query(
    `INSERT INTO create_pipeline_sessions (
       id, user_phone, species, breed, pet_name, intent, style, input_photo_url, candidate_image_url, 
       customization_state, validation_state, status, idempotency_key, build_job_id, provider_handle
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE 
       species = VALUES(species),
       breed = VALUES(breed),
       pet_name = VALUES(pet_name),
       intent = VALUES(intent),
       style = VALUES(style),
       input_photo_url = VALUES(input_photo_url),
       candidate_image_url = VALUES(candidate_image_url),
       customization_state = VALUES(customization_state),
       validation_state = VALUES(validation_state),
       status = VALUES(status),
       idempotency_key = VALUES(idempotency_key),
       build_job_id = VALUES(build_job_id),
       provider_handle = VALUES(provider_handle)`,
    [
      session.id, session.user_phone, session.species, session.breed, session.pet_name, session.intent, session.style,
      session.input_photo_url, session.candidate_image_url, 
      session.customization_state ? JSON.stringify(session.customization_state) : null,
      session.validation_state, session.status, session.idempotency_key, session.build_job_id, session.provider_handle || null
    ]
  );
}

export async function getCreatePipelineSession(id: string, userPhone: string): Promise<CreatePipelineSession | null> {
  const [rows] = await getPool().query(
    "SELECT * FROM create_pipeline_sessions WHERE id = ? AND user_phone = ?",
    [id, userPhone]
  ) as any;
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  let customization_state = null;
  try {
    if (row.customization_state) customization_state = JSON.parse(row.customization_state);
  } catch (e) {}
  return {
    ...row,
    customization_state
  };
}

export async function updateCreatePipelineStatus(id: string, userPhone: string, status: PipelineStatus, buildJobId?: number): Promise<void> {
  if (buildJobId !== undefined) {
    await getPool().query(
      "UPDATE create_pipeline_sessions SET status = ?, build_job_id = ? WHERE id = ? AND user_phone = ?",
      [status, buildJobId, id, userPhone]
    );
  } else {
    await getPool().query(
      "UPDATE create_pipeline_sessions SET status = ? WHERE id = ? AND user_phone = ?",
      [status, id, userPhone]
    );
  }
}

// ---------------------------------------------------------------------------
// Pipeline Transactions (Phase 2)
// ---------------------------------------------------------------------------

function pipelineDebitCorrelation(
  sessionId: string,
  userPhone: string,
  idempotencyKey: string,
): string {
  const digest = createHash("sha256")
    .update(`${sessionId}\u0000${userPhone}\u0000${idempotencyKey}`)
    .digest("hex");
  return `pipeline-build:${digest}:debit`;
}

export async function reservePipelineSessionForBuild(sessionId: string, userPhone: string, idempotencyKey: string, modelCost: number): Promise<{ success: boolean; error?: string; alreadyReservedOrBuilding?: boolean; sessionRow?: CreatePipelineSession }> {
  const connection = await getPool().getConnection();
  try {
    await connection.query('START TRANSACTION');

    // 1. Lock the session row
    const [rows] = await connection.query(
      "SELECT * FROM create_pipeline_sessions WHERE id = ? AND user_phone = ? FOR UPDATE",
      [sessionId, userPhone]
    ) as any;

    if (!rows || rows.length === 0) {
      await connection.query('ROLLBACK');
      return { success: false, error: "Session not found." };
    }

    const session = rows[0];

    // If it's already past reference_ready...
    if (session.status !== 'reference_ready') {
      if (session.idempotency_key === idempotencyKey) {
        // Safe retry of an already successfully reserved/built session
        await connection.query('ROLLBACK');
        return { success: true, alreadyReservedOrBuilding: true, sessionRow: session };
      }
      await connection.query('ROLLBACK');
      return { success: false, error: "Session is in an invalid state for approval, or a conflicting approval is already processing." };
    }

    // 2. Lock the user row and record one wallet debit in the same transaction
    // as the durable session reservation. A later refund derives its owner and
    // amount from this immutable correlation, never from route parameters.
    const [userRows] = await connection.query(
      "SELECT credits, is_admin FROM users WHERE phone = ? LIMIT 1 FOR UPDATE",
      [userPhone],
    ) as any;
    if (!userRows || userRows.length === 0) {
      await connection.query('ROLLBACK');
      return { success: false, error: "User not found." };
    }
    const user = userRows[0];
    
    // Admins don't need credits, but normal users do.
    const isAdmin = user.is_admin === 1;
    const debitCorrelationId = isAdmin
      ? null
      : pipelineDebitCorrelation(sessionId, userPhone, idempotencyKey);
    if (debitCorrelationId) {
      const debit = await applyWalletDebitInTransaction(connection, {
        ownerId: userPhone,
        correlationId: debitCorrelationId,
        amount: modelCost,
        reason: "create_pipeline_model",
      });
      if (!debit.authorized) {
        await connection.query('ROLLBACK');
        return { success: false, error: "Insufficient PupCoins." };
      }
    }

    // 3. Update status to 'build_starting' and set idempotency key
    await connection.query(
      `UPDATE create_pipeline_sessions
          SET status = 'build_starting', idempotency_key = ?, credits_reserved = ?,
              credit_debit_correlation_id = ?
        WHERE id = ?`,
      [idempotencyKey, isAdmin ? 0 : modelCost, debitCorrelationId, sessionId]
    );

    await connection.query('COMMIT');
    return { success: true, sessionRow: session };
  } catch (err: any) {
    await connection.query('ROLLBACK');
    return { success: false, error: err.message };
  } finally {
    connection.release();
  }
}

export async function commitPipelineSessionBuild(sessionId: string, userPhone: string, jobData: { kind: JobKind; credits_reserved: number; operation_name?: string | null }, creationData: any): Promise<{ success: boolean; error?: string }> {
  // This path INSERTs into generation_jobs directly rather than via createJob(),
  // so it needs its own guard — see assertJobKind for why the DB won't do it.
  //
  // Reported through the {success,error} return rather than thrown: this
  // function's contract is that callers branch on `success`, and the route
  // handler relies on that to release the session reservation. Throwing here
  // would skip that cleanup and strand the session in 'build_starting'.
  if (!isJobKind(jobData?.kind)) {
    return { success: false, error: jobKindError(jobData?.kind) };
  }
  const connection = await getPool().getConnection();
  try {
    await connection.query('START TRANSACTION');

    // 1. Lock the session row to ensure it's still 'build_starting'
    const [rows] = await connection.query(
      "SELECT * FROM create_pipeline_sessions WHERE id = ? AND user_phone = ? FOR UPDATE",
      [sessionId, userPhone]
    ) as any;

    if (!rows || rows.length === 0) {
      throw new Error("Session not found.");
    }
    const session = rows[0];
    
    if (session.status !== 'build_starting') {
      throw new Error("Session is not in build_starting state.");
    }

    // 2. Insert into creations (FurBin)
    const [creationRes] = await connection.query(
      `INSERT INTO creations (user_phone, media_type, style, backdrop_kind, preset_name, image_url, model_url, pet_name, pet_breed)
       VALUES (?, 'model', ?, 'preset', 'Studio', ?, NULL, ?, ?)`,
      [userPhone, creationData.style || 'Realistic', creationData.image_url, creationData.pet_name, creationData.pet_breed]
    ) as any;
    const creationId = creationRes.insertId;

    const reservedCredits = Number(session.credits_reserved || 0);
    const debitCorrelationId = session.credit_debit_correlation_id
      ? String(session.credit_debit_correlation_id)
      : null;
    if (reservedCredits !== Number(jobData.credits_reserved)) {
      throw new Error("Generation job credit reservation does not match the approved session.");
    }
    if ((reservedCredits > 0) !== Boolean(debitCorrelationId)) {
      throw new Error("Generation job credit evidence is incomplete.");
    }

    // 3. Insert into generation_jobs with the exact session debit evidence.
    const [jobRes] = await connection.query(
      `INSERT INTO generation_jobs
        (user_phone, creation_id, kind, credits_reserved, credit_debit_correlation_id, operation_name, status)
       VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
      [userPhone, creationId, jobData.kind, reservedCredits, debitCorrelationId, jobData.operation_name || null]
    ) as any;
    const jobId = jobRes.insertId;

    // 4. Update session status to building
    await connection.query(
      "UPDATE create_pipeline_sessions SET status = 'building', build_job_id = ? WHERE id = ?",
      [jobId, sessionId]
    );

    await connection.query('COMMIT');
    return { success: true };
  } catch (err: any) {
    await connection.query('ROLLBACK');
    return { success: false, error: err.message };
  } finally {
    connection.release();
  }
}

export async function getPipelineSessionByProviderHandle(providerHandle: string): Promise<CreatePipelineSession | null> {
  const [rows] = await getPool().query(
    "SELECT * FROM create_pipeline_sessions WHERE provider_handle = ?",
    [providerHandle]
  ) as any;
  return rows[0] || null;
}

export async function recoverPipelineSession(sessionId: string, userPhone: string, jobData: { kind: JobKind; credits_reserved: number; operation_name?: string | null }, creationData: any): Promise<{ success: boolean; error?: string; alreadyRecovered?: boolean }> {
  if (!isJobKind(jobData?.kind)) {
    return { success: false, error: jobKindError(jobData?.kind) };
  }
  const connection = await getPool().getConnection();
  try {
    await connection.query('START TRANSACTION');

    const [rows] = await connection.query(
      "SELECT * FROM create_pipeline_sessions WHERE id = ? AND user_phone = ? FOR UPDATE",
      [sessionId, userPhone]
    ) as any;

    if (!rows || rows.length === 0) {
      throw new Error("Session not found.");
    }
    const session = rows[0];
    
    // Allow either build_starting or recovery_required
    if (session.status !== 'recovery_required' && session.status !== 'build_starting') {
      // If it's already in building or beyond, it's technically already recovered
      if (session.status === 'building' || session.status === 'complete' || session.status === 'failed') {
        await connection.query('ROLLBACK');
        return { success: true, alreadyRecovered: true };
      }
      throw new Error("Session is not in a recoverable state.");
    }

    // Database-level idempotency guard: guarantee only one creation/job is made
    // Check if we already created a job for this provider_handle
    if (session.provider_handle) {
      const [existingJobs] = await connection.query(
        `SELECT id FROM generation_jobs WHERE operation_name = ? FOR UPDATE`,
        [session.provider_handle]
      ) as any;
      if (existingJobs && existingJobs.length > 0) {
        // We already created a job/creation for this provider_handle
        // Ensure session status matches
        await connection.query(
          "UPDATE create_pipeline_sessions SET status = 'building', build_job_id = ? WHERE id = ?",
          [existingJobs[0].id, sessionId]
        );
        await connection.query('COMMIT');
        return { success: true, alreadyRecovered: true };
      }
    }

    // Idempotency check: see if a creation already exists for this session's external job
    // Actually, we can check generation_jobs by operation_name, or just avoid duplicates
    // based on session.build_job_id if it got partially set, but if recovery_required is set,
    // the previous transaction rolled back, so it shouldn't exist.
    // We will ensure only 1 creation is made by doing the same insertions.
    
    const [creationRes] = await connection.query(
      `INSERT INTO creations (user_phone, media_type, style, backdrop_kind, preset_name, image_url, model_url, pet_name, pet_breed)
       VALUES (?, 'model', ?, 'preset', 'Studio', ?, NULL, ?, ?)`,
      [userPhone, creationData.style || 'Realistic', creationData.image_url, creationData.pet_name, creationData.pet_breed]
    ) as any;
    const creationId = creationRes.insertId;

    const reservedCredits = Number(session.credits_reserved || 0);
    const debitCorrelationId = session.credit_debit_correlation_id
      ? String(session.credit_debit_correlation_id)
      : null;
    if (reservedCredits !== Number(jobData.credits_reserved)) {
      throw new Error("Recovered job credit reservation does not match the approved session.");
    }
    if ((reservedCredits > 0) !== Boolean(debitCorrelationId)) {
      throw new Error("Recovered job credit evidence is incomplete.");
    }

    const [jobRes] = await connection.query(
      `INSERT INTO generation_jobs
        (user_phone, creation_id, kind, credits_reserved, credit_debit_correlation_id, operation_name, status)
       VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
      [userPhone, creationId, jobData.kind, reservedCredits, debitCorrelationId,
        session.provider_handle || jobData.operation_name || null]
    ) as any;
    const jobId = jobRes.insertId;

    await connection.query(
      "UPDATE create_pipeline_sessions SET status = 'building', build_job_id = ? WHERE id = ?",
      [jobId, sessionId]
    );

    await connection.query('COMMIT');
    return { success: true };
  } catch (err: any) {
    await connection.query('ROLLBACK');
    return { success: false, error: err.message };
  } finally {
    connection.release();
  }
}


export async function markPipelineSessionRecoveryRequired(sessionId: string, userPhone: string, providerHandle: string): Promise<{ success: boolean; error?: string }> {
  try {
    await getPool().query(
      "UPDATE create_pipeline_sessions SET status = 'recovery_required', provider_handle = ? WHERE id = ? AND user_phone = ?",
      [providerHandle, sessionId, userPhone]
    );
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function releasePipelineSessionReservation(sessionId: string, userPhone: string, _modelCost: number): Promise<{ success: boolean; error?: string }> {
  const connection = await getPool().getConnection();
  try {
    await connection.query('START TRANSACTION');

    const [rows] = await connection.query(
      "SELECT * FROM create_pipeline_sessions WHERE id = ? AND user_phone = ? FOR UPDATE",
      [sessionId, userPhone]
    ) as any;

    if (!rows || rows.length === 0) {
      throw new Error("Session not found.");
    }
    const session = rows[0];
    
    if (session.status !== 'build_starting') {
      throw new Error("Session is not in build_starting state.");
    }

    const reservedCredits = Number(session.credits_reserved || 0);
    const debitCorrelationId = session.credit_debit_correlation_id
      ? String(session.credit_debit_correlation_id)
      : null;
    if (reservedCredits > 0) {
      if (!debitCorrelationId) throw new Error("Pipeline reservation is missing debit evidence.");
      await refundWalletDebitInTransaction(connection, debitCorrelationId, {
        ownerId: userPhone,
        amount: reservedCredits,
      });
    } else if (debitCorrelationId) {
      throw new Error("Zero-cost pipeline reservation has unexpected debit evidence.");
    }

    // Revert status to reference_ready
    await connection.query(
      `UPDATE create_pipeline_sessions
          SET status = 'reference_ready', idempotency_key = NULL,
              credits_reserved = 0, credit_debit_correlation_id = NULL
        WHERE id = ?`,
      [sessionId]
    );

    await connection.query('COMMIT');
    return { success: true };
  } catch (err: any) {
    await connection.query('ROLLBACK');
    return { success: false, error: err.message };
  } finally {
    connection.release();
  }
}
