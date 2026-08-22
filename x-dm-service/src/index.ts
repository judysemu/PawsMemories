/**
 * Entry point for x-dm-service.
 *
 * Express + TypeScript server implementing:
 *   - Webhook CRC + event delivery (§5.2)
 *   - DM event processing with dedupe (§5.7)
 *   - Webhook lifecycle management (§5.1)
 *   - DM event subscriptions (§5.3)
 *   - Polling fallback (§5.4)
 *   - DM conversation state machine (M3+)
 *   - Trend harvester (M6+)
 *
 * Spec: X_DM_REFINEMENT_SPEC.md
 */

import express from 'express';
import { getConfig } from './config.js';
import { createWebhookRouter } from './routes/webhooks.js';
import { createOAuthRouter } from './routes/oauth.js';
import { createSchedulerRouter } from './routes/scheduler.js';
import { ensureWebhookRegistered } from './webhookManager.js';
import { ensureSubscriptions } from './subscriptions.js';
import { startPoller } from './poller.js';
import { runMigrations } from './migrate.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

// Load + validate config early — exits loudly on failure
const config = getConfig();
console.log(`[Boot] x-dm-service starting...`);
console.log(`[Boot] PORT=${config.PORT}`);

const app = express();

// ---------------------------------------------------------------------------
// Webhook routes — raw body parser MUST come before global JSON parser (§7.3)
// ---------------------------------------------------------------------------

// Mount raw body parser on /webhooks/x so signature verification works
// over the original bytes (timing-safe compare requires raw body).
app.use('/webhooks/x', express.raw({ type: '*/*' }));

// Attach webhook router
app.use('/webhooks/x', createWebhookRouter(config.X_CONSUMER_SECRET));

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------

// JSON parser for all other routes
app.use(express.json());

// ---------------------------------------------------------------------------
// OAuth routes — PKCE flow for bot token seeding (§4.1)
// ---------------------------------------------------------------------------

app.use('/oauth', createOAuthRouter());

// ---------------------------------------------------------------------------
// Scheduled posting — bearer-authenticated, mirrors the catalog-sync pattern
// ---------------------------------------------------------------------------

app.use('/admin', createSchedulerRouter());

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'x-dm-service' });
});

app.get('/', (_req, res) => {
  res.json({
    service: 'x-dm-service',
    version: '1.0.0',
    milestone: 'M2',
    docs: 'https://github.com/...',
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/**
 * Sleep helper — Promise-based setTimeout for delayed boot setup.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

app.listen(config.PORT, () => {
  console.log(`[Boot] x-dm-service listening on :${config.PORT}`);

  // Boot-time migrations — run before any DB touch.
  // On failure: log, but still try boot setup (webhook may work without DB).
  runMigrations()
    .then(() => console.log('[Boot] DB migrations complete'))
    .catch((err) => console.error(`[Boot] Migration error: ${(err as Error).message}`));

  // Schedule delayed boot setup with retry (CRC deploy-race fix)
  scheduleBootSetup();
});

/**
 * Delayed boot-time setup with retry.
 *
 * Waits 30s before the first attempt (gives deploy time to settle so CRC
 * succeeds). Retries up to 3 times at 60s intervals on failure.
 *
 * Once webhook + subscriptions succeed, starts the optional poller.
 */
async function scheduleBootSetup(): Promise<void> {
  // Wait 30s for deploy to settle
  await sleep(30_000);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const webhookId = await ensureWebhookRegistered();
      if (webhookId) {
        await ensureSubscriptions(webhookId);
        if (config.X_DM_POLLING_ENABLED) {
          startPoller();
        } else {
          console.log('[Boot] DM polling fallback disabled (X_DM_POLLING_ENABLED=false)');
        }
        console.log(`[Boot] Setup complete on attempt ${attempt}`);
        return;
      }
    } catch (err) {
      console.error(`[Boot] Setup attempt ${attempt} error: ${(err as Error).message}`);
    }

    if (attempt < 3) {
      console.warn(`[Boot] Setup attempt ${attempt} failed — retrying in 60s`);
      await sleep(60_000);
    }
  }

  console.error('[Boot] Setup failed after 3 attempts — server alive for health checks, poller not started');
}

// ---------------------------------------------------------------------------
// Hourly health check — re-ensure webhook + subscriptions
// ---------------------------------------------------------------------------

setInterval(async () => {
  try {
    const webhookId = await ensureWebhookRegistered();
    if (webhookId) {
      await ensureSubscriptions(webhookId);
    }
  } catch (err) {
    console.error(`[Boot] Hourly health check error: ${(err as Error).message}`);
  }
}, 3_600_000);

export default app;

// ---------------------------------------------------------------------------
// Global error handlers — keep the server alive for DB/network failures
// ---------------------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  console.error('[Process] UNHANDLED REJECTION — server stays alive');
  console.error(`  Reason: ${(reason as Error)?.message ?? reason}`);
  if ((reason as Error)?.stack) {
    const lines = (reason as Error).stack!.split('\n').slice(0, 5).join('\n');
    console.error(`  Stack (top 5):\n${lines}`);
  }
});

process.on('uncaughtException', (err) => {
  console.error('[Process] UNCAUGHT EXCEPTION — server stays alive');
  console.error(`  Error: ${err.message}`);
  console.error(`  Stack (top 5):\n${err.stack?.split('\n').slice(0, 5).join('\n') ?? 'none'}`);
});
