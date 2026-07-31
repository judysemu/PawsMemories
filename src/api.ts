import { PublicUser, Creation, Album, LocationParams, Avatar, PhotoRequest, RequestType, AvatarNeeds, BehaviorAction, PlacedObject, VoiceCloneAsset } from "./types";
import type { VisemeTrack } from "./animator/viseme/visemeRules";

/**
 * Lightweight API client that manages the session token and auth flow.
 * The token is stored in localStorage and attached to protected requests.
 */

const TOKEN_KEY = "paws_auth_token";

export function getToken(): string | null {
  if (typeof localStorage === "undefined" || typeof localStorage.getItem !== "function") return null;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  if (typeof localStorage === "undefined" || typeof localStorage.setItem !== "function") return;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage can be denied in private or embedded browser contexts.
  }
}

export function clearToken(): void {
  if (typeof localStorage === "undefined" || typeof localStorage.removeItem !== "function") return;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Treat an inaccessible token store as already cleared.
  }
}

export function isAuthenticated(): boolean {
  return !!getToken();
}

/** fetch() wrapper that adds the Authorization header for protected endpoints. */
export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

export async function importIfc(ifcBase64: string): Promise<any> {
  const res = await authedFetch("/api/bim/import-ifc", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ifcBase64 }),
  });
  if (!res.ok) throw new Error(await parseError(res, "IFC import failed."));
  return res.json();
}

export type BimSourceKind = "text" | "image";
export type BimImageView = "front" | "rear" | "left" | "right" | "interior" | "plan" | "detail";
export interface BimCalibrationInput {
  sourceKind: BimSourceKind;
  sourceDescription: string;
  imageViews: BimImageView[];
  synthesizedImageViews: BimImageView[];
  measurements: Array<{ id: string; axis: "width" | "depth" | "height"; value: number; unit: "m" | "cm" | "mm" | "ft" | "in"; source: "user_measurement" | "drawing" | "survey" | "known_object" }>;
  coordinateReference?: string;
  userConfirmedAssumptions: string[];
}
export interface BimProposalImage { view: BimImageView; mimeType: "image/jpeg" | "image/png" | "image/webp"; data: string }

export async function proposeBim(calibration: BimCalibrationInput, mode: "shell" | "ifc", images: BimProposalImage[]): Promise<any> {
  const res = await authedFetch("/api/bim/propose", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ calibration, mode, images }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Building proposal failed."));
  return res.json();
}

export async function preflightBim(model: Record<string, unknown>, mode: "shell" | "ifc", calibration?: BimCalibrationInput): Promise<any> {
  const res = await authedFetch("/api/bim/preflight", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, mode, calibration }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.verification) throw new Error(data.error || "Pre-build verification failed.");
  return data;
}

export async function buildBim(model: Record<string, unknown>, mode: "shell" | "ifc", calibration?: BimCalibrationInput): Promise<any> {
  const res = await authedFetch("/api/bim/build", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, mode, calibration }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Verified model build failed."));
  return res.json();
}

export interface SavedBimBuild {
  id: string; name: string; mode: "shell" | "ifc"; price: number;
  glbUrl: string | null; ifcUrl: string | null; sidecarUrl: string | null;
  elementCount: number; sizeBytes: number; createdAt: string;
}

export async function listBimBuilds(): Promise<SavedBimBuild[]> {
  const res = await authedFetch("/api/bim/builds");
  if (!res.ok) throw new Error(await parseError(res, "Could not load saved models."));
  const data = await res.json();
  return Array.isArray(data.builds) ? data.builds : [];
}

async function parseError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    return data?.error || fallback;
  } catch {
    return fallback;
  }
}

export class ApiError extends Error {
  constructor(public status: number, public code: string | null, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function throwApiError(res: Response, fallback: string): Promise<never> {
  let body: any = {};
  try {
    body = await res.json();
  } catch {}
  throw new ApiError(res.status, body?.code ?? null, body?.error || fallback);
}

// --- Auth flow -------------------------------------------------------------

/** Step 1: create an account with email + password. Stores the session token. */
export async function signup(email: string, password: string, confirmPassword: string, acceptedTerms: boolean): Promise<PublicUser> {
  const res = await fetch("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, confirmPassword, acceptedTerms }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Sign up failed."));
  const data = await res.json();
  setToken(data.token);
  return data.user as PublicUser;
}

export async function acceptCurrentTerms(): Promise<PublicUser> {
  const res = await authedFetch("/api/auth/accept-terms", { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res, "Could not save your acceptance."));
  const data = await res.json();
  return data.user as PublicUser;
}

/** Step 2: save the required profile (name, birthdate, city, pets) to the DB. */
export async function completeProfile(fullName: string, birthdate: string, city: string, pets?: {name: string, kind: string}[]): Promise<PublicUser> {
  const res = await authedFetch("/api/auth/complete-profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fullName, birthdate, city, pets }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Could not save your profile."));
  const data = await res.json();
  return data.user as PublicUser;
}

export async function login(email: string, password: string): Promise<PublicUser> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Login failed."));
  const data = await res.json();
  setToken(data.token);
  return data.user as PublicUser;
}

/** Request a password-reset email. Always resolves (no account enumeration). */
export async function requestPasswordReset(email: string): Promise<string> {
  const res = await fetch("/api/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const data = await res.json().catch(() => ({}));
  return data.message || "If that email is registered, a reset link is on its way.";
}

/** Complete a password reset with the emailed token. */
export async function resetPassword(token: string, newPassword: string): Promise<string> {
  const res = await fetch("/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, newPassword }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Could not reset password."));
  const data = await res.json();
  return data.message || "Password updated.";
}

/** Restore the session on app load. Returns null if there is no valid session. */
export async function fetchMe(): Promise<PublicUser | null> {
  if (!getToken()) return null;
  const res = await authedFetch("/api/me");
  if (res.status === 401 || res.status === 403) {
    clearToken();
    return null;
  }
  if (!res.ok) throw new Error(await parseError(res, "Could not restore your session."));
  const data = await res.json();
  return data.user as PublicUser;
}

export async function claimDailyStreak(): Promise<PublicUser> {
  const res = await authedFetch("/api/streak/claim", { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res, "Failed to claim streak."));
  const data = await res.json();
  return data.user as PublicUser;
}

export async function claimAchievement(id: string): Promise<PublicUser> {
  const res = await authedFetch("/api/achievements/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Failed to claim achievement."));
  const data = await res.json();
  return data.user as PublicUser;
}

export interface CreditTxn {
  id: number;
  delta: number;
  reason: string;
  balance_after: number;
  created_at: string;
}

export async function getCreditHistory(): Promise<CreditTxn[]> {
  const res = await authedFetch("/api/credits/history");
  if (!res.ok) return [];
  const data = await res.json();
  return (data.history as CreditTxn[]) || [];
}

/** Confirm a Stripe checkout session after redirect and credit it if not already done. */
export async function confirmCreditsSession(sessionId: string): Promise<{ credited: number; balance: number } | null> {
  const res = await authedFetch(`/api/credits/confirm?session_id=${encodeURIComponent(sessionId)}`);
  if (!res.ok) return null;
  const d = await res.json();
  return { credited: d.credited ?? 0, balance: d.balance ?? 0 };
}

// --- User photo library ----------------------------------------------------

export interface UserPhoto { id: number; image_url: string; source: string; created_at?: string; }

export async function uploadProfilePhoto(image: string): Promise<PublicUser> {
  const res = await authedFetch("/api/profile/photo", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Failed to update profile photo."));
  return (await res.json()).user as PublicUser;
}

export async function getUserPhotos(): Promise<UserPhoto[]> {
  const res = await authedFetch("/api/profile/photos");
  if (!res.ok) return [];
  return ((await res.json()).photos as UserPhoto[]) || [];
}

export async function addUserPhoto(image: string): Promise<UserPhoto> {
  const res = await authedFetch("/api/profile/photos", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Failed to add photo."));
  return (await res.json()).photo as UserPhoto;
}

export async function deleteUserPhoto(id: number): Promise<boolean> {
  const res = await authedFetch(`/api/profile/photos/${id}`, { method: "DELETE" });
  return res.ok;
}

export async function listVoiceCloneAssets(): Promise<VoiceCloneAsset[]> {
  const res = await authedFetch("/api/voice-clones");
  if (!res.ok) return [];
  return ((await res.json()).assets as VoiceCloneAsset[]) || [];
}

export async function createVoiceCloneAsset(input: {
  name: string;
  audioBase64: string;
  mimeType: string;
  bytes: number;
  voiceConsent: boolean;
}): Promise<{ asset: VoiceCloneAsset; user?: PublicUser }> {
  const res = await authedFetch("/api/voice-clones", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res, "Could not save the voice clone."));
  const data = await res.json();
  return { asset: data.asset as VoiceCloneAsset, user: data.user as PublicUser | undefined };
}

// --- Community -------------------------------------------------------------

export interface CommunityPark { name: string; address: string; rating: number | null; open: boolean | null; }
export interface CommunityWeather { tempC: number; tempF: number; condition: string; source: string; }
export interface CommunityRecall { product: string; reason: string; company: string; date: string; classification: string; }
export interface CommunityMemory { id: number; image_url: string; caption: string | null; created_at?: string; }

export async function getCommunityParks(lat: number, lng: number): Promise<CommunityPark[]> {
  const res = await authedFetch(`/api/community/parks?lat=${lat}&lng=${lng}`);
  if (!res.ok) return [];
  return ((await res.json()).parks as CommunityPark[]) || [];
}

export async function getCommunityWeather(lat: number, lng: number): Promise<CommunityWeather | null> {
  const res = await authedFetch(`/api/community/weather?lat=${lat}&lng=${lng}`);
  if (!res.ok) return null;
  return ((await res.json()).weather as CommunityWeather) || null;
}

export async function getPetRecalls(): Promise<CommunityRecall[]> {
  const res = await authedFetch(`/api/community/recalls`);
  if (!res.ok) return [];
  return ((await res.json()).recalls as CommunityRecall[]) || [];
}

export async function getCommunityMemories(): Promise<CommunityMemory[]> {
  const res = await authedFetch(`/api/community/memories`);
  if (!res.ok) return [];
  return ((await res.json()).memories as CommunityMemory[]) || [];
}

export async function uploadCommunityMemory(image: string, caption: string): Promise<CommunityMemory> {
  const res = await authedFetch(`/api/community/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image, caption }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Failed to share memory."));
  return (await res.json()).memory as CommunityMemory;
}

// --- Phase 1: Street View & Creations Flow ---------------------------------

export async function checkStreetViewCoverage(lat: number, lng: number): Promise<{ status: string }> {
  const res = await authedFetch(`/api/streetview/coverage?lat=${lat}&lng=${lng}`);
  if (!res.ok) throw new Error(await parseError(res, "Failed to check street view coverage."));
  const data = await res.json();
  return data.data;
}

export async function fetchCreations(): Promise<Creation[]> {
  try {
    const res = await authedFetch("/api/creations");
    if (!res.ok) throw new Error("Failed to fetch creations");
    const data = await res.json();
    return data.creations || [];
  } catch (err) {
    console.error(err);
    return [];
  }
}

export interface ModelLibraryItem {
  id: number;
  source_type: "creation" | "avatar" | "pet_glb_order" | "marketplace_listing";
  listing_uuid?: string;
  name: string | null;
  breed: string | null;
  image_url: string | null;
  model_url: string | null;
  rigged_model_url: string | null;
  status: string;
  created_at: string;
  canonical_asset_uuid?: string;
  billing_disposition?: "charged" | "refunded" | "not_charged" | "refund_pending";
  failure_code?: string | null;
}

export async function fetchModelLibrary(): Promise<ModelLibraryItem[]> {
  const res = await authedFetch("/api/models/library");
  if (!res.ok) throw new Error(await parseError(res, "Failed to load your models."));
  return (await res.json()).models || [];
}

export interface FulfillmentReadiness {
  /**
   * `blockers` names absent server dependencies (e.g. "stripe",
   * "printful_api_key") so a surface can explain *why* ordering is paused
   * instead of only that it is. Never contains secret names or values.
   */
  modelPrinting: { provider: "slant3d"; available: boolean; blockers?: string[] };
  pawprintPrinting: { provider: "printful"; available: boolean; productCount: number; blockers?: string[] };
}

export async function fetchFulfillmentReadiness(): Promise<FulfillmentReadiness> {
  const res = await fetch("/api/fulfillment/readiness");
  if (!res.ok) throw new Error("Could not check print availability.");
  return await res.json();
}

export async function createSlant3dCheckout(input: {
  sourceType: "creation" | "avatar" | "pet_glb_order";
  sourceId: number;
  targetHeightMm: number;
  recipient: {
    name: string;
    email: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
}): Promise<{ checkoutUrl: string; stlUrl: string; dimensionsMm: { x: number; y: number; z: number } }> {
  const res = await authedFetch("/api/print/slant3d/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res, "Could not prepare this model for printing."));
  return await res.json();
}

export async function createMarketplacePrintCheckout(input: {
  listingUuid: string;
  targetHeightMm: number;
  recipient: {
    name: string;
    email: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
}): Promise<{ checkoutUrl: string; stlUrl: string; dimensionsMm: { x: number; y: number; z: number } }> {
  const res = await authedFetch(`/api/marketplace/listings/${input.listingUuid}/print/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res, "Could not prepare this listing for printing."));
  return await res.json();
}

export interface ModelPrintOrder {
  id: number;
  source_type: "creation" | "avatar" | "marketplace_listing";
  source_id: number;
  provider: "slant3d";
  provider_pack_id: string;
  target_height_mm: number;
  checkout_url: string | null;
  retail_price_cents: number | null;
  status: string;
  created_at: string;
  updated_at: string;
  tracking: ShipmentTracking[];
}

export interface ShipmentTracking {
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: string | null;
}

export async function fetchModelPrintOrders(): Promise<ModelPrintOrder[]> {
  const res = await authedFetch("/api/print/orders");
  if (!res.ok) throw new Error(await parseError(res, "Could not load print orders."));
  return (await res.json()).orders || [];
}

export interface PawprintPrintOrder {
  id: number;
  creation_id: number;
  product_code: string;
  provider_order_id: string;
  print_file_url: string;
  quantity: number;
  retail_price_cents: number | null;
  checkout_url: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  tracking: ShipmentTracking[];
}

export async function fetchPawprintPrintOrders(): Promise<PawprintPrintOrder[]> {
  const res = await authedFetch("/api/pawprints/print-orders");
  if (!res.ok) throw new Error(await parseError(res, "Could not load Pawprint print orders."));
  return (await res.json()).orders || [];
}

export async function fetchAlbums(): Promise<Album[]> {
  try {
    const res = await authedFetch("/api/albums");
    if (!res.ok) throw new Error("Failed to fetch albums");
    const data = await res.json();
    return data.albums || [];
  } catch (err) {
    console.error(err);
    return [];
  }
}

export async function createAlbum(name: string): Promise<Album | null> {
  const res = await authedFetch("/api/albums", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    console.error(await parseError(res, "Failed to create album."));
    return null;
  }
  const data = await res.json();
  return data.album as Album;
}

export async function updateCreationOrder(id: number, sortOrder: number): Promise<void> {
  const res = await authedFetch(`/api/creations/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sort_order: sortOrder }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Failed to update creation order."));
}

export async function createVideo(
  creationId: number,
  motionPrompt?: string,
  generateAudio: boolean = true,
  aspectRatio: "16:9" | "9:16" = "16:9"
): Promise<{ jobId: number }> {
  const res = await authedFetch("/api/create-video", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creationId, motionPrompt, generateAudio, aspectRatio }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Failed to start video generation."));
  return await res.json();
}

export async function createTalkingVideo(creationId: number, script: string, voiceId?: string): Promise<{ jobId: number }> {
  const res = await authedFetch("/api/create-talking-video", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creationId, script, voiceId }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Failed to start talking video generation."));
  return await res.json();
}

export interface VoicePreviewResult {
  audioBase64: string;
  mimeType: string;
  track: VisemeTrack | null;
  tier: "B" | "A";
  degradedReason?: string;
  creditsCharged: number;
}

/** Generate real configured TTS audio and its server-produced lip-sync track. */
export async function createVoicePreview(text: string): Promise<VoicePreviewResult> {
  const res = await authedFetch("/api/animator/speech-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, language: "en" }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Voice and lip-sync preview could not be generated."));
  const data = await res.json() as Partial<VoicePreviewResult>;
  if (typeof data.audioBase64 !== "string" || !data.audioBase64 || typeof data.mimeType !== "string" || !data.mimeType.startsWith("audio/") || (data.tier !== "A" && data.tier !== "B")) {
    throw new Error("The voice service returned an invalid preview.");
  }
  return data as VoicePreviewResult;
}

export async function create3DModel(creationId: number): Promise<{ jobId: number }> {
  const res = await authedFetch("/api/create-3d-model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creationId }),
  });
  if (!res.ok) await throwApiError(res, "Failed to start 3D model generation.");
  return await res.json();
}

export async function pollJob(jobId: number): Promise<{ status: string; video_url?: string | null; model_url?: string | null; error?: string | null }> {
  const res = await authedFetch(`/api/jobs/${jobId}`);
  if (!res.ok) throw new Error(await parseError(res, "Failed to poll job status."));
  return await res.json();
}

// --- Avatars Flow ----------------------------------------------------------

export async function fetchAvatars(): Promise<Avatar[]> {
  try {
    const res = await authedFetch("/api/avatars");
    if (!res.ok) throw new Error("Failed to fetch avatars");
    const data = await res.json();
    return data.avatars || [];
  } catch (err) {
    console.error(err);
    return [];
  }
}

/**
 * Create a new 3D avatar from one or more pet photos.
 * The server first fuses the photos into a single hyper-realistic reference image
 * (pet standing on all 4 legs, facing forward, slight panting expression),
 * then generates the 3D model from that image. Returns immediately; generation is async.
 */
export async function generate3DAvatar(options: any): Promise<{ avatarId: number; status: string; referenceImageUrl?: string; usedReferenceImage?: boolean; avatarType?: 'dog' | 'human' | 'object'; notice?: string; chargedCredits?: number }> {
  const res = await authedFetch("/api/avatars", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!res.ok) await throwApiError(res, "Failed to create model.");
  return await res.json();
}

/** Poll the generation status of a 3D avatar. */
export async function pollAvatarStatus(avatarId: number): Promise<{
  status: string;
  error?: string | null;
  model_url?: string | null;
  sprite_sheet_url?: string | null;
}> {
  const res = await authedFetch(`/api/avatars/${avatarId}/status`);
  if (!res.ok) throw new Error(await parseError(res, "Failed to get avatar status."));
  return await res.json();
}

/** Retry a failed avatar generation. Resets status and re-triggers the 3D pipeline. */
export async function retryAvatarGeneration(avatarId: number, stylePreset?: string): Promise<{ success: boolean; status: string; chargedCredits?: number; user?: PublicUser }> {
  const res = await authedFetch(`/api/avatars/${avatarId}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stylePreset ? { stylePreset } : {}),
  });
  if (!res.ok) throw new Error(await parseError(res, "Failed to retry avatar generation."));
  return await res.json();
}

export async function feedAvatarReq(id: number): Promise<boolean> {
  const res = await authedFetch(`/api/avatars/${id}/feed`, { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res, "Failed to feed avatar."));
  const data = await res.json();
  return data.success;
}

export async function waterAvatarReq(id: number): Promise<boolean> {
  const res = await authedFetch(`/api/avatars/${id}/water`, { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res, "Failed to water avatar."));
  const data = await res.json();
  return data.success;
}

export async function giveTreatReq(id: number): Promise<{ success: boolean, user?: PublicUser }> {
  const res = await authedFetch(`/api/avatars/${id}/treat`, { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res, "Failed to give treat."));
  return await res.json();
}

// --- Photo Requests Flow ---------------------------------------------------

/** Submit a photo/video memory request with upfront Stripe payment. */
export async function submitPhotoRequest(
  request_type: RequestType,
  comment: string,
  photo?: string | null
): Promise<{ requestId: number; checkoutUrl: string; mode: string }> {
  const res = await authedFetch("/api/photo-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_type, comment, photo: photo || null }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Failed to submit request."));
  return await res.json();
}

/** Fetch the current user's photo/video requests. */
export async function fetchMyRequests(): Promise<PhotoRequest[]> {
  try {
    const res = await authedFetch("/api/photo-requests");
    if (!res.ok) throw new Error("Failed to fetch requests");
    const data = await res.json();
    return data.requests || [];
  } catch (err) {
    console.error(err);
    return [];
  }
}

/** Admin: fetch all photo/video requests. */
export async function fetchAdminRequests(): Promise<PhotoRequest[]> {
  try {
    const res = await authedFetch("/api/admin/photo-requests");
    if (!res.ok) throw new Error("Failed to fetch admin requests");
    const data = await res.json();
    return data.requests || [];
  } catch (err) {
    console.error(err);
    return [];
  }
}

/** Admin: fulfill a request by linking a generation result. */
export async function fulfillRequest(
  requestId: number,
  creationId: number
): Promise<{ success: boolean; userCreationId?: number }> {
  const res = await authedFetch(`/api/admin/photo-requests/${requestId}/fulfill`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creationId }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Failed to fulfill request."));
  return await res.json();
}

/** Admin: reject a request and trigger Stripe refund. */
export async function rejectRequest(
  requestId: number,
  adminNotes?: string
): Promise<{ success: boolean }> {
  const res = await authedFetch(`/api/admin/photo-requests/${requestId}/reject`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ adminNotes }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Failed to reject request."));
  return await res.json();
}

// --- Living avatar: needs & commands (Phase 2) -----------------------------

/**
 * Fetch the server-computed live needs for an avatar (server applies offline
 * decay from `last_seen`). Returns null if the endpoint is unavailable so the
 * client can fall back to a local simulation — safe to deploy the frontend
 * before the backend.
 */
export async function fetchAvatarNeeds(avatarId: number): Promise<AvatarNeeds | null> {
  try {
    const res = await authedFetch(`/api/avatars/${avatarId}/state`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.needs as AvatarNeeds) ?? null;
  } catch {
    return null;
  }
}

/** Persist the current needs snapshot. Best-effort; resolves false on failure. */
export async function patchAvatarNeeds(avatarId: number, needs: AvatarNeeds): Promise<boolean> {
  try {
    const res = await authedFetch(`/api/avatars/${avatarId}/state`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ needs }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Log a user-issued command (telemetry + ambient awareness). Best-effort. */
export async function sendAvatarCommand(
  avatarId: number,
  action: BehaviorAction,
  targetObjectId?: string
): Promise<boolean> {
  try {
    const res = await authedFetch(`/api/avatars/${avatarId}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, targetObjectId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// --- Placed objects (Phase 3) ----------------------------------------------

/** Load the objects the user has placed for an avatar. Returns [] on failure. */
export async function fetchPlacedObjects(avatarId: number): Promise<PlacedObject[]> {
  try {
    const res = await authedFetch(`/api/avatars/${avatarId}/objects`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.objects as PlacedObject[]) ?? [];
  } catch {
    return [];
  }
}

/** Persist a newly placed object. Best-effort. */
export async function createPlacedObject(avatarId: number, obj: PlacedObject): Promise<boolean> {
  try {
    const res = await authedFetch(`/api/avatars/${avatarId}/objects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(obj),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Remove a placed object. Best-effort. */
export async function deletePlacedObject(avatarId: number, objectId: string): Promise<boolean> {
  try {
    const res = await authedFetch(`/api/avatars/${avatarId}/objects/${objectId}`, {
      method: "DELETE",
    });
    return res.ok;
  } catch {
    return false;
  }
}

// --- AR Cast (Phase 5) ----------------------------------------------------

export async function fetchSceneActors(avatarId: number): Promise<any[]> {
  try {
    const res = await authedFetch(`/api/ar/${avatarId}/cast`);
    if (!res.ok) return [];
    const data = await res.json();
    return data?.actors || [];
  } catch {
    return [];
  }
}

export async function addSceneActor(avatarId: number, actor: any): Promise<boolean> {
  try {
    const res = await authedFetch(`/api/ar/${avatarId}/cast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(actor),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function updateSceneActor(avatarId: number, actorId: string, transform: any, selectedClip?: string): Promise<boolean> {
  try {
    const res = await authedFetch(`/api/ar/${avatarId}/cast/${actorId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transform, selectedClip }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function removeSceneActor(avatarId: number, actorId: string): Promise<boolean> {
  try {
    const res = await authedFetch(`/api/ar/${avatarId}/cast/${actorId}`, {
      method: "DELETE",
    });
    return res.ok;
  } catch {
    return false;
  }
}

// --- Image-to-3D utility (generic, not pet-specific) -----------------------

export interface ImageTo3DMultiview {
  left?: string;
  back?: string;
  right?: string;
}

/** Geometry overrides for 3D generation (ids match the backend dropdowns). */
export interface ImageTo3DGeometry {
  /** "draft" | "standard" | "high" | "ultra" */
  detail?: string;
  /** "pbr_detailed" | "basic" | "none" */
  texture?: string;
}

/**
 * Submit any arbitrary image for 3D GLB generation via Tripo.
 * Optionally supply multiview turnaround shots and/or geometry overrides.
 * Returns a jobId that can be polled via the existing `pollJob()`.
 */
export async function submitImageTo3D(
  image: string,
  multiview?: ImageTo3DMultiview,
  geometry?: ImageTo3DGeometry
): Promise<{ jobId: number; status: string }> {
  const res = await authedFetch("/api/image-to-3d", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image, multiview, geometry }),
  });
  if (!res.ok) await throwApiError(res, "Failed to start 3D generation.");
  return await res.json();
}

/** Structured text-prompt fields for generating a reference image. */
export interface TextReferenceFields {
  subject: string;
  style?: string;
  framing?: string;
  angle?: string;
  lighting?: string;
}

/**
 * Turn a structured text prompt into a single reference image (data URL) via
 * the backend Gemini step. Cheap preview — the returned image is then passed to
 * `submitImageTo3D()` to actually build the mesh.
 */
export async function generateTextReference(
  fields: TextReferenceFields
): Promise<{ image: string; prompt: string }> {
  const res = await authedFetch("/api/text-to-reference", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) await throwApiError(res, "Failed to generate reference image.");
  return await res.json();
}

/** Delete an avatar/model from the user's roster (removes the DB row). */
/**
 * Remove a model from the roster. Server-side this is a soft hide — the row and
 * the GLB survive and the removal can be undone with restoreAvatar().
 */
export async function deleteAvatar(id: number): Promise<void> {
  const res = await authedFetch(`/api/avatars/${id}`, { method: "DELETE" });
  if (!res.ok) await throwApiError(res, "Failed to remove model.");
}

/** Models the user removed from their roster; still restorable. */
export async function fetchHiddenAvatars(): Promise<any[]> {
  const res = await authedFetch("/api/avatars/hidden");
  if (!res.ok) return [];
  const data = await res.json();
  return data.avatars || [];
}

/** Undo a removal. */
export async function restoreAvatar(id: number): Promise<void> {
  const res = await authedFetch(`/api/avatars/${id}/restore`, { method: "POST" });
  if (!res.ok) await throwApiError(res, "Failed to restore model.");
}

/** Public per-site config (deployTarget + printEmail). No auth required. */
export async function getAppConfig(): Promise<{ deployTarget: string; printEmail?: string }> {
  const res = await fetch("/api/config");
  if (!res.ok) return { deployTarget: "main" };
  return await res.json();
}

/** Upload a model file (base64 data URL) for a 3D-print request → durable URL. */
export async function uploadPrintFile(fileBase64: string, mime: string): Promise<string> {
  const res = await authedFetch("/api/print-uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileBase64, mime }),
  });
  if (!res.ok) await throwApiError(res, "Upload failed.");
  const data = await res.json();
  return data.url as string;
}

// --- Storage (Phase 8) ------------------------------------------------------

export interface StorageUsage {
  bytesHot: number;
  bytesCold: number;
  freeLimit: number;
  coldGbPurchased: number;
  coldLimit: number;
}

export async function fetchStorageUsage(): Promise<StorageUsage | null> {
  try {
    const res = await authedFetch("/api/storage/usage");
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function purchaseStorageGb(requestId: string): Promise<{ success: boolean; error?: string; usage?: StorageUsage }> {
  try {
    const res = await authedFetch("/api/storage/purchase-gb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId }),
    });
    const data = await res.json();
    return { success: data.success, error: data.error, usage: data.usage };
  } catch {
    return { success: false, error: "Network error" };
  }
}

// --- Public Marketplace & Entitlements --------------------------------------

export async function fetchMarketplaceListings(params: Record<string, string | number> = {}): Promise<any> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") qs.set(k, String(v));
  }
  const url = `/api/marketplace/listings${qs.toString() ? '?' + qs.toString() : ''}`;
  const res = await fetch(url); // Unauthed
  if (!res.ok) throw new Error(await parseError(res, "Could not load marketplace listings."));
  return await res.json();
}

export async function checkoutDigitalListing(uuid: string, idempotencyKey: string): Promise<{ checkoutUrl: string }> {
  const res = await authedFetch(`/api/marketplace/listings/${uuid}/checkout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    }
  });
  if (!res.ok) await throwApiError(res, "Checkout failed.");
  return await res.json();
}

export async function fetchDigitalOrderStatus(orderId: string): Promise<{ status: string }> {
  const res = await authedFetch(`/api/marketplace/orders/${orderId}`);
  if (!res.ok) throw new Error(await parseError(res, "Could not get order status."));
  return await res.json();
}

export async function fetchUserEntitlements(): Promise<any[]> {
  const res = await authedFetch("/api/marketplace/entitlements");
  if (!res.ok) return [];
  const data = await res.json();
  return data.entitlements || [];
}

export async function downloadDigitalListing(uuid: string): Promise<{ url: string }> {
  const res = await authedFetch(`/api/marketplace/listings/${uuid}/download`);
  if (!res.ok) await throwApiError(res, "Download failed.");
  return await res.json();
}

// --- Texturizer API (Phase UV6) -----------------------------------------------

export interface TextureJobStatus {
  jobId: string;
  avatarId?: number;
  status: "queued" | "processing" | "rendering_views" | "stylizing" | "baking" | "completed" | "failed";
  resultUrl?: string;
  stats?: Record<string, any>;
  error?: string;
  idempotent?: boolean;
}

export async function createTextureJob(
  idempotencyKey: string,
  payload: {
    avatar_id: number;
    prompt: string;
    tier: "draft" | "standard" | "studio";
    identity_strength: "high" | "medium" | "stylized";
  }
): Promise<{ jobId: string; status: string; cost: number }> {
  const res = await authedFetch("/api/texture/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to create texture job (${res.status})`);
  }
  return res.json();
}

export async function rebakeTextureJob(
  idempotencyKey: string,
  payload: { avatar_id: number; texture_size?: number }
): Promise<{ jobId: string; status: string; idempotent?: boolean; resultUrl?: string }> {
  const res = await authedFetch("/api/texture/rebake", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to start rebake (${res.status})`);
  }
  return res.json();
}

export async function getTextureJob(jobId: string): Promise<TextureJobStatus> {
  const res = await authedFetch(`/api/texture/jobs/${jobId}`);
  if (!res.ok) throw new Error("Failed to fetch texture job");
  return res.json();
}

export async function createReferenceSession(
  inputMode: "text" | "photo",
  prompt?: string,
  subjectClass: string = "pet",
  sourceImageDataUrl?: string,
  sourceImageDataUrls?: string[],
): Promise<{ success: boolean; sessionUuid: string; state: string }> {
  const candidates = (sourceImageDataUrls?.length ? sourceImageDataUrls : sourceImageDataUrl ? [sourceImageDataUrl] : [])
    .map((value) => value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/i))
    .filter((match): match is RegExpMatchArray => Boolean(match));
  if (inputMode === "photo" && candidates.length === 0) {
    throw new Error("The source photo must be an embedded PNG, JPEG, or WebP image.");
  }
  const res = await authedFetch("/api/reference-sessions/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inputMode,
      prompt,
      subjectClass,
      sourceImageBase64: candidates[0]?.[2],
      sourceMimeType: candidates[0]?.[1]?.toLowerCase(),
      sourceImagesBase64: candidates.map((match) => match[2]),
      sourceMimeTypes: candidates.map((match) => match[1].toLowerCase()),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to create reference session (${res.status})`);
  }
  return res.json();
}

export async function startReferenceAttempt(
  sessionUuid: string,
  idempotencyKey: string,
): Promise<{ success: boolean; session: any }> {
  const res = await authedFetch("/api/reference-sessions/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionUuid, idempotencyKey }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to start reference attempt (${res.status})`);
  }
  return res.json();
}

export async function replaceReferenceSource(
  sessionUuid: string,
  sourceImageDataUrl: string,
): Promise<{ success: boolean; session: any }> {
  const match = sourceImageDataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) throw new Error("The replacement must be a PNG, JPEG, or WebP image.");
  const res = await authedFetch("/api/reference-sessions/replace-source", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionUuid, mimeType: match[1].toLowerCase(), imageBufferBase64: match[2] }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to replace reference source (${res.status})`);
  }
  return res.json();
}

export async function retryReferenceAttempt(
  sessionUuid: string,
  idempotencyKey: string,
  retryNotes?: string,
): Promise<{ success: boolean; session: any }> {
  const res = await authedFetch("/api/reference-sessions/retry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionUuid, idempotencyKey, retryNotes }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to retry reference attempt (${res.status})`);
  }
  return res.json();
}

export async function cancelReferenceSession(
  sessionUuid: string,
): Promise<{ success: boolean; state: string }> {
  const res = await authedFetch("/api/reference-sessions/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionUuid }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to cancel reference session (${res.status})`);
  }
  return res.json();
}

export async function approveReferenceManifest(
  sessionUuid: string,
  manifestHash: string,
): Promise<{ success: boolean; session: any }> {
  const res = await authedFetch("/api/reference-sessions/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionUuid, manifestHash }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to approve reference manifest (${res.status})`);
  }
  return res.json();
}

export async function getReferenceSessionDetail(
  sessionUuid: string,
): Promise<{ success: boolean; session: any }> {
  const res = await authedFetch(`/api/reference-sessions/detail/${sessionUuid}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to fetch reference session detail (${res.status})`);
  }
  return res.json();
}

// ─── Phase 3 Model Build API ────────────────────────────────────────────────

export async function getModelBuildQuote(
  referenceSessionUuid: string,
): Promise<{ success: boolean; data: any }> {
  const res = await authedFetch("/api/model-builds/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ referenceSessionUuid }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to get model build quote (${res.status})`);
  }
  return res.json();
}

export async function startModelBuild(
  referenceSessionUuid: string,
  idempotencyKey: string,
  requestedOutput: string = "glb",
): Promise<{ success: boolean; data: any }> {
  const res = await authedFetch("/api/model-builds/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ referenceSessionUuid, idempotencyKey, requestedOutput }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to start model build (${res.status})`);
  }
  return res.json();
}

export async function getModelBuildDetail(
  jobUuid: string,
): Promise<{ success: boolean; data: any }> {
  const res = await authedFetch(`/api/model-builds/${jobUuid}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to fetch model build detail (${res.status})`);
  }
  return res.json();
}

export async function listModelBuilds(): Promise<{ success: boolean; data: any[] }> {
  const res = await authedFetch("/api/model-builds");
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to list model builds (${res.status})`);
  }
  return res.json();
}

export async function retryModelBuild(
  jobUuid: string,
  idempotencyKey: string,
  correctionNotes?: string,
): Promise<{ success: boolean; data: any }> {
  const res = await authedFetch(`/api/model-builds/${jobUuid}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idempotencyKey, correctionNotes }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to retry model build (${res.status})`);
  }
  return res.json();
}

export async function cancelModelBuild(
  jobUuid: string,
  reason?: string,
): Promise<{ success: boolean; data: any }> {
  const res = await authedFetch(`/api/model-builds/${jobUuid}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to cancel model build (${res.status})`);
  }
  return res.json();
}

export async function acceptModelBuild(
  jobUuid: string,
  artifactHash: string,
  reportHash: string,
): Promise<{ success: boolean; data: any }> {
  const res = await authedFetch(`/api/model-builds/${jobUuid}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artifactHash, reportHash }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to accept model build (${res.status})`);
  }
  return res.json();
}

// ── Phase 4 Rig Pipeline API ────────────────────────────────────────────────

export interface RigJobResponse {
  jobUuid: string;
  state: string;
  classification: "biped" | "quadruped" | "unsupported" | null;
  selectedProfile: string | null;
  facialCapability: "full" | "partial" | "body_only" | "unsupported" | null;
  rigValidation: {
    boneCount: number;
    maxInfluences: number;
    mobileBudgetPass: boolean;
    animationSweepPass: boolean;
    overallPass: boolean;
    rules: Array<{ rule: string; pass: boolean; detail: string; measured?: number | string }>;
  } | null;
  facialInventory: {
    capability: "full" | "partial" | "body_only" | "unsupported";
    morphCount: number;
    visemeCoverage: number;
    hasBlink: boolean;
    hasJaw: boolean;
    hasEyeControls: boolean;
    deformationPass: boolean;
  } | null;
  accessories: Array<Record<string, unknown>>;
  outputArtifact: {
    assetUuid: string;
    versionNumber: number;
    sha256: string;
    sizeBytes: number;
    signedUrl?: string;
  } | null;
  manifestHash: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function startRigJob(params: {
  modelBuildJobUuid: string;
  idempotencyKey: string;
  profileId?: string;
  requestFacial?: boolean;
  accessoryIds?: string[];
}): Promise<RigJobResponse> {
  const res = await authedFetch("/api/rig-pipeline/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to start rig job (${res.status})`);
  }
  return res.json();
}

export async function getRigJob(jobUuid: string): Promise<RigJobResponse> {
  const res = await authedFetch(`/api/rig-pipeline/jobs/${jobUuid}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to fetch rig job (${res.status})`);
  }
  return res.json();
}

export async function acceptRigJob(jobUuid: string, manifestHash: string): Promise<RigJobResponse> {
  const res = await authedFetch(`/api/rig-pipeline/jobs/${jobUuid}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manifestHash }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to accept rig job (${res.status})`);
  }
  return res.json();
}

export async function retryRigJob(
  jobUuid: string,
  idempotencyKey: string,
  accessoryIds: string[] = [],
): Promise<RigJobResponse> {
  const res = await authedFetch(`/api/rig-pipeline/jobs/${jobUuid}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idempotencyKey, accessoryIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to retry rig job (${res.status})`);
  }
  return res.json();
}

// ── Customizer API Surface ──────────────────────────────────────────────────

export interface CustomizableProduct {
  id: number;
  listing_id: number;
  printful_product_id: number;
  printful_variant_id: number;
  placement: string;
  printfile_width_px: number;
  printfile_height_px: number;
  printfile_dpi: number;
  box_x: number;
  box_y: number;
  box_w: number;
  box_h: number;
  box_shape: "rect" | "circle" | "arch";
  overlay_asset_uuid: string | null;
  retail_price_cents: number;
  status: "draft" | "published" | "archived";
  listing_name?: string;
  listing_slug?: string;
  listing_description?: string;
}

export interface CustomizeOrder {
  id: number;
  user_phone: string;
  customizable_id: number;
  source_photo_url: string;
  source_kind: "upload" | "furbin";
  print_file_url: string | null;
  recipient_json: any;
  retail_price_cents: number;
  checkout_url: string | null;
  stripe_session_id: string | null;
  provider_order_id: string | null;
  provider_payload_json: any;
  status: string;
  created_at: string;
}

export async function fetchPublishedCustomizableProducts(): Promise<CustomizableProduct[]> {
  const res = await fetch("/api/customize/products");
  if (!res.ok) throw new Error("Failed to fetch customizable products");
  const data = await res.json();
  return data.products || [];
}

export async function fetchCustomizerProductsAdmin(status?: string): Promise<CustomizableProduct[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await authedFetch(`/api/admin/customizer/customizable-products${query}`);
  if (!res.ok) throw new Error("Failed to fetch admin customizable products");
  return await res.json();
}

export async function searchPrintfulCatalogue(q: string = ""): Promise<any[]> {
  const res = await authedFetch(`/api/admin/customizer/products?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error("Failed to search Printful catalogue");
  const data = await res.json();
  return data.products || [];
}

export async function fetchPrintfulVariants(productId: number): Promise<any[]> {
  const res = await authedFetch(`/api/admin/customizer/products/${productId}/variants`);
  if (!res.ok) throw new Error("Failed to load Printful variants");
  const data = await res.json();
  return data.variants || [];
}

export async function fetchPrintfulTemplateContext(productId: number, variantId: number): Promise<{ variant: any; placements: any[] }> {
  const res = await authedFetch(`/api/admin/customizer/products/${productId}/variants/${variantId}/template`);
  if (!res.ok) throw new Error("Failed to load printfile template context");
  return await res.json();
}

export async function createCustomizableProduct(payload: any): Promise<{ success: boolean; id: number }> {
  const res = await authedFetch("/api/admin/customizer/customizable-products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await parseError(res, "Failed to create customizable product"));
  return await res.json();
}

export async function updateCustomizableProduct(id: number, payload: any): Promise<{ success: boolean }> {
  const res = await authedFetch(`/api/admin/customizer/customizable-products/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await parseError(res, "Failed to update customizable product"));
  return await res.json();
}

export async function checkoutCustomizeOrder(payload: any, idempotencyKey: string): Promise<{ success: boolean; checkoutUrl: string }> {
  const res = await authedFetch("/api/customize/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await parseError(res, "Failed to start customizer checkout"));
  return await res.json();
}

export async function fetchCustomizeOrders(): Promise<CustomizeOrder[]> {
  const res = await authedFetch("/api/customize/orders");
  if (!res.ok) throw new Error("Failed to fetch customizer orders");
  const data = await res.json();
  return data.orders || [];
}
