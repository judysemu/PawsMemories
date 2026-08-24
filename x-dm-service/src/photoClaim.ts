/**
 * Turns an inbound photo DM into a one-time claim link.
 *
 * The deliberate choice here is what this module does NOT do: it never starts a
 * generation. A DM is an unauthenticated stranger, and pet model builds spend
 * real provider compute, reserve PupCoins, and require the customer to approve
 * generated views before each paid stage. None of that can happen in a DM, so
 * the photo is handed to the main app, which replies with a link into the
 * studio where those gates already live.
 *
 * The service therefore holds no ability to spend anything. It can park a photo
 * and hand back a URL, and that is the whole of its authority.
 */

import { getConfig } from './config.js';

/**
 * Hosts X serves DM media from. An allowlist rather than "any https URL"
 * because the media reference arrives inside a webhook payload -- that is
 * attacker-influenced input, and following it unrestricted is an SSRF the
 * service would perform against itself.
 */
const X_MEDIA_HOSTS = new Set([
  'pbs.twimg.com',
  'ton.twitter.com',
  'ton.x.com',
  'video.twimg.com',
]);

const ACCEPTED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Comfortably above any DM photo X will deliver, well below anything abusive. */
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Picks a directly fetchable photo URL out of the normalized media keys.
 *
 * Legacy Account Activity payloads carry `media_url_https`, which is a URL and
 * usable as-is. The v2 shape carries an opaque media key that only resolves
 * through a DM lookup with expansions -- a call this service cannot make until
 * the account has the DM read tier, so those return null and fall back to the
 * plain reply rather than pretending to work.
 */
export function directPhotoUrl(mediaKeys: string[] | null): string | null {
  for (const key of mediaKeys || []) {
    if (!key.startsWith('https://')) continue;
    try {
      const url = new URL(key);
      if (X_MEDIA_HOSTS.has(url.hostname)) return url.toString();
    } catch {
      // Not a URL we can use; keep looking.
    }
  }
  return null;
}

/** Bounded download: allowlisted host, capped size, capped time, image types only. */
export async function downloadPhoto(
  url: string,
): Promise<{ base64: string; mimeType: string } | null> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !X_MEDIA_HOSTS.has(parsed.hostname)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!res.ok) return null;

    const mimeType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ACCEPTED_MIME.has(mimeType)) return null;

    const declared = Number(res.headers.get('content-length') || '0');
    if (declared > MAX_PHOTO_BYTES) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    // Re-checked after reading: content-length is a claim, not a guarantee.
    if (buffer.byteLength > MAX_PHOTO_BYTES) return null;

    return { base64: buffer.toString('base64'), mimeType };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks the main app to park the photo and mint a one-time link.
 * Returns null on any failure -- the caller falls back to a plain reply rather
 * than DMing a link that will not work.
 */
export async function mintClaimLink(params: {
  base64: string;
  mimeType: string;
  sourceRef: string | null;
}): Promise<string | null> {
  const config = getConfig();
  if (!config.X_PHOTO_CLAIM_ENABLED) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.PAWSOME_API_BASE}/api/x-claims`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.X_CLAIM_SERVICE_SECRET}`,
      },
      body: JSON.stringify({
        imageBase64: params.base64,
        mimeType: params.mimeType,
        sourceRef: params.sourceRef,
        source: 'x_dm',
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[PhotoClaim] Mint failed: ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { claimUrl?: string };
    return body.claimUrl || null;
  } catch (err) {
    console.error(`[PhotoClaim] Mint error: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The full inbound-photo path. Returns the reply text to send, or null when
 * this DM is not a photo we can act on -- the caller then keeps its existing
 * behaviour rather than inventing a response.
 */
export async function claimReplyForPhoto(params: {
  mediaKeys: string[] | null;
  sourceRef: string | null;
}): Promise<string | null> {
  const config = getConfig();
  if (!config.X_PHOTO_CLAIM_ENABLED) return null;

  const url = directPhotoUrl(params.mediaKeys);
  if (!url) return null;

  const photo = await downloadPhoto(url);
  if (!photo) return null;

  const claimUrl = await mintClaimLink({
    base64: photo.base64,
    mimeType: photo.mimeType,
    sourceRef: params.sourceRef,
  });
  if (!claimUrl) return null;

  return (
    `Got your pet photo! 🐾 Here's your link to build the 3D model — ` +
    `it opens the studio with the photo already loaded:\n\n${claimUrl}\n\n` +
    `You'll pick the finish and approve the preview views before anything is built. ` +
    `Link is good for 3 days.`
  );
}
