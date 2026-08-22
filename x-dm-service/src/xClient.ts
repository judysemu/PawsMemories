/**
 * X API Client for x-dm-service.
 *
 * Implements OAuth 2.0 Authorization Code + PKCE (bot account, §4.1),
 * app-only bearer token (§4.2), and rate-limit/429 backoff (§7.1).
 *
 * Spec: X_DM_REFINEMENT_SPEC.md §4, §7.1
 *
 * TODO(§7.6): Before wiring any X API endpoint, verify endpoint availability and
 * payload shape against https://docs.x.com/x-api/overview for the account's tier.
 */

import { getConfig } from './config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: 'bearer';
}

export interface XApiError {
  status: number;
  title: string;
  detail?: string;
  type?: string;
  rateLimitReset?: number;
}

/** Result wrapping potential X API error metadata */
export type XApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: XApiError };

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/**
 * Scopes requested when the bot account authorises.
 *
 * `tweet.write` was absent until 2026-08-21, so a token minted before then can
 * read timelines but cannot publish — every post returns 403. Scopes are fixed
 * at issue time, so adding one here does nothing to a token already stored:
 * the bot must walk the /oauth flow again and consent to the new scope.
 */
export const DM_SCOPES = [
  'dm.read',
  'dm.write',
  'tweet.read',
  // Publishing the scheduled traffic posts. Read alone is not enough.
  'tweet.write',
  'users.read',
  'media.write',
  'offline.access',
].join(' ');

/** Scopes a token must hold to publish. */
export const POSTING_SCOPES = ['tweet.write'] as const;

/**
 * Whether a stored scope string permits publishing.
 *
 * Returns null when the scope was never recorded — that is not the same as
 * "cannot post", and reporting it as such would send someone re-authorising a
 * token that was fine.
 */
export function canPost(grantedScope: string | null | undefined): boolean | null {
  if (grantedScope == null || grantedScope.trim() === '') return null;
  const granted = new Set(grantedScope.trim().split(/\s+/));
  return POSTING_SCOPES.every((s) => granted.has(s));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function basicAuth(clientId: string, clientSecret: string): string {
  const raw = `${clientId}:${clientSecret}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generate a cryptographically random code_verifier for PKCE.
 */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/**
 * Compute S256 code_challenge from a code_verifier.
 */
async function computeCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  return base64url(new Uint8Array(hash));
}

/**
 * Parse rate-limit headers from a Response and compute backoff delay.
 * Returns delay in milliseconds.
 */
function parseRateLimitReset(resp: Response): number {
  const reset = resp.headers.get('x-rate-limit-reset');
  if (reset) {
    const resetSec = parseInt(reset, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    const wait = Math.max(resetSec - nowSec, 1) * 1000;
    // Add 0—5s jitter
    return wait + Math.floor(Math.random() * 5000);
  }
  return 60_000 + Math.floor(Math.random() * 10_000);
}

// ---------------------------------------------------------------------------
// Token refresh (§4.1 step 3)
// ---------------------------------------------------------------------------

/**
 * Refresh the bot's OAuth 2.0 token via the X API.
 *
 * On success, callers should persist the new tokens to the x_oauth_tokens table.
 */
export async function refreshBotToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const resp = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth(clientId, clientSecret),
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => 'unknown');
    throw new Error(`Token refresh failed (${resp.status}): ${text}`);
  }

  return (await resp.json()) as TokenResponse;
}

// ---------------------------------------------------------------------------
// App-only bearer token (§4.2)
// ---------------------------------------------------------------------------

/**
 * Obtain an app-only bearer token using the API Key + API Key Secret.
 *
 * Two strategies:
 *   1. If X_BEARER_TOKEN env var is set, returns it directly (portal-issued
 *      token) without any HTTP call.
 *   2. Otherwise, fall back to the legacy app-only endpoint
 *      POST https://api.x.com/oauth2/token (no /2/) with URL-encoded Basic
 *      auth, consuming an API Key + Secret pair. The /2/ endpoint returns
 *      400 "Missing required parameter [client_secret]" for client_credentials,
 *      hence the explicit legacy path.
 *
 * Used for: webhook management (§5.1), X Activity subscriptions (§5.3),
 * recent search + trends (Feature B).
 *
 * TODO(§7.6): Verify endpoint and body shape at
 * https://docs.x.com/x-api/overview for the account's tier.
 */
export async function getAppOnlyBearerToken(
  apiKey: string,
  apiKeySecret: string,
): Promise<TokenResponse> {
  // Short-circuit: portal-issued token
  const cfgToken = getConfig().X_BEARER_TOKEN;
  if (cfgToken) {
    return {
      access_token: cfgToken,
      expires_in: 86_400 * 365, // ~1 year — portal tokens are long-lived
      token_type: 'bearer',
    };
  }

  // Legacy endpoint (/oauth2/token — no /2/) with URL-encoded Basic auth.
  // The /2/oauth2/token endpoint rejects client_credentials with
  // "Missing required parameter [client_secret]".
  const encodedKey = encodeURIComponent(apiKey);
  const encodedSecret = encodeURIComponent(apiKeySecret);
  const raw = `${encodedKey}:${encodedSecret}`;
  const auth = `Basic ${Buffer.from(raw).toString('base64')}`;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
  });

  const resp = await fetch('https://api.x.com/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: auth,
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => 'unknown');
    throw new Error(`App-only token failed (${resp.status}): ${text}`);
  }

  return (await resp.json()) as TokenResponse;
}

// ---------------------------------------------------------------------------
// xClient — authenticated HTTP client with rate-limit handling (§7.1)
// ---------------------------------------------------------------------------

export async function xFetch(
  url: string,
  options: RequestInit & {
    token?: string;
    refreshFn?: () => Promise<string>;
  } = {},
): Promise<Response> {
  const { token, refreshFn, ...fetchOpts } = options;

  const headers = new Headers(fetchOpts.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let resp = await fetch(url, { ...fetchOpts, headers });

  // 429: rate limit backoff (§7.1)
  if (resp.status === 429) {
    const delay = parseRateLimitReset(resp);
    console.warn(`[xClient] 429 on ${url}; backing off ${Math.round(delay / 1000)}s`);
    await sleep(delay);
    resp = await fetch(url, { ...fetchOpts, headers });
  }

  return resp;
}

// ---------------------------------------------------------------------------
// Build PKCE authorize URL (§4.1 step 1)
// ---------------------------------------------------------------------------

export async function buildAuthorizeUrl(
  clientId: string,
  redirectUri: string,
): Promise<{ url: string; codeVerifier: string; state: string }> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeCodeChallenge(codeVerifier);
  const state = generateCodeVerifier();

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: DM_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const url = `https://x.com/i/oauth2/authorize?${params.toString()}`;
  return { url, codeVerifier, state };
}

// ---------------------------------------------------------------------------
// Exchange authorization code for tokens (§4.1 step 2)
// ---------------------------------------------------------------------------

export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const resp = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth(clientId, clientSecret),
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => 'unknown');
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }

  return (await resp.json()) as TokenResponse;
}

// ---------------------------------------------------------------------------
// Convenience: get the current bot user token (from config or DB)
// ---------------------------------------------------------------------------

export function getBotToken(): string {
  const cfg = getConfig();
  return cfg.X_BOT_ACCESS_TOKEN;
}

/**
 * The X API media upload categories for DM attachments.
 * TODO(§7.6): Verify the exact `dm_*` category strings accepted on the
 * current tier at https://docs.x.com/x-api/media/quickstart/media-upload-chunked .
 * If dm_image / dm_video / dm_gif are unsupported, fall back to hosting
 * renders on B2 and sending the URL as text (X auto-previews image links in DMs).
 */
export const DM_MEDIA_CATEGORIES = {
  image: 'dm_image',
  video: 'dm_video',
  gif: 'dm_gif',
} as const;