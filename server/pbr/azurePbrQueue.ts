/**
 * server/pbr/azurePbrQueue.ts — FalPbrQueue adapter for Azure Container Apps
 *
 * Implements the same three-method queue interface that falPbr.ts already uses,
 * but routes requests to a self-hosted PBR worker on Azure Container Apps
 * instead of the fal.ai SaaS endpoint.
 *
 * The worker exposes:
 *   POST /queue/submit   { endpoint, input }           → { request_id }
 *   GET  /queue/status    ?requestId=<id>               → { status, error? }
 *   GET  /queue/result    ?requestId=<id>               → { data }
 *
 * This adapter is injected into generateFalPbrMaterial() via options.queue,
 * completely bypassing the @fal-ai/client dependency.
 */

import type { FalPbrQueue } from "./falPbr";

export function createAzurePbrQueue(
  baseUrl: string,
  secret: string,
): FalPbrQueue {
  // Normalize: strip trailing slash
  const base = baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "X-Worker-Secret": secret,
    "Content-Type": "application/json",
  };

  return {
    async submit(endpoint, options) {
      const res = await fetch(`${base}/queue/submit`, {
        method: "POST",
        headers,
        body: JSON.stringify({ endpoint, input: options.input }),
      });
      if (!res.ok) {
        throw new Error(`Azure PBR worker submit failed: HTTP ${res.status}`);
      }
      return (await res.json()) as { request_id?: unknown };
    },

    async status(endpoint, options) {
      const res = await fetch(
        `${base}/queue/status?requestId=${encodeURIComponent(options.requestId)}`,
        { headers },
      );
      if (!res.ok) {
        throw new Error(`Azure PBR worker status failed: HTTP ${res.status}`);
      }
      return (await res.json()) as { status?: unknown; error?: unknown };
    },

    async result(endpoint, options) {
      const res = await fetch(
        `${base}/queue/result?requestId=${encodeURIComponent(options.requestId)}`,
        { headers },
      );
      if (!res.ok) {
        throw new Error(`Azure PBR worker result failed: HTTP ${res.status}`);
      }
      return (await res.json()) as { data?: unknown };
    },
  };
}
