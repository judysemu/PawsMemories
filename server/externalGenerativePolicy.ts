export class ExternalGenerativeProviderBlockedError extends Error {
  readonly code = "INHOUSE_EXTERNAL_PROVIDER_BLOCKED";

  constructor(public readonly providerId: string) {
    super(`In-house-only mode blocks external generative provider '${providerId}'`);
    this.name = "ExternalGenerativeProviderBlockedError";
  }
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
  if (env.PAWS_3D_INHOUSE_ONLY === "true") {
    throw new ExternalGenerativeProviderBlockedError(providerId);
  }
}
