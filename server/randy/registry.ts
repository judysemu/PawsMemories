import { CREDIT_PRICES } from "../../src/pricing";

export const RANDY_REGISTRY_VERSION = "2026-07-22.2";

export type RandyModuleId = "create" | "furbin" | "pawprints" | "animator" | "ar" | "bim" | "wags" | "credits";
export type RandyRegistryStatus = "current" | "stale" | "unknown";

export interface RandyHelpReference {
  id: string;
  label: string;
  screen: string;
}

export interface RandyModuleEntry {
  id: RandyModuleId;
  revision: number;
  name: string;
  capability: string;
  prerequisites: string[];
  prices: Record<string, number>;
  screens: string[];
  actions: string[];
  tourIds: string[];
  highlightTargets: string[];
  limitations: string[];
  helpReferences: RandyHelpReference[];
}

export interface RandyLiveContext {
  credits: number;
  isAdmin: boolean;
  activeBuildStates?: string[];
  entitlements?: string[];
  clientRegistryVersion?: string;
}

const HELP: Record<RandyModuleId, RandyHelpReference[]> = {
  create: [
    { id: "create.multiview-approval", label: "Create 3D Pet reference approval", screen: "AVATAR_DASHBOARD" },
    { id: "create.rig-capability", label: "Measured body and facial capability", screen: "AVATAR_DASHBOARD" },
  ],
  furbin: [
    { id: "furbin.private-library", label: "Private model library", screen: "FURBIN" },
    { id: "furbin.publish-rights", label: "Publishing and rights review", screen: "FURBIN" },
  ],
  pawprints: [
    { id: "pawprints.digital-print", label: "Digital stationery creation", screen: "PAWPRINTS" },
    { id: "pawprints.physical-fulfillment", label: "Physical print fulfillment", screen: "PAWPRINTS" },
  ],
  animator: [
    { id: "animator.compatibility", label: "Animation compatibility", screen: "PAWLISHER" },
    { id: "animator.voice-lipsync", label: "Voice and lip-sync workflow", screen: "PAWLISHER" },
  ],
  ar: [
    { id: "ar.device-support", label: "AR device and browser support", screen: "AVATAR_DASHBOARD" },
    { id: "ar.performance", label: "AR model performance limits", screen: "AVATAR_DASHBOARD" },
  ],
  bim: [
    { id: "bim.calibration", label: "Scaled-model calibration", screen: "AVATAR_DASHBOARD" },
    { id: "bim.shell-vs-ifc", label: "Shell versus IFC claims", screen: "AVATAR_DASHBOARD" },
  ],
  wags: [
    { id: "wags.entitlements", label: "Subscription pack entitlements", screen: "WAGS_INBOX" },
    { id: "wags.delivery", label: "Pack delivery status", screen: "WAGS_INBOX" },
  ],
  credits: [
    { id: "credits.balance", label: "Live credit balance", screen: "STORE" },
    { id: "credits.purchase", label: "Credit-store purchase flow", screen: "STORE" },
  ],
};

const REGISTRY: RandyModuleEntry[] = [
  { id: "create", revision: 2, name: "Create 3D Pet", capability: "Approved multiview references and verified GLB builds", prerequisites: ["signed-in user", "approved references"], prices: { photoModel: CREDIT_PRICES.STATIC_3D_PHOTO, textModel: CREDIT_PRICES.STATIC_3D_TEXT }, screens: ["AVATAR_DASHBOARD"], actions: ["navigate", "start_tour", "highlight"], tourIds: ["first_avatar"], highlightTargets: ["[data-tour=\"avatar-create\"]"], limitations: ["Generation is not instant", "Rig and facial capability require separate measured validation"], helpReferences: HELP.create },
  { id: "furbin", revision: 2, name: "Fur Bin", capability: "Private model and media library", prerequisites: ["signed-in user"], prices: {}, screens: ["FURBIN"], actions: ["navigate", "start_tour", "highlight"], tourIds: ["manage_furbin"], highlightTargets: ["[data-tour=\"furbin-library\"]"], limitations: ["Public showcase and marketplace availability depend on moderation and rights"], helpReferences: HELP.furbin },
  { id: "pawprints", revision: 2, name: "Pawprints", capability: "Digital stationery and print products", prerequisites: ["signed-in user"], prices: { pawprintDigital: CREDIT_PRICES.PAWPRINT_DIGITAL, pawprintPrint: CREDIT_PRICES.PAWPRINT_PRINT, customization: CREDIT_PRICES.PAWPRINT_CUSTOMIZE_ADDON }, screens: ["PAWPRINTS"], actions: ["navigate", "start_tour", "highlight"], tourIds: ["make_pawprint"], highlightTargets: ["[data-tour=\"pawprint-create\"]"], limitations: ["Physical products require separate fulfillment confirmation"], helpReferences: HELP.pawprints },
  { id: "animator", revision: 2, name: "Animator", capability: "Animation, voice, and lip sync tools", prerequisites: ["compatible accepted model"], prices: { lipSync30Seconds: CREDIT_PRICES.LIP_SYNC_30_SECONDS, video: CREDIT_PRICES.ANIMATED_VIDEO_8S }, screens: ["PAWLISHER"], actions: ["navigate", "start_tour"], tourIds: ["use_pawlisher"], highlightTargets: [], limitations: ["Availability depends on measured rig and facial capability"], helpReferences: HELP.animator },
  { id: "ar", revision: 2, name: "Augmented Reality", capability: "Place compatible models in a mobile AR scene", prerequisites: ["compatible model", "supported device/browser"], prices: {}, screens: ["AVATAR_DASHBOARD"], actions: ["navigate", "launch_ar"], tourIds: [], highlightTargets: [], limitations: ["Device support and model performance budgets apply"], helpReferences: HELP.ar },
  { id: "bim", revision: 2, name: "Scaled Building and IFC", capability: "Calibrated shell or semantic IFC4 model", prerequisites: ["trusted measurement", "pre-build verification"], prices: { shell: CREDIT_PRICES.BIM_SHELL_MODEL, ifc: CREDIT_PRICES.BIM_IFC_MODEL }, screens: ["AVATAR_DASHBOARD"], actions: ["navigate"], tourIds: [], highlightTargets: [], limitations: ["Images alone are not survey-grade", "Concealed construction and code compliance are never inferred as fact"], helpReferences: HELP.bim },
  { id: "wags", revision: 2, name: "Wags", capability: "Subscription packs and owned digital items", prerequisites: ["active entitlement"], prices: {}, screens: ["WAGS_INBOX"], actions: ["navigate"], tourIds: [], highlightTargets: [], limitations: ["Entitlement status must come from the live account"], helpReferences: HELP.wags },
  { id: "credits", revision: 2, name: "Credits", capability: "Wallet used for paid product actions", prerequisites: ["signed-in user"], prices: {}, screens: ["STORE"], actions: ["navigate", "open_credit_store", "start_tour", "highlight"], tourIds: ["buy_credits"], highlightTargets: ["[data-tour=\"credit-store\"]"], limitations: ["Randy cannot change balances or promise refunds"], helpReferences: HELP.credits },
];

const BUILD_STATES = new Set(["draft", "queued", "submitted", "processing", "validating", "ready", "accepted", "failed_retryable", "failed_terminal", "cancelled"]);

function copyModule(entry: RandyModuleEntry): RandyModuleEntry {
  return {
    ...entry,
    prerequisites: [...entry.prerequisites],
    prices: { ...entry.prices },
    screens: [...entry.screens],
    actions: [...entry.actions],
    tourIds: [...entry.tourIds],
    highlightTargets: [...entry.highlightTargets],
    limitations: [...entry.limitations],
    helpReferences: entry.helpReferences.map((reference) => ({ ...reference })),
  };
}

export function getRandyModuleRegistry(scope?: readonly RandyModuleId[]): RandyModuleEntry[] {
  const allowed = scope ? new Set(scope) : null;
  return REGISTRY.filter((entry) => !allowed || allowed.has(entry.id)).map(copyModule);
}

export function assessRandyRegistryVersion(clientVersion?: string): RandyRegistryStatus {
  if (clientVersion === undefined) return "current";
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(clientVersion)) return "unknown";
  return clientVersion === RANDY_REGISTRY_VERSION ? "current" : "stale";
}

export function validateRandyCitations(citations: unknown, scope?: readonly RandyModuleId[]): string[] | null {
  if (!Array.isArray(citations) || citations.length > 4 || citations.some((value) => typeof value !== "string")) return null;
  const allowed = new Set(getRandyModuleRegistry(scope).flatMap((entry) => entry.helpReferences.map((reference) => reference.id)));
  const values = citations as string[];
  if (new Set(values).size !== values.length || values.some((value) => !allowed.has(value))) return null;
  return [...values];
}

export function buildRandyGrounding(context: RandyLiveContext, scope?: readonly RandyModuleId[]): string {
  const registry = getRandyModuleRegistry(scope);
  const activeBuildStates = Array.isArray(context.activeBuildStates)
    ? context.activeBuildStates.filter((state) => BUILD_STATES.has(state)).slice(0, 20)
    : null;
  const entitlements = Array.isArray(context.entitlements)
    ? context.entitlements.filter((value) => typeof value === "string" && /^[a-z0-9._:-]{1,80}$/i.test(value)).slice(0, 50)
    : null;
  const credits = Number.isSafeInteger(context.credits) && context.credits >= 0 ? context.credits : null;
  const isAdmin = typeof context.isAdmin === "boolean" ? context.isAdmin : null;
  const unknownLiveFields = [
    ...(credits === null ? ["credits"] : []),
    ...(isAdmin === null ? ["isAdmin"] : []),
    ...(activeBuildStates === null ? ["activeBuildStates"] : []),
    ...(entitlements === null ? ["entitlements"] : []),
  ];
  return JSON.stringify({
    registryVersion: RANDY_REGISTRY_VERSION,
    registryStatus: assessRandyRegistryVersion(context.clientRegistryVersion),
    modules: registry,
    liveContext: { credits, isAdmin, activeBuildStates, entitlements },
    unknownLiveFields,
  });
}
