/**
 * Analytics endpoints.
 *
 * The collector is public and unauthenticated by necessity — it records
 * anonymous visitors, most of whom never sign in. That makes it the one route
 * where "someone could post junk at it" is a real consideration, so it is
 * rate-limited, validates every field, stores nothing free-form, and answers
 * 204 regardless of outcome. Telling a caller whether their row was kept would
 * turn it into an oracle for the bot filter.
 *
 * The report endpoint is the opposite: admin only, because aggregate traffic is
 * business information even when the underlying rows are anonymous.
 */
import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import type mysql from "mysql2/promise";
import { recordPageView, trafficSummary } from "./pageviews";

export interface AnalyticsDeps {
  getPool: () => mysql.Pool;
  isAdmin: (phone: string) => Promise<boolean>;
  /** Resolves the caller's phone from the request, or null when unauthenticated. */
  phoneOf: (req: Request) => string | null;
}

export function createAnalyticsRouter(deps: AnalyticsDeps): Router {
  const router = Router();

  // Generous enough for a real reader moving through the site, tight enough
  // that a single source cannot flood the table.
  const collectLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    // A rate-limited beacon should be silently dropped, not answered with an
    // error the page has to handle.
    handler: (_req, res) => res.status(204).end(),
  });

  router.post("/pageview", collectLimiter, async (req: Request, res: Response) => {
    // Answer immediately and record afterwards. A visitor should never wait on
    // an analytics insert, and sendBeacon does not read the response anyway.
    res.status(204).end();

    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      await recordPageView(deps.getPool(), {
        path: String(body.path ?? ""),
        referrer: typeof body.referrer === "string" ? body.referrer : null,
        utmSource: typeof body.utmSource === "string" ? body.utmSource : null,
        utmMedium: typeof body.utmMedium === "string" ? body.utmMedium : null,
        utmCampaign: typeof body.utmCampaign === "string" ? body.utmCampaign : null,
        userAgent: req.headers["user-agent"] ?? null,
      });
    } catch (err: any) {
      // Already responded; nothing to surface to the caller.
      console.error(`[Analytics] pageview failed: ${err?.message || err}`);
    }
  });

  router.get("/traffic", async (req: Request, res: Response) => {
    const phone = deps.phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    if (!(await deps.isAdmin(phone))) return res.status(403).json({ error: "ADMIN_REQUIRED" });

    try {
      const days = Number(req.query.days) || 30;
      res.json(await trafficSummary(deps.getPool(), days));
    } catch (err: any) {
      console.error(`[Analytics] traffic summary failed: ${err?.message || err}`);
      res.status(500).json({ error: "Traffic summary failed." });
    }
  });

  return router;
}
