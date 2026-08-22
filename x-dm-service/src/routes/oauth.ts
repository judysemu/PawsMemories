/**
 * OAuth 2.0 Authorization Code + PKCE routes (§4.1).
 *
 * These routes allow the bot operator to seed the OAuth tokens once
 * by logging in as @Pawsome3D in the browser.
 *
 * Spec: X_DM_REFINEMENT_SPEC.md §4.1
 *
 * TODO(§7.6): Verify callback URL and redirect URI exactly match the
 * X Developer Portal app settings before deploying.
 */

import { Router, type Request, type Response } from 'express';
import { getConfig } from '../config.js';
import { buildAuthorizeUrl, exchangeCode } from '../xClient.js';
import { persistTokens } from '../botTokenStore.js';
import { ensureSubscriptions } from '../subscriptions.js';
import { kvGet, KV_KEYS } from '../db.js';

// ---------------------------------------------------------------------------
// In-memory PKCE state store (single-user — only the bot account does this)
// ---------------------------------------------------------------------------

let pendingVerifier: string | null = null;
let pendingState: string | null = null;

const OAUTH_CALLBACK_PATH = '/oauth/callback';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createOAuthRouter(): Router {
  const router = Router();

  // -----------------------------------------------------------------------
  // GET /oauth/start — Generate PKCE authorize URL and redirect the
  // bot operator's browser to X.
  // -----------------------------------------------------------------------
  router.get('/start', async (_req: Request, res: Response) => {
    const cfg = getConfig();
    const redirectUri = `${cfg.X_WEBHOOK_URL.replace(/\/webhooks\/x$/, '')}${OAUTH_CALLBACK_PATH}`;

    try {
      const { url, codeVerifier, state } = await buildAuthorizeUrl(
        cfg.X_CLIENT_ID,
        redirectUri,
      );

      // Store for callback verification
      pendingVerifier = codeVerifier;
      pendingState = state;

      res.redirect(url);
    } catch (err) {
      res.status(500).json({
        error: 'Failed to build authorize URL',
        detail: (err as Error).message,
      });
    }
  });

  // -----------------------------------------------------------------------
  // GET /oauth/callback — Exchange authorization code for tokens.
  // Persists the resulting token pair via botTokenStore.
  // -----------------------------------------------------------------------
  router.get('/callback', async (req: Request, res: Response) => {
    const cfg = getConfig();
    const { code, state, error: oauthError } = req.query;

    // Check for OAuth error
    if (oauthError) {
      return res.status(400).json({
        error: 'OAuth authorization denied',
        detail: oauthError,
      });
    }

    // Validate state
    if (!state || state !== pendingState) {
      return res.status(400).json({ error: 'Invalid state parameter — possible CSRF' });
    }

    // Validate code
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Missing authorization code' });
    }

    // Validate verifier
    if (!pendingVerifier) {
      return res.status(400).json({ error: 'No pending PKCE verifier — restart OAuth flow' });
    }

    const redirectUri = `${cfg.X_WEBHOOK_URL.replace(/\/webhooks\/x$/, '')}${OAUTH_CALLBACK_PATH}`;

    try {
      const tokenResponse = await exchangeCode(
        cfg.X_CLIENT_ID,
        cfg.X_CLIENT_SECRET,
        code,
        pendingVerifier,
        redirectUri,
      );

      // Persist tokens
      await persistTokens(
        tokenResponse.access_token,
        tokenResponse.refresh_token ?? '',
        cfg.X_BOT_USER_ID,
        // X returns what it actually granted, which can be narrower than what
        // was requested if the account declined part of the consent screen.
        tokenResponse.scope,
      );

      // Clear pending state
      pendingVerifier = null;
      pendingState = null;

      console.log('[OAuth] Bot tokens acquired and persisted successfully');

      // Try to set up subscriptions now that we have a user token
      try {
        const storedWebhookId = await kvGet(KV_KEYS.WEBHOOK_ID);
        if (storedWebhookId) {
          await ensureSubscriptions(storedWebhookId);
        }
      } catch (subErr) {
        console.warn(`[OAuth] Could not ensure subscriptions after token: ${(subErr as Error).message}`);
      }

      res.status(200).json({
        ok: true,
        message: 'OAuth flow complete — bot tokens acquired',
        // Never log the full token, but confirm it exists
        token_type: tokenResponse.token_type,
        scope: tokenResponse.scope,
      });
    } catch (err) {
      console.error('[OAuth] Token exchange failed:', (err as Error).message);
      res.status(500).json({
        error: 'Token exchange failed',
        detail: (err as Error).message,
      });
    }
  });

  return router;
}