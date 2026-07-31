/**
 * Express proxy: routes /api/studio/* → Python FastAPI on port 8001
 *
 * Register in server.ts:
 *   import { studioRouter } from './animator/studio_proxy';
 *   app.use('/api/studio', studioRouter);
 */

import { Router, Request, Response, NextFunction } from 'express';
import httpProxy from 'http-proxy';

const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  // Required for SSE (progress stream) — disable buffering
  selfHandleResponse: false,
});

proxy.on('error', (err: Error, req: Request, res: Response) => {
  console.error('[studio-proxy] error:', err.message);
  if (!res.headersSent) {
    res.status(502).json({ error: 'Studio service unavailable', detail: err.message });
  }
});

export const studioRouter = Router();

export function getStudioProxyConfiguration(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  serviceUrl: string | null;
  internalSecret: string | null;
} {
  if (env.STUDIO_PROXY_ENABLED !== 'true') {
    return { enabled: false, serviceUrl: null, internalSecret: null };
  }
  const serviceUrl = env.STUDIO_SERVICE_URL?.trim() || '';
  const internalSecret = env.STUDIO_INTERNAL_SECRET?.trim() || '';
  try {
    const parsed = new URL(serviceUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return { enabled: false, serviceUrl: null, internalSecret: null };
    }
  } catch {
    return { enabled: false, serviceUrl: null, internalSecret: null };
  }
  if (Buffer.byteLength(internalSecret, 'utf8') < 32) {
    return { enabled: false, serviceUrl: null, internalSecret: null };
  }
  return { enabled: true, serviceUrl, internalSecret };
}

/**
 * Rewrite /api/studio/* → /studio/*
 * e.g. POST /api/studio/productions → POST /studio/productions
 */
studioRouter.use('/', (req: Request, res: Response, next: NextFunction) => {
  const configuration = getStudioProxyConfiguration();
  const ownerId = (req as Request & { user?: { phone?: string } }).user?.phone;
  if (!configuration.enabled || !configuration.serviceUrl || !configuration.internalSecret || !ownerId) {
    return res.status(503).json({ error: 'Studio service is disabled until its secure worker is configured.' });
  }

  // Preserve the /studio prefix that FastAPI expects
  req.url = `/studio${req.url}`;
  req.headers['x-pawsome-owner-id'] = ownerId;
  req.headers['x-pawsome-studio-secret'] = configuration.internalSecret;
  // The user's browser credential must never be forwarded to the separate
  // Python process; it receives only the server-authenticated owner identity.
  delete req.headers.authorization;

  // For SSE endpoints, ensure no timeout and flushing
  if (req.headers.accept?.includes('text/event-stream')) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
  }

  proxy.web(req, res, { target: configuration.serviceUrl });
});
