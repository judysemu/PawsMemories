export class ExternalGenerativeProviderBlockedError extends Error {
  readonly code = "INHOUSE_EXTERNAL_PROVIDER_BLOCKED";

  constructor(public readonly providerId: string) {
    super(`In-house-only mode blocks external generative provider '${providerId}'`);
    this.name = "ExternalGenerativeProviderBlockedError";
  }
}

/** One canonical parser for the fail-closed in-house generation switch. */
export function isInHouseOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.PAWS_3D_INHOUSE_ONLY || "").trim().toLowerCase() === "true";
}

/**
 * Last-line network boundary for paid external generative providers.
 *
 * Provider selection guards protect the current preferred path; this boundary
 * also protects legacy routes, retry workers, and direct adapter imports. It is
 * intentionally independent of any TRELLIS or Azure implementation.
 */
export function assertExternalGenerativeProviderAllowed(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isInHouseOnly(env)) {
    throw new ExternalGenerativeProviderBlockedError(providerId);
  }
}

export function rejectLegacyExternal3dRoute(
  _request: unknown,
  response: {
    status(code: number): { json(value: unknown): unknown };
  },
  next: () => void,
): unknown {
  if (!isInHouseOnly()) {
    next();
    return undefined;
  }
  return response.status(503).json({
    error: "This legacy outside 3D route is disabled while in-house generation is active.",
    code: "INHOUSE_EXTERNAL_PROVIDER_BLOCKED",
  });
}
