import crypto from "node:crypto";
import type mysql from "mysql2/promise";

export const CURRENT_SCHEMA_VERSION = 51;

export interface Migration {
  version: number;
  name: string;
  statements: string[];
  skipWhenTableMissing?: string;
  /**
   * Zero-based statement indexes whose SQL is valid only when the named table
   * exists. This is execution metadata and deliberately does not participate
   * in the published SQL checksum.
   */
  statementRequiresTable?: Partial<Record<number, string>>;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  applied_at: Date;
  duration_ms: number;
}

export function sha256(content: string): string {
  return crypto.createHash("sha256").update(content.trim()).digest("hex");
}

/**
 * Single Authoritative TypeScript Migration Registry.
 * Baseline versions 001..015 correspond to legacy boot DDL (server/migrations/001_... to 015_...).
 * First managed migrations are 16, 17, and 18.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 16,
    name: "wags_stripe_customer_id",
    skipWhenTableMissing: "users",
    statements: [
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'stripe_customer_id'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE users ADD COLUMN stripe_customer_id VARCHAR(128) NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`,
      `EXECUTE stmt`,
      `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 17,
    name: "stl_derivatives_unique_constraint",
    skipWhenTableMissing: "marketplace_assets",
    statements: [
      // 1. Reconcile existing duplicate active STL derivatives to 'superseded'
      `UPDATE marketplace_assets ma
       JOIN (
         SELECT listing_id, ROUND(derivative_height_mm, 2) as norm_height, MAX(id) as max_id
         FROM marketplace_assets
         WHERE kind = 'stl_derivative' AND status = 'active' AND derivative_height_mm IS NOT NULL
         GROUP BY listing_id, ROUND(derivative_height_mm, 2)
         HAVING COUNT(*) > 1
       ) dupes ON ma.listing_id = dupes.listing_id${" "}
              AND ROUND(ma.derivative_height_mm, 2) = dupes.norm_height${" "}
              AND ma.id < dupes.max_id
       SET ma.status = 'superseded'
       WHERE ma.kind = 'stl_derivative' AND ma.status = 'active'`,

      // 2. Add generated active height stored column (evaluates to height if active, NULL otherwise)
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketplace_assets' AND COLUMN_NAME = 'generated_active_height'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE marketplace_assets ADD COLUMN generated_active_height DECIMAL(8,2) GENERATED ALWAYS AS (CASE WHEN kind=\\'stl_derivative\\' AND status=\\'active\\' THEN ROUND(derivative_height_mm, 2) ELSE NULL END) STORED', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`,
      `EXECUTE stmt`,
      `DEALLOCATE PREPARE stmt`,

      // 3. Add active-only unique index on (listing_id, generated_active_height)
      `SELECT COUNT(*) INTO @idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketplace_assets' AND INDEX_NAME = 'uniq_stl_active_derivative'`,
      `SET @stmt = IF(@idx_exists = 0, 'ALTER TABLE marketplace_assets ADD UNIQUE INDEX uniq_stl_active_derivative (listing_id, generated_active_height)', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`,
      `EXECUTE stmt`,
      `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 18,
    name: "canonical_asset_registry",
    statements: [
      `CREATE TABLE IF NOT EXISTS assets (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        asset_uuid CHAR(36) NOT NULL,
        owner_id VARCHAR(190) NOT NULL,
        asset_type VARCHAR(64) NOT NULL,
        visibility ENUM('private', 'public', 'published') NOT NULL DEFAULT 'private',
        status ENUM('active', 'archived', 'deleted') NOT NULL DEFAULT 'active',
        current_version_id BIGINT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_asset_uuid (asset_uuid),
        INDEX idx_assets_owner (owner_id, asset_type, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS asset_versions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        asset_id BIGINT NOT NULL,
        version_number INT NOT NULL DEFAULT 1,
        sha256 CHAR(64) NOT NULL,
        mime_type VARCHAR(120) NOT NULL,
        size_bytes BIGINT NOT NULL,
        bucket ENUM('public', 'private') NOT NULL,
        object_key VARCHAR(512) NOT NULL,
        metadata JSON NULL,
        source_provider VARCHAR(64) NOT NULL DEFAULT 'original',
        license VARCHAR(64) NOT NULL DEFAULT 'proprietary',
        commercial_use_eligible TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_asset_version (asset_id, version_number),
        INDEX idx_asset_version_checksum (sha256),
        INDEX idx_asset_version_storage (bucket, object_key(191)),
        CONSTRAINT fk_asset_version_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS asset_relations (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        parent_version_id BIGINT NOT NULL,
        child_version_id BIGINT NOT NULL,
        relation_type ENUM('turnaround', 'mesh', 'rig', 'stl', 'render', 'print_file', 'derivative') NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_asset_relation (parent_version_id, child_version_id, relation_type),
        CONSTRAINT fk_asset_relation_parent FOREIGN KEY (parent_version_id) REFERENCES asset_versions(id) ON DELETE CASCADE,
        CONSTRAINT fk_asset_relation_child FOREIGN KEY (child_version_id) REFERENCES asset_versions(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS asset_legacy_links (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        legacy_table VARCHAR(64) NOT NULL,
        legacy_id VARCHAR(190) NOT NULL,
        asset_id BIGINT NOT NULL,
        asset_version_id BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_legacy_mapping (legacy_table, legacy_id),
        CONSTRAINT fk_legacy_link_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
        CONSTRAINT fk_legacy_link_version FOREIGN KEY (asset_version_id) REFERENCES asset_versions(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // Add FK constraint on assets.current_version_id after asset_versions table creation
      `SELECT COUNT(*) INTO @fk_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'assets' AND CONSTRAINT_NAME = 'fk_asset_current_version'`,
      `SET @stmt = IF(@fk_exists = 0, 'ALTER TABLE assets ADD CONSTRAINT fk_asset_current_version FOREIGN KEY (current_version_id) REFERENCES asset_versions(id) ON DELETE SET NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`,
      `EXECUTE stmt`,
      `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 19,
    name: "canonical_asset_integrity_hardening",
    statements: [
      // Repair any pre-existing cross-asset pointers before tightening the FK.
      `UPDATE assets a
       LEFT JOIN asset_versions av ON av.id = a.current_version_id AND av.asset_id = a.id
       SET a.current_version_id = (
         SELECT replacement.id FROM asset_versions replacement
         WHERE replacement.asset_id = a.id
         ORDER BY replacement.version_number DESC LIMIT 1
       )
       WHERE a.current_version_id IS NOT NULL AND av.id IS NULL`,

      `SELECT COUNT(*) INTO @idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asset_versions' AND INDEX_NAME = 'uniq_asset_version_identity'`,
      `SET @stmt = IF(@idx_exists = 0, 'ALTER TABLE asset_versions ADD UNIQUE KEY uniq_asset_version_identity (asset_id, id)', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`,
      `EXECUTE stmt`,
      `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @fk_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'assets' AND CONSTRAINT_NAME = 'fk_asset_current_version'`,
      `SET @stmt = IF(@fk_exists > 0, 'ALTER TABLE assets DROP FOREIGN KEY fk_asset_current_version', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`,
      `EXECUTE stmt`,
      `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @fk_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'assets' AND CONSTRAINT_NAME = 'fk_asset_current_version_owned'`,
      `SET @stmt = IF(@fk_exists = 0, 'ALTER TABLE assets ADD CONSTRAINT fk_asset_current_version_owned FOREIGN KEY (id, current_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`,
      `EXECUTE stmt`,
      `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @check_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asset_relations' AND CONSTRAINT_NAME = 'chk_asset_relation_not_self'`,
      `SET @stmt = IF(@check_exists = 0, 'ALTER TABLE asset_relations ADD CONSTRAINT chk_asset_relation_not_self CHECK (parent_version_id <> child_version_id)', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`,
      `EXECUTE stmt`,
      `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 20,
    name: "multiview_reference_approval",
    statements: [
      `CREATE TABLE IF NOT EXISTS reference_sessions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        session_uuid CHAR(36) NOT NULL UNIQUE,
        owner_id VARCHAR(190) NOT NULL,
        input_mode ENUM('text', 'photo') NOT NULL,
        subject_class VARCHAR(64) NOT NULL DEFAULT 'pet',
        prompt TEXT NULL,
        source_asset_id BIGINT NULL,
        source_asset_version_id BIGINT NULL,
        state ENUM('draft', 'queued', 'generating', 'ready', 'approved', 'failed', 'cancelled') NOT NULL DEFAULT 'draft',
        current_attempt_id BIGINT NULL,
        approved_attempt_id BIGINT NULL,
        retry_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_ref_sessions_owner (owner_id),
        INDEX idx_ref_sessions_state (state)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS reference_attempts (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        session_id BIGINT NOT NULL,
        attempt_number INT NOT NULL,
        idempotency_key VARCHAR(190) NOT NULL,
        provider VARCHAR(64) NOT NULL DEFAULT 'gemini',
        model VARCHAR(120) NOT NULL,
        prompt_config_hash CHAR(64) NOT NULL,
        retry_notes TEXT NULL,
        state ENUM('queued', 'generating', 'ready', 'failed', 'cancelled') NOT NULL DEFAULT 'queued',
        failure_code VARCHAR(64) NULL,
        error_message TEXT NULL,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP NULL,
        UNIQUE KEY uniq_ref_attempt_number (session_id, attempt_number),
        UNIQUE KEY uniq_ref_attempt_idempotency (session_id, idempotency_key),
        FOREIGN KEY (session_id) REFERENCES reference_sessions(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS reference_views (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        attempt_id BIGINT NOT NULL,
        view_kind ENUM('front', 'left', 'right', 'rear', 'front_three_quarter') NOT NULL,
        asset_id BIGINT NOT NULL,
        asset_version_id BIGINT NOT NULL,
        width_px INT NOT NULL,
        height_px INT NOT NULL,
        is_synthesized TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_ref_view_kind (attempt_id, view_kind),
        FOREIGN KEY (attempt_id) REFERENCES reference_attempts(id) ON DELETE CASCADE,
        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
        FOREIGN KEY (asset_version_id) REFERENCES asset_versions(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS reference_reports (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        attempt_id BIGINT NOT NULL UNIQUE,
        report_asset_version_id BIGINT NULL,
        status ENUM('pass', 'warn', 'fail') NOT NULL DEFAULT 'pass',
        scale_confidence ENUM('unknown', 'declared', 'calibrated') NOT NULL DEFAULT 'unknown',
        report_hash CHAR(64) NOT NULL,
        metrics_json JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (attempt_id) REFERENCES reference_attempts(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS reference_approvals (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        session_id BIGINT NOT NULL UNIQUE,
        attempt_id BIGINT NOT NULL,
        manifest_hash CHAR(64) NOT NULL,
        approved_by_user VARCHAR(190) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES reference_sessions(id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES reference_attempts(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },
  {
    version: 21,
    name: "multiview_reference_integrity_hardening",
    statements: [
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reference_reports' AND COLUMN_NAME = 'report_asset_id'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE reference_reports ADD COLUMN report_asset_id BIGINT NULL AFTER attempt_id', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reference_approvals' AND COLUMN_NAME = 'manifest_asset_id'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE reference_approvals ADD COLUMN manifest_asset_id BIGINT NULL AFTER attempt_id', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reference_approvals' AND COLUMN_NAME = 'manifest_asset_version_id'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE reference_approvals ADD COLUMN manifest_asset_version_id BIGINT NULL AFTER manifest_asset_id', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reference_attempts' AND INDEX_NAME = 'uniq_ref_attempt_identity'`,
      `SET @stmt = IF(@idx_exists = 0, 'ALTER TABLE reference_attempts ADD UNIQUE KEY uniq_ref_attempt_identity (session_id, id)', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @fk_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reference_sessions' AND CONSTRAINT_NAME = 'fk_ref_session_current_attempt_owned'`,
      `SET @stmt = IF(@fk_exists = 0, 'ALTER TABLE reference_sessions ADD CONSTRAINT fk_ref_session_current_attempt_owned FOREIGN KEY (id, current_attempt_id) REFERENCES reference_attempts(session_id, id) ON DELETE RESTRICT', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @fk_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reference_sessions' AND CONSTRAINT_NAME = 'fk_ref_session_approved_attempt_owned'`,
      `SET @stmt = IF(@fk_exists = 0, 'ALTER TABLE reference_sessions ADD CONSTRAINT fk_ref_session_approved_attempt_owned FOREIGN KEY (id, approved_attempt_id) REFERENCES reference_attempts(session_id, id) ON DELETE RESTRICT', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @fk_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reference_sessions' AND CONSTRAINT_NAME = 'fk_ref_session_source_version_owned'`,
      `SET @stmt = IF(@fk_exists = 0, 'ALTER TABLE reference_sessions ADD CONSTRAINT fk_ref_session_source_version_owned FOREIGN KEY (source_asset_id, source_asset_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @fk_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reference_views' AND CONSTRAINT_NAME = 'fk_ref_view_version_owned'`,
      `SET @stmt = IF(@fk_exists = 0, 'ALTER TABLE reference_views ADD CONSTRAINT fk_ref_view_version_owned FOREIGN KEY (asset_id, asset_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @fk_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reference_reports' AND CONSTRAINT_NAME = 'fk_ref_report_version_owned'`,
      `SET @stmt = IF(@fk_exists = 0, 'ALTER TABLE reference_reports ADD CONSTRAINT fk_ref_report_version_owned FOREIGN KEY (report_asset_id, report_asset_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @fk_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reference_approvals' AND CONSTRAINT_NAME = 'fk_ref_approval_attempt_owned'`,
      `SET @stmt = IF(@fk_exists = 0, 'ALTER TABLE reference_approvals ADD CONSTRAINT fk_ref_approval_attempt_owned FOREIGN KEY (session_id, attempt_id) REFERENCES reference_attempts(session_id, id) ON DELETE RESTRICT', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @fk_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reference_approvals' AND CONSTRAINT_NAME = 'fk_ref_approval_manifest_version_owned'`,
      `SET @stmt = IF(@fk_exists = 0, 'ALTER TABLE reference_approvals ADD CONSTRAINT fk_ref_approval_manifest_version_owned FOREIGN KEY (manifest_asset_id, manifest_asset_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @check_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reference_views' AND CONSTRAINT_NAME = 'chk_ref_view_min_dimensions'`,
      `SET @stmt = IF(@check_exists = 0, 'ALTER TABLE reference_views ADD CONSTRAINT chk_ref_view_min_dimensions CHECK (width_px >= 1024 AND height_px >= 1024)', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 22,
    name: "durable_model_build",
    statements: [
      `CREATE TABLE IF NOT EXISTS model_build_jobs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_uuid CHAR(36) NOT NULL,
        owner_id VARCHAR(190) NOT NULL,
        reference_session_id BIGINT NOT NULL,
        reference_attempt_id BIGINT NOT NULL,
        manifest_asset_id BIGINT NOT NULL,
        manifest_asset_version_id BIGINT NOT NULL,
        manifest_hash CHAR(64) NOT NULL,
        requested_output VARCHAR(20) NOT NULL DEFAULT 'glb',
        pricing_key VARCHAR(64) NOT NULL,
        quoted_credits INT NOT NULL,
        state VARCHAR(30) NOT NULL DEFAULT 'draft',
        current_attempt_id BIGINT NULL,
        accepted_artifact_id BIGINT NULL,
        accepted_report_id BIGINT NULL,
        credit_correlation_id VARCHAR(120) NULL,
        refund_correlation_id VARCHAR(120) NULL,
        failure_code VARCHAR(120) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_job_uuid (job_uuid),
        UNIQUE KEY uniq_job_reference_owner (reference_session_id, owner_id),
        INDEX idx_job_owner (owner_id, state),
        CONSTRAINT chk_job_quoted_credits CHECK (quoted_credits >= 0),
        FOREIGN KEY (reference_session_id) REFERENCES reference_sessions(id) ON DELETE RESTRICT,
        FOREIGN KEY (reference_session_id, reference_attempt_id) REFERENCES reference_attempts(session_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (manifest_asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
        FOREIGN KEY (manifest_asset_id, manifest_asset_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS model_build_attempts (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_id BIGINT NOT NULL,
        attempt_number INT NOT NULL,
        idempotency_key CHAR(36) NOT NULL,
        provider VARCHAR(64) NOT NULL DEFAULT 'tripo',
        model VARCHAR(64) NOT NULL DEFAULT 'default',
        provider_task_handle VARCHAR(255) NULL,
        input_config_hash CHAR(64) NOT NULL,
        lease_owner VARCHAR(120) NULL,
        lease_expires_at TIMESTAMP NULL,
        state VARCHAR(30) NOT NULL DEFAULT 'queued',
        failure_code VARCHAR(120) NULL,
        error_message VARCHAR(500) NULL,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP NULL,
        UNIQUE KEY uniq_attempt_idempotency (idempotency_key),
        UNIQUE KEY uniq_attempt_job_number (job_id, attempt_number),
        UNIQUE KEY uniq_model_attempt_identity (job_id, id),
        CONSTRAINT chk_attempt_number CHECK (attempt_number >= 1),
        FOREIGN KEY (job_id) REFERENCES model_build_jobs(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS model_provider_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        provider VARCHAR(64) NOT NULL,
        event_hash CHAR(64) NOT NULL,
        attempt_id BIGINT NOT NULL,
        event_type VARCHAR(30) NOT NULL,
        received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP NULL,
        payload_metadata JSON NULL,
        UNIQUE KEY uniq_provider_event (event_hash),
        FOREIGN KEY (attempt_id) REFERENCES model_build_attempts(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS model_build_artifacts (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        attempt_id BIGINT NOT NULL,
        asset_id BIGINT NOT NULL,
        asset_version_id BIGINT NOT NULL,
        role VARCHAR(30) NOT NULL,
        computed_hash CHAR(64) NOT NULL,
        size_bytes BIGINT NOT NULL,
        mime_type VARCHAR(120) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_artifact_role (attempt_id, role),
        UNIQUE KEY uniq_model_artifact_identity (attempt_id, id),
        CONSTRAINT chk_artifact_size CHECK (size_bytes >= 0),
        FOREIGN KEY (attempt_id) REFERENCES model_build_attempts(id) ON DELETE CASCADE,
        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
        FOREIGN KEY (asset_id, asset_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS model_post_build_reports (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        attempt_id BIGINT NOT NULL UNIQUE,
        report_asset_id BIGINT NOT NULL,
        report_asset_version_id BIGINT NOT NULL,
        status ENUM('pass', 'warn', 'fail') NOT NULL DEFAULT 'pass',
        validator_versions VARCHAR(255) NOT NULL,
        metrics_hash CHAR(64) NOT NULL,
        metrics_json JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (attempt_id) REFERENCES model_build_attempts(id) ON DELETE CASCADE,
        FOREIGN KEY (report_asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
        UNIQUE KEY uniq_model_report_identity (attempt_id, id),
        FOREIGN KEY (report_asset_id, report_asset_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS model_build_acceptances (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_id BIGINT NOT NULL UNIQUE,
        attempt_id BIGINT NOT NULL,
        artifact_id BIGINT NOT NULL,
        report_id BIGINT NOT NULL,
        accepted_by_user VARCHAR(190) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (job_id) REFERENCES model_build_jobs(id) ON DELETE RESTRICT,
        FOREIGN KEY (job_id, attempt_id) REFERENCES model_build_attempts(job_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id, artifact_id) REFERENCES model_build_artifacts(attempt_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id, report_id) REFERENCES model_post_build_reports(attempt_id, id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS model_build_credit_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_id BIGINT NOT NULL,
        attempt_id BIGINT NOT NULL,
        owner_id VARCHAR(190) NOT NULL,
        correlation_id VARCHAR(120) NOT NULL,
        event_type ENUM('charge', 'refund') NOT NULL,
        delta INT NOT NULL,
        balance_after INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_model_credit_correlation (correlation_id),
        INDEX idx_model_credit_job (job_id, attempt_id),
        CONSTRAINT chk_model_credit_delta CHECK (delta <> 0),
        FOREIGN KEY (job_id, attempt_id) REFERENCES model_build_attempts(job_id, id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },
  {
    version: 23,
    name: "rig_pipeline",
    statements: [
      `CREATE TABLE IF NOT EXISTS rig_classifications (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        model_build_job_id BIGINT NOT NULL,
        accepted_artifact_id BIGINT NOT NULL,
        classification ENUM('biped', 'quadruped', 'unsupported') NOT NULL,
        classifier_version VARCHAR(50) NOT NULL,
        confidence DECIMAL(5,4) NOT NULL DEFAULT 0.0,
        evidence_json JSON NOT NULL,
        override_by VARCHAR(190) NULL,
        override_reason TEXT NULL,
        override_at TIMESTAMP NULL,
        selected_profile_id VARCHAR(120) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_rig_class_job (model_build_job_id),
        INDEX idx_rig_class_artifact (accepted_artifact_id),
        FOREIGN KEY (model_build_job_id) REFERENCES model_build_jobs(id) ON DELETE RESTRICT,
        FOREIGN KEY (accepted_artifact_id) REFERENCES model_build_artifacts(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS rig_jobs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_uuid CHAR(36) NOT NULL,
        owner_id VARCHAR(190) NOT NULL,
        model_build_job_id BIGINT NOT NULL,
        classification_id BIGINT NOT NULL,
        source_artifact_id BIGINT NOT NULL,
        source_version_id BIGINT NOT NULL,
        state ENUM('draft','classifying','classified','queued','submitted','rigging','validating_rig','inventorying_facial','fitting_accessories','ready','accepted','failed_classification','failed_rig','failed_validation','cancelled') NOT NULL DEFAULT 'draft',
        current_attempt_id BIGINT NULL,
        request_facial BOOLEAN NOT NULL DEFAULT TRUE,
        failure_code VARCHAR(60) NULL,
        accepted_artifact_id BIGINT NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_rig_job_uuid (job_uuid),
        UNIQUE KEY uniq_rig_idempotency (idempotency_key),
        UNIQUE KEY uniq_rig_model_job (model_build_job_id),
        UNIQUE KEY uniq_rig_job_current_attempt (id, current_attempt_id),
        INDEX idx_rig_job_owner (owner_id),
        INDEX idx_rig_job_model (model_build_job_id),
        FOREIGN KEY (model_build_job_id) REFERENCES model_build_jobs(id) ON DELETE RESTRICT,
        FOREIGN KEY (classification_id) REFERENCES rig_classifications(id) ON DELETE RESTRICT,
        FOREIGN KEY (source_artifact_id) REFERENCES model_build_artifacts(id) ON DELETE RESTRICT,
        FOREIGN KEY (source_version_id) REFERENCES asset_versions(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS rig_attempts (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_id BIGINT NOT NULL,
        attempt_number TINYINT UNSIGNED NOT NULL DEFAULT 1,
        state ENUM('queued','submitted','rigging','validating','ready','failed','cancelled') NOT NULL DEFAULT 'queued',
        provider VARCHAR(50) NULL,
        provider_task_handle VARCHAR(255) NULL,
        worker_lease_owner VARCHAR(120) NULL,
        worker_lease_expiry TIMESTAMP NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        started_at TIMESTAMP NULL,
        completed_at TIMESTAMP NULL,
        failure_code VARCHAR(60) NULL,
        failure_detail TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_rig_attempt_idemp (idempotency_key),
        UNIQUE KEY uniq_rig_attempt_job_num (job_id, attempt_number),
        UNIQUE KEY uniq_rig_attempt_identity (job_id, id),
        INDEX idx_rig_attempt_state (state),
        FOREIGN KEY (job_id) REFERENCES rig_jobs(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS rig_validation_manifests (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        rig_attempt_id BIGINT NOT NULL,
        validator_version VARCHAR(50) NOT NULL,
        bone_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        skinned_vertex_count INT UNSIGNED NOT NULL DEFAULT 0,
        max_influences TINYINT UNSIGNED NOT NULL DEFAULT 0,
        unweighted_islands SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        bind_matrix_valid BOOLEAN NOT NULL DEFAULT FALSE,
        animation_sweep_pass BOOLEAN NOT NULL DEFAULT FALSE,
        silhouette_deviation DECIMAL(8,4) NOT NULL DEFAULT 0.0,
        mobile_budget_pass BOOLEAN NOT NULL DEFAULT FALSE,
        triangle_count INT UNSIGNED NOT NULL DEFAULT 0,
        texture_max_dimension SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        joint_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        rules_json JSON NOT NULL,
        metrics_hash CHAR(64) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_rig_manifest_attempt (rig_attempt_id),
        FOREIGN KEY (rig_attempt_id) REFERENCES rig_attempts(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS facial_inventories (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        rig_job_id BIGINT NOT NULL,
        rig_attempt_id BIGINT NOT NULL,
        capability ENUM('full', 'partial', 'body_only', 'unsupported') NOT NULL,
        morph_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        viseme_coverage DECIMAL(5,4) NOT NULL DEFAULT 0.0,
        has_blink BOOLEAN NOT NULL DEFAULT FALSE,
        has_jaw BOOLEAN NOT NULL DEFAULT FALSE,
        has_eye_controls BOOLEAN NOT NULL DEFAULT FALSE,
        morph_names_json JSON NOT NULL,
        canonical_map_json JSON NOT NULL,
        deformation_pass BOOLEAN NOT NULL DEFAULT FALSE,
        notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_facial_inv_attempt (rig_attempt_id),
        INDEX idx_facial_inv_job (rig_job_id),
        FOREIGN KEY (rig_job_id) REFERENCES rig_jobs(id) ON DELETE RESTRICT,
        FOREIGN KEY (rig_attempt_id) REFERENCES rig_attempts(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS accessory_catalog (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        accessory_uuid CHAR(36) NOT NULL,
        owner_id VARCHAR(190) NOT NULL,
        name VARCHAR(200) NOT NULL,
        asset_id BIGINT NOT NULL,
        asset_version_id BIGINT NOT NULL,
        compatible_profiles JSON NOT NULL,
        attachment_bone VARCHAR(100) NOT NULL,
        fit_bounds_json JSON NOT NULL,
        collision_bounds_json JSON NOT NULL,
        license VARCHAR(500) NOT NULL DEFAULT 'proprietary',
        commercial_use_eligible BOOLEAN NOT NULL DEFAULT FALSE,
        export_policy ENUM('allowed', 'preview_only', 'derivative_only') NOT NULL DEFAULT 'allowed',
        preview_asset_id BIGINT NULL,
        status ENUM('active', 'archived', 'deleted') NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_accessory_uuid (accessory_uuid),
        INDEX idx_accessory_owner (owner_id),
        INDEX idx_accessory_status (status),
        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
        FOREIGN KEY (asset_id, asset_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (preview_asset_id) REFERENCES assets(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS accessory_fits (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        fit_uuid CHAR(36) NOT NULL,
        rig_job_id BIGINT NOT NULL,
        accessory_id BIGINT NOT NULL,
        derivative_asset_id BIGINT NULL,
        derivative_version_id BIGINT NULL,
        attachment_bone VARCHAR(100) NOT NULL,
        transform_json JSON NOT NULL,
        floating_distance DECIMAL(8,4) NOT NULL DEFAULT 0.0,
        penetration_depth DECIMAL(8,4) NOT NULL DEFAULT 0.0,
        animation_sweep_pass BOOLEAN NOT NULL DEFAULT FALSE,
        polygon_budget_pass BOOLEAN NOT NULL DEFAULT FALSE,
        print_clearance_mm DECIMAL(8,4) NOT NULL DEFAULT 0.0,
        status ENUM('pending', 'fitted', 'failed', 'accepted') NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_fit_uuid (fit_uuid),
        INDEX idx_fit_rig_job (rig_job_id),
        INDEX idx_fit_accessory (accessory_id),
        FOREIGN KEY (rig_job_id) REFERENCES rig_jobs(id) ON DELETE RESTRICT,
        FOREIGN KEY (accessory_id) REFERENCES accessory_catalog(id) ON DELETE RESTRICT,
        FOREIGN KEY (derivative_asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
        FOREIGN KEY (derivative_asset_id, derivative_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS rig_acceptances (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        rig_job_id BIGINT NOT NULL,
        rig_attempt_id BIGINT NOT NULL,
        manifest_id BIGINT NOT NULL,
        accepted_by_user VARCHAR(190) NOT NULL,
        manifest_hash CHAR(64) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_rig_acceptance_job (rig_job_id),
        FOREIGN KEY (rig_job_id) REFERENCES rig_jobs(id) ON DELETE RESTRICT,
        FOREIGN KEY (rig_attempt_id) REFERENCES rig_attempts(id) ON DELETE RESTRICT,
        FOREIGN KEY (manifest_id) REFERENCES rig_validation_manifests(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `SELECT COUNT(*) INTO @fk_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rig_jobs' AND CONSTRAINT_NAME = 'fk_rig_job_current_attempt'`,
      `SET @stmt = IF(@fk_exists = 0, 'ALTER TABLE rig_jobs ADD CONSTRAINT fk_rig_job_current_attempt FOREIGN KEY (id, current_attempt_id) REFERENCES rig_attempts(job_id, id) ON DELETE RESTRICT', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 24,
    name: "fur_bin_showcase",
    statements: [
      `CREATE TABLE IF NOT EXISTS fur_bin_items (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        item_uuid CHAR(36) NOT NULL,
        owner_id VARCHAR(190) NOT NULL,
        asset_id BIGINT NOT NULL,
        current_version_id BIGINT NULL,
        title VARCHAR(300) NOT NULL DEFAULT '',
        description TEXT NULL,
        cover_asset_id BIGINT NULL,
        tags_json JSON NOT NULL DEFAULT (JSON_ARRAY()),
        dimensions_json JSON NULL,
        has_rig BOOLEAN NOT NULL DEFAULT FALSE,
        has_facial BOOLEAN NOT NULL DEFAULT FALSE,
        has_animations BOOLEAN NOT NULL DEFAULT FALSE,
        accessory_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        derivative_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        storage_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        status ENUM('active', 'archived', 'deleted') NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_furbin_item_uuid (item_uuid),
        UNIQUE KEY uniq_furbin_owner_asset (owner_id, asset_id),
        INDEX idx_furbin_owner (owner_id),
        INDEX idx_furbin_status (status),
        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
        FOREIGN KEY (asset_id, current_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (cover_asset_id) REFERENCES assets(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS fur_bin_collections (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        collection_uuid CHAR(36) NOT NULL,
        owner_id VARCHAR(190) NOT NULL,
        name VARCHAR(200) NOT NULL,
        description TEXT NULL,
        cover_asset_id BIGINT NULL,
        sort_order SMALLINT NOT NULL DEFAULT 0,
        status ENUM('active', 'archived', 'deleted') NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_collection_uuid (collection_uuid),
        INDEX idx_collection_owner (owner_id),
        FOREIGN KEY (cover_asset_id) REFERENCES assets(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS fur_bin_collection_items (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        collection_id BIGINT NOT NULL,
        item_id BIGINT NOT NULL,
        sort_order SMALLINT NOT NULL DEFAULT 0,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_collection_item (collection_id, item_id),
        FOREIGN KEY (collection_id) REFERENCES fur_bin_collections(id) ON DELETE CASCADE,
        FOREIGN KEY (item_id) REFERENCES fur_bin_items(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS fur_bin_tags (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        tag_name VARCHAR(100) NOT NULL,
        owner_id VARCHAR(190) NOT NULL,
        usage_count INT UNSIGNED NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_tag_owner (tag_name, owner_id),
        INDEX idx_tag_owner (owner_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS showcase_records (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        showcase_uuid CHAR(36) NOT NULL,
        owner_id VARCHAR(190) NOT NULL,
        fur_bin_item_id BIGINT NOT NULL,
        published_version_id BIGINT NOT NULL,
        title VARCHAR(300) NOT NULL,
        description TEXT NULL,
        tags_json JSON NOT NULL DEFAULT (JSON_ARRAY()),
        category VARCHAR(100) NOT NULL DEFAULT 'general',
        cover_asset_id BIGINT NULL,
        attribution TEXT NULL,
        rights_declaration VARCHAR(200) NOT NULL DEFAULT 'all_rights_reserved',
        commercial_eligible BOOLEAN NOT NULL DEFAULT FALSE,
        moderation_state ENUM('pending', 'approved', 'rejected', 'suspended') NOT NULL DEFAULT 'pending',
        moderation_notes TEXT NULL,
        view_count INT UNSIGNED NOT NULL DEFAULT 0,
        published_at TIMESTAMP NULL,
        unpublished_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_showcase_uuid (showcase_uuid),
        UNIQUE KEY uniq_showcase_item_version (fur_bin_item_id, published_version_id),
        INDEX idx_showcase_owner (owner_id),
        INDEX idx_showcase_moderation (moderation_state),
        INDEX idx_showcase_category (category),
        FOREIGN KEY (fur_bin_item_id) REFERENCES fur_bin_items(id) ON DELETE RESTRICT,
        FOREIGN KEY (published_version_id) REFERENCES asset_versions(id) ON DELETE RESTRICT,
        FOREIGN KEY (cover_asset_id) REFERENCES assets(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS moderation_history (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        showcase_id BIGINT NOT NULL,
        previous_state ENUM('pending', 'approved', 'rejected', 'suspended') NOT NULL,
        new_state ENUM('pending', 'approved', 'rejected', 'suspended') NOT NULL,
        moderator_id VARCHAR(190) NOT NULL,
        reason TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (showcase_id) REFERENCES showcase_records(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },
  {
    version: 25,
    name: "rig_worker_artifact_integrity",
    statements: [
      `CREATE TABLE IF NOT EXISTS rig_worker_attempts (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        rig_attempt_id BIGINT NOT NULL,
        attempt_uuid CHAR(36) NOT NULL,
        contract_version SMALLINT UNSIGNED NOT NULL,
        profile_id VARCHAR(120) NOT NULL,
        source_sha256 CHAR(64) NOT NULL,
        request_hash CHAR(64) NOT NULL,
        request_json JSON NOT NULL,
        response_hash CHAR(64) NULL,
        provider_task_id VARCHAR(255) NULL,
        state ENUM('created','submitted','processing','received','persisted','failed') NOT NULL DEFAULT 'created',
        warnings_json JSON NOT NULL DEFAULT (JSON_ARRAY()),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_rig_worker_attempt (rig_attempt_id),
        UNIQUE KEY uniq_rig_worker_attempt_uuid (attempt_uuid),
        UNIQUE KEY uniq_rig_worker_request_hash (request_hash),
        FOREIGN KEY (rig_attempt_id) REFERENCES rig_attempts(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS rig_attempt_artifacts (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        rig_attempt_id BIGINT NOT NULL,
        artifact_key VARCHAR(120) NOT NULL,
        role ENUM('rigged_glb','validation_manifest','facial_render_front','facial_render_three_quarter','accessory_glb','fused_print_glb') NOT NULL,
        asset_id BIGINT NOT NULL,
        asset_version_id BIGINT NOT NULL,
        computed_hash CHAR(64) NOT NULL,
        size_bytes BIGINT UNSIGNED NOT NULL,
        mime_type VARCHAR(120) NOT NULL,
        evidence_json JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_rig_attempt_artifact_key (rig_attempt_id, artifact_key),
        INDEX idx_rig_artifact_asset_version (asset_id, asset_version_id),
        FOREIGN KEY (rig_attempt_id) REFERENCES rig_attempts(id) ON DELETE RESTRICT,
        FOREIGN KEY (asset_id, asset_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS rig_worker_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        event_uuid CHAR(36) NOT NULL,
        rig_attempt_id BIGINT NOT NULL,
        event_type VARCHAR(80) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_rig_worker_event_uuid (event_uuid),
        UNIQUE KEY uniq_rig_worker_event_payload (rig_attempt_id, event_type, payload_hash),
        FOREIGN KEY (rig_attempt_id) REFERENCES rig_attempts(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },
  {
    version: 26,
    name: "fur_bin_version_evidence",
    statements: [
      `CREATE TABLE IF NOT EXISTS fur_bin_version_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        event_uuid CHAR(36) NOT NULL,
        item_id BIGINT NOT NULL,
        actor_id VARCHAR(190) NOT NULL,
        event_type ENUM('registered','current_changed','rollback','archived','restored') NOT NULL,
        from_version_id BIGINT NULL,
        to_version_id BIGINT NULL,
        evidence_hash CHAR(64) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_furbin_version_event_uuid (event_uuid),
        INDEX idx_furbin_version_event_item (item_id, created_at),
        FOREIGN KEY (item_id) REFERENCES fur_bin_items(id) ON DELETE RESTRICT,
        FOREIGN KEY (from_version_id) REFERENCES asset_versions(id) ON DELETE RESTRICT,
        FOREIGN KEY (to_version_id) REFERENCES asset_versions(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS fur_bin_badge_evidence (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        item_id BIGINT NOT NULL,
        asset_id BIGINT NOT NULL,
        asset_version_id BIGINT NOT NULL,
        badge_type ENUM('rigged','facial','animated','scaled','print_ready') NOT NULL,
        rule_id VARCHAR(128) NOT NULL,
        pass BOOLEAN NOT NULL,
        manifest_hash CHAR(64) NOT NULL,
        evidence_asset_version_id BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_furbin_badge_rule (item_id, asset_version_id, badge_type, rule_id),
        INDEX idx_furbin_badge_version (asset_id, asset_version_id),
        FOREIGN KEY (item_id) REFERENCES fur_bin_items(id) ON DELETE RESTRICT,
        FOREIGN KEY (asset_id, asset_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (evidence_asset_version_id) REFERENCES asset_versions(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS showcase_publication_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        event_uuid CHAR(36) NOT NULL,
        showcase_id BIGINT NOT NULL,
        event_type ENUM('submitted','published','unpublished','rejected','suspended') NOT NULL,
        public_version_id BIGINT NOT NULL,
        actor_id VARCHAR(190) NOT NULL,
        evidence_hash CHAR(64) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_showcase_publication_event (event_uuid),
        INDEX idx_showcase_publication_history (showcase_id, created_at),
        FOREIGN KEY (showcase_id) REFERENCES showcase_records(id) ON DELETE RESTRICT,
        FOREIGN KEY (public_version_id) REFERENCES asset_versions(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },
  {
    version: 27,
    name: "stationery_fulfillment_v2",
    statements: [
      `CREATE TABLE IF NOT EXISTS stationery_payment_evidence (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        payment_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        owner_id VARCHAR(190) NOT NULL,
        state ENUM('pending','paid','failed','refunded') NOT NULL,
        amount_minor BIGINT UNSIGNED NOT NULL,
        currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        provider VARCHAR(32) NOT NULL,
        provider_payment_ref VARCHAR(255) NOT NULL,
        confirmed_at DATETIME(3) NULL,
        evidence_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uniq_stationery_payment_uuid (payment_uuid),
        UNIQUE KEY uniq_stationery_provider_payment (provider, provider_payment_ref),
        INDEX idx_stationery_payment_owner (owner_id, state)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS stationery_template_versions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        template_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        version_number INT UNSIGNED NOT NULL,
        spec_json JSON NOT NULL,
        spec_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        status ENUM('active','retired') NOT NULL DEFAULT 'active',
        created_at DATETIME(3) NOT NULL,
        UNIQUE KEY uniq_stationery_template_version (template_uuid, version_number),
        INDEX idx_stationery_template_catalog (status, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS stationery_render_jobs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        owner_id VARCHAR(190) NOT NULL,
        template_version_id BIGINT NOT NULL,
        preset_id VARCHAR(64) NOT NULL,
        client_idempotency_key VARCHAR(190) NOT NULL,
        request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        request_json JSON NOT NULL,
        validation_report_json JSON NOT NULL,
        state ENUM('queued','dispatch_failed','rendering','ready','failed') NOT NULL DEFAULT 'queued',
        render_manifest_json JSON NULL,
        render_manifest_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        output_asset_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
        output_version_number INT UNSIGNED NULL,
        output_asset_id BIGINT NULL,
        output_asset_version_id BIGINT NULL,
        failure_code VARCHAR(120) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uniq_stationery_render_uuid (job_uuid),
        UNIQUE KEY uniq_stationery_render_idempotency (owner_id, client_idempotency_key),
        INDEX idx_stationery_render_owner (owner_id, created_at),
        INDEX idx_stationery_render_state (state, updated_at),
        FOREIGN KEY (template_version_id) REFERENCES stationery_template_versions(id) ON DELETE RESTRICT,
        FOREIGN KEY (output_asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
        FOREIGN KEY (output_asset_id, output_asset_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS stationery_render_outbox (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        render_job_id BIGINT NOT NULL,
        dispatch_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        payload_json JSON NOT NULL,
        state ENUM('pending','dispatched','failed') NOT NULL DEFAULT 'pending',
        attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
        available_at DATETIME(3) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uniq_stationery_outbox_job (render_job_id),
        UNIQUE KEY uniq_stationery_outbox_dispatch (dispatch_key),
        INDEX idx_stationery_outbox_ready (state, available_at),
        FOREIGN KEY (render_job_id) REFERENCES stationery_render_jobs(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS stationery_print_manifests (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        local_order_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        owner_id VARCHAR(190) NOT NULL,
        render_job_id BIGINT NOT NULL,
        client_idempotency_key VARCHAR(190) NOT NULL,
        request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        manifest_json JSON NOT NULL,
        manifest_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        payment_evidence_json JSON NOT NULL,
        created_at DATETIME(3) NOT NULL,
        UNIQUE KEY uniq_stationery_print_order (local_order_uuid),
        UNIQUE KEY uniq_stationery_print_idempotency (owner_id, client_idempotency_key),
        UNIQUE KEY uniq_stationery_print_manifest_hash (manifest_hash),
        INDEX idx_stationery_print_owner (owner_id, created_at),
        FOREIGN KEY (render_job_id) REFERENCES stationery_render_jobs(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS stationery_fulfillment_orders (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        local_order_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        print_manifest_id BIGINT NOT NULL,
        provider ENUM('printful','slant3d') NOT NULL,
        provider_idempotency_key VARCHAR(190) NOT NULL,
        payment_state ENUM('unpaid','paid','refunded') NOT NULL DEFAULT 'unpaid',
        state VARCHAR(40) NOT NULL,
        provider_order_id VARCHAR(200) NULL,
        applied_event_ids_json JSON NOT NULL,
        state_changed_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uniq_stationery_order_uuid (local_order_uuid),
        UNIQUE KEY uniq_stationery_provider_key (provider, provider_idempotency_key),
        INDEX idx_stationery_order_state (state, updated_at),
        INDEX idx_stationery_provider_order (provider, provider_order_id),
        FOREIGN KEY (local_order_uuid) REFERENCES stationery_print_manifests(local_order_uuid) ON DELETE RESTRICT,
        FOREIGN KEY (print_manifest_id) REFERENCES stationery_print_manifests(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS stationery_provider_event_claims (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        provider ENUM('printful','slant3d') NOT NULL,
        provider_event_id VARCHAR(200) NOT NULL,
        local_order_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        claimed_at DATETIME(3) NOT NULL,
        UNIQUE KEY uniq_stationery_event_claim (provider, provider_event_id),
        UNIQUE KEY uniq_stationery_event_claim_order (provider, provider_event_id, local_order_uuid),
        INDEX idx_stationery_event_claim_time (claimed_at),
        FOREIGN KEY (local_order_uuid) REFERENCES stationery_fulfillment_orders(local_order_uuid) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS stationery_provider_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        provider ENUM('printful','slant3d') NOT NULL,
        provider_event_id VARCHAR(200) NOT NULL,
        local_order_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        event_json JSON NOT NULL,
        disposition VARCHAR(40) NOT NULL,
        reason VARCHAR(300) NOT NULL,
        occurred_at DATETIME(3) NOT NULL,
        recorded_at DATETIME(3) NOT NULL,
        UNIQUE KEY uniq_stationery_provider_event (provider, provider_event_id),
        INDEX idx_stationery_event_order (local_order_uuid, recorded_at),
        FOREIGN KEY (local_order_uuid) REFERENCES stationery_fulfillment_orders(local_order_uuid) ON DELETE RESTRICT,
        FOREIGN KEY (provider, provider_event_id, local_order_uuid) REFERENCES stationery_provider_event_claims(provider, provider_event_id, local_order_uuid) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS stationery_reconciliation_runs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        reconciliation_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        local_order_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        requested_by_owner_id VARCHAR(190) NOT NULL,
        reason VARCHAR(300) NOT NULL,
        observation_json JSON NULL,
        decision_json JSON NOT NULL,
        created_at DATETIME(3) NOT NULL,
        UNIQUE KEY uniq_stationery_reconciliation (reconciliation_uuid),
        INDEX idx_stationery_reconciliation_order (local_order_uuid, created_at),
        FOREIGN KEY (local_order_uuid) REFERENCES stationery_fulfillment_orders(local_order_uuid) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },
  {
    version: 28,
    name: "wags_entitlements_v2",
    statements: [
      // Keep the existing wallet ledger authoritative. Fresh managed-migration
      // databases may not have run legacy boot DDL yet, while deployed databases
      // already have this table without an idempotency column.
      `CREATE TABLE IF NOT EXISTS credit_transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_phone VARCHAR(32) NOT NULL,
        delta INT NOT NULL,
        reason VARCHAR(80) NOT NULL,
        balance_after INT NOT NULL,
        idempotency_key VARCHAR(190) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_credit_transaction_user (user_phone),
        INDEX idx_credit_transaction_created (created_at),
        UNIQUE KEY uniq_credit_transaction_user_identity (id, user_phone),
        UNIQUE KEY uniq_credit_transaction_idempotency (idempotency_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `SELECT COUNT(*) INTO @credit_col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'credit_transactions' AND COLUMN_NAME = 'idempotency_key'`,
      `SET @stmt = IF(@credit_col_exists = 0, 'ALTER TABLE credit_transactions ADD COLUMN idempotency_key VARCHAR(190) NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @credit_idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'credit_transactions' AND INDEX_NAME = 'uniq_credit_transaction_idempotency'`,
      `SET @stmt = IF(@credit_idx_exists = 0, 'ALTER TABLE credit_transactions ADD UNIQUE KEY uniq_credit_transaction_idempotency (idempotency_key)', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @credit_identity_idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'credit_transactions' AND INDEX_NAME = 'uniq_credit_transaction_user_identity'`,
      `SET @stmt = IF(@credit_identity_idx_exists = 0, 'ALTER TABLE credit_transactions ADD UNIQUE KEY uniq_credit_transaction_user_identity (id, user_phone)', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `CREATE TABLE IF NOT EXISTS wags_owner_identities_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        owner_uuid CHAR(36) NOT NULL,
        auth_subject VARCHAR(32) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_wags_owner_uuid (owner_uuid),
        UNIQUE KEY uniq_wags_owner_auth_subject (auth_subject),
        UNIQUE KEY uniq_wags_owner_identity_subject (id, auth_subject)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS wags_plan_versions_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        plan_uuid CHAR(36) NOT NULL,
        version_number INT UNSIGNED NOT NULL,
        tier ENUM('basic','plus') NOT NULL,
        cadence ENUM('monthly','annual_prepaid') NOT NULL,
        provider ENUM('stripe') NOT NULL DEFAULT 'stripe',
        provider_price_ref VARCHAR(255) NOT NULL,
        plan_hash CHAR(64) NOT NULL,
        plan_json JSON NOT NULL,
        active BOOLEAN NOT NULL DEFAULT FALSE,
        published_at DATETIME(3) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_wags_plan_version (plan_uuid, version_number),
        UNIQUE KEY uniq_wags_plan_hash (plan_hash),
        UNIQUE KEY uniq_wags_provider_price (provider, provider_price_ref),
        UNIQUE KEY uniq_wags_plan_cadence (id, cadence),
        INDEX idx_wags_plan_catalog (active, tier, cadence, published_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS wags_pack_versions_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        pack_uuid CHAR(36) NOT NULL,
        version_number INT UNSIGNED NOT NULL,
        release_period CHAR(7) NOT NULL,
        title VARCHAR(160) NOT NULL,
        tier ENUM('basic','plus') NOT NULL,
        pack_hash CHAR(64) NOT NULL,
        pack_json JSON NOT NULL,
        published_at DATETIME(3) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_wags_pack_version (pack_uuid, version_number),
        UNIQUE KEY uniq_wags_pack_hash (pack_hash),
        UNIQUE KEY uniq_wags_pack_hash_identity (id, pack_hash),
        INDEX idx_wags_pack_catalog (release_period, tier, published_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS wags_subscriptions_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        subscription_uuid CHAR(36) NOT NULL,
        owner_identity_id BIGINT NOT NULL,
        plan_version_id BIGINT NOT NULL,
        cadence ENUM('monthly','annual_prepaid') NOT NULL,
        status ENUM('checkout_pending','active','past_due','cancel_at_period_end','canceled','expired') NOT NULL,
        provider ENUM('stripe') NOT NULL DEFAULT 'stripe',
        provider_subscription_ref VARCHAR(255) NULL,
        service_starts_at DATETIME(3) NOT NULL,
        service_ends_at DATETIME(3) NOT NULL,
        cancel_effective_at DATETIME(3) NULL,
        last_lifecycle_event_at DATETIME(3) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_wags_subscription_uuid (subscription_uuid),
        UNIQUE KEY uniq_wags_provider_subscription (provider, provider_subscription_ref),
        UNIQUE KEY uniq_wags_subscription_owner_identity (id, owner_identity_id),
        INDEX idx_wags_subscription_owner (owner_identity_id, status),
        INDEX idx_wags_subscription_plan (plan_version_id, status),
        CONSTRAINT chk_wags_subscription_interval CHECK (service_starts_at < service_ends_at),
        FOREIGN KEY (owner_identity_id) REFERENCES wags_owner_identities_v2(id) ON DELETE RESTRICT,
        FOREIGN KEY (plan_version_id, cadence) REFERENCES wags_plan_versions_v2(id, cadence) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS wags_lifecycle_events_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        subscription_id BIGINT NOT NULL,
        provider ENUM('stripe') NOT NULL DEFAULT 'stripe',
        source ENUM('webhook','reconciliation') NOT NULL,
        provider_event_id VARCHAR(200) NOT NULL,
        event_type VARCHAR(80) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        event_json JSON NOT NULL,
        state ENUM('received','processed','failed') NOT NULL DEFAULT 'received',
        disposition ENUM('applied','ignored_out_of_order','ignored_terminal') NULL,
        failure_code VARCHAR(80) NULL,
        occurred_at DATETIME(3) NOT NULL,
        received_at DATETIME(3) NOT NULL,
        processed_at DATETIME(3) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_wags_provider_event (provider, provider_event_id),
        UNIQUE KEY uniq_wags_lifecycle_subscription_identity (subscription_id, id),
        INDEX idx_wags_lifecycle_subscription (subscription_id, occurred_at),
        INDEX idx_wags_lifecycle_processing (state, received_at),
        FOREIGN KEY (subscription_id) REFERENCES wags_subscriptions_v2(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS wags_payment_coverage_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        payment_uuid CHAR(36) NOT NULL,
        subscription_id BIGINT NOT NULL,
        lifecycle_event_id BIGINT NOT NULL,
        provider_payment_ref VARCHAR(255) NULL,
        status ENUM('pending','paid','failed','refunded') NOT NULL,
        covers_from DATETIME(3) NOT NULL,
        covers_until DATETIME(3) NOT NULL,
        amount_minor BIGINT UNSIGNED NULL,
        currency CHAR(3) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_wags_payment_uuid (payment_uuid),
        UNIQUE KEY uniq_wags_payment_event (lifecycle_event_id),
        UNIQUE KEY uniq_wags_provider_payment (provider_payment_ref),
        UNIQUE KEY uniq_wags_payment_subscription_identity (subscription_id, id),
        INDEX idx_wags_payment_coverage (subscription_id, covers_from, covers_until),
        CONSTRAINT chk_wags_payment_interval CHECK (covers_from < covers_until),
        FOREIGN KEY (subscription_id) REFERENCES wags_subscriptions_v2(id) ON DELETE RESTRICT,
        FOREIGN KEY (subscription_id, lifecycle_event_id) REFERENCES wags_lifecycle_events_v2(subscription_id, id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS wags_entitlement_periods_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        period_uuid CHAR(36) NOT NULL,
        subscription_id BIGINT NOT NULL,
        period_key CHAR(7) NOT NULL,
        starts_at DATETIME(3) NOT NULL,
        ends_at DATETIME(3) NOT NULL,
        payment_coverage_id BIGINT NULL,
        state ENUM('pending_payment','paid','held','delivering','delivered','skipped') NOT NULL DEFAULT 'pending_payment',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_wags_period_uuid (period_uuid),
        UNIQUE KEY uniq_wags_subscription_period (subscription_id, period_key),
        UNIQUE KEY uniq_wags_period_delivery_identity (subscription_id, id, period_key),
        INDEX idx_wags_period_state (state, starts_at),
        CONSTRAINT chk_wags_period_interval CHECK (starts_at < ends_at),
        FOREIGN KEY (subscription_id) REFERENCES wags_subscriptions_v2(id) ON DELETE RESTRICT,
        FOREIGN KEY (subscription_id, payment_coverage_id) REFERENCES wags_payment_coverage_v2(subscription_id, id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS wags_incentive_policies_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        policy_uuid CHAR(36) NOT NULL,
        version_number INT UNSIGNED NOT NULL,
        incentive_sku VARCHAR(80) NOT NULL,
        policy_json JSON NOT NULL,
        policy_hash CHAR(64) NOT NULL,
        active_from DATETIME(3) NOT NULL,
        active_until DATETIME(3) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_wags_incentive_policy (policy_uuid, version_number),
        UNIQUE KEY uniq_wags_incentive_policy_hash (policy_hash),
        INDEX idx_wags_incentive_active (active_from, active_until),
        CONSTRAINT chk_wags_incentive_interval CHECK (active_until IS NULL OR active_from < active_until)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS wags_deliveries_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        delivery_identity VARCHAR(96) NOT NULL,
        subscription_id BIGINT NOT NULL,
        owner_identity_id BIGINT NOT NULL,
        period_key CHAR(7) NULL,
        entitlement_period_id BIGINT NULL,
        pack_version_id BIGINT NULL,
        pack_hash CHAR(64) NULL,
        policy_version_id BIGINT NULL,
        term_starts_at DATETIME(3) NULL,
        term_ends_at DATETIME(3) NULL,
        delivery_kind ENUM('monthly_pack','annual_incentive') NOT NULL DEFAULT 'monthly_pack',
        state ENUM('planned','granting','complete','reconciliation_required') NOT NULL DEFAULT 'planned',
        expected_grant_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        completed_at DATETIME(3) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_wags_delivery_identity (delivery_identity),
        UNIQUE KEY uniq_wags_delivery_owner_identity (id, owner_identity_id),
        UNIQUE KEY uniq_wags_period_pack (subscription_id, entitlement_period_id, pack_version_id, delivery_kind),
        UNIQUE KEY uniq_wags_annual_incentive (subscription_id, policy_version_id, term_starts_at, term_ends_at, delivery_kind),
        INDEX idx_wags_delivery_state (state, created_at),
        CONSTRAINT chk_wags_delivery_shape CHECK (
          (delivery_kind = 'monthly_pack' AND period_key IS NOT NULL AND entitlement_period_id IS NOT NULL AND pack_version_id IS NOT NULL AND pack_hash IS NOT NULL AND policy_version_id IS NULL AND term_starts_at IS NULL AND term_ends_at IS NULL)
          OR
          (delivery_kind = 'annual_incentive' AND period_key IS NULL AND entitlement_period_id IS NULL AND pack_version_id IS NULL AND pack_hash IS NULL AND policy_version_id IS NOT NULL AND term_starts_at IS NOT NULL AND term_ends_at IS NOT NULL AND term_starts_at < term_ends_at)
        ),
        FOREIGN KEY (subscription_id, owner_identity_id) REFERENCES wags_subscriptions_v2(id, owner_identity_id) ON DELETE RESTRICT,
        FOREIGN KEY (subscription_id, entitlement_period_id, period_key) REFERENCES wags_entitlement_periods_v2(subscription_id, id, period_key) ON DELETE RESTRICT,
        FOREIGN KEY (pack_version_id, pack_hash) REFERENCES wags_pack_versions_v2(id, pack_hash) ON DELETE RESTRICT,
        FOREIGN KEY (policy_version_id) REFERENCES wags_incentive_policies_v2(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS wags_grants_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        grant_identity VARCHAR(96) NOT NULL,
        delivery_id BIGINT NOT NULL,
        owner_identity_id BIGINT NOT NULL,
        owner_auth_subject VARCHAR(32) NOT NULL,
        slot_key VARCHAR(64) NOT NULL,
        disposition ENUM('primary','substitution','owned_fallback','replay') NOT NULL,
        deliverable_kind ENUM('asset','credits','benefit') NOT NULL,
        deliverable_json JSON NOT NULL,
        deliverable_hash CHAR(64) NOT NULL,
        asset_id BIGINT NULL,
        asset_version_id BIGINT NULL,
        credit_amount INT UNSIGNED NULL,
        credit_ledger_key VARCHAR(190) NULL,
        credit_transaction_id INT NULL,
        benefit_sku VARCHAR(80) NULL,
        benefit_quantity INT UNSIGNED NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_wags_grant_identity (grant_identity),
        UNIQUE KEY uniq_wags_delivery_slot (delivery_id, slot_key),
        UNIQUE KEY uniq_wags_credit_ledger_key (credit_ledger_key),
        UNIQUE KEY uniq_wags_credit_transaction (credit_transaction_id),
        INDEX idx_wags_grant_owner_asset (owner_identity_id, asset_id),
        CONSTRAINT chk_wags_grant_shape CHECK (
          (deliverable_kind = 'asset' AND asset_id IS NOT NULL AND asset_version_id IS NOT NULL AND credit_amount IS NULL AND credit_ledger_key IS NULL AND credit_transaction_id IS NULL AND benefit_sku IS NULL AND benefit_quantity IS NULL)
          OR
          (deliverable_kind = 'credits' AND asset_id IS NULL AND asset_version_id IS NULL AND credit_amount > 0 AND credit_ledger_key IS NOT NULL AND credit_transaction_id IS NOT NULL AND benefit_sku IS NULL AND benefit_quantity IS NULL)
          OR
          (deliverable_kind = 'benefit' AND asset_id IS NULL AND asset_version_id IS NULL AND credit_amount IS NULL AND credit_ledger_key IS NULL AND credit_transaction_id IS NULL AND benefit_sku IS NOT NULL AND benefit_quantity > 0)
        ),
        FOREIGN KEY (delivery_id, owner_identity_id) REFERENCES wags_deliveries_v2(id, owner_identity_id) ON DELETE RESTRICT,
        FOREIGN KEY (owner_identity_id, owner_auth_subject) REFERENCES wags_owner_identities_v2(id, auth_subject) ON DELETE RESTRICT,
        FOREIGN KEY (asset_id, asset_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS wags_checkout_sessions_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        checkout_uuid CHAR(36) NOT NULL,
        owner_identity_id BIGINT NOT NULL,
        plan_version_id BIGINT NOT NULL,
        idempotency_key VARCHAR(160) NOT NULL,
        request_hash CHAR(64) NOT NULL,
        request_json JSON NOT NULL,
        state ENUM('reserved','complete','failed') NOT NULL DEFAULT 'reserved',
        provider ENUM('stripe') NOT NULL DEFAULT 'stripe',
        provider_session_ref VARCHAR(255) NULL,
        checkout_url VARCHAR(2048) NULL,
        expires_at DATETIME(3) NULL,
        failure_code VARCHAR(80) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_wags_checkout_uuid (checkout_uuid),
        UNIQUE KEY uniq_wags_checkout_owner_idempotency (owner_identity_id, idempotency_key),
        UNIQUE KEY uniq_wags_checkout_provider_session (provider, provider_session_ref),
        INDEX idx_wags_checkout_state (state, created_at),
        CONSTRAINT chk_wags_checkout_complete CHECK (state <> 'complete' OR (provider_session_ref IS NOT NULL AND checkout_url IS NOT NULL AND expires_at IS NOT NULL)),
        FOREIGN KEY (owner_identity_id) REFERENCES wags_owner_identities_v2(id) ON DELETE RESTRICT,
        FOREIGN KEY (plan_version_id) REFERENCES wags_plan_versions_v2(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS wags_reconciliation_runs_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        run_uuid CHAR(36) NOT NULL,
        subscription_id BIGINT NOT NULL,
        reason ENUM('manual','scheduled','missing_webhook') NOT NULL,
        state ENUM('requested','fetching','applied','no_change','failed') NOT NULL DEFAULT 'requested',
        provider_event_id VARCHAR(200) NULL,
        lifecycle_event_id BIGINT NULL,
        snapshot_hash CHAR(64) NULL,
        snapshot_json JSON NULL,
        failure_code VARCHAR(80) NULL,
        started_at DATETIME(3) NOT NULL,
        completed_at DATETIME(3) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_wags_reconciliation_uuid (run_uuid),
        INDEX idx_wags_reconciliation_subscription (subscription_id, created_at),
        INDEX idx_wags_reconciliation_state (state, started_at),
        FOREIGN KEY (subscription_id) REFERENCES wags_subscriptions_v2(id) ON DELETE RESTRICT,
        FOREIGN KEY (subscription_id, lifecycle_event_id) REFERENCES wags_lifecycle_events_v2(subscription_id, id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // The deployed users table uses VARCHAR(32). Some legacy test/backup
      // schemas used wider keys, so add this FK only when the referenced type is compatible.
      `SELECT COUNT(*) INTO @users_fk_compatible FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'phone' AND DATA_TYPE = 'varchar' AND CHARACTER_MAXIMUM_LENGTH = 32`,
      `SELECT COUNT(*) INTO @owner_fk_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wags_owner_identities_v2' AND CONSTRAINT_NAME = 'fk_wags_owner_user'`,
      `SET @stmt = IF(@users_fk_compatible > 0 AND @owner_fk_exists = 0, 'ALTER TABLE wags_owner_identities_v2 ADD CONSTRAINT fk_wags_owner_user FOREIGN KEY (auth_subject) REFERENCES users(phone) ON DELETE RESTRICT', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @grant_credit_fk_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wags_grants_v2' AND CONSTRAINT_NAME = 'fk_wags_grant_credit_transaction'`,
      `SELECT COUNT(*) INTO @grant_credit_fk_compatible
         FROM information_schema.COLUMNS child_id
         JOIN information_schema.COLUMNS parent_id
           ON parent_id.TABLE_SCHEMA = child_id.TABLE_SCHEMA
          AND parent_id.TABLE_NAME = 'credit_transactions' AND parent_id.COLUMN_NAME = 'id'
         JOIN information_schema.COLUMNS child_owner
           ON child_owner.TABLE_SCHEMA = child_id.TABLE_SCHEMA
          AND child_owner.TABLE_NAME = 'wags_grants_v2' AND child_owner.COLUMN_NAME = 'owner_auth_subject'
         JOIN information_schema.COLUMNS parent_owner
           ON parent_owner.TABLE_SCHEMA = child_id.TABLE_SCHEMA
          AND parent_owner.TABLE_NAME = 'credit_transactions' AND parent_owner.COLUMN_NAME = 'user_phone'
        WHERE child_id.TABLE_SCHEMA = DATABASE()
          AND child_id.TABLE_NAME = 'wags_grants_v2' AND child_id.COLUMN_NAME = 'credit_transaction_id'
          AND child_id.COLUMN_TYPE = parent_id.COLUMN_TYPE
          AND child_owner.COLUMN_TYPE = parent_owner.COLUMN_TYPE
          AND child_owner.CHARACTER_SET_NAME = parent_owner.CHARACTER_SET_NAME
          AND child_owner.COLLATION_NAME = parent_owner.COLLATION_NAME`,
      `SET @stmt = IF(@grant_credit_fk_compatible > 0 AND @grant_credit_fk_exists = 0, 'ALTER TABLE wags_grants_v2 ADD CONSTRAINT fk_wags_grant_credit_transaction FOREIGN KEY (credit_transaction_id, owner_auth_subject) REFERENCES credit_transactions(id, user_phone) ON DELETE RESTRICT', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 29,
    name: "durable_bim_builds_v2",
    statements: [
      `CREATE TABLE IF NOT EXISTS bim_build_jobs_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_uuid CHAR(36) NOT NULL,
        owner_id VARCHAR(190) NOT NULL,
        mode ENUM('shell','ifc') NOT NULL,
        state ENUM('queued','claimed','processing','validating','ready','accepted','failed_retryable','failed_terminal','cancelled') NOT NULL DEFAULT 'queued',
        idempotency_key VARCHAR(200) NOT NULL,
        model_hash CHAR(64) NOT NULL,
        calibration_hash CHAR(64) NOT NULL,
        proposal_hash CHAR(64) NOT NULL,
        accepted_proposal_hash CHAR(64) NOT NULL,
        prebuild_report_hash CHAR(64) NOT NULL,
        quoted_credits INT UNSIGNED NOT NULL,
        current_attempt_id BIGINT NULL,
        retry_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
        failure_code VARCHAR(80) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_bim_v2_job_uuid (job_uuid),
        UNIQUE KEY uniq_bim_v2_idempotency (owner_id, idempotency_key),
        UNIQUE KEY uniq_bim_v2_job_current_attempt (id, current_attempt_id),
        INDEX idx_bim_v2_owner_state (owner_id, state)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS bim_build_attempts_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        attempt_uuid CHAR(36) NOT NULL,
        job_id BIGINT NOT NULL,
        attempt_number TINYINT UNSIGNED NOT NULL,
        state ENUM('queued','claimed','processing','validating','ready','failed_retryable','failed_terminal','cancelled') NOT NULL DEFAULT 'queued',
        command_json JSON NOT NULL,
        command_hash CHAR(64) NOT NULL,
        provider_task_id VARCHAR(255) NULL,
        worker_lease_owner VARCHAR(120) NULL,
        worker_lease_expiry TIMESTAMP NULL,
        failure_code VARCHAR(80) NULL,
        failure_detail TEXT NULL,
        started_at TIMESTAMP NULL,
        completed_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_bim_v2_attempt_uuid (attempt_uuid),
        UNIQUE KEY uniq_bim_v2_attempt_number (job_id, attempt_number),
        UNIQUE KEY uniq_bim_v2_attempt_identity (job_id, id),
        INDEX idx_bim_v2_attempt_lease (state, worker_lease_expiry),
        FOREIGN KEY (job_id) REFERENCES bim_build_jobs_v2(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS bim_verification_reports_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        attempt_id BIGINT NOT NULL,
        stage ENUM('prebuild','postbuild') NOT NULL,
        mode ENUM('shell','ifc') NOT NULL,
        report_hash CHAR(64) NOT NULL,
        model_hash CHAR(64) NOT NULL,
        calibration_hash CHAR(64) NOT NULL,
        overall_pass BOOLEAN NOT NULL,
        report_json JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_bim_v2_report_stage (attempt_id, stage),
        UNIQUE KEY uniq_bim_v2_report_hash (report_hash),
        FOREIGN KEY (attempt_id) REFERENCES bim_build_attempts_v2(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS bim_build_artifacts_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        attempt_id BIGINT NOT NULL,
        role ENUM('shell_glb','ifc','semantic_glb','semantic_sidecar','validation_report') NOT NULL,
        asset_id BIGINT NOT NULL,
        asset_version_id BIGINT NOT NULL,
        sha256 CHAR(64) NOT NULL,
        size_bytes BIGINT UNSIGNED NOT NULL,
        mime_type VARCHAR(120) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_bim_v2_artifact_role (attempt_id, role),
        FOREIGN KEY (attempt_id) REFERENCES bim_build_attempts_v2(id) ON DELETE RESTRICT,
        FOREIGN KEY (asset_id, asset_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS bim_build_acceptances_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_id BIGINT NOT NULL,
        attempt_id BIGINT NOT NULL,
        postbuild_report_id BIGINT NOT NULL,
        accepted_by_user VARCHAR(190) NOT NULL,
        output_manifest_hash CHAR(64) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_bim_v2_acceptance_job (job_id),
        FOREIGN KEY (job_id) REFERENCES bim_build_jobs_v2(id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES bim_build_attempts_v2(id) ON DELETE RESTRICT,
        FOREIGN KEY (postbuild_report_id) REFERENCES bim_verification_reports_v2(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS bim_credit_events_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        event_uuid CHAR(36) NOT NULL,
        job_id BIGINT NOT NULL,
        attempt_id BIGINT NULL,
        owner_id VARCHAR(190) NOT NULL,
        event_type ENUM('quote','debit','refund','reconciliation') NOT NULL,
        amount_credits INT NOT NULL,
        idempotency_key VARCHAR(200) NOT NULL,
        state ENUM('pending','committed','failed','unknown') NOT NULL,
        evidence_hash CHAR(64) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_bim_v2_credit_event_uuid (event_uuid),
        UNIQUE KEY uniq_bim_v2_credit_idempotency (idempotency_key),
        INDEX idx_bim_v2_credit_job (job_id, event_type, state),
        FOREIGN KEY (job_id) REFERENCES bim_build_jobs_v2(id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES bim_build_attempts_v2(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS bim_worker_events_v2 (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        event_uuid CHAR(36) NOT NULL,
        attempt_id BIGINT NOT NULL,
        event_type VARCHAR(80) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_bim_v2_worker_event_uuid (event_uuid),
        UNIQUE KEY uniq_bim_v2_worker_event_payload (attempt_id, event_type, payload_hash),
        FOREIGN KEY (attempt_id) REFERENCES bim_build_attempts_v2(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `SELECT COUNT(*) INTO @fk_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bim_build_jobs_v2' AND CONSTRAINT_NAME = 'fk_bim_v2_current_attempt'`,
      `SET @stmt = IF(@fk_exists = 0, 'ALTER TABLE bim_build_jobs_v2 ADD CONSTRAINT fk_bim_v2_current_attempt FOREIGN KEY (id, current_attempt_id) REFERENCES bim_build_attempts_v2(job_id, id) ON DELETE RESTRICT', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 30,
    name: "create_pipeline_rig_recovery_leases",
    skipWhenTableMissing: "generation_jobs",
    statements: [
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_jobs' AND COLUMN_NAME = 'rig_attempt_count'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE generation_jobs ADD COLUMN rig_attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_jobs' AND COLUMN_NAME = 'recovery_lease_owner'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE generation_jobs ADD COLUMN recovery_lease_owner VARCHAR(128) NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_jobs' AND COLUMN_NAME = 'recovery_lease_expires_at'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE generation_jobs ADD COLUMN recovery_lease_expires_at DATETIME(3) NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_jobs' AND COLUMN_NAME = 'recovery_started_at'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE generation_jobs ADD COLUMN recovery_started_at DATETIME(3) NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_jobs' AND COLUMN_NAME = 'recovery_last_heartbeat_at'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE generation_jobs ADD COLUMN recovery_last_heartbeat_at DATETIME(3) NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_jobs' AND COLUMN_NAME = 'recovery_reason'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE generation_jobs ADD COLUMN recovery_reason VARCHAR(255) NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_jobs' AND COLUMN_NAME = 'rig_source_model_hash'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE generation_jobs ADD COLUMN rig_source_model_hash CHAR(64) NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_jobs' AND COLUMN_NAME = 'rig_refunded_at'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE generation_jobs ADD COLUMN rig_refunded_at DATETIME(3) NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_jobs' AND COLUMN_NAME = 'generation_refunded_at'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE generation_jobs ADD COLUMN generation_refunded_at DATETIME(3) NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_jobs' AND INDEX_NAME = 'idx_generation_jobs_recovery_lease'`,
      `SET @stmt = IF(@idx_exists = 0, 'ALTER TABLE generation_jobs ADD INDEX idx_generation_jobs_recovery_lease (status, recovery_lease_expires_at, updated_at)', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 31,
    name: "inhouse_spatial_generator",
    statements: [
      `CREATE TABLE IF NOT EXISTS spatial_generation_jobs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_uuid CHAR(36) NOT NULL,
        owner_phone VARCHAR(32) NOT NULL,
        subject_kind ENUM('accessory','hard_surface') NOT NULL,
        target_use ENUM('digital','attachment','print') NOT NULL,
        state ENUM('draft','observing','planning','awaiting_math_worker','validating_math','building_draft','verifying_draft','awaiting_human_review','correction_requested','approved','finalizing','completed','failed','cancelled') NOT NULL DEFAULT 'draft',
        current_attempt_id BIGINT NULL,
        credits_reserved INT UNSIGNED NOT NULL DEFAULT 0,
        credits_disposition ENUM('reserved','charged','refunded','none') NOT NULL DEFAULT 'none',
        idempotency_key VARCHAR(128) NOT NULL,
        failure_code VARCHAR(64) NULL,
        failure_detail VARCHAR(512) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_spatial_job_uuid (job_uuid),
        UNIQUE KEY uniq_spatial_job_idempotency (owner_phone, idempotency_key),
        INDEX idx_spatial_job_owner (owner_phone, state),
        CONSTRAINT chk_spatial_credits_reserved CHECK (credits_reserved >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS spatial_generation_inputs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_id BIGINT NOT NULL UNIQUE,
        prompt TEXT NOT NULL,
        target_envelope_mm JSON NOT NULL,
        scale_anchor JSON NULL,
        attachment_interface JSON NULL,
        reference_asset_version_ids JSON NOT NULL DEFAULT (JSON_ARRAY()),
        input_hash CHAR(64) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (job_id) REFERENCES spatial_generation_jobs(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS spatial_generation_attempts (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_id BIGINT NOT NULL,
        attempt_number TINYINT UNSIGNED NOT NULL,
        idempotency_key CHAR(36) NOT NULL,
        state ENUM('queued','observing','planning','awaiting_math','validating_math','compiling','building_draft','verifying_draft','awaiting_review','correction_requested','finalizing','completed','failed','cancelled') NOT NULL DEFAULT 'queued',
        observation_json JSON NULL,
        observation_hash CHAR(64) NULL,
        plan_json JSON NULL,
        plan_hash CHAR(64) NULL,
        math_json JSON NULL,
        math_hash CHAR(64) NULL,
        compiled_program_hash CHAR(64) NULL,
        automated_report_json JSON NULL,
        automated_report_hash CHAR(64) NULL,
        lease_owner VARCHAR(120) NULL,
        lease_expires_at TIMESTAMP NULL,
        last_heartbeat_at TIMESTAMP NULL,
        started_at TIMESTAMP NULL,
        completed_at TIMESTAMP NULL,
        failure_code VARCHAR(64) NULL,
        error_message TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_spatial_attempt_job_number (job_id, attempt_number),
        UNIQUE KEY uniq_spatial_attempt_idempotency (idempotency_key),
        UNIQUE KEY uniq_spatial_attempt_identity (job_id, id),
        INDEX idx_spatial_attempt_state (state),
        INDEX idx_spatial_attempt_lease (state, lease_expires_at),
        FOREIGN KEY (job_id) REFERENCES spatial_generation_jobs(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS spatial_generation_artifacts (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        attempt_id BIGINT NOT NULL,
        asset_id BIGINT NOT NULL,
        asset_version_id BIGINT NOT NULL,
        role ENUM('reference_front','reference_right','reference_back','reference_left','draft_glb','draft_render_front','draft_render_right','draft_render_back','draft_render_left','draft_render_three_quarter','final_glb','final_stl','manufacturing_report') NOT NULL,
        computed_hash CHAR(64) NOT NULL,
        size_bytes BIGINT NOT NULL,
        mime_type VARCHAR(120) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_spatial_artifact_role (attempt_id, role),
        UNIQUE KEY uniq_spatial_artifact_identity (attempt_id, id),
        CONSTRAINT chk_spatial_artifact_size CHECK (size_bytes >= 0),
        FOREIGN KEY (attempt_id) REFERENCES spatial_generation_attempts(id) ON DELETE CASCADE,
        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
        FOREIGN KEY (asset_id, asset_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS spatial_generation_reviews (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_id BIGINT NOT NULL,
        attempt_id BIGINT NOT NULL,
        attempt_hash CHAR(64) NOT NULL,
        report_hash CHAR(64) NOT NULL,
        owner_phone VARCHAR(32) NOT NULL,
        decision ENUM('approve','request_correction') NOT NULL,
        correction_tags JSON NOT NULL DEFAULT (JSON_ARRAY()),
        comment TEXT NULL,
        actor_audit_hash CHAR(64) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_spatial_review_job_attempt (job_id, attempt_id),
        FOREIGN KEY (job_id) REFERENCES spatial_generation_jobs(id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES spatial_generation_attempts(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS spatial_generation_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        event_uuid CHAR(36) NOT NULL,
        job_id BIGINT NOT NULL,
        attempt_id BIGINT NULL,
        event_type VARCHAR(80) NOT NULL,
        payload_json JSON NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_spatial_event_uuid (event_uuid),
        UNIQUE KEY uniq_spatial_event_payload (job_id, attempt_id, event_type, payload_hash),
        INDEX idx_spatial_event_job (job_id, created_at),
        FOREIGN KEY (job_id) REFERENCES spatial_generation_jobs(id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES spatial_generation_attempts(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `SELECT COUNT(*) INTO @fk_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'spatial_generation_jobs' AND CONSTRAINT_NAME = 'fk_spatial_job_current_attempt'`,
      `SET @stmt = IF(@fk_exists = 0, 'ALTER TABLE spatial_generation_jobs ADD CONSTRAINT fk_spatial_job_current_attempt FOREIGN KEY (id, current_attempt_id) REFERENCES spatial_generation_attempts(job_id, id) ON DELETE RESTRICT', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 32,
    name: "durable_model_persistence",
    skipWhenTableMissing: "generation_jobs",
    statements: [
      `CREATE TABLE IF NOT EXISTS model_persistence_events (
        id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_id              BIGINT NULL,
        model_build_job_uuid VARCHAR(36) NULL,
        event_type          VARCHAR(64) NOT NULL,
        detail              VARCHAR(512) NULL,
        asset_uuid          CHAR(36) NULL,
        created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_persist_events_job (job_id),
        INDEX idx_persist_events_type (event_type, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_jobs' AND COLUMN_NAME = 'canonical_asset_uuid'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE generation_jobs ADD COLUMN canonical_asset_uuid CHAR(36) NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_jobs' AND COLUMN_NAME = 'done_static_fallback_at'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE generation_jobs ADD COLUMN done_static_fallback_at DATETIME(3) NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 33,
    name: "customizer_tables_adoption",
    statements: [
      `CREATE TABLE IF NOT EXISTS customizable_products (
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS customize_orders (
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
        INDEX idx_custorder_user (user_phone)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },
  {
    version: 34,
    name: "wags_box_item_assets",
    skipWhenTableMissing: "wardrobe_wags_box_items",
    statements: [
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wardrobe_wags_box_items' AND COLUMN_NAME = 'asset_url'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE wardrobe_wags_box_items ADD COLUMN asset_url TEXT NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wardrobe_wags_box_items' AND COLUMN_NAME = 'asset_status'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE wardrobe_wags_box_items ADD COLUMN asset_status ENUM(''none'',''pending'',''generated'',''failed'') NOT NULL DEFAULT ''none''', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wardrobe_wags_box_items' AND COLUMN_NAME = 'asset_error'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE wardrobe_wags_box_items ADD COLUMN asset_error VARCHAR(255) NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wardrobe_wags_box_items' AND COLUMN_NAME = 'asset_generated_at'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE wardrobe_wags_box_items ADD COLUMN asset_generated_at DATETIME NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 35,
    name: "spatial_attempt_idempotency_key",
    skipWhenTableMissing: "spatial_generation_attempts",
    statements: [
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'spatial_generation_attempts' AND COLUMN_NAME = 'idempotency_key'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE spatial_generation_attempts ADD COLUMN idempotency_key CHAR(36) NOT NULL DEFAULT \"\" AFTER attempt_number', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'spatial_generation_attempts' AND INDEX_NAME = 'uniq_spatial_attempt_idempotency'`,
      `SET @stmt = IF(@idx_exists = 0, 'ALTER TABLE spatial_generation_attempts ADD UNIQUE KEY uniq_spatial_attempt_idempotency (idempotency_key)', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    // NOTE: version 36 is the BO-4 Nurse-Saul maturity index, which lives on
    // phase/bo-4-spatial-generator. Numbering is intentionally left clear for
    // it; the runner applies by version number and tolerates the gap until
    // that branch merges.
    version: 37,
    name: "pet_glb_orders_and_provider_jobs",
    statements: [
      `CREATE TABLE IF NOT EXISTS provider_generation_jobs (
         job_id CHAR(36) NOT NULL PRIMARY KEY,
         order_id BIGINT NULL,
         provider_id VARCHAR(40) NOT NULL,
         provider_version VARCHAR(80) NOT NULL,
         provider_task_handle VARCHAR(190) NOT NULL,
         model VARCHAR(120) NOT NULL DEFAULT '',
         config_hash CHAR(64) NOT NULL DEFAULT '',
         cancelled TINYINT(1) NOT NULL DEFAULT 0,
         glb_url TEXT NULL,
         created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         KEY idx_pgj_order (order_id),
         KEY idx_pgj_handle (provider_task_handle)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS pet_glb_orders (
         id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
         order_uuid CHAR(36) NOT NULL,
         owner_phone VARCHAR(32) NOT NULL,
         sku VARCHAR(64) NOT NULL,
         state VARCHAR(40) NOT NULL DEFAULT 'draft',
         reference_session_id BIGINT NULL,
         generation_job_id CHAR(36) NULL,
         asset_id BIGINT NULL,
         approved_version_id BIGINT NULL,
         credits_reserved INT NOT NULL DEFAULT 0,
         credits_disposition ENUM('reserved','charged','refunded','none') NOT NULL DEFAULT 'none',
         delivered_at DATETIME NULL,
         created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         UNIQUE KEY uniq_pet_glb_order_uuid (order_uuid),
         KEY idx_pgo_owner_state (owner_phone, state),
         KEY idx_pgo_state_created (state, created_at)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS pet_glb_order_events (
         id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
         order_id BIGINT NOT NULL,
         from_state VARCHAR(40) NULL,
         to_state VARCHAR(40) NOT NULL,
         actor_type ENUM('system','customer','operator') NOT NULL DEFAULT 'system',
         actor_id VARCHAR(64) NULL,
         reason VARCHAR(190) NULL,
         request_id CHAR(36) NULL,
         job_id CHAR(36) NULL,
         created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         KEY idx_pgoe_order_created (order_id, created_at)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // Inbound Stripe replay defence. Stripe's idempotencyKey protects
      // OUTBOUND calls only; a redelivered event must be a no-op here.
      `CREATE TABLE IF NOT EXISTS stripe_event_ledger (
         event_id VARCHAR(190) NOT NULL PRIMARY KEY,
         event_type VARCHAR(80) NOT NULL,
         order_id BIGINT NULL,
         processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // SALTI forward-compatibility (populated at G10; UNMEASURED until then).
      // salti_margin is signed and numerically compared, so DECIMAL not VARCHAR.
      // Operator role. Deliberately NOT is_admin — an existing admin bypass
      // must not silently satisfy mandatory operator approval.
      `SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_operator'`,
      `SET @stmt = IF(@c = 0, 'ALTER TABLE users ADD COLUMN is_operator TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asset_versions' AND COLUMN_NAME = 'salti_condition'`,
      `SET @stmt = IF(@c = 0, 'ALTER TABLE asset_versions ADD COLUMN salti_condition JSON NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asset_versions' AND COLUMN_NAME = 'salti_damage'`,
      `SET @stmt = IF(@c = 0, 'ALTER TABLE asset_versions ADD COLUMN salti_damage JSON NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asset_versions' AND COLUMN_NAME = 'salti_margin'`,
      `SET @stmt = IF(@c = 0, 'ALTER TABLE asset_versions ADD COLUMN salti_margin DECIMAL(6,3) NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    // Multi-stage Tripo animation pipeline (base -> rig -> idle/walk -> merge).
    // The adapter persists which stage a job is in plus the rig/retarget task
    // handles and the idle/walk GLB URLs, so an animated build survives across
    // poll calls / restarts. All internal; never selected toward a caller.
    version: 38,
    name: "provider_generation_jobs_animation_stages",
    skipWhenTableMissing: "provider_generation_jobs",
    statements: [
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'provider_generation_jobs' AND COLUMN_NAME = 'stage'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE provider_generation_jobs ADD COLUMN stage VARCHAR(16) NULL, ADD COLUMN rig_task_handle VARCHAR(190) NULL, ADD COLUMN idle_task_handle VARCHAR(190) NULL, ADD COLUMN walk_task_handle VARCHAR(190) NULL, ADD COLUMN idle_glb_url TEXT NULL, ADD COLUMN walk_glb_url TEXT NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 39,
    name: "pet_glb_customer_gated_stages",
    skipWhenTableMissing: "pet_glb_orders",
    statements: [
      `SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_glb_orders' AND COLUMN_NAME = 'mesh_profile'`,
      `SET @stmt = IF(@c = 0, 'ALTER TABLE pet_glb_orders ADD COLUMN mesh_profile VARCHAR(24) NOT NULL DEFAULT ''hd''', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_glb_orders' AND COLUMN_NAME = 'subject_profile'`,
      `SET @stmt = IF(@c = 0, 'ALTER TABLE pet_glb_orders ADD COLUMN subject_profile VARCHAR(24) NOT NULL DEFAULT ''pet''', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_glb_orders' AND COLUMN_NAME = 'include_texture'`,
      `SET @stmt = IF(@c = 0, 'ALTER TABLE pet_glb_orders ADD COLUMN include_texture TINYINT(1) NOT NULL DEFAULT 1', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_glb_orders' AND COLUMN_NAME = 'include_rig'`,
      `SET @stmt = IF(@c = 0, 'ALTER TABLE pet_glb_orders ADD COLUMN include_rig TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_glb_orders' AND COLUMN_NAME = 'texture_quality'`,
      `SET @stmt = IF(@c = 0, 'ALTER TABLE pet_glb_orders ADD COLUMN texture_quality VARCHAR(24) NOT NULL DEFAULT ''standard''', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_glb_orders' AND COLUMN_NAME = 'style_direction'`,
      `SET @stmt = IF(@c = 0, 'ALTER TABLE pet_glb_orders ADD COLUMN style_direction VARCHAR(400) NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_glb_orders' AND COLUMN_NAME = 'reference_manifest_json'`,
      `SET @stmt = IF(@c = 0, 'ALTER TABLE pet_glb_orders ADD COLUMN reference_manifest_json JSON NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_glb_orders' AND COLUMN_NAME = 'reference_manifest_hash'`,
      `SET @stmt = IF(@c = 0, 'ALTER TABLE pet_glb_orders ADD COLUMN reference_manifest_hash CHAR(64) NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_glb_orders' AND COLUMN_NAME = 'current_stage'`,
      `SET @stmt = IF(@c = 0, 'ALTER TABLE pet_glb_orders ADD COLUMN current_stage VARCHAR(24) NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_glb_orders' AND COLUMN_NAME = 'current_stage_attempt_id'`,
      `SET @stmt = IF(@c = 0, 'ALTER TABLE pet_glb_orders ADD COLUMN current_stage_attempt_id BIGINT NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_glb_orders' AND COLUMN_NAME = 'final_customer_version_id'`,
      `SET @stmt = IF(@c = 0, 'ALTER TABLE pet_glb_orders ADD COLUMN final_customer_version_id BIGINT NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `CREATE TABLE IF NOT EXISTS pet_glb_stage_attempts (
         id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
         attempt_uuid CHAR(36) NOT NULL,
         order_id BIGINT NOT NULL,
         stage VARCHAR(24) NOT NULL,
         attempt_number INT NOT NULL,
         state VARCHAR(40) NOT NULL,
         input_hash CHAR(64) NOT NULL,
         source_attempt_id BIGINT NULL,
         provider_job_id CHAR(36) NULL,
         asset_id BIGINT NULL,
         asset_version_id BIGINT NULL,
         artifact_sha256 CHAR(64) NULL,
         validation_report_json JSON NULL,
         validation_report_sha256 CHAR(64) NULL,
         capability_report_json JSON NULL,
         price_credits INT NOT NULL DEFAULT 0,
         credits_disposition ENUM('none','charged','refunded') NOT NULL DEFAULT 'none',
         charge_idempotency_key VARCHAR(190) NULL,
         approval_idempotency_key VARCHAR(190) NULL,
         approval_hash CHAR(64) NULL,
         approved_by VARCHAR(32) NULL,
         approved_at DATETIME NULL,
         rejection_reason VARCHAR(500) NULL,
         failure_code VARCHAR(80) NULL,
         created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         UNIQUE KEY uniq_pet_glb_stage_uuid (attempt_uuid),
         UNIQUE KEY uniq_pet_glb_stage_number (order_id, stage, attempt_number),
         UNIQUE KEY uniq_pet_glb_stage_order_identity (order_id, id),
         UNIQUE KEY uniq_pet_glb_stage_charge_key (charge_idempotency_key),
         UNIQUE KEY uniq_pet_glb_stage_approval_key (approval_idempotency_key),
         KEY idx_pet_glb_stage_order_current (order_id, state, created_at),
         KEY idx_pet_glb_stage_provider_job (provider_job_id),
         CONSTRAINT fk_pet_glb_stage_order
           FOREIGN KEY (order_id) REFERENCES pet_glb_orders(id) ON DELETE RESTRICT,
         CONSTRAINT fk_pet_glb_stage_source
           FOREIGN KEY (source_attempt_id) REFERENCES pet_glb_stage_attempts(id) ON DELETE RESTRICT,
         CONSTRAINT fk_pet_glb_stage_provider_job
           FOREIGN KEY (provider_job_id) REFERENCES provider_generation_jobs(job_id) ON DELETE RESTRICT,
         CONSTRAINT fk_pet_glb_stage_asset_version
           FOREIGN KEY (asset_id, asset_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `SELECT COUNT(*) INTO @fk_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_glb_orders' AND CONSTRAINT_NAME = 'fk_pet_glb_order_current_stage'`,
      `SET @stmt = IF(@fk_exists = 0, 'ALTER TABLE pet_glb_orders ADD CONSTRAINT fk_pet_glb_order_current_stage FOREIGN KEY (id, current_stage_attempt_id) REFERENCES pet_glb_stage_attempts(order_id, id) ON DELETE RESTRICT', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @fk_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_glb_orders' AND CONSTRAINT_NAME = 'fk_pet_glb_order_final_customer_version'`,
      `SET @stmt = IF(@fk_exists = 0, 'ALTER TABLE pet_glb_orders ADD CONSTRAINT fk_pet_glb_order_final_customer_version FOREIGN KEY (asset_id, final_customer_version_id) REFERENCES asset_versions(asset_id, id) ON DELETE RESTRICT', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 40,
    name: "model_build_durability_recovery",
    statements: [
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'model_build_jobs' AND COLUMN_NAME = 'refund_pending_at'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE model_build_jobs ADD COLUMN refund_pending_at TIMESTAMP NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'model_build_jobs' AND COLUMN_NAME = 'refund_attempts'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE model_build_jobs ADD COLUMN refund_attempts INT NOT NULL DEFAULT 0', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'model_build_jobs' AND COLUMN_NAME = 'last_refund_error_code'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE model_build_jobs ADD COLUMN last_refund_error_code VARCHAR(120) NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'model_build_attempts' AND COLUMN_NAME = 'submission_claimed_at'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE model_build_attempts ADD COLUMN submission_claimed_at TIMESTAMP NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'model_build_attempts' AND COLUMN_NAME = 'recovery_required_at'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE model_build_attempts ADD COLUMN recovery_required_at TIMESTAMP NULL', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'model_build_attempts' AND COLUMN_NAME = 'handle_persist_attempts'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE model_build_attempts ADD COLUMN handle_persist_attempts INT NOT NULL DEFAULT 0', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'model_build_jobs' AND INDEX_NAME = 'idx_model_build_refund_sweep'`,
      `SET @stmt = IF(@idx_exists = 0, 'ALTER TABLE model_build_jobs ADD INDEX idx_model_build_refund_sweep (state, refund_correlation_id, refund_pending_at)', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'model_build_attempts' AND INDEX_NAME = 'idx_model_build_recovery_sweep'`,
      `SET @stmt = IF(@idx_exists = 0, 'ALTER TABLE model_build_attempts ADD INDEX idx_model_build_recovery_sweep (state, provider_task_handle, recovery_required_at)', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 41,
    name: "reference_source_attempt_allowance",
    statements: [
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reference_sessions' AND COLUMN_NAME = 'source_attempt_count'`,
      `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE reference_sessions ADD COLUMN source_attempt_count INT NOT NULL DEFAULT 0 AFTER approved_attempt_id', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      // Existing sessions must keep their already-consumed allowance. Only an
      // explicit, owner-authorized source replacement may reset this counter.
      `UPDATE reference_sessions SET source_attempt_count = retry_count WHERE source_attempt_count = 0 AND retry_count > 0`,

      `SELECT COUNT(*) INTO @check_exists FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reference_sessions' AND CONSTRAINT_NAME = 'chk_ref_source_attempt_count'`,
      `SET @stmt = IF(@check_exists = 0, 'ALTER TABLE reference_sessions ADD CONSTRAINT chk_ref_source_attempt_count CHECK (source_attempt_count >= 0 AND source_attempt_count <= retry_count)', 'SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 42,
    name: "snapgen_durable_purchase_orders",
    statements: [
      `CREATE TABLE IF NOT EXISTS sg_tiers (
        code VARCHAR(24) PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        price_cents INT NOT NULL,
        face_limit INT NOT NULL DEFAULT 10000,
        pbr TINYINT(1) NOT NULL DEFAULT 0,
        rig TINYINT(1) NOT NULL DEFAULT 0,
        texture_res VARCHAR(8) NOT NULL DEFAULT '1K',
        sort_order INT NOT NULL DEFAULT 0,
        active TINYINT(1) NOT NULL DEFAULT 1
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `INSERT INTO sg_tiers (code, name, price_cents, face_limit, pbr, rig, texture_res, sort_order) VALUES
        ('basic','Basic',299,10000,0,0,'1K',1),
        ('standard','Standard',699,30000,0,0,'2K',2),
        ('detailed','Detailed',1499,80000,1,0,'4K',3),
        ('pro','Pro',2999,120000,1,1,'4K',4)
       ON DUPLICATE KEY UPDATE name=VALUES(name), price_cents=VALUES(price_cents), face_limit=VALUES(face_limit), pbr=VALUES(pbr), rig=VALUES(rig), texture_res=VALUES(texture_res), sort_order=VALUES(sort_order)`,
      `CREATE TABLE IF NOT EXISTS sg_categories (
        code VARCHAR(24) PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        active TINYINT(1) NOT NULL DEFAULT 1
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `INSERT INTO sg_categories (code, name, sort_order) VALUES
        ('people','People',1),('pets','Pets & Animals',2),('vehicles','Vehicles',3),
        ('objects','Objects & Props',4),('landmarks','Landmarks & Scenes',5),('figurines','Toys & Figurines',6)
       ON DUPLICATE KEY UPDATE name=VALUES(name), sort_order=VALUES(sort_order)`,
      `CREATE TABLE IF NOT EXISTS sg_orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_key VARCHAR(32) NOT NULL,
        tier_code VARCHAR(24) NOT NULL,
        category_code VARCHAR(24) NOT NULL,
        status ENUM('pending','submitting','processing','recovery_required','completed','failed') NOT NULL DEFAULT 'pending',
        tripo_op VARCHAR(128) NULL,
        source_image_url TEXT NULL,
        options_json JSON NULL,
        purchase_token VARCHAR(512) NULL,
        purchase_token_sha256 CHAR(64) NULL,
        request_hash CHAR(64) NOT NULL,
        price_cents INT NOT NULL,
        currency CHAR(3) NOT NULL DEFAULT 'USD',
        is_remake TINYINT(1) NOT NULL DEFAULT 0,
        original_order_id INT NULL,
        model_url TEXT NULL,
        progress INT NOT NULL DEFAULT 0,
        error TEXT NULL,
        error_code VARCHAR(64) NULL,
        submission_attempted_at DATETIME(3) NULL,
        provider_handle_persisted_at DATETIME(3) NULL,
        provider_completed_at DATETIME(3) NULL,
        storage_persisted_at DATETIME(3) NULL,
        poll_lease_owner VARCHAR(64) NULL,
        poll_lease_expires_at DATETIME(3) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_sg_order_purchase_hash (purchase_token_sha256),
        INDEX idx_sg_orders_user (user_key),
        INDEX idx_sg_orders_status (status, poll_lease_expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS sg_purchases (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_key VARCHAR(32) NOT NULL,
        platform ENUM('play','appstore','dev') NOT NULL DEFAULT 'play',
        product_id VARCHAR(128) NOT NULL,
        purchase_token VARCHAR(512) NOT NULL,
        purchase_token_sha256 CHAR(64) NULL,
        price_cents INT NOT NULL DEFAULT 0,
        currency CHAR(3) NULL,
        consumed TINYINT(1) NOT NULL DEFAULT 0,
        consumed_order_id INT NULL,
        raw_json JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_sg_purchase_token (purchase_token(191)),
        UNIQUE KEY uniq_sg_purchase_hash (purchase_token_sha256),
        INDEX idx_sg_purchases_user (user_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sg_orders' AND COLUMN_NAME='purchase_token_sha256'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE sg_orders ADD COLUMN purchase_token_sha256 CHAR(64) NULL AFTER purchase_token','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sg_orders' AND COLUMN_NAME='request_hash'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE sg_orders ADD COLUMN request_hash CHAR(64) NULL AFTER purchase_token_sha256','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sg_orders' AND COLUMN_NAME='currency'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE sg_orders ADD COLUMN currency CHAR(3) NOT NULL DEFAULT ''USD'' AFTER price_cents','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sg_orders' AND COLUMN_NAME='error_code'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE sg_orders ADD COLUMN error_code VARCHAR(64) NULL AFTER error','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      ...["submission_attempted_at", "provider_handle_persisted_at", "provider_completed_at", "storage_persisted_at"].flatMap((column) => [
        `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sg_orders' AND COLUMN_NAME='${column}'`,
        `SET @stmt=IF(@col_exists=0,'ALTER TABLE sg_orders ADD COLUMN ${column} DATETIME(3) NULL','SELECT 1')`,
        `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      ]),
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sg_orders' AND COLUMN_NAME='poll_lease_owner'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE sg_orders ADD COLUMN poll_lease_owner VARCHAR(64) NULL','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sg_orders' AND COLUMN_NAME='poll_lease_expires_at'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE sg_orders ADD COLUMN poll_lease_expires_at DATETIME(3) NULL','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `ALTER TABLE sg_orders MODIFY COLUMN status ENUM('pending','submitting','processing','recovery_required','completed','failed') NOT NULL DEFAULT 'pending'`,
      `UPDATE sg_orders duplicate_order
         JOIN (
           SELECT purchase_token, MIN(id) AS canonical_id
             FROM (SELECT id, purchase_token FROM sg_orders) legacy_order_snapshot
            WHERE purchase_token IS NOT NULL
            GROUP BY purchase_token
           HAVING COUNT(*) > 1
         ) duplicates
           ON duplicate_order.purchase_token = duplicates.purchase_token
          AND duplicate_order.id <> duplicates.canonical_id
          SET duplicate_order.purchase_token = NULL,
              duplicate_order.status = 'recovery_required',
              duplicate_order.error_code = 'DUPLICATE_LEGACY_TOKEN',
              duplicate_order.error = 'Legacy duplicate purchase token requires reconciliation.'`,
      `UPDATE sg_orders SET purchase_token_sha256=SHA2(purchase_token,256) WHERE purchase_token IS NOT NULL AND purchase_token_sha256 IS NULL`,
      `UPDATE sg_orders SET request_hash=SHA2(CONCAT('legacy:',id),256) WHERE request_hash IS NULL`,
      `ALTER TABLE sg_orders MODIFY COLUMN request_hash CHAR(64) NOT NULL`,
      `SELECT COUNT(*) INTO @idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sg_orders' AND INDEX_NAME='uniq_sg_order_purchase_hash'`,
      `SET @stmt=IF(@idx_exists=0,'ALTER TABLE sg_orders ADD UNIQUE KEY uniq_sg_order_purchase_hash (purchase_token_sha256)','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sg_purchases' AND COLUMN_NAME='purchase_token_sha256'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE sg_purchases ADD COLUMN purchase_token_sha256 CHAR(64) NULL AFTER purchase_token','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sg_purchases' AND COLUMN_NAME='currency'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE sg_purchases ADD COLUMN currency CHAR(3) NULL AFTER price_cents','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sg_purchases' AND COLUMN_NAME='consumed_order_id'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE sg_purchases ADD COLUMN consumed_order_id INT NULL AFTER consumed','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `UPDATE sg_purchases SET purchase_token_sha256=SHA2(purchase_token,256) WHERE purchase_token_sha256 IS NULL`,
      `UPDATE sg_purchases purchase
         JOIN sg_orders purchase_order
           ON purchase_order.purchase_token_sha256 = purchase.purchase_token_sha256
          SET purchase.consumed_order_id = purchase_order.id
        WHERE purchase.consumed = 1 AND purchase.consumed_order_id IS NULL`,
      `SELECT COUNT(*) INTO @idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sg_purchases' AND INDEX_NAME='uniq_sg_purchase_hash'`,
      `SET @stmt=IF(@idx_exists=0,'ALTER TABLE sg_purchases ADD UNIQUE KEY uniq_sg_purchase_hash (purchase_token_sha256)','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 43,
    name: "generation_job_exact_once_refunds",
    skipWhenTableMissing: "generation_jobs",
    statements: [
      `SELECT COUNT(*) INTO @generation_jobs_exists FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='generation_jobs'`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='generation_jobs' AND COLUMN_NAME='generation_refund_pending_at'`,
      `SET @stmt=IF(@generation_jobs_exists=1 AND @col_exists=0,'ALTER TABLE generation_jobs ADD COLUMN generation_refund_pending_at DATETIME(3) NULL AFTER generation_refunded_at','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='generation_jobs' AND COLUMN_NAME='generation_refund_attempts'`,
      `SET @stmt=IF(@generation_jobs_exists=1 AND @col_exists=0,'ALTER TABLE generation_jobs ADD COLUMN generation_refund_attempts INT NOT NULL DEFAULT 0 AFTER generation_refund_pending_at','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='generation_jobs' AND COLUMN_NAME='generation_refund_error'`,
      `SET @stmt=IF(@generation_jobs_exists=1 AND @col_exists=0,'ALTER TABLE generation_jobs ADD COLUMN generation_refund_error VARCHAR(255) NULL AFTER generation_refund_attempts','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='generation_jobs' AND INDEX_NAME='idx_generation_refund_sweep'`,
      `SET @stmt=IF(@generation_jobs_exists=1 AND @idx_exists=0,'ALTER TABLE generation_jobs ADD INDEX idx_generation_refund_sweep (status, generation_refund_pending_at, generation_refunded_at)','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='generation_jobs' AND COLUMN_NAME='credit_debit_correlation_id'`,
      `SET @stmt=IF(@generation_jobs_exists=1 AND @col_exists=0,'ALTER TABLE generation_jobs ADD COLUMN credit_debit_correlation_id VARCHAR(190) NULL AFTER credits_reserved','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='generation_jobs' AND INDEX_NAME='uniq_generation_credit_debit'`,
      `SET @stmt=IF(@generation_jobs_exists=1 AND @idx_exists=0,'ALTER TABLE generation_jobs ADD UNIQUE KEY uniq_generation_credit_debit (credit_debit_correlation_id)','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,

      `SELECT COUNT(*) INTO @pipeline_sessions_exists FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='create_pipeline_sessions'`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='create_pipeline_sessions' AND COLUMN_NAME='credits_reserved'`,
      `SET @stmt=IF(@pipeline_sessions_exists=1 AND @col_exists=0,'ALTER TABLE create_pipeline_sessions ADD COLUMN credits_reserved INT NOT NULL DEFAULT 0 AFTER build_job_id','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='create_pipeline_sessions' AND COLUMN_NAME='credit_debit_correlation_id'`,
      `SET @stmt=IF(@pipeline_sessions_exists=1 AND @col_exists=0,'ALTER TABLE create_pipeline_sessions ADD COLUMN credit_debit_correlation_id VARCHAR(190) NULL AFTER credits_reserved','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='create_pipeline_sessions' AND INDEX_NAME='uniq_pipeline_credit_debit'`,
      `SET @stmt=IF(@pipeline_sessions_exists=1 AND @idx_exists=0,'ALTER TABLE create_pipeline_sessions ADD UNIQUE KEY uniq_pipeline_credit_debit (credit_debit_correlation_id)','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 44,
    name: "stationery_payment_order_binding",
    skipWhenTableMissing: "stationery_payment_evidence",
    statements: [
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stationery_payment_evidence' AND COLUMN_NAME='fulfillment_provider'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE stationery_payment_evidence ADD COLUMN fulfillment_provider ENUM(''printful'',''slant3d'') NULL AFTER state','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stationery_payment_evidence' AND COLUMN_NAME='provider_sku'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE stationery_payment_evidence ADD COLUMN provider_sku VARCHAR(160) NULL AFTER fulfillment_provider','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stationery_payment_evidence' AND COLUMN_NAME='unit_amount_minor'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE stationery_payment_evidence ADD COLUMN unit_amount_minor BIGINT UNSIGNED NULL AFTER provider_sku','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stationery_payment_evidence' AND COLUMN_NAME='quantity'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE stationery_payment_evidence ADD COLUMN quantity INT UNSIGNED NULL AFTER unit_amount_minor','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stationery_payment_evidence' AND COLUMN_NAME='consumed_local_order_uuid'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE stationery_payment_evidence ADD COLUMN consumed_local_order_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER evidence_hash','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stationery_payment_evidence' AND INDEX_NAME='uniq_stationery_payment_consumption'`,
      `SET @stmt=IF(@idx_exists=0,'ALTER TABLE stationery_payment_evidence ADD UNIQUE KEY uniq_stationery_payment_consumption (consumed_local_order_uuid)','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 45,
    name: "pet_glb_recovery_evidence",
    skipWhenTableMissing: "pet_glb_stage_attempts",
    statements: [
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pet_glb_stage_attempts' AND COLUMN_NAME='recovery_lease_owner'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE pet_glb_stage_attempts ADD COLUMN recovery_lease_owner CHAR(36) NULL AFTER failure_code','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pet_glb_stage_attempts' AND COLUMN_NAME='recovery_lease_expires_at'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE pet_glb_stage_attempts ADD COLUMN recovery_lease_expires_at DATETIME(3) NULL AFTER recovery_lease_owner','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pet_glb_stage_attempts' AND COLUMN_NAME='recovery_attempts'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE pet_glb_stage_attempts ADD COLUMN recovery_attempts INT NOT NULL DEFAULT 0 AFTER recovery_lease_expires_at','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pet_glb_stage_attempts' AND COLUMN_NAME='last_recovery_at'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE pet_glb_stage_attempts ADD COLUMN last_recovery_at DATETIME(3) NULL AFTER recovery_attempts','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pet_glb_stage_attempts' AND INDEX_NAME='idx_pet_glb_stage_recovery_lease'`,
      `SET @stmt=IF(@idx_exists=0,'ALTER TABLE pet_glb_stage_attempts ADD KEY idx_pet_glb_stage_recovery_lease (state, recovery_lease_expires_at, updated_at)','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `CREATE TABLE IF NOT EXISTS pet_glb_recovery_evidence (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        stage_attempt_id BIGINT NOT NULL,
        order_id BIGINT NOT NULL,
        decision VARCHAR(48) NOT NULL,
        reason_code VARCHAR(96) NOT NULL,
        provider_handle_present BOOLEAN NOT NULL DEFAULT FALSE,
        refund_correlation_id VARCHAR(190) NULL,
        redacted_evidence_json JSON NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_pet_glb_recovery_decision (stage_attempt_id, decision, reason_code),
        KEY idx_pet_glb_recovery_order (order_id, created_at),
        CONSTRAINT fk_pet_glb_recovery_stage FOREIGN KEY (stage_attempt_id) REFERENCES pet_glb_stage_attempts(id) ON DELETE RESTRICT,
        CONSTRAINT fk_pet_glb_recovery_order FOREIGN KEY (order_id) REFERENCES pet_glb_orders(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },
  {
    version: 46,
    name: "fur_bin_feedback_and_ai_video_scripts",
    // generation_jobs belongs to the legacy application bootstrap and is
    // intentionally absent from migration-only asset/Pet GLB fixtures. Keep
    // the published SQL immutable while conditionally omitting only the Fur
    // Reels child table in those reduced schemas.
    statementRequiresTable: { 1: "generation_jobs" },
    statements: [
      `CREATE TABLE IF NOT EXISTS fur_bin_feedback (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        feedback_uuid CHAR(36) NOT NULL,
        item_id BIGINT NOT NULL,
        owner_id VARCHAR(190) NOT NULL,
        asset_id BIGINT NOT NULL,
        asset_version_id BIGINT NULL,
        pet_glb_order_uuid CHAR(36) NULL,
        decision ENUM('keep','toss') NOT NULL,
        subject VARCHAR(200) NULL,
        message TEXT NULL,
        context_json JSON NOT NULL,
        email_status ENUM('not_required','pending','sent','failed','unconfigured') NOT NULL DEFAULT 'not_required',
        email_error VARCHAR(500) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uniq_fur_bin_feedback_uuid (feedback_uuid),
        KEY idx_fur_bin_feedback_item (item_id, created_at),
        KEY idx_fur_bin_feedback_owner (owner_id, created_at),
        KEY idx_fur_bin_feedback_email (email_status, created_at),
        CONSTRAINT fk_fur_bin_feedback_item FOREIGN KEY (item_id) REFERENCES fur_bin_items(id) ON DELETE RESTRICT,
        CONSTRAINT fk_fur_bin_feedback_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
        CONSTRAINT fk_fur_bin_feedback_version FOREIGN KEY (asset_version_id) REFERENCES asset_versions(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS ai_video_requests (
        job_id INT NOT NULL PRIMARY KEY,
        template_id VARCHAR(80) NULL,
        script_json JSON NOT NULL,
        compiled_prompt TEXT NOT NULL,
        duration_seconds TINYINT UNSIGNED NOT NULL DEFAULT 8,
        aspect_ratio ENUM('16:9','9:16') NOT NULL DEFAULT '9:16',
        generate_audio BOOLEAN NOT NULL DEFAULT TRUE,
        voice_text VARCHAR(280) NULL,
        voice_id VARCHAR(128) NULL,
        provider VARCHAR(32) NOT NULL DEFAULT 'veo',
        provider_model VARCHAR(120) NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_ai_video_provider (provider, created_at),
        CONSTRAINT fk_ai_video_job FOREIGN KEY (job_id) REFERENCES generation_jobs(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },
  {
    version: 47,
    name: "fur_bin_private_actions_and_full_retry",
    statements: [
      `ALTER TABLE fur_bin_feedback MODIFY COLUMN decision ENUM('keep','toss','defect') NOT NULL`,
      `ALTER TABLE fur_bin_version_events MODIFY COLUMN event_type ENUM('registered','current_changed','rollback','archived','restored','deleted') NOT NULL`,

      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pet_glb_orders' AND COLUMN_NAME='retry_source_order_id'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE pet_glb_orders ADD COLUMN retry_source_order_id BIGINT NULL AFTER style_direction','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pet_glb_orders' AND COLUMN_NAME='retry_idempotency_key'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE pet_glb_orders ADD COLUMN retry_idempotency_key CHAR(36) NULL AFTER retry_source_order_id','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pet_glb_orders' AND INDEX_NAME='uniq_pet_glb_retry_owner_key'`,
      `SET @stmt=IF(@idx_exists=0,'ALTER TABLE pet_glb_orders ADD UNIQUE KEY uniq_pet_glb_retry_owner_key (owner_phone, retry_idempotency_key)','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pet_glb_orders' AND INDEX_NAME='idx_pet_glb_retry_source'`,
      `SET @stmt=IF(@idx_exists=0,'ALTER TABLE pet_glb_orders ADD KEY idx_pet_glb_retry_source (retry_source_order_id, created_at)','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    version: 48,
    name: "tripo_reference_multiview_tasks",
    statements: [
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='reference_attempts' AND COLUMN_NAME='provider_task_handle'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE reference_attempts ADD COLUMN provider_task_handle VARCHAR(255) NULL AFTER model','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @idx_exists FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='reference_attempts' AND INDEX_NAME='idx_reference_provider_task'`,
      `SET @stmt=IF(@idx_exists=0,'ALTER TABLE reference_attempts ADD KEY idx_reference_provider_task (provider, provider_task_handle)','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
  },
  {
    // MG-9: the legacy resumeStalledBuilds sweep re-submitted stalled avatars to
    // Tripo every 3 minutes with no idempotency record, so repeated process
    // recycles could fan out several duplicate paid tasks for one avatar.
    // resume_attempts is a dedicated budget claimed atomically by that sweep.
    // It is deliberately NOT avatars.retry_count, which is user-facing
    // regeneration pricing state.
    version: 49,
    name: "avatar_resume_attempt_budget",
    statements: [
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='avatars' AND COLUMN_NAME='resume_attempts'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE avatars ADD COLUMN resume_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER retry_count','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
    ],
    skipWhenTableMissing: "avatars",
  },
  {
    version: 50,
    name: "pawprints_dual_assets_and_shopify_catalog",
    statementRequiresTable: {
      0: "pawprint_assets", 1: "pawprint_assets", 2: "pawprint_assets", 3: "pawprint_assets", 4: "pawprint_assets",
      5: "pawprint_assets", 6: "pawprint_assets", 7: "pawprint_assets", 8: "pawprint_assets", 9: "pawprint_assets",
    },
    statements: [
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pawprint_assets' AND COLUMN_NAME='subject_art_id'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE pawprint_assets ADD COLUMN subject_art_id INT NULL AFTER entry_mode','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pawprint_assets' AND COLUMN_NAME='clean_image_url'`,
      `SET @stmt=IF(@col_exists=0,'ALTER TABLE pawprint_assets ADD COLUMN clean_image_url TEXT NULL AFTER image_url','SELECT 1')`,
      `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
      `CREATE TABLE IF NOT EXISTS shopify_store_products (
        shopify_product_gid VARCHAR(128) NOT NULL PRIMARY KEY,
        handle VARCHAR(255) NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT NOT NULL,
        featured_image_url TEXT NULL,
        featured_image_alt VARCHAR(500) NULL,
        min_price DECIMAL(12,2) NOT NULL DEFAULT 0,
        max_price DECIMAL(12,2) NOT NULL DEFAULT 0,
        currency_code CHAR(3) NOT NULL DEFAULT 'USD',
        available_for_sale TINYINT(1) NOT NULL DEFAULT 0,
        published TINYINT(1) NOT NULL DEFAULT 0,
        product_url TEXT NOT NULL,
        pawprint_personalizable TINYINT(1) NOT NULL DEFAULT 0,
        variants_json JSON NOT NULL,
        shopify_updated_at DATETIME(3) NULL,
        last_synced_at DATETIME(3) NOT NULL,
        active TINYINT(1) NOT NULL DEFAULT 1,
        UNIQUE KEY uniq_shopify_store_handle (handle),
        KEY idx_shopify_store_public (active, published, pawprint_personalizable)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS shopify_catalog_sync_runs (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        status ENUM('running','succeeded','failed') NOT NULL,
        product_count INT NOT NULL DEFAULT 0,
        duration_ms INT NULL,
        error_summary VARCHAR(500) NULL,
        started_at DATETIME(3) NOT NULL,
        completed_at DATETIME(3) NULL,
        KEY idx_shopify_catalog_sync_status (status, started_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS shopify_webhook_receipts (
        webhook_id VARCHAR(128) NOT NULL PRIMARY KEY,
        topic VARCHAR(64) NOT NULL,
        received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY idx_shopify_webhook_topic (topic, received_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },
  {
    version: 51,
    name: "email_verification_tokens",
    statements: [
      // Mirrors password_resets: only the SHA-256 hash of the token is stored,
      // rows are single-use via used_at, and expiry is enforced in SQL.
      //
      // `email` records the address the token was actually sent to. The token
      // proves control of THAT address, so consuming it must not verify a
      // different one if the account email changed in between. Without this
      // column a user could request a link, change their email, then click the
      // link and have the new, unproven address marked verified.
      `CREATE TABLE IF NOT EXISTS email_verifications (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        user_phone  VARCHAR(32) NOT NULL,
        email       VARCHAR(190) NOT NULL,
        token_hash  VARCHAR(64) NOT NULL,
        expires_at  TIMESTAMP NOT NULL,
        used_at     TIMESTAMP NULL,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_email_verif_user (user_phone),
        INDEX idx_email_verif_token (token_hash)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },
];

export async function ensureMigrationTable(conn: mysql.PoolConnection | mysql.Pool): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT NOT NULL PRIMARY KEY,
      name VARCHAR(190) NOT NULL,
      checksum VARCHAR(64) NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      duration_ms INT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Record baseline transition versions 1..15 if users table exists and ledger is empty
  const [ledgerCountRows]: any = await conn.query("SELECT COUNT(*) AS c FROM schema_migrations");
  const count = Number(ledgerCountRows?.[0]?.c || 0);

  if (count === 0) {
    const [usersTableRows]: any = await conn.query(
      "SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'",
    );
    const usersExist = Number(usersTableRows?.[0]?.c || 0) > 0;
    if (usersExist) {
      // Pre-existing legacy schema: record baseline versions 1..15
      for (let v = 1; v <= 15; v++) {
        const vPad = String(v).padStart(3, "0");
        const name = `baseline_${vPad}`;
        const checksum = sha256(`BASELINE_TRANSITION_${vPad}`);
        await conn.query(
          "INSERT IGNORE INTO schema_migrations (version, name, checksum, applied_at, duration_ms) VALUES (?, ?, ?, NOW(), 0)",
          [v, name, checksum],
        );
      }
    }
  }
}

export async function runMigrations(
  pool: mysql.Pool,
  migrations: Migration[] = MIGRATIONS,
): Promise<{ applied: number; durationMs: number }> {
  const startAll = Date.now();

  // 1. Validate migration definitions before acquiring connection
  const versionsSeen = new Set<number>();
  const namesSeen = new Set<string>();
  for (const mig of migrations) {
    if (versionsSeen.has(mig.version)) {
      throw new Error(`Duplicate migration version detected: ${mig.version}`);
    }
    if (namesSeen.has(mig.name)) {
      throw new Error(`Duplicate migration name detected: ${mig.name}`);
    }
    if (!Array.isArray(mig.statements) || mig.statements.length === 0) {
      throw new Error(`Migration v${mig.version} (${mig.name}) must define explicit statements.`);
    }
    for (const [indexText, tableName] of Object.entries(mig.statementRequiresTable || {})) {
      const index = Number(indexText);
      if (!Number.isInteger(index) || index < 0 || index >= mig.statements.length) {
        throw new Error(`Migration v${mig.version} (${mig.name}) has an invalid statement dependency index: ${indexText}`);
      }
      if (!/^[a-zA-Z0-9_]+$/.test(tableName || "")) {
        throw new Error(`Migration v${mig.version} (${mig.name}) has an invalid statement dependency table: ${tableName}`);
      }
    }
    versionsSeen.add(mig.version);
    namesSeen.add(mig.name);
  }

  // 2. Acquire single dedicated PoolConnection
  const connection = await pool.getConnection();

  // 3. Acquire connection-scoped named lock
  const lockName = "paws_schema_migrations_lock";
  let lockAcquired = false;

  try {
    const [lockRes]: any = await connection.query("SELECT GET_LOCK(?, 10) AS lock_acquired", [lockName]);
    lockAcquired = lockRes?.[0]?.lock_acquired === 1;

    if (!lockAcquired) {
      throw new Error("Could not acquire schema migration lock within 10 seconds.");
    }

    await ensureMigrationTable(connection);

    const [rows]: any = await connection.query(
      "SELECT version, name, checksum, applied_at, duration_ms FROM schema_migrations ORDER BY version ASC",
    );
    const appliedMap = new Map<number, AppliedMigration>(
      (rows as any[]).map((r) => [
        Number(r.version),
        {
          version: Number(r.version),
          name: String(r.name),
          checksum: String(r.checksum),
          applied_at: new Date(r.applied_at),
          duration_ms: Number(r.duration_ms),
        },
      ]),
    );

    let appliedCount = 0;
    const sorted = [...migrations].sort((a, b) => a.version - b.version);

    for (const mig of sorted) {
      const rawSql = mig.statements.map((s) => s.trim()).join(";\n");
      const checksum = sha256(rawSql);
      const existing = appliedMap.get(mig.version);

      if (existing) {
        if (existing.checksum !== checksum) {
          throw new Error(
            `Migration checksum mismatch for version ${mig.version} (${mig.name}). Recorded: ${existing.checksum}, Current: ${checksum}`,
          );
        }
        if (existing.name !== mig.name) {
          throw new Error(
            `Migration name mismatch for version ${mig.version}. Recorded: ${existing.name}, Current: ${mig.name}`,
          );
        }
        continue;
      }

      const migStart = Date.now();
      let skippedMissingTable = false;
      let skippedOptionalStatements = 0;

      const tablePresence = new Map<string, boolean>();
      const tableExists = async (tableName: string): Promise<boolean> => {
        const cached = tablePresence.get(tableName);
        if (cached !== undefined) return cached;
        const [tableRows]: any = await connection.query(
          "SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
          [tableName],
        );
        const exists = Number(tableRows?.[0]?.c || 0) > 0;
        tablePresence.set(tableName, exists);
        return exists;
      };

      if (mig.skipWhenTableMissing) {
        skippedMissingTable = !(await tableExists(mig.skipWhenTableMissing));
      }

      if (!skippedMissingTable) {
        for (const [statementIndex, statement] of mig.statements.entries()) {
          const requiredTable = mig.statementRequiresTable?.[statementIndex];
          if (requiredTable && !(await tableExists(requiredTable))) {
            skippedOptionalStatements++;
            continue;
          }
          await connection.query(statement);
        }
      }

      const durationMs = Date.now() - migStart;

      await connection.query(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at, duration_ms) VALUES (?, ?, ?, NOW(), ?)",
        [mig.version, mig.name, checksum, durationMs],
      );

      appliedCount++;
      const outcome = skippedMissingTable
        ? `recorded; optional table ${mig.skipWhenTableMissing} is absent`
        : skippedOptionalStatements > 0
          ? `applied; skipped ${skippedOptionalStatements} statement(s) with absent optional tables`
        : "applied";
      console.log(`✅ Migration v${mig.version} (${mig.name}) ${outcome} in ${durationMs}ms`);
    }

    return { applied: appliedCount, durationMs: Date.now() - startAll };
  } finally {
    if (lockAcquired) {
      await connection.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => {});
    }
    connection.release();
  }
}
