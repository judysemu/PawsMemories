/**
 * Barkley Presenter — API routes.
 *
 * GET  /api/barkley/show          — return the current show definition
 * GET  /api/barkley/clips         — return clip manifest
 * POST /api/barkley/session       — create a presenter session
 * POST /api/barkley/advance       — advance to next beat
 * POST /api/barkley/interact      — submit quiz/reveal answer
 * POST /api/barkley/replay        — replay a specific beat
 */

import { Router, type Request, type Response } from "express";
import { BARKLEY_SHOW as CANONICAL_SHOW } from "../../src/barkley/shows";
import {
  isBarkleyPresenterEnabled,
  BarkleyFeatureError,
  createBarkleySession,
  updateBarkleySession,
  getBarkleySession,
  deleteBarkleySession,
  getMissingClips,
  validateClipExists,
} from "./featureFlag";

// Lazy-import shows manifest (client-side file available at build time)
// The canonical show definition, imported statically.
//
// This previously used a lazy CommonJS require(), which cannot work in this
// ESM project ("type": "module") — it threw ReferenceError at startup and
// aborted startServer(), so every route mounted after it 404'd. A static
// import is also resolvable by the esbuild server bundle, so the try/catch
// stub it carried is unnecessary.
const BARKLEY_SHOW = CANONICAL_SHOW;

// ──────────────────────────────────────────────────────────────────
// Express router
// ──────────────────────────────────────────────────────────────────

export function barkleyRoutes(): any {
  const router = Router();

  // GET /api/barkley/status — feature flag + clip readiness
  router.get("/status", (_req: Request, res: Response) => {
    const enabled = isBarkleyPresenterEnabled();
    const missing = enabled ? getMissingClips() : [];
    const totalClips = 30;
    const readyClips = totalClips - missing.length;

    res.json({
      enabled,
      clips: {
        total: totalClips,
        ready: readyClips,
        missing: missing,
        allReady: missing.length === 0,
      },
      show: {
        id: BARKLEY_SHOW.id,
        name: BARKLEY_SHOW.name,
        beatCount: BARKLEY_SHOW.beats?.length ?? 0,
      },
    });
  });

  // GET /api/barkley/show — return the full show definition
  router.get("/show", (_req: Request, res: Response) => {
    if (!isBarkleyPresenterEnabled()) {
      return res.status(503).json({ error: "Barkley presenter is disabled" });
    }

    const missing = getMissingClips();
    if (missing.length > 0) {
      return res.status(503).json({
        error: "Barkley clips not yet ready",
        missingClips: missing,
        ready: false,
      });
    }

    // Sanitize beats: only send fields the client needs
    const safeBeats = (BARKLEY_SHOW.beats ?? []).map((b: any) => ({
      id: b.id,
      title: b.title,
      description: b.description,
      clip: b.clip,
      dialogue: b.dialogue,
      language: b.language ?? "en",
      camera: b.camera,
      durationSeconds: b.durationSeconds,
      interactive: b.interactive,
      edu: b.edu,
      order: b.order,
    }));

    res.json({
      show: {
        id: BARKLEY_SHOW.id,
        name: BARKLEY_SHOW.name,
        description: BARKLEY_SHOW.description,
        beats: safeBeats,
        totalDurationSeconds: BARKLEY_SHOW.totalDurationSeconds,
      },
    });
  });

  // GET /api/barkley/clips — return clip manifest
  router.get("/clips", (_req: Request, res: Response) => {
    if (!isBarkleyPresenterEnabled()) {
      return res.status(503).json({ error: "Barkley presenter is disabled" });
    }

    res.json({
      clips: (BARKLEY_SHOW.beats ?? []).map((b: any) => ({
        clipName: b.clip,
        usedBy: [b.id],
      })),
    });
  });

  // POST /api/barkley/session — create a new presenter session
  router.post("/session", (req: Request, res: Response) => {
    if (!isBarkleyPresenterEnabled()) {
      return res.status(503).json({ error: "Barkley presenter is disabled" });
    }

    const sessionId = req.headers["x-session-id"] as string || `barkley-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session = createBarkleySession(sessionId, BARKLEY_SHOW.id);

    res.json({
      sessionId: session.sessionId,
      showId: session.showId,
      state: session.state,
    });
  });

  // POST /api/barkley/advance — advance to next beat
  router.post("/advance", (req: Request, res: Response) => {
    if (!isBarkleyPresenterEnabled()) {
      return res.status(503).json({ error: "Barkley presenter is disabled" });
    }

    const sessionId = req.body.sessionId;
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }

    const session = getBarkleySession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const beats = BARKLEY_SHOW.beats ?? [];
    const nextIndex = session.currentBeatIndex + 1;

    if (nextIndex >= beats.length) {
      updateBarkleySession(sessionId, {
        state: "complete",
        progress: 1,
      });
      return res.json({
        state: "complete",
        progress: 1,
        beat: null,
      });
    }

    const nextBeat = beats[nextIndex];
    const progress = (nextIndex + 1) / beats.length;

    updateBarkleySession(sessionId, {
      currentBeatIndex: nextIndex,
      state: "playing",
      progress,
    });

    res.json({
      state: "playing",
      progress,
      beatIndex: nextIndex,
      beat: {
        id: nextBeat.id,
        title: nextBeat.title,
        clip: nextBeat.clip,
        dialogue: nextBeat.dialogue,
        camera: nextBeat.camera,
        durationSeconds: nextBeat.durationSeconds,
        interactive: nextBeat.interactive,
        edu: nextBeat.edu,
      },
    });
  });

  // POST /api/barkley/interact — submit quiz/reveal answer
  router.post("/interact", (req: Request, res: Response) => {
    if (!isBarkleyPresenterEnabled()) {
      return res.status(503).json({ error: "Barkley presenter is disabled" });
    }

    const sessionId = req.body.sessionId;
    const beatId = req.body.beatId;
    const answer = req.body.answer;
    const interactionType = req.body.interactionType;

    if (!sessionId || !beatId) {
      return res.status(400).json({ error: "sessionId and beatId are required" });
    }

    const session = getBarkleySession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Determine correctness for quiz interactions
    let correct = true;
    if (interactionType === "quiz") {
      const beat = (BARKLEY_SHOW.beats ?? []).find((b: any) => b.id === beatId);
      correct = beat?.interactive?.correctAnswer === answer;
    }

    // Record interaction
    const result = {
      beatId,
      interactionType,
      correct,
      timestamp: Date.now(),
    };
    session.interactions.push(result);

    updateBarkleySession(sessionId, {
      interactions: session.interactions,
      state: correct ? "playing" : "interacting",
    });

    res.json({
      correct,
      interactionResult: result,
    });
  });

  // POST /api/barkley/replay — replay a specific beat
  router.post("/replay", (req: Request, res: Response) => {
    if (!isBarkleyPresenterEnabled()) {
      return res.status(503).json({ error: "Barkley presenter is disabled" });
    }

    const sessionId = req.body.sessionId;
    const beatId = req.body.beatId;

    if (!sessionId || !beatId) {
      return res.status(400).json({ error: "sessionId and beatId are required" });
    }

    const session = getBarkleySession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const beats = BARKLEY_SHOW.beats ?? [];
    const beatIndex = beats.findIndex((b: any) => b.id === beatId);
    if (beatIndex === -1) {
      return res.status(404).json({ error: `Beat ${beatId} not found` });
    }

    updateBarkleySession(sessionId, {
      currentBeatIndex: beatIndex,
      state: "playing",
    });

    const beat = beats[beatIndex];
    res.json({
      state: "playing",
      beatIndex,
      beat: {
        id: beat.id,
        title: beat.title,
        clip: beat.clip,
        dialogue: beat.dialogue,
        camera: beat.camera,
        durationSeconds: beat.durationSeconds,
        interactive: beat.interactive,
        edu: beat.edu,
      },
    });
  });

  // DELETE /api/barkley/session — end session
  router.delete("/session", (req: Request, res: Response) => {
    const sessionId = req.body.sessionId || req.query.sessionId;
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }
    deleteBarkleySession(sessionId);
    res.json({ status: "deleted" });
  });

  return router;
}
