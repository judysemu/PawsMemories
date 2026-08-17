/**
 * Barkley Presenter — client-side presenter manager.
 *
 * Handles state machine, beat progression, TTS/lip-sync integration,
 * and interaction tracking for the Barkley educational experience.
 */

import { authedFetch } from "../api";
import type { BarkleyBeat, BarkleyShow, BarkleyState, BarkleyPresenterState, BarkleyInteractionResult, BarkleyInteractionType } from "./types";

const API_BASE = "/api/barkley";

/**
 * Fetch the current Barkley show from the server.
 * Returns null if the feature is disabled or clips are missing.
 */
export async function fetchBarkleyShow(): Promise<{ show: BarkleyShow } | null> {
  try {
    const res = await authedFetch(`${API_BASE}/show`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch Barkley readiness status (feature flag, clip availability).
 */
export async function fetchBarkleyStatus(): Promise<{
  enabled: boolean;
  clips: { total: number; ready: number; missing: string[]; allReady: boolean };
  show: { id: string; name: string; beatCount: number };
} | null> {
  try {
    const res = await authedFetch(`${API_BASE}/status`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Create a new presenter session on the server.
 */
export async function createBarkleySession(): Promise<{ sessionId: string; showId: string } | null> {
  try {
    const res = await authedFetch(`${API_BASE}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Advance to the next beat.
 */
export async function advanceBeat(sessionId: string): Promise<{
  state: BarkleyState;
  progress: number;
  beatIndex: number;
  beat: BarkleyBeat | null;
} | null> {
  try {
    const res = await authedFetch(`${API_BASE}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Submit an interaction result (quiz answer, reveal click).
 */
export async function submitInteraction(
  sessionId: string,
  beatId: string,
  answer: unknown,
  interactionType: BarkleyInteractionType
): Promise<{ correct: boolean; interactionResult: BarkleyInteractionResult } | null> {
  try {
    const res = await authedFetch(`${API_BASE}/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, beatId, answer, interactionType }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Replay a specific beat by ID.
 */
export async function replayBeat(
  sessionId: string,
  beatId: string
): Promise<{ state: BarkleyState; beatIndex: number; beat: BarkleyBeat } | null> {
  try {
    const res = await authedFetch(`${API_BASE}/replay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, beatId }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Delete the presenter session.
 */
export async function endSession(sessionId: string): Promise<void> {
  try {
    await authedFetch(`${API_BASE}/session`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  } catch {
    // Non-critical
  }
}
