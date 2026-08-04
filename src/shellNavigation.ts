import { Screen } from "./types";

export interface ShellNavigationItem {
  id: string;
  label: string;
  screen: Screen;
  materialIcon: string;
  imageSrc?: string;
}

export const TOP_PRIMARY_NAV: ShellNavigationItem[] = [
  { id: "create", label: "Create", screen: Screen.CREATE, materialIcon: "add_circle", imageSrc: "/brand/furball3d.jpg" },
  { id: "voice", label: "Voice Test", screen: Screen.VOICE_TEST, materialIcon: "graphic_eq" },
  { id: "pawprints", label: "Pawprints", screen: Screen.PAWPRINTS, materialIcon: "auto_stories", imageSrc: "/brand/pawprints.png" },
  { id: "pet-glb", label: "3D Model", screen: Screen.PET_GLB, materialIcon: "view_in_ar" },
];

/**
 * SHELL_ICON_NAV — the four stencil icons in the header's right corner.
 *
 * Deliberately exactly four. The header previously carried ten controls on the
 * right (Pet Health, Store, Community, theme, profile, PupCoins, help, two
 * admin buttons, logout), which is why nothing in it read as primary. Retired
 * panels remain in source but are not routed; supported secondary controls live
 * in the profile overflow menu.
 *
 * "Stencil" here means stroke-only lucide glyphs at a uniform 1.75 stroke
 * width, no fills and no pill/border chrome. Active state is carried by colour
 * and a dot, not by a filled background, so all four stay visually equal
 * weight. `screens` lists every route that should light the icon — the Create
 * flow spans five screens and must not go dark mid-flow.
 */
export interface ShellIconNavItem {
  id: string;
  label: string;
  screen: Screen;
  /** Every screen that counts as "inside" this destination, for active state. */
  screens: Screen[];
}

export const SHELL_ICON_NAV: ShellIconNavItem[] = [
  {
    id: "create",
    label: "Create",
    screen: Screen.CREATE,
    screens: [
      Screen.CREATE,
      Screen.CREATE_REFERENCE,
      Screen.CREATE_CUSTOMIZE,
      Screen.CREATE_VALIDATE,
      Screen.CREATE_CHECKOUT,
    ],
  },
  { id: "voice", label: "Voice Test", screen: Screen.VOICE_TEST, screens: [Screen.VOICE_TEST] },
  { id: "pawprints", label: "Pawprints", screen: Screen.PAWPRINTS, screens: [Screen.PAWPRINTS, Screen.PAWLISHER] },
  { id: "profile", label: "Profile", screen: Screen.PROFILE, screens: [Screen.PROFILE] },
];

export const SIDEBAR_NAV: ShellNavigationItem[] = [
  { id: "home", label: "Home", screen: Screen.DASHBOARD, materialIcon: "home" },
  { id: "pawprints", label: "Pawprints", screen: Screen.PAWPRINTS, materialIcon: "auto_stories" },
  { id: "animate", label: "Fur Reels", screen: Screen.ANIMATOR, materialIcon: "movie_creation", imageSrc: "/brand/fur-reels-icon.png" },
  { id: "fur-bin", label: "Fur Bin©️", screen: Screen.FURBIN, materialIcon: "inventory_2" },
  { id: "wags-inbox", label: "Wags", screen: Screen.WAGS_INBOX, materialIcon: "redeem" },
  // 2026-07-30: "Scaled BIM" removed from the left panel per owner request —
  // BIM modeling has been split into its own project (see memory:
  // pawsome3d-ar-bim-retirement). Screen.BIM route/component still exist so
  // this is a nav-only removal, not a feature deletion.
];

/**
 * MOBILE_NAV — the bottom bar on small screens.
 *
 * Deliberately NOT `SIDEBAR_NAV + Profile`. Profile and Voice Test are both
 * reachable from the header's SHELL_ICON_NAV on every screen, so repeating them
 * in the bottom bar spent two of five slots on duplicates.
 *
 * LIVE-1 (2026-08-04 deployment review): Fur Reels was being filtered out here.
 *
 * The exclusion rule above is "drop destinations that already have a one-tap
 * route from the header" — which is true of Profile and Voice Test, both of
 * which appear in SHELL_ICON_NAV. It is NOT true of ANIMATOR: SHELL_ICON_NAV is
 * [Create, Voice Test, Pawprints, Profile], so filtering ANIMATOR left the
 * 100-PupCoin Fur Reels module with NO entry point at all on small screens.
 *
 * The bottom-bar renderer in App.tsx still carries a dedicated
 * `item.screen === Screen.ANIMATOR ? openAnimationStudio() : ...` branch, which
 * was dead code while this filter excluded it — good evidence the removal was
 * accidental rather than intended.
 *
 * LIVE-1 follow-up: Help was moved from a trailing button in the bottom bar to
 * the profile overflow menu (it was already listed in SHELL_MENU_ITEMS). A paid
 * module (Fur Reels) outranks a help link for primary navigation, and keeping
 * the bar at five slots preserves label legibility at 390 px.
 */
export const MOBILE_NAV: ShellNavigationItem[] = SIDEBAR_NAV.filter(
  (item) => item.screen !== Screen.PROFILE && item.screen !== Screen.VOICE_TEST
);
