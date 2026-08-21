/**
 * Shared HTTP behaviour for the Backblaze B2 S3 clients.
 *
 * Neither storage client set any timeout, so both inherited the SDK default of
 * none. That matters more than it looks: the AWS SDK retries transient 5xx and
 * socket errors on its own, but a connection that stalls without erroring
 * never produces a result to retry. It simply hangs — holding an Express
 * request, and in the paid pet-GLB flow holding a job in a non-terminal state
 * where the customer has been charged and nothing will ever settle it.
 *
 * A stall therefore has to become an error before the retry policy can do
 * anything useful.
 *
 * requestTimeout is socket inactivity, not total request duration, so a slow
 * upload of a large GLB is unaffected as long as bytes keep moving. Only a
 * genuinely dead connection trips it.
 */

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
};

export interface StorageHttpTuning {
  connectionTimeout: number;
  requestTimeout: number;
  maxAttempts: number;
}

/** Resolves the tuning, allowing an operator override without a code change. */
export function storageHttpTuning(env: NodeJS.ProcessEnv = process.env): StorageHttpTuning {
  return {
    // Establishing a TCP connection to B2 should be fast; waiting longer than
    // this means the endpoint is unreachable, not slow.
    connectionTimeout: positiveInt(env.MEDIA_BUCKET_CONNECT_TIMEOUT_MS, 6_000),
    // Inactivity, not total duration.
    requestTimeout: positiveInt(env.MEDIA_BUCKET_REQUEST_TIMEOUT_MS, 60_000),
    // One initial attempt plus three retries, using the SDK's standard
    // exponential backoff with jitter.
    maxAttempts: positiveInt(env.MEDIA_BUCKET_MAX_ATTEMPTS, 4),
  };
}

/**
 * S3Client options that make a stalled B2 call fail instead of hang.
 *
 * Spread into the client config. requestHandler is given as a plain options
 * object so the SDK builds its own default handler — importing
 * @smithy/node-http-handler directly would depend on a transitive package this
 * repo does not declare.
 */
export function storageHttpClientOptions(env: NodeJS.ProcessEnv = process.env) {
  const tuning = storageHttpTuning(env);
  return {
    maxAttempts: tuning.maxAttempts,
    requestHandler: {
      connectionTimeout: tuning.connectionTimeout,
      requestTimeout: tuning.requestTimeout,
    },
    // Backblaze is S3-compatible, not S3. Recent AWS SDK versions default both
    // of these to WHEN_SUPPORTED, which appends x-amz-checksum-mode=ENABLED to
    // GetObject and adds flexible-checksum headers to PutObject. B2 does not
    // implement those, and because the parameter participates in the signature
    // a presigned download comes back 403 rather than a clear "unsupported"
    // error -- which reads as an expired or malformed URL.
    //
    // WHEN_REQUIRED keeps checksums for the operations that genuinely need
    // them and stops the SDK volunteering them everywhere else.
    requestChecksumCalculation: "WHEN_REQUIRED" as const,
    responseChecksumValidation: "WHEN_REQUIRED" as const,
  };
}
