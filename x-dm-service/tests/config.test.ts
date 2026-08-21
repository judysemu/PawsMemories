/**
 * Tests for config validation.
 *
 * Spec: X_DM_REFINEMENT_SPEC.md §3 (updated)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('loadConfig', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    // Set all required env vars to valid values (new §3 names)
    process.env.X_CLIENT_ID = 'test-client-id';
    process.env.X_CLIENT_SECRET = 'test-client-secret';
    process.env.X_CONSUMER_SECRET = 'test-consumer-secret';
    process.env.X_BOT_USER_ID = '12345';
    process.env.X_BOT_ACCESS_TOKEN = 'test-access-token';
    process.env.X_BOT_REFRESH_TOKEN = 'test-refresh-token';
    process.env.X_WEBHOOK_URL = 'https://example.com/webhooks/x';
    process.env.DB_HOST = 'db.example.com';
    process.env.DB_PORT = '3306';
    process.env.DB_NAME = 'pawsome3d';
    process.env.DB_USER = 'dbuser';
    process.env.DB_PASSWORD = 'dbpass';
    process.env.BLENDER_WORKER_URL = 'https://worker.example.com/render';
    process.env.WORKER_SHARED_SECRET = 'worker-shared-secret';
    process.env.LLM_API_KEY = 'test-llm-key';
    process.env.LLM_MODEL = 'nvidia/nemotron-nano-12b-v2-vl:free';
    process.env.MEDIA_BUCKET_NAME = 'test-bucket';
    process.env.MEDIA_BUCKET_URL = 'https://s3.us-east-005.backblazeb2.com';
    process.env.MEDIA_BUCKET_KEY = 'test-key';
    process.env.MEDIA_BUCKET_SECRET = 'test-secret';
    process.env.DM_DAILY_SEND_CAP = '400';
    process.env.HARVEST_MAX_POSTS_PER_RUN = '300';
    process.env.PORT = '3001';
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('should load config with all required env vars', async () => {
    vi.resetModules();
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.X_CLIENT_ID).toBe('test-client-id');
    expect(config.X_CLIENT_SECRET).toBe('test-client-secret');
    expect(config.X_CONSUMER_SECRET).toBe('test-consumer-secret');
    expect(config.X_BOT_USER_ID).toBe('12345');
    expect(config.X_BOT_ACCESS_TOKEN).toBe('test-access-token');
    expect(config.X_BOT_REFRESH_TOKEN).toBe('test-refresh-token');
    expect(config.X_WEBHOOK_URL).toBe('https://example.com/webhooks/x');
    expect(config.DB_HOST).toBe('db.example.com');
    expect(config.DB_PORT).toBe(3306);
    expect(config.DB_NAME).toBe('pawsome3d');
    expect(config.DB_USER).toBe('dbuser');
    expect(config.DB_PASSWORD).toBe('dbpass');
    expect(config.BLENDER_WORKER_URL).toBe('https://worker.example.com');
    expect(config.WORKER_SHARED_SECRET).toBe('worker-shared-secret');
    expect(config.LLM_API_KEY).toBe('test-llm-key');
    expect(config.LLM_MODEL).toBe('nvidia/nemotron-nano-12b-v2-vl:free');
    expect(config.LLM_BASE_URL).toBe('https://openrouter.ai/api/v1');
    expect(config.MEDIA_BUCKET_NAME).toBe('test-bucket');
    expect(config.MEDIA_BUCKET_URL).toBe('https://s3.us-east-005.backblazeb2.com');
    expect(config.MEDIA_BUCKET_KEY).toBe('test-key');
    expect(config.MEDIA_BUCKET_SECRET).toBe('test-secret');
    expect(config.DM_DAILY_SEND_CAP).toBe(400);
    expect(config.HARVEST_MAX_POSTS_PER_RUN).toBe(300);
    expect(config.X_DM_POLLING_ENABLED).toBe(false);
    expect(config.PORT).toBe(3001);
  });

  it('should strip path from BLENDER_WORKER_URL', async () => {
    vi.resetModules();
    process.env.BLENDER_WORKER_URL =
      'https://pawsome3d-blender-worker.ambitiousforest-08789dd3.eastus.azurecontainerapps.io/execute';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.BLENDER_WORKER_URL).toBe(
      'https://pawsome3d-blender-worker.ambitiousforest-08789dd3.eastus.azurecontainerapps.io',
    );
  });

  it('should use defaults for optional vars', async () => {
    vi.resetModules();
    delete process.env.DM_DAILY_SEND_CAP;
    delete process.env.HARVEST_MAX_POSTS_PER_RUN;
    delete process.env.PORT;
    delete process.env.X_BOT_ACCESS_TOKEN;
    delete process.env.X_BOT_REFRESH_TOKEN;
    delete process.env.X_WEBHOOK_URL;
    delete process.env.LLM_BASE_URL;
    delete process.env.DB_PORT;

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.DM_DAILY_SEND_CAP).toBe(400);
    expect(config.HARVEST_MAX_POSTS_PER_RUN).toBe(300);
    expect(config.PORT).toBe(3001);
    expect(config.X_BOT_ACCESS_TOKEN).toBe('');
    expect(config.X_BOT_REFRESH_TOKEN).toBe('');
    expect(config.X_WEBHOOK_URL).toBe('');
    expect(config.LLM_BASE_URL).toBe('https://openrouter.ai/api/v1');
    expect(config.DB_PORT).toBe(3306);
  });

  it('should enable DM polling only when explicitly configured', async () => {
    vi.resetModules();
    process.env.X_DM_POLLING_ENABLED = 'true';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.X_DM_POLLING_ENABLED).toBe(true);
  });

  it('should exit on missing required env vars', async () => {
    vi.resetModules();
    delete process.env.X_CLIENT_ID;
    delete process.env.DB_HOST;

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow('process.exit called');
    expect(exitMock).toHaveBeenCalledWith(1);

    exitMock.mockRestore();
  });

  it('should exit when a numeric env var is not a number', async () => {
    vi.resetModules();
    process.env.PORT = 'not-a-number';

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow('process.exit called');

    exitMock.mockRestore();
  });

  it('should fail when a number is below the minimum', async () => {
    vi.resetModules();
    process.env.DM_DAILY_SEND_CAP = '0';

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow('process.exit called');

    exitMock.mockRestore();
  });

  it('should accept LLM_BASE_URL override', async () => {
    vi.resetModules();
    process.env.LLM_BASE_URL = 'https://api.anthropic.com/v1';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.LLM_BASE_URL).toBe('https://api.anthropic.com/v1');
  });

  it('should return numeric PORT as a number', async () => {
    vi.resetModules();
    process.env.PORT = '8080';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.PORT).toBe(8080);
    expect(typeof config.PORT).toBe('number');
  });

  it('should reject invalid DB_PORT', async () => {
    vi.resetModules();
    process.env.DB_PORT = '99999';

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow('process.exit called');

    exitMock.mockRestore();
  });

  it('should default X_BEARER_TOKEN to empty string', async () => {
    vi.resetModules();
    // X_BEARER_TOKEN not set
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.X_BEARER_TOKEN).toBe('');
  });

  it('should read X_BEARER_TOKEN from env', async () => {
    vi.resetModules();
    process.env.X_BEARER_TOKEN = 'portal-issued-token-abc';
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.X_BEARER_TOKEN).toBe('portal-issued-token-abc');
  });
});
