export enum Screen {
  SIGN_UP = "SIGN_UP",
  WELCOME = "WELCOME",
  TUTORIAL = "TUTORIAL",
  DASHBOARD = "DASHBOARD",
  ALBUMS = "ALBUMS",
  ALBUM_VIEW = "ALBUM_VIEW",
  EDIT_MEMORY = "EDIT_MEMORY",
  SHARE_MEMORY = "SHARE_MEMORY",
  MODELS = "MODELS",
  REQUEST_MEMORY = "REQUEST_MEMORY",
  STORE = "STORE",
  VOICE_TEST = "VOICE_TEST",
  BIM = "BIM",
  PROFILE = "PROFILE",
  COMMUNITY = "COMMUNITY",
  ANIMATOR = "ANIMATOR",
  PAWPRINTS = "PAWPRINTS",
  PET_GLB = "PET_GLB",
  PAWLISHER = "PAWLISHER",
  FURBIN = "FURBIN",
  CREATIONS = "CREATIONS",
  CREATE = "CREATE",
  CREATE_REFERENCE = "CREATE_REFERENCE",
  CREATE_CUSTOMIZE = "CREATE_CUSTOMIZE",
  CREATE_VALIDATE = "CREATE_VALIDATE",
  CREATE_CHECKOUT = "CREATE_CHECKOUT",
  CREATE_BUILD_PROGRESS = "CREATE_BUILD_PROGRESS",
  CREATE_BUILD_REVIEW = "CREATE_BUILD_REVIEW",
  CREATE_RIG_PROGRESS = "CREATE_RIG_PROGRESS",
  CREATE_RIG_REVIEW = "CREATE_RIG_REVIEW",
  MARKETPLACE = "MARKETPLACE",
  LANDING_MODELS = "LANDING_MODELS",
  LANDING_DOGS = "LANDING_DOGS",
  LANDING_MEMORIALS = "LANDING_MEMORIALS",
  HOW_IT_WORKS = "HOW_IT_WORKS",
  PRICING = "PRICING",
  ADMIN_WAGS = "ADMIN_WAGS",
  PET_HEALTH = "PET_HEALTH",
  WAGS_INBOX = "WAGS_INBOX",
  ADMIN_MARKETPLACE = "ADMIN_MARKETPLACE",
}

// Randy AI guidance action types — used by /api/randy-chat response and RandyChat component
export type RandyActionType = 'navigate' | 'launch_ar' | 'open_credit_store' | 'start_tour' | 'highlight' | 'none';

export interface RandyAction {
  type: RandyActionType;
  screen?: string; // Screen enum value for 'navigate' actions
  tourId?: string;
  target?: string;
}

export type RandyHeadState = 'idle' | 'listen' | 'think' | 'talk' | 'happy';

export type PetSpecies = 'dog' | 'cat' | 'bird' | 'rabbit' | 'horse' | 'reptile' | 'small_animal' | 'other';

export type StyleType = "Realistic" | "Sketch" | "Clay" | "Artistic" | "Anime" | "3D" | "Retro";

// Background ids are defined in src/backgrounds.ts (single source of truth).
// Kept as a string so new presets can be added without touching this type.
export type BackgroundType = string;

export interface LocationParams {
  lat: number;
  lng: number;
  heading: number;
  pitch: number;
  fov: number;
  placeLabel: string;
}

export interface Creation {
  id: number;
  user_phone: string;
  album_id: number | null;
  media_type: 'still' | 'video' | 'model';
  style: StyleType;
  backdrop_kind: 'preset' | 'streetview';
  preset_name: string | null;
  sv_lat: number | null;
  sv_lng: number | null;
  sv_heading: number | null;
  sv_pitch: number | null;
  sv_fov: number | null;
  place_label: string | null;
  image_url: string | null;
  video_url: string | null;
  model_url: string | null;
  sort_order: number;
  created_at: string;
  // Legacy / frontend-only fields
  name?: string;
  pet_name?: string | null;
  pet_breed?: string | null;
  breed?: string;
  background?: BackgroundType;
  isCustomUploaded?: boolean;
}

export interface Album {
  id: string;
  name: string;
  itemCount: number;
  imageUrl: string;
}

export interface UserProfile {
  fullName: string;
  email?: string;
  credits: number;
  freeAvatarAvailable?: boolean;
  treats: number;
  isAdmin?: boolean;
  city?: string;
  ageVerified?: boolean;
  profilePhotoUrl?: string | null;
  // Phase 8
  referralCode?: string | null;
  phoneVerified?: boolean;
  emailVerified?: boolean;
  zip?: string;
  bio?: string | null;
  profileBonusGranted?: boolean;
  acceptedTermsVersion?: string | null;
  acceptedTermsAt?: string | null;
  currentTermsVersion?: string;
  requiresTermsAcceptance?: boolean;
}

export interface PublicUser {
  id: number;
  fullName: string;
  email: string;
  credits: number;
  freeAvatarAvailable?: boolean;
  treats: number;
  city: string;
  birthdate: string;
  profileComplete: boolean;
  isAdmin: boolean;
  isTester?: boolean;
  dailyStreak: number;
  lastStreakClaim: string | null;
  profilePhotoUrl?: string | null;
  achievements: any[];
  // Phase 8
  referralCode?: string | null;
  phoneVerified?: boolean;
  emailVerified?: boolean;
  zip?: string;
  bio?: string | null;
  profileBonusGranted?: boolean;
  acceptedTermsVersion?: string | null;
  acceptedTermsAt?: string | null;
  currentTermsVersion?: string;
  requiresTermsAcceptance?: boolean;
}

export interface VoiceCloneAsset {
  id: number;
  name: string;
  audio_url: string;
  mime_type: string;
  bytes: number;
  voice_consent: number;
  voice_consent_at: string | null;
  created_at: string;
}

export interface PhysicalOrder {
  orderId: string;
  creationId: string;
  creationName: string;
  imageUrl: string;
  style: string;
  creditsDeducted: number;
  cashPaid: number;
  shippingName: string;
  shippingAddress: string;
  shippingCity: string;
  shippingState: string;
  shippingZip: string;
  shippingCountry: string;
  createdAt: string;
  status: "pending" | "processing" | "shipped" | "cancelled";
}

export interface GenerationJob {
  id: number;
  status: "queued" | "running" | "done" | "failed";
  video_url?: string | null;
  model_url?: string | null;
  error?: string | null;
}

export type AvatarAction = 'eating' | 'drinking' | 'running' | 'playing' | 'sleeping' | 'photo';

export interface AnimationDef {
  row: number;
  frames: number;
  fps: number;
}

export interface AnimationMetadata {
  frameWidth: number;
  frameHeight: number;
  animations: Record<AvatarAction, AnimationDef>;
}

export interface Avatar {
  id: number;
  user_phone: string;
  name: string;
  image_url: string;
  model_url?: string | null;
  /** Rigged GLB with skeletal clips (Phase 5). Preferred over model_url for the 3D/AR scene. */
  rigged_model_url?: string | null;
  /** Names/metadata of skeletal clips embedded in the rigged model. */
  clips?: SkeletalClip[] | null;
  sprite_sheet_url?: string | null;
  animation_data?: AnimationMetadata | null;
  animal_type?: string | null;
  breed?: string | null;
  avatar_type?: 'dog' | 'human';
  generation_status: 'pending' | 'generating_mesh' | 'rigging' | 'retargeting' | 'baking_clips' | 'baking_sprites' | 'done' | 'failed';
  generation_error?: string | null;
  /** Build analysis JSON; may carry a "Fix the vibe" restyle preset chosen on regeneration. */
  generation_analysis?: { stylePreset?: string; styleHint?: string; [k: string]: unknown } | string | null;
  food_level: number;
  water_level: number;
  last_fed: string;
  last_watered: string;
  created_at: string;
}

/* ------------------------------------------------------------------ *
 * Living-avatar 3D behavior system (Phase 1 & 2)
 * NOTE: `AvatarAction` above is the LEGACY sprite-sheet action union and
 * is intentionally left unchanged. The 3D behavior engine uses the richer
 * `BehaviorAction` union below so existing sprite code keeps compiling.
 * ------------------------------------------------------------------ */

/** Every motion the 3D behavior engine can request from the avatar. */
export type BehaviorAction =
  | 'idle'
  | 'walking'
  | 'running'
  | 'sitting'
  | 'sleeping'
  | 'eating'
  | 'drinking'
  | 'playing'
  | 'peeing'
  | 'pooping'
  | 'speaking'
  | 'interacting'
  // New abilities (skeletal-clip overhaul)
  | 'wagging'
  | 'stretching'
  | 'shaking'
  | 'digging';

/** A skeletal animation clip embedded in a rigged GLB. */
export interface SkeletalClip {
  name: string;
  loop: boolean;
  durationSec: number;
}

/** Metadata for the rigged model produced by the Blender clip pipeline (Phase 5). */
export interface RiggedModelData {
  modelUrl: string;
  clips: SkeletalClip[];
}

/**
 * The pet's live "needs". 0..100. Higher food/water/energy = better;
 * higher bladder/bowel = more urgent. `lastSeen` drives offline decay so
 * the pet appears to have lived while the app was closed.
 */
export interface AvatarNeeds {
  food: number;
  water: number;
  energy: number;
  bladder: number;
  bowel: number;
  happiness: number;
  lastSeen: string; // ISO timestamp
}

/** Kinds of placeable dog objects (Phase 3 assets). */
export type PetObjectKind =
  | 'dog_house'
  | 'food_bowl'
  | 'water_bowl'
  | 'ball'
  | 'bone'
  | 'bed'
  | 'hydrant'
  | 'chew_toy';

/** An object the user has placed in the scene / AR space. */
export interface PlacedObject {
  id: string;
  kind: PetObjectKind;
  position: [number, number, number];
  rotationY: number;
  /** Combined user-scale factor. For authoritative models, physicalScale
   *  from spatialMetadata overrides display fitting and this is display-only. */
  scale: number;
  createdAt: string;
  /**
   * Optional spatial metadata for authoritative scale and coordinate info.
   * Absent for legacy objects created before Phase 1.
   */
  spatialMetadata?: {
    sourceUnit: string;
    metersPerSourceUnit: number;
    canonicalBoundsMin: [number, number, number];
    canonicalBoundsMax: [number, number, number];
    physicalScale: number;
    displayScale: number;
    accuracyClass: string;
    calibrationMethod: string;
    sourceHash: string;
    createdAt: string;
  };
}

/** A command the user issues to the avatar. */
export interface AvatarCommand {
  action: BehaviorAction;
  /** Optional target object the command refers to (e.g. go eat from this bowl). */
  targetObjectId?: string;
  issuedAt: number; // epoch ms
}

export type RequestType = 'photo_standard' | 'photo_premium' | 'video_standard' | 'video_premium';
export type RequestStatus = 'pending' | 'fulfilled' | 'rejected';

export interface PhotoRequest {
  id: number;
  user_phone?: string;
  request_type: RequestType;
  comment: string;
  photo_url: string | null;
  result_url: string | null;
  creation_id: number | null;
  status: RequestStatus;
  paid: number;
  amount_paid: number | null;
  admin_notes?: string | null;
  created_at: string;
  updated_at?: string;
  // Admin-joined fields
  user_full_name?: string | null;
  user_email?: string | null;
}
