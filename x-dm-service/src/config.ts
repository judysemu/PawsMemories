/**
 * Config loader for x-dm-service.
 *
 * Reads env vars from the shared main-app .env names (spec §3 updated).
 * Uses DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD instead of DATABASE_URL,
 * BLENDER_WORKER_URL instead of WORKER_URL, MEDIA_BUCKET_* instead of B2_*.
 *
 * Spec: X_DM_REFINEMENT_SPEC.md §3
 */

export interface Config {
  X_CLIENT_ID: string;
  X_CLIENT_SECRET: string;
  X_CONSUMER_SECRET: string;
  X_BOT_USER_ID: string;
  X_BOT_ACCESS_TOKEN: string;
  X_BOT_REFRESH_TOKEN: string;
  X_WEBHOOK_URL: string;
  /** MySQL connection parts (same names as main app .env) */
  DB_HOST: string;
  DB_PORT: number;
  DB_NAME: string;
  DB_USER: string;
  DB_PASSWORD: string;
  /** Blender worker origin (path stripped) */
  BLENDER_WORKER_URL: string;
  WORKER_SHARED_SECRET: string;
  LLM_API_KEY: string;
  LLM_MODEL: string;
  LLM_BASE_URL: string;
  MEDIA_BUCKET_NAME: string;
  MEDIA_BUCKET_URL: string;
  MEDIA_BUCKET_KEY: string;
  MEDIA_BUCKET_SECRET: string;
  DM_DAILY_SEND_CAP: number;
  HARVEST_MAX_POSTS_PER_RUN: number;
  /** Enables the optional DM lookup fallback. Defaults off to avoid unauthorized retry loops. */
  X_DM_POLLING_ENABLED: boolean;
  PORT: number;
  /** Portal-issued app-only bearer token (optional). When set, bypasses the OAuth2 client_credentials fetch. */
  X_BEARER_TOKEN: string;
  /** OAuth 1.0a consumer key (API Key) for subscription management — optional, warn-and-skip if absent */
  X_CONSUMER_KEY: string;
  /** OAuth 1.0a user access token for subscription management — optional, warn-and-skip if absent */
  X_ACCESS_TOKEN: string;
  /** OAuth 1.0a user access token secret for subscription management — optional, warn-and-skip if absent */
  X_ACCESS_TOKEN_SECRET: string;
}

export function loadConfig(): Config {
  const env = process.env;
  const errors: string[] = [];

  // Read all vars
  const X_CLIENT_ID = env.X_CLIENT_ID;
  const X_CLIENT_SECRET = env.X_CLIENT_SECRET;
  const X_CONSUMER_SECRET = env.X_CONSUMER_SECRET;
  const X_BOT_USER_ID = env.X_BOT_USER_ID;
  const X_BOT_ACCESS_TOKEN = env.X_BOT_ACCESS_TOKEN ?? '';
  const X_BOT_REFRESH_TOKEN = env.X_BOT_REFRESH_TOKEN ?? '';
  const X_WEBHOOK_URL = env.X_WEBHOOK_URL ?? '';
  const DB_HOST = env.DB_HOST;
  const DB_PORT = env.DB_PORT ? Number(env.DB_PORT) : 3306;
  const DB_NAME = env.DB_NAME;
  const DB_USER = env.DB_USER;
  const DB_PASSWORD = env.DB_PASSWORD;
  const BLENDER_WORKER_URL = env.BLENDER_WORKER_URL ? stripPath(env.BLENDER_WORKER_URL) : '';
  const WORKER_SHARED_SECRET = env.WORKER_SHARED_SECRET;
  const LLM_API_KEY = env.LLM_API_KEY;
  const LLM_MODEL = env.LLM_MODEL;
  const LLM_BASE_URL = env.LLM_BASE_URL || 'https://openrouter.ai/api/v1';
  const MEDIA_BUCKET_NAME = env.MEDIA_BUCKET_NAME;
  const MEDIA_BUCKET_URL = env.MEDIA_BUCKET_URL;
  const MEDIA_BUCKET_KEY = env.MEDIA_BUCKET_KEY;
  const MEDIA_BUCKET_SECRET = env.MEDIA_BUCKET_SECRET;
  let DM_DAILY_SEND_CAP = env.DM_DAILY_SEND_CAP ? Number(env.DM_DAILY_SEND_CAP) : 400;
  let HARVEST_MAX_POSTS_PER_RUN = env.HARVEST_MAX_POSTS_PER_RUN ? Number(env.HARVEST_MAX_POSTS_PER_RUN) : 300;
  const X_DM_POLLING_ENABLED = parseBoolean(env.X_DM_POLLING_ENABLED, false);
  let PORT = env.PORT ? Number(env.PORT) : 3001;
  const X_BEARER_TOKEN = env.X_BEARER_TOKEN ?? '';
  const X_CONSUMER_KEY = env.X_CONSUMER_KEY ?? '';
  const X_ACCESS_TOKEN = env.X_ACCESS_TOKEN ?? '';
  const X_ACCESS_TOKEN_SECRET = env.X_ACCESS_TOKEN_SECRET ?? '';

  // Validate required strings
  const required: [string, string | undefined][] = [
    ['X_CLIENT_ID', X_CLIENT_ID],
    ['X_CLIENT_SECRET', X_CLIENT_SECRET],
    ['X_CONSUMER_SECRET', X_CONSUMER_SECRET],
    ['X_BOT_USER_ID', X_BOT_USER_ID],
    ['DB_HOST', DB_HOST],
    ['DB_NAME', DB_NAME],
    ['DB_USER', DB_USER],
    ['DB_PASSWORD', DB_PASSWORD],
    ['BLENDER_WORKER_URL', BLENDER_WORKER_URL],
    ['WORKER_SHARED_SECRET', WORKER_SHARED_SECRET],
    ['LLM_API_KEY', LLM_API_KEY],
    ['LLM_MODEL', LLM_MODEL],
    ['MEDIA_BUCKET_NAME', MEDIA_BUCKET_NAME],
    ['MEDIA_BUCKET_URL', MEDIA_BUCKET_URL],
    ['MEDIA_BUCKET_KEY', MEDIA_BUCKET_KEY],
    ['MEDIA_BUCKET_SECRET', MEDIA_BUCKET_SECRET],
  ];

  for (const [name, val] of required) {
    if (!val || val.trim() === '') {
      errors.push(`Missing required env var: ${name}`);
    }
  }

  // Validate numbers
  if (Number.isNaN(DB_PORT) || DB_PORT < 1 || DB_PORT > 65535) {
    errors.push(`DB_PORT must be a valid port number (1-65535), got ${env.DB_PORT}`);
  }
  if (Number.isNaN(DM_DAILY_SEND_CAP) || DM_DAILY_SEND_CAP < 1) {
    errors.push(`DM_DAILY_SEND_CAP must be a positive number, got ${env.DM_DAILY_SEND_CAP}`);
  }
  if (Number.isNaN(HARVEST_MAX_POSTS_PER_RUN) || HARVEST_MAX_POSTS_PER_RUN < 1) {
    errors.push(`HARVEST_MAX_POSTS_PER_RUN must be a positive number, got ${env.HARVEST_MAX_POSTS_PER_RUN}`);
  }
  if (Number.isNaN(PORT) || PORT < 1) {
    errors.push(`PORT must be a positive number, got ${env.PORT}`);
  }

  if (errors.length > 0) {
    console.error('[Config] Fatal: environment validation failed');
    for (const err of errors) {
      console.error(`  x ${err}`);
    }
    process.exit(1);
  }

  return {
    X_CLIENT_ID: X_CLIENT_ID!,
    X_CLIENT_SECRET: X_CLIENT_SECRET!,
    X_CONSUMER_SECRET: X_CONSUMER_SECRET!,
    X_BOT_USER_ID: X_BOT_USER_ID!,
    X_BOT_ACCESS_TOKEN,
    X_BOT_REFRESH_TOKEN,
    X_WEBHOOK_URL,
    DB_HOST: DB_HOST!,
    DB_PORT,
    DB_NAME: DB_NAME!,
    DB_USER: DB_USER!,
    DB_PASSWORD: DB_PASSWORD!,
    BLENDER_WORKER_URL: BLENDER_WORKER_URL!,
    WORKER_SHARED_SECRET: WORKER_SHARED_SECRET!,
    LLM_API_KEY: LLM_API_KEY!,
    LLM_MODEL: LLM_MODEL!,
    LLM_BASE_URL,
    MEDIA_BUCKET_NAME: MEDIA_BUCKET_NAME!,
    MEDIA_BUCKET_URL: MEDIA_BUCKET_URL!,
    MEDIA_BUCKET_KEY: MEDIA_BUCKET_KEY!,
    MEDIA_BUCKET_SECRET: MEDIA_BUCKET_SECRET!,
    DM_DAILY_SEND_CAP,
    HARVEST_MAX_POSTS_PER_RUN,
    X_DM_POLLING_ENABLED,
    PORT,
    X_BEARER_TOKEN,
    X_CONSUMER_KEY,
    X_ACCESS_TOKEN,
    X_ACCESS_TOKEN_SECRET,
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * Strip the path component from a URL, keeping only the origin.
 * e.g. ".../azurecontainerapps.io/execute" → ".../azurecontainerapps.io"
 */
function stripPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

/** Lazy singleton — loaded once on first access */
let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}
