import React, { useState, lazy, Suspense } from "react";
import { Screen, UserProfile, Creation, Album, PublicUser } from "./types";
import SignUp from "./components/SignUp";
import ResetPassword from "./components/ResetPassword";
import VerifyEmail from "./components/VerifyEmail";
import AnimationStudio from "./components/AnimationStudio";
import Welcome from "./components/Welcome";
import Tutorial from "./components/Tutorial";
import HomePage from "./components/HomePage";
import CreateScreen from "./components/CreateScreen";
import CreateReferenceScreen from "./components/create-flow/CreateReferenceScreen";
import CreateCustomizeScreen from "./components/create-flow/CreateCustomizeScreen";
import CreateValidateScreen from "./components/create-flow/CreateValidateScreen";
import CreateCheckoutScreen from "./components/create-flow/CreateCheckoutScreen";
import CreateBuildProgressScreen from "./components/create-flow/CreateBuildProgressScreen";
import CreateBuildReviewScreen from "./components/create-flow/CreateBuildReviewScreen";
import { CreateRigProgressScreen } from "./components/create-flow/CreateRigProgressScreen";
import { CreateRigReviewScreen } from "./components/create-flow/CreateRigReviewScreen";
import { CreateFlowProvider } from "./components/create-flow/CreateFlowContext";
import UnderConstructionLock from "./components/UnderConstructionLock";
import EditMemory from "./components/EditMemory";
import ShareMemory from "./components/ShareMemory";
// Lazy-loaded: these are the only screens/widgets that pull the three.js + R3F
// runtime. Loading them on demand keeps three.js OUT of the initial bundle so the
// landing/dashboard don't download the whole 3D stack.
const RandyChat = lazy(() => import("./components/RandyChat"));
// Heavy: pulls three.js and a 4MB GLB. Lazy so no other route pays for it.
const BarkleyScreen = lazy(() => import("./components/BarkleyScreen"));
import AlbumView from "./components/AlbumView";
import AlbumsPage from "./components/AlbumsPage";
import { fetchMe, fetchCreations, fetchAlbums, createAlbum, clearToken, claimAchievement, claimDailyStreak, confirmCreditsSession, acceptCurrentTerms } from "./api";
import { Sun, Moon, LogOut, RefreshCw, Zap, ShoppingCart, Users, HelpCircle, PackageCheck, Activity, PlusCircle, Mic2, PawPrint, User as UserIcon, MoreHorizontal, House, Archive, Building2, Gift } from "lucide-react";
import CreditStore from "./components/CreditStore";
const AvatarDashboard = lazy(() => import("./components/AvatarDashboard"));
import Store from "./components/Store";
import VoiceFlowTest from "./components/VoiceFlowTest";
import BimPreviewScreen from "./components/BimPreviewScreen";
import ProfileScreen from "./components/ProfileScreen";
import Community from "./components/Community";
import HelpModal from "./components/HelpModal";
// PP-16: import the real component directly. PawprintsScreen was a 3-line
// re-export shim, which made it easy to open the wrong file when editing.
const PawprintsScreen = lazy(() => import("./components/PawprintsStudio"));
const FidosStylesScreen = lazy(() => import("./components/FidosStylesScreen"));
const FurBinScreen = lazy(() => import("./components/FurBinScreen"));
const PrintShopScreen = lazy(() => import("./components/PrintShopScreen"));
const WagsAdminPanel = lazy(() => import("./components/WagsAdminPanel"));
const PetHealthScreen = lazy(() => import("./components/PetHealthScreen"));
const WagsInboxScreen = lazy(() => import("./components/WagsInboxScreen"));
import WarehouseMode from "./components/WarehouseMode";
import { MOBILE_NAV, SIDEBAR_NAV, SHELL_ICON_NAV } from "./shellNavigation";
import { syncSeoMetadata } from "./seo";
import PetModelStudio from "./components/PetModelStudio";
import DogModelsPage from "./components/landing/DogModelsPage";
import CatModelsPage from "./components/landing/CatModelsPage";
import PetProfessionalsPage from "./components/landing/PetProfessionalsPage";
import GlbGuidePage from "./components/landing/GlbGuidePage";
import DenverPage from "./components/landing/DenverPage";
import PhiladelphiaPage from "./components/landing/PhiladelphiaPage";
import GuidesHubPage from "./components/landing/GuidesHubPage";
import ProductPage from "./components/ProductPage";

const EMPTY_PROFILE: UserProfile = { fullName: "", email: "", credits: 0, treats: 0, isAdmin: false, city: "", ageVerified: false, acceptedTermsVersion: null, currentTermsVersion: undefined, requiresTermsAcceptance: false };

const SCREEN_PATHS: Partial<Record<Screen, string>> = {
  [Screen.DASHBOARD]: "/",
  [Screen.SIGN_UP]: "/sign-up",
  [Screen.MODELS]: "/furball3d",
  [Screen.ANIMATOR]: "/animator",
  [Screen.PAWPRINTS]: "/pawprints",
  [Screen.PRINT_SHOP]: "/print-shop",
  [Screen.PET_GLB]: "/pet-glb",
  [Screen.PAWLISHER]: "/fidos-styles",
  [Screen.FURBIN]: "/fur-bin",
  [Screen.STORE]: "/store",
  [Screen.VOICE_TEST]: "/voice-test",
  [Screen.BIM]: "/bim",
  [Screen.COMMUNITY]: "/community",
  [Screen.PROFILE]: "/profile",
  [Screen.ALBUMS]: "/albums",
  [Screen.CREATE]: "/create",
  [Screen.CREATE_REFERENCE]: "/create/reference",
  [Screen.CREATE_CUSTOMIZE]: "/create/customize",
  [Screen.CREATE_VALIDATE]: "/create/validate",
  [Screen.CREATE_CHECKOUT]: "/create/checkout",
  [Screen.LANDING_MODELS]: "/3d-pet-models",
  [Screen.LANDING_DOGS]: "/dog-3d-models",
  [Screen.LANDING_CATS]: "/cat-3d-models",
  [Screen.LANDING_PROFESSIONALS]: "/pet-professionals",
  [Screen.LANDING_GLB_GUIDE]: "/glb-pet-models-guide",
  [Screen.LANDING_DENVER]: "/denver",
  [Screen.LANDING_PHILADELPHIA]: "/philadelphia",
  [Screen.GUIDES_HUB]: "/guides",
  [Screen.BARKLEY]: "/barkley",
  [Screen.PRODUCT_VIEW]: "/product",
  [Screen.LANDING_MEMORIALS]: "/pet-memorial-models",
  [Screen.HOW_IT_WORKS]: "/how-it-works",
  [Screen.PRICING]: "/pricing",
  [Screen.ADMIN_WAGS]: "/admin/wags",
  [Screen.PET_HEALTH]: "/pet-health",
  [Screen.WAGS_INBOX]: "/wags",
};

function screenFromPath(pathname: string): Screen | null {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === "/creations") return Screen.FURBIN;
  // Retire the unsupported paid concierge surface until its payment and
  // fulfillment routes exist. Old bookmarks land on a working keepsake flow.
  if (normalized === "/request-memory") return Screen.PAWPRINTS;
  // Retire bookmarked create-wizard steps. Signed-in customers enter the
  // tracked model lifecycle so every generated asset is registered.
  if (normalized.startsWith("/create/")) return Screen.CREATE;
  // Retired marketplace surfaces fall through to the safe Shop landing page.
  if (normalized === "/marketplace" || normalized === "/admin/marketplace") return Screen.STORE;
  if (normalized === "/home" || normalized === "/") return Screen.DASHBOARD;
  if (normalized === "/custom-dog-figurines" || normalized === "/dog-3d-models") return Screen.LANDING_DOGS;
  if (normalized.startsWith("/product/")) return Screen.PRODUCT_VIEW;
  if (normalized.startsWith("/guides/")) return Screen.GUIDES_HUB;
  const entry = Object.entries(SCREEN_PATHS).find(([, path]) => path === normalized);
  return entry ? entry[0] as Screen : null;
}

const PUBLIC_SCREENS = new Set<Screen>([
  Screen.DASHBOARD,
  Screen.SIGN_UP,
  Screen.CREATE,
  Screen.PAWPRINTS,
  Screen.STORE,
  Screen.PRINT_SHOP,
  Screen.LANDING_MODELS,
  Screen.LANDING_DOGS,
  Screen.LANDING_CATS,
  Screen.LANDING_PROFESSIONALS,
  Screen.LANDING_GLB_GUIDE,
  Screen.LANDING_DENVER,
  Screen.LANDING_PHILADELPHIA,
  Screen.GUIDES_HUB,
  Screen.BARKLEY,
  Screen.PRODUCT_VIEW,
  Screen.LANDING_MEMORIALS,
  Screen.HOW_IT_WORKS,
  Screen.PRICING,
]);

const getBackgroundImage = (screen: Screen) => {
  switch (screen) {
    case Screen.SIGN_UP:
      return {
        url: "/MAIN4.jpg",
        className: "opacity-40"
      };
    case Screen.WELCOME:
    case Screen.TUTORIAL:
      return {
        url: "/MAIN.jpg",
        className: "opacity-35 grayscale brightness-110"
      };
    case Screen.MODELS:
    case Screen.STORE:
    case Screen.VOICE_TEST:
    case Screen.BIM:
    case Screen.PET_GLB:
    case Screen.PAWPRINTS:
    case Screen.PRINT_SHOP:
    case Screen.PAWLISHER:
    case Screen.FURBIN:
    case Screen.CREATE:
    case Screen.CREATE_REFERENCE:
    case Screen.CREATE_CUSTOMIZE:
    case Screen.CREATE_VALIDATE:
    case Screen.CREATE_CHECKOUT:
      return {
        url: "/MAIN2.jpg",
        className: "opacity-45 blur-[1px]"
      };
    case Screen.PROFILE:
    case Screen.ALBUMS:
    case Screen.ALBUM_VIEW:
    case Screen.SHARE_MEMORY:
    case Screen.REQUEST_MEMORY:
    case Screen.EDIT_MEMORY:
      return {
        url: "/MAIN.jpg",
        className: "opacity-55"
      };
    case Screen.DASHBOARD:
    default:
      return {
        url: "/MAIN2.jpg",
        className: "opacity-55 blur-[1px] brightness-110"
      };
  }
};

/**
 * Glyphs for the four shell icons, keyed by SHELL_ICON_NAV id.
 *
 * Kept here rather than in shellNavigation.ts so that module stays free of JSX
 * and importable by non-React code (tests, the mobile nav builder). All four are
 * stroke-only lucide icons drawn at strokeWidth 1.75 for a consistent stencil
 * weight — no filled or duotone glyphs in this row.
 */
const SHELL_ICONS: Record<string, React.ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean | "true" | "false" }>> = {
  create: PlusCircle,
  voice: Mic2,
  pawprints: PawPrint,
  profile: UserIcon,
};

const SHELL_NAV_ICONS: Record<string, React.ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean | "true" | "false" }>> = {
  home: House,
  "fur-bin": Archive,
  pawprints: PawPrint,
  bim: Building2,
  "wags-inbox": Gift,
};

export default function App() {
  // Auth gating state
  const [isAuthed, setIsAuthed] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  const [currentScreen, setCurrentScreen] = useState<Screen>(() => {
    if (typeof window === "undefined") return Screen.DASHBOARD;
    const routed = screenFromPath(window.location.pathname);
    return routed && PUBLIC_SCREENS.has(routed) ? routed : Screen.DASHBOARD;
  });
  const [incompleteUser, setIncompleteUser] = useState<PublicUser | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile>(EMPTY_PROFILE);

  const [showOrderSuccessModal, setShowOrderSuccessModal] = useState(false);
  const [successOrderSessionId, setSuccessOrderSessionId] = useState("");
  const [showCreditStore, setShowCreditStore] = useState(false);
  const [creditSuccessMsg, setCreditSuccessMsg] = useState("");
  const [showHelpModal, setShowHelpModal] = useState(false);
  /** Header overflow menu — holds the controls demoted from the icon row. */
  const [showShellMenu, setShowShellMenu] = useState(false);

  const [albums, setAlbums] = useState<Album[]>([]);
  const [creations, setCreations] = useState<Creation[]>([]);
  const [activeAlbum, setActiveAlbum] = useState<Album | null>(null);
  const [selectedCreationForShare, setSelectedCreationForShare] = useState<Creation | null>(null);

  const refreshCreations = async () => {
    const serverCreations = await fetchCreations();
    setCreations(serverCreations);
    if (serverCreations.length > 0) handleUnlockAchievement("creation");
  };

  const openAnimationStudio = () => {
    setCurrentScreen(Screen.ANIMATOR);
  };

  // Dynamic Theme state
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    return localStorage.getItem("paws_dark_mode") === "true";
  });

  // Daily Streak and achievement tracker persistence states (from server)
  const [dailyStreak, setDailyStreak] = useState<number>(0);
  const [dailyStreakClaimed, setDailyStreakClaimed] = useState<boolean>(false);
  const [achievements, setAchievements] = useState<any[]>([
      { id: "pioneer", title: "Pioneer Parent", desc: "Successfully completed user profile registration", reward: 25, icon: "🎉", isUnlocked: false, isClaimed: false },
      { id: "creation", title: "Art Keepsake", desc: "Created your first styled AI animal masterpiece memory", reward: 20, icon: "🎨", isUnlocked: false, isClaimed: false },
  ]);

  // Restore an existing session on load (validates the token against the server).
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const user = await fetchMe();
        if (cancelled) return;
        if (user?.profileComplete) {
          applyUser(user);
          setIncompleteUser(null);
          setIsAuthed(true);
          const restoredScreen = screenFromPath(window.location.pathname);
          setCurrentScreen(restoredScreen === Screen.SIGN_UP ? Screen.DASHBOARD : restoredScreen || Screen.DASHBOARD);
          // Login/check-in rewards are server-side and idempotent per calendar day.
          try {
            const checkedIn = await claimDailyStreak();
            applyUser(checkedIn);
          } catch {
            // A reward outage must never block a returning user from entering the app.
          }
          // Phase 1.7: Fetch persistent creations from backend
          await refreshCreations();
          const serverAlbums = await fetchAlbums();
          setAlbums(serverAlbums);
        } else if (user) {
          applyUser(user);
          setIncompleteUser(user);
          setIsAuthed(false);
          setCurrentScreen(Screen.SIGN_UP);
        } else {
          setIsAuthed(false);
        }
      } catch {
        // A transient /api/me outage must not destroy a valid local session.
        setIsAuthed(false);
      } finally {
        if (!cancelled) setAuthChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep state-driven navigation addressable and make browser back/forward work.
  React.useEffect(() => {
    if (!authChecked || (!isAuthed && !PUBLIC_SCREENS.has(currentScreen))) return;
    const path = SCREEN_PATHS[currentScreen];
    if (path && window.location.pathname !== path) window.history.pushState({ screen: currentScreen }, "", path);
  }, [authChecked, isAuthed, currentScreen]);

  React.useEffect(() => {
    const onPopState = () => {
      const screen = screenFromPath(window.location.pathname);
      if (screen) setCurrentScreen(screen);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Public entry is indexable; every account-specific studio route stays out of
  // search results even though this is a client-routed application.
  React.useEffect(() => {
    syncSeoMetadata(currentScreen, isAuthed);
  }, [currentScreen, isAuthed]);

  // Per-site mode: "main" (pawsome3d.com) vs "warehouse" (mypets.cc). Read from
  // the public /api/config endpoint (driven by the DEPLOY_TARGET env var).
  const [deployTarget, setDeployTarget] = useState<string>("main");
  React.useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => { if (d && typeof d.deployTarget === "string") setDeployTarget(d.deployTarget); })
      .catch(() => {});
  }, []);

  // Handle Stripe order success/cancel redirects.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const orderSuccess = params.get("order_success");
    const sessionId = params.get("session_id");
    const orderCancelled = params.get("order_cancelled");

    if (orderSuccess === "true" && sessionId) {
      setSuccessOrderSessionId(sessionId);
      setShowOrderSuccessModal(true);
      const newUrl = window.location.pathname;
      window.history.replaceState({}, document.title, newUrl);
    } else if (orderCancelled === "true") {
      alert("Order cancelled. Your payment was not processed and no PupCoins were deducted.");
      const newUrl = window.location.pathname;
      window.history.replaceState({}, document.title, newUrl);
    } else if (params.get("credits_success") === "true") {
      const added = params.get("added") || "?";
      const sessionId = params.get("session_id");
      setCreditSuccessMsg(`🎉 ${added} PupCoins added to your account!`);
      // Confirm the purchase server-side (credits it if the webhook hasn't yet),
      // then re-fetch so the displayed balance is accurate even if the webhook failed.
      (async () => {
        if (sessionId) { try { await confirmCreditsSession(sessionId); } catch { /* ignore */ } }
        const user = await fetchMe();
        if (user) applyUser(user);
      })();
      window.history.replaceState({}, document.title, window.location.pathname);
      setTimeout(() => setCreditSuccessMsg(""), 5000);
    } else if (params.get("credits_cancelled") === "true") {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  const applyUser = (user: PublicUser) => {
    setUserProfile({
      fullName: user.fullName,
      email: user.email,
      credits: user.credits,
      treats: user.treats,
      isAdmin: user.isAdmin,
      city: user.city,
      profilePhotoUrl: user.profilePhotoUrl ?? null,
      referralCode: user.referralCode ?? null,
      phoneVerified: user.phoneVerified ?? false,
      emailVerified: user.emailVerified ?? false,
      zip: user.zip,
      bio: user.bio ?? null,
      profileBonusGranted: user.profileBonusGranted ?? false,
      acceptedTermsVersion: user.acceptedTermsVersion ?? null,
      acceptedTermsAt: user.acceptedTermsAt ?? null,
      currentTermsVersion: user.currentTermsVersion,
      requiresTermsAcceptance: user.requiresTermsAcceptance ?? false,
    });
    setDailyStreak(user.dailyStreak || 0);
    const today = new Date().toISOString().split('T')[0];
    setDailyStreakClaimed(user.lastStreakClaim?.startsWith(today) || false);
    const claimed = new Set(
      Array.isArray(user.achievements)
        ? user.achievements.filter((value): value is string => typeof value === "string")
        : [],
    );
    setAchievements((current) => current.map((achievement) => ({
      ...achievement,
      isUnlocked: achievement.isUnlocked || claimed.has(achievement.id) || (achievement.id === "pioneer" && user.profileComplete),
      isClaimed: claimed.has(achievement.id),
    })));
  };

  const toggleDarkMode = () => {
    const newVal = !isDarkMode;
    setIsDarkMode(newVal);
    localStorage.setItem("paws_dark_mode", String(newVal));
  };

  const handleUnlockAchievement = (id: string) => {
    setAchievements((prev) => {
      const idx = prev.findIndex((a) => a.id === id);
      if (idx !== -1 && !prev[idx].isUnlocked) {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], isUnlocked: true };
        // We still keep a tiny bit of local state for instant UI unlock before claim
        return updated;
      }
      return prev;
    });
  };

  const handleClaimReward = async (id: string) => {
    try {
      const updatedUser = await claimAchievement(id);
      applyUser(updatedUser);
    } catch(err: any) {
      alert(err.message || "Could not claim achievement.");
    }
  };

  const handleClaimDailyStreak = async () => {
    try {
      const updatedUser = await claimDailyStreak();
      applyUser(updatedUser);
    } catch(err: any) {
      alert(err.message || "Could not claim daily streak.");
    }
  };

  const handleCreateAlbum = async (name: string) => {
    const newAlbum = await createAlbum(name);
    if (newAlbum) {
      setAlbums((prev) => [newAlbum, ...prev]);
    }
  };

  // Called by SignUp once the user is verified AND has a complete profile.
  const handleAuthenticated = (user: PublicUser, isNew: boolean) => {
    applyUser(user);
    if (!user.profileComplete) {
      setIncompleteUser(user);
      setIsAuthed(false);
      setCurrentScreen(Screen.SIGN_UP);
      return;
    }
    setIncompleteUser(null);
    setIsAuthed(true);
    if (isNew) {
      handleUnlockAchievement("pioneer");
      setCurrentScreen(Screen.WELCOME);
    } else {
      setCurrentScreen(Screen.DASHBOARD);
      refreshCreations().catch(() => {});
      fetchAlbums().then(setAlbums);
    }
  };

  const handleLogout = () => {
    clearToken();
    setIsAuthed(false);
    setUserProfile(EMPTY_PROFILE);
    setCurrentScreen(Screen.SIGN_UP);
  };

  /**
   * Header overflow menu contents.
   *
   * Every entry here was previously its own always-visible button in the header
   * corner. They are preserved verbatim (same handler, same admin gating) — the
   * only change is that they now sit one click deeper so the four primary
   * icons can read as primary. Order runs most- to least-used.
   */
  const SHELL_MENU_ITEMS: {
    id: string;
    label: string;
    icon: React.ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean | "true" | "false" }>;
    run: () => void;
    adminOnly?: boolean;
    danger?: boolean;
  }[] = [
    { id: "credits", label: "Buy PupCoins", icon: Zap, run: () => setShowCreditStore(true) },
    { id: "store", label: "Shop", icon: ShoppingCart, run: () => setCurrentScreen(Screen.STORE) },
    { id: "community", label: "Community", icon: Users, run: () => setCurrentScreen(Screen.COMMUNITY) },
    { id: "health", label: "Pet Health", icon: Activity, run: () => setCurrentScreen(Screen.PET_HEALTH) },
    { id: "theme", label: isDarkMode ? "Light mode" : "Dark mode", icon: isDarkMode ? Sun : Moon, run: toggleDarkMode },
    { id: "help", label: "Help & Support", icon: HelpCircle, run: () => setShowHelpModal(true) },
    { id: "admin-wags", label: "Wags admin", icon: PackageCheck, run: () => setCurrentScreen(Screen.ADMIN_WAGS), adminOnly: true },
    { id: "logout", label: "Log out", icon: LogOut, run: handleLogout, danger: true },
  ];

  const handleWelcomeNext = () => setCurrentScreen(Screen.TUTORIAL);

  const handleTutorialComplete = () => setCurrentScreen(Screen.DASHBOARD);

  const handleClaimDailyBonus = async () => {
    // Persist server-side (reuses the daily-streak grant: +5 PupCoins & a treat).
    try {
      const updatedUser = await claimDailyStreak();
      applyUser(updatedUser);
    } catch (err: any) {
      alert(err.message || "Daily bonus already claimed today.");
    }
  };

  const handlePawprintComplete = (pawprintId: number) => {
    window.history.pushState(
      { screen: Screen.STORE, pawprintId },
      "",
      `/store?pawprint=${pawprintId}`,
    );
    setCurrentScreen(Screen.STORE);
  };

  const handleCreationSaved = (newCreation: Creation) => {
    setCreations((prev) => {
      const exists = prev.some((c) => c.id === newCreation.id);
      if (exists) {
        return prev.map((c) => (c.id === newCreation.id ? newCreation : c));
      }
      return [newCreation, ...prev];
    });
    setSelectedCreationForShare(newCreation);
    handleUnlockAchievement("creation");
    setCurrentScreen(Screen.SHARE_MEMORY);
  };

  const handleCreationGenerated = (newCreation: Creation) => {
    setCreations((prev) => {
      const exists = prev.some((c) => c.id === newCreation.id);
      if (exists) return prev;
      return [newCreation, ...prev];
    });
    handleUnlockAchievement("creation");
  };

  const handleCreationUpdated = (updatedCreation: Creation) => {
    setCreations((prev) =>
      prev.map((c) => (c.id === updatedCreation.id ? updatedCreation : c))
    );
  };

  const handleSelectCreation = (creation: Creation) => {
    setSelectedCreationForShare(creation);
    setCurrentScreen(Screen.SHARE_MEMORY);
  };

  const handleDeductCredits = async (amount: number) => {
    // Optimistic UI, then reconcile with the server (the real spend is persisted
    // server-side during generation, and logged to the credit ledger).
    setUserProfile((prev) => ({ ...prev, credits: Math.max(0, prev.credits - amount) }));
    try {
      const me = await fetchMe();
      if (me) applyUser(me);
    } catch {
      /* keep optimistic value if the refresh fails */
    }
  };

  const handleAcceptTerms = async () => {
    try {
      const updatedUser = await acceptCurrentTerms();
      applyUser(updatedUser);
    } catch (err: any) {
      alert(err.message || "Could not save your acceptance. Please try again.");
    }
  };

  // Standalone password-reset page (opened from the emailed link) — render it
  // before auth/warehouse so a logged-out user can reset from any deploy target.
  if (typeof window !== "undefined" && window.location.pathname === "/reset-password") {
    return <ResetPassword />;
  }

  // Standalone email-confirmation page. Rendered before auth for the same
  // reason as the reset page: the emailed link is frequently opened in a
  // different browser than the one holding the session.
  if (typeof window !== "undefined" && window.location.pathname === "/verify-email") {
    return <VerifyEmail />;
  }

  // While we check for an existing session, show a lightweight loader.
  // mypets.cc runs the same build but serves the cold-storage warehouse identity.
  if (deployTarget === "warehouse") {
    return <WarehouseMode isDarkMode={isDarkMode} />;
  }

  if (!authChecked) {
    return (
      <div className={`min-h-screen bg-surface flex items-center justify-center ${isDarkMode ? "dark" : ""}`}>
        <div className="flex flex-col items-center gap-3 text-on-surface-variant">
          <span className="text-3xl">🐾</span>
          <RefreshCw className="animate-spin" size={20} />
        </div>
      </div>
    );
  }

  return (
    <div className={`min-h-screen flex flex-col selection:bg-primary-container selection:text-on-primary-container ${isDarkMode ? "dark" : ""}`}>

      {/* Global Background Layer */}
      <div className="fixed inset-0 z-[-10] pointer-events-none overflow-hidden bg-background">
        <div
          className={`absolute inset-0 bg-cover bg-center bg-transition ${getBackgroundImage(currentScreen).className}`}
          style={{ backgroundImage: `url('${getBackgroundImage(currentScreen).url}')` }}
        ></div>
        {/* Readability scrim: keeps foreground text from washing into the photo background */}
        <div className="absolute inset-0 bg-gradient-to-b from-background/70 via-background/50 to-background/80"></div>
        {/* Mud splatters */}
        <div className="mud-splatter" style={{ width: "120px", height: "90px", top: "-20px", left: "-10%", "--rot": "15deg" } as React.CSSProperties}></div>
        <div className="mud-splatter" style={{ width: "180px", height: "140px", top: "40%", right: "-15%", "--rot": "-25deg", animationDelay: "0.2s" } as React.CSSProperties}></div>
        <div className="mud-splatter" style={{ width: "90px", height: "70px", bottom: "-30px", left: "20%", "--rot": "45deg", animationDelay: "0.5s" } as React.CSSProperties}></div>
        <div className="mud-splatter" style={{ width: "150px", height: "100px", top: "10%", right: "10%", "--rot": "10deg", animationDelay: "0.8s" } as React.CSSProperties}></div>
        {/* Gradient overlay to ensure text remains readable */}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-background/25 to-background/60 dark:from-transparent dark:via-[#17120f]/40 dark:to-[#17120f]/80"></div>
      </div>

      {/* Dynamic Upper Header Bar */}
      <header className="fixed inset-x-0 top-0 z-50 h-16 bg-surface/85 backdrop-blur-xl shadow-[0_8px_32px_0_rgba(68,42,34,0.08)]">
        {/* Two corners only: brand on the left, four stencil icons on the right.
            The centre is intentionally empty so primary tools remain legible. */}
        <nav className="mx-auto flex h-16 w-full max-w-[96rem] items-center justify-between gap-2 px-3 sm:px-5 lg:px-8">
          <button
            type="button"
            onClick={() => setCurrentScreen(isAuthed ? Screen.DASHBOARD : Screen.WELCOME)}
            className="flex min-w-0 shrink-0 items-center gap-2.5 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            aria-label="Pawsome3D home"
          >
            <img src="/brand/pawsome-logo.png" alt="Pawsome3D" className="h-9 w-9 shrink-0 rounded-lg object-contain" />
          </button>

          {isAuthed && (
            <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
              {SHELL_ICON_NAV.map((item) => {
                const Icon = SHELL_ICONS[item.id];
                const active = item.screens.includes(currentScreen);
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-tour={item.id === "create" ? "nav-create" : undefined}
                    onClick={() => setCurrentScreen(item.screen)}
                    title={item.label}
                    aria-label={item.label}
                    aria-current={active ? "page" : undefined}
                    className={`group relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                      active ? "text-primary" : "text-on-surface-variant hover:text-primary"
                    }`}
                  >
                    <Icon size={22} strokeWidth={1.75} aria-hidden="true" />
                    {/* Active marker is a dot, not a filled pill — keeps all
                        four glyphs at identical visual weight. */}
                    <span
                      className={`pointer-events-none absolute bottom-1.5 h-1 w-1 rounded-full bg-primary transition-opacity ${
                        active ? "opacity-100" : "opacity-0"
                      }`}
                    />
                  </button>
                );
              })}

              {/* Overflow — everything the old header crowded into the corner.
                  Nothing was removed, only demoted one level. */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowShellMenu((open) => !open)}
                  title="More"
                  aria-label="More options"
                  aria-haspopup="menu"
                  aria-expanded={showShellMenu}
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                    showShellMenu ? "text-primary" : "text-on-surface-variant hover:text-primary"
                  }`}
                >
                  <MoreHorizontal size={22} strokeWidth={1.75} aria-hidden="true" />
                </button>

                {showShellMenu && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      aria-hidden="true"
                      onClick={() => setShowShellMenu(false)}
                    />
                    <div
                      role="menu"
                      className="absolute right-0 top-[52px] z-50 w-60 overflow-hidden rounded-2xl border border-outline-variant/25 bg-surface-container-high shadow-2xl"
                    >
                      {userProfile.fullName && (
                        <div className="flex items-center gap-2.5 border-b border-outline-variant/20 px-4 py-3">
                          {userProfile.profilePhotoUrl ? (
                            <img src={userProfile.profilePhotoUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
                          ) : (
                            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-[11px] font-black text-on-primary">
                              {userProfile.fullName.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase() || "U"}
                            </div>
                          )}
                          <div className="min-w-0">
                            <p className="truncate text-xs font-bold text-on-surface">{userProfile.fullName.split(" ")[0]}</p>
                            <p className="text-[11px] font-bold text-secondary">{userProfile.credits} PupCoins</p>
                          </div>
                        </div>
                      )}
                      {SHELL_MENU_ITEMS.map((entry) => {
                        if (entry.adminOnly && !userProfile.isAdmin) return null;
                        const EntryIcon = entry.icon;
                        return (
                          <button
                            key={entry.id}
                            role="menuitem"
                            type="button"
                            onClick={() => {
                              setShowShellMenu(false);
                              entry.run();
                            }}
                            className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium transition-colors hover:bg-surface-container-highest ${
                              entry.danger ? "text-error" : "text-on-surface"
                            }`}
                          >
                            <EntryIcon size={17} strokeWidth={1.75} aria-hidden="true" />
                            {entry.label}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {!isAuthed && (
            <button
              type="button"
              onClick={toggleDarkMode}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-on-surface-variant transition-colors hover:text-primary"
              title={isDarkMode ? "Turn on Light Mode" : "Turn on Dark Mode"}
              aria-label={isDarkMode ? "Turn on light mode" : "Turn on dark mode"}
            >
              {isDarkMode ? <Sun size={20} strokeWidth={1.75} /> : <Moon size={20} strokeWidth={1.75} />}
            </button>
          )}
        </nav>
      </header>

      <div className="flex-grow flex w-full relative">
        {/* Desktop Sidebar */}
        {isAuthed && [Screen.DASHBOARD, Screen.ALBUMS, Screen.EDIT_MEMORY, Screen.REQUEST_MEMORY, Screen.SHARE_MEMORY, Screen.ALBUM_VIEW, Screen.MODELS, Screen.STORE, Screen.VOICE_TEST, Screen.BIM, Screen.PROFILE, Screen.COMMUNITY, Screen.ANIMATOR, Screen.PAWPRINTS, Screen.PRINT_SHOP, Screen.PET_GLB, Screen.PAWLISHER, Screen.FURBIN, Screen.CREATE, Screen.CREATE_REFERENCE, Screen.CREATE_CUSTOMIZE, Screen.CREATE_VALIDATE, Screen.CREATE_CHECKOUT, Screen.ADMIN_WAGS, Screen.WAGS_INBOX, Screen.PET_HEALTH].includes(currentScreen) && (
          <aside className="fixed bottom-0 left-0 top-16 z-40 hidden w-56 shrink-0 flex-col overflow-x-hidden overflow-y-auto border-r border-outline-variant/20 bg-surface/85 py-3 shadow-xl backdrop-blur-xl dark:bg-surface-dim/85 md:flex">
            <nav className="mt-2 flex-1 space-y-1 px-3">
              {SIDEBAR_NAV.map((item) => {
                const NavIcon = SHELL_NAV_ICONS[item.id] || HelpCircle;
                return (
                  <button
                    key={item.id}
                    onClick={() => item.screen === Screen.ANIMATOR ? openAnimationStudio() : setCurrentScreen(item.screen)}
                    className={`flex min-h-10 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-all ${currentScreen === item.screen ? "bg-primary text-on-primary shadow-sm" : "text-on-surface-variant hover:bg-secondary-container/50 dark:hover:bg-surface-variant/30"}`}
                  >
                    {item.imageSrc
                      ? <img src={item.imageSrc} alt="" aria-hidden="true" className={`h-5 w-5 shrink-0 object-contain ${currentScreen === item.screen ? "invert" : "dark:invert"}`} />
                      : <NavIcon size={20} strokeWidth={1.9} aria-hidden="true" />}
                    <span className="min-w-0 truncate font-medium">{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="mx-4 mt-auto space-y-2 border-t border-outline-variant/20 px-4 py-6">
              <button onClick={() => setCurrentScreen(Screen.PROFILE)} className={`flex w-full items-center gap-4 rounded-lg px-4 py-2 transition-all ${currentScreen === Screen.PROFILE ? "bg-primary text-on-primary" : "text-on-surface-variant hover:bg-secondary-container/30"}`}>
                <UserIcon size={20} strokeWidth={1.9} aria-hidden="true" />
                <span className="text-body-sm">Profile</span>
              </button>
              <button onClick={() => setShowHelpModal(true)} className="flex w-full items-center gap-4 rounded-lg px-4 py-2 text-on-surface-variant transition-all hover:bg-secondary-container/30">
                <HelpCircle size={20} strokeWidth={1.9} aria-hidden="true" />
                <span className="text-body-sm">Help / Support</span>
              </button>
            </div>
          </aside>
        )}

      {/* Main Content Router viewport */}
      <CreateFlowProvider>
      {/*
        LIVE-6 (2026-08-04 deployment review): a keyboard or screen-reader user
        previously had to tab through the whole header plus every sidebar
        destination on every route change before reaching page content. WCAG
        2.4.1 (Bypass Blocks) asks for a way past repeated navigation. The link
        is visually hidden until focused, so it costs sighted users nothing.
      */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-xl focus:bg-primary focus:px-4 focus:py-3 focus:font-black focus:text-on-primary focus:shadow-lg"
      >
        Skip to main content
      </a>
      <main id="main-content" tabIndex={-1} className={`flex min-w-0 flex-grow flex-col items-center justify-center pt-16 pb-24 md:pb-0 ${isAuthed ? 'relative w-full md:ml-56 md:w-[calc(100%-14rem)]' : 'w-full'}`}>
        {/* Render public screens regardless of auth state */}
        {[Screen.DASHBOARD, Screen.LANDING_MODELS, Screen.LANDING_MEMORIALS, Screen.HOW_IT_WORKS, Screen.PRICING].includes(currentScreen) && (
          <HomePage
            userProfile={userProfile}
            onOpenCreate={() => !isAuthed ? setCurrentScreen(Screen.SIGN_UP) : setCurrentScreen(Screen.CREATE)}
            onOpenShop={() => setCurrentScreen(Screen.PRICING)}
            onOpenPawprints={() => setCurrentScreen(Screen.PAWPRINTS)}
            onOpenFurball={() => setCurrentScreen(Screen.CREATE)}
            onOpenFidos={() => setCurrentScreen(Screen.PAWLISHER)}
          />
        )}

        {currentScreen === Screen.BARKLEY && (
          <Suspense fallback={<div className="p-12 text-center text-on-surface-variant">Loading the studio tour…</div>}>
            <BarkleyScreen onClose={() => setCurrentScreen(Screen.DASHBOARD)} />
          </Suspense>
        )}

        {currentScreen === Screen.LANDING_DOGS && (
          <DogModelsPage
            onOpenCreate={() => !isAuthed ? setCurrentScreen(Screen.SIGN_UP) : setCurrentScreen(Screen.CREATE)}
            onOpenPricing={() => setCurrentScreen(Screen.PRICING)}
            onSelectProduct={(slug) => {
              window.history.pushState({}, "", `/product/${slug}`);
              setCurrentScreen(Screen.PRODUCT_VIEW);
            }}
          />
        )}

        {currentScreen === Screen.LANDING_CATS && (
          <CatModelsPage
            onOpenCreate={() => !isAuthed ? setCurrentScreen(Screen.SIGN_UP) : setCurrentScreen(Screen.CREATE)}
            onOpenPricing={() => setCurrentScreen(Screen.PRICING)}
            onSelectProduct={(slug) => {
              window.history.pushState({}, "", `/product/${slug}`);
              setCurrentScreen(Screen.PRODUCT_VIEW);
            }}
          />
        )}

        {currentScreen === Screen.LANDING_PROFESSIONALS && (
          <PetProfessionalsPage
            onOpenCreate={() => !isAuthed ? setCurrentScreen(Screen.SIGN_UP) : setCurrentScreen(Screen.CREATE)}
            onOpenPricing={() => setCurrentScreen(Screen.PRICING)}
          />
        )}

        {currentScreen === Screen.LANDING_GLB_GUIDE && (
          <GlbGuidePage
            onOpenCreate={() => !isAuthed ? setCurrentScreen(Screen.SIGN_UP) : setCurrentScreen(Screen.CREATE)}
            onOpenPricing={() => setCurrentScreen(Screen.PRICING)}
          />
        )}

        {currentScreen === Screen.LANDING_DENVER && (
          <DenverPage
            onOpenCreate={() => !isAuthed ? setCurrentScreen(Screen.SIGN_UP) : setCurrentScreen(Screen.CREATE)}
            onOpenPricing={() => setCurrentScreen(Screen.PRICING)}
          />
        )}

        {currentScreen === Screen.LANDING_PHILADELPHIA && (
          <PhiladelphiaPage
            onOpenCreate={() => !isAuthed ? setCurrentScreen(Screen.SIGN_UP) : setCurrentScreen(Screen.CREATE)}
            onOpenPricing={() => setCurrentScreen(Screen.PRICING)}
          />
        )}

        {currentScreen === Screen.GUIDES_HUB && (
          <GuidesHubPage
            onOpenCreate={() => !isAuthed ? setCurrentScreen(Screen.SIGN_UP) : setCurrentScreen(Screen.CREATE)}
            onOpenPricing={() => setCurrentScreen(Screen.PRICING)}
          />
        )}

        {currentScreen === Screen.PRODUCT_VIEW && (
          <ProductPage
            productSlug={window.location.pathname.replace("/product/", "") || "shiba-inu-glb"}
            onOpenCreate={() => !isAuthed ? setCurrentScreen(Screen.SIGN_UP) : setCurrentScreen(Screen.CREATE)}
            onOpenPricing={() => setCurrentScreen(Screen.PRICING)}
          />
        )}

        {currentScreen === Screen.CREATE && (
          isAuthed
            ? <PetModelStudio />
            : <CreateScreen onNavigate={setCurrentScreen} />
        )}
        {currentScreen === Screen.CREATE_REFERENCE && (
          <CreateReferenceScreen onNavigate={setCurrentScreen} />
        )}
        {currentScreen === Screen.CREATE_CUSTOMIZE && (
          <CreateCustomizeScreen onNavigate={setCurrentScreen} />
        )}
        {currentScreen === Screen.CREATE_VALIDATE && (
          <CreateValidateScreen onNavigate={setCurrentScreen} />
        )}
        {currentScreen === Screen.CREATE_CHECKOUT && (
          <CreateCheckoutScreen onNavigate={setCurrentScreen} userProfile={userProfile} />
        )}
        {currentScreen === Screen.CREATE_BUILD_PROGRESS && (
          <CreateBuildProgressScreen onNavigate={setCurrentScreen} />
        )}
        {currentScreen === Screen.CREATE_BUILD_REVIEW && (
          <CreateBuildReviewScreen onNavigate={setCurrentScreen} />
        )}
        {currentScreen === Screen.CREATE_RIG_PROGRESS && (
          <CreateRigProgressScreen onNavigate={setCurrentScreen} />
        )}
        {currentScreen === Screen.CREATE_RIG_REVIEW && (
          <CreateRigReviewScreen onNavigate={setCurrentScreen} />
        )}

        {currentScreen === Screen.PET_GLB && <PetModelStudio />}

        {currentScreen === Screen.PAWPRINTS && (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center py-24 text-on-surface-variant"><RefreshCw className="animate-spin" size={22} /></div>}>
            <PawprintsScreen userProfile={userProfile} creations={creations} onOpenCreditStore={() => setShowCreditStore(true)} onUserUpdate={applyUser} onCreationSaved={refreshCreations} onPawprintComplete={handlePawprintComplete} />
          </Suspense>
        )}

        {/* Public storefront. Signed-out visitors see the formats and pricing;
            the figurine picker asks them to sign in rather than disappearing,
            so the page works as a landing surface as well as an ordering one. */}
        {currentScreen === Screen.PRINT_SHOP && (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center py-24 text-on-surface-variant"><RefreshCw className="animate-spin" size={22} /></div>}>
            <PrintShopScreen userProfile={userProfile} />
          </Suspense>
        )}

        {currentScreen === Screen.STORE && <Store />}

        {/* When not authenticated and screen is not public, render sign-up. */}
        {!isAuthed && ![
          Screen.DASHBOARD, Screen.CREATE, Screen.CREATE_REFERENCE, Screen.CREATE_CUSTOMIZE, Screen.CREATE_VALIDATE, Screen.CREATE_CHECKOUT, Screen.CREATE_BUILD_PROGRESS, Screen.CREATE_BUILD_REVIEW, Screen.CREATE_RIG_PROGRESS, Screen.CREATE_RIG_REVIEW, Screen.PAWPRINTS, Screen.STORE, Screen.PRINT_SHOP, Screen.LANDING_MODELS, Screen.LANDING_DOGS, Screen.LANDING_CATS, Screen.LANDING_PROFESSIONALS, Screen.LANDING_GLB_GUIDE, Screen.LANDING_DENVER, Screen.LANDING_PHILADELPHIA, Screen.GUIDES_HUB, Screen.PRODUCT_VIEW, Screen.LANDING_MEMORIALS, Screen.HOW_IT_WORKS, Screen.PRICING
        ].includes(currentScreen) ? (
          <SignUp onAuthenticated={handleAuthenticated} resumeProfile={incompleteUser} />
        ) : (
          isAuthed && (
            <>
              {currentScreen === Screen.WELCOME && (
                <Welcome
                  userName={userProfile.fullName}
                  onNext={handleWelcomeNext}
                  onBackToSignUp={handleLogout}
                />
              )}

              {currentScreen === Screen.TUTORIAL && <Tutorial onComplete={handleTutorialComplete} />}

              {currentScreen === Screen.EDIT_MEMORY && userProfile.isAdmin && (
                <EditMemory
                  credits={userProfile.credits}
                  isAdmin={userProfile.isAdmin}
                  onCreationSaved={handleCreationSaved}
                onCreationGenerated={handleCreationGenerated}
                onCreationUpdated={handleCreationUpdated}
                onDeductCredits={handleDeductCredits}
                onNavigateBack={() => setCurrentScreen(Screen.DASHBOARD)}
                onUnlockAchievement={handleUnlockAchievement}
                userCity={userProfile.city}
              />
            )}

            {/* The paid concierge request flow is retired until real server
                routes and fulfillment exist. Never route a customer into its
                preserved legacy source. */}
            {currentScreen === Screen.EDIT_MEMORY && !userProfile.isAdmin && (
              <main className="mx-auto w-full max-w-xl px-4 py-12 text-center">
                <h1 className="text-2xl font-black text-on-surface">Create a supported keepsake</h1>
                <p className="mt-3 text-on-surface-variant">Concierge photo and video requests are not accepting payment. Pawprints and 3D Create remain available.</p>
                <button type="button" onClick={() => setCurrentScreen(Screen.PAWPRINTS)} className="mt-6 min-h-12 rounded-xl bg-primary px-5 font-black text-on-primary">Open Pawprints</button>
              </main>
            )}

            {currentScreen === Screen.REQUEST_MEMORY && (
              <main className="mx-auto w-full max-w-xl px-4 py-12 text-center">
                <h1 className="text-2xl font-black text-on-surface">Create a supported keepsake</h1>
                <p className="mt-3 text-on-surface-variant">Concierge photo and video requests are not accepting payment. Pawprints and 3D Create remain available.</p>
                <button type="button" onClick={() => setCurrentScreen(Screen.PAWPRINTS)} className="mt-6 min-h-12 rounded-xl bg-primary px-5 font-black text-on-primary">Open Pawprints</button>
              </main>
            )}

            {currentScreen === Screen.ALBUMS && (
              <AlbumsPage
                userProfile={userProfile}
                creations={creations}
                albums={albums}
                onSelectCreation={handleSelectCreation}
                onNavigate={setCurrentScreen}
              />
            )}

            {currentScreen === Screen.ALBUM_VIEW && activeAlbum && (
              <AlbumView
                album={activeAlbum}
                creations={creations.filter(c => c.album_id?.toString() === activeAlbum.id)}
                onBack={() => setCurrentScreen(Screen.ALBUMS)}
                onSelectCreation={(c) => setSelectedCreationForShare(c)}
                onPlayVideo={() => {}}
                animatingJobs={{}}
              />
            )}

            {currentScreen === Screen.SHARE_MEMORY && selectedCreationForShare && (
              <ShareMemory
                creation={selectedCreationForShare || creations[0]}
                userCredits={userProfile.credits}
                isAdmin={userProfile.isAdmin}
                onBack={() => setCurrentScreen(Screen.DASHBOARD)}
              />
            )}

            {currentScreen === Screen.MODELS && (
                <UnderConstructionLock
                  featureName="Furball3D"
                  featureDescription="The legacy Furball3D builder is offline while we migrate to the new create-to-print workflow."
                  onGoToCreate={() => setCurrentScreen(Screen.CREATE)}
                />
              )}

            {currentScreen === Screen.VOICE_TEST && (
              <VoiceFlowTest userProfile={userProfile} onUserUpdate={applyUser} />
            )}

            {currentScreen === Screen.BIM && (
              <BimPreviewScreen onGoToCreate={() => setCurrentScreen(Screen.CREATE)} />
            )}

            {currentScreen === Screen.PROFILE && (
              <ProfileScreen
                userProfile={userProfile}
                achievements={achievements}
                onClaimReward={handleClaimReward}
                dailyStreak={dailyStreak}
                dailyStreakClaimed={dailyStreakClaimed}
                onClaimDailyStreak={handleClaimDailyStreak}
                onOpenCreditStore={() => setShowCreditStore(true)}
                onLogout={handleLogout}
                isDarkMode={isDarkMode}
                onToggleDarkMode={toggleDarkMode}
                onUserUpdate={applyUser}
              />
            )}

            {currentScreen === Screen.COMMUNITY && (
              <Community userProfile={userProfile} />
            )}

            {currentScreen === Screen.PAWLISHER && (
              <Suspense fallback={<div className="flex-1 flex items-center justify-center py-24 text-on-surface-variant"><RefreshCw className="animate-spin" size={22} /></div>}>
                <FidosStylesScreen
                  userProfile={userProfile}
                  onGoToPawprints={() => setCurrentScreen(Screen.PAWPRINTS)}
                  onUserUpdate={applyUser}
                />
              </Suspense>
            )}

            {currentScreen === Screen.PET_HEALTH && (
              <Suspense fallback={<div className="flex-1 flex items-center justify-center py-24 text-on-surface-variant"><RefreshCw className="animate-spin" size={22} /></div>}>
                <PetHealthScreen
                  userProfile={userProfile}
                  onBack={() => setCurrentScreen(Screen.DASHBOARD)}
                />
              </Suspense>
            )}

            {currentScreen === Screen.WAGS_INBOX && (
              <Suspense fallback={<div className="flex-1 flex items-center justify-center py-24 text-on-surface-variant"><RefreshCw className="animate-spin" size={22} /></div>}>
                <WagsInboxScreen onGoToFidos={() => setCurrentScreen(Screen.PAWLISHER)} />
              </Suspense>
            )}

            {/* Server-guarded too: every /api/admin/wags/* route checks isUserAdmin.
                This client gate is cosmetic; non-admins landing here are bounced. */}
            {currentScreen === Screen.ADMIN_WAGS && (
              userProfile.isAdmin ? (
                <Suspense fallback={<div className="flex-1 flex items-center justify-center py-24 text-on-surface-variant"><RefreshCw className="animate-spin" size={22} /></div>}>
                  <WagsAdminPanel onClose={() => setCurrentScreen(Screen.DASHBOARD)} />
                </Suspense>
              ) : (
                <HomePage
                  userProfile={userProfile}
                  onOpenCreate={() => setCurrentScreen(Screen.CREATE)}
                  onOpenShop={() => setCurrentScreen(Screen.STORE)}
                  onOpenPawprints={() => setCurrentScreen(Screen.PAWPRINTS)}
                  onOpenFurball={() => setCurrentScreen(Screen.CREATE)}
                  onOpenFidos={() => setCurrentScreen(Screen.PAWLISHER)}
                />
              )
            )}

            {currentScreen === Screen.FURBIN && (
              <Suspense fallback={<div className="flex-1 flex items-center justify-center py-24 text-on-surface-variant"><RefreshCw className="animate-spin" size={22} /></div>}>
                <FurBinScreen userProfile={userProfile} creations={creations} onOpenCreditStore={() => setShowCreditStore(true)} />
              </Suspense>
            )}


            {currentScreen === Screen.ANIMATOR && (
              <AnimationStudio
                creations={creations}
                userProfile={userProfile}
                onOpenCreditStore={() => setShowCreditStore(true)}
                onClose={() => setCurrentScreen(Screen.CREATE)}
                onCreationsChanged={refreshCreations}
              />
            )}


            {/* Safety net: if somehow on SIGN_UP while authed, send to dashboard */}
            {currentScreen === Screen.SIGN_UP && (
              <HomePage
                userProfile={userProfile}
                onOpenCreate={() => setCurrentScreen(Screen.CREATE)}
                onOpenShop={() => setCurrentScreen(Screen.STORE)}
                onOpenPawprints={() => setCurrentScreen(Screen.PAWPRINTS)}
                onOpenFurball={() => setCurrentScreen(Screen.CREATE)} /* RD-6: Furball3D gated; route to Create */
                onOpenFidos={() => setCurrentScreen(Screen.PAWLISHER)}
              />
            )}
          </>
        )
      )}
      </main>
      </CreateFlowProvider>

      {isAuthed && userProfile.requiresTermsAcceptance && (
        <div className="fixed inset-0 z-[90] bg-black/70 flex items-center justify-center p-4">
          <section className="w-full max-w-lg rounded-2xl bg-surface text-on-surface border border-outline-variant shadow-2xl p-6">
            <h2 className="text-2xl font-black mb-3">Please review our terms</h2>
            <p className="text-lg leading-relaxed text-on-surface-variant mb-5">
              We updated our Terms and Privacy Policy. Please accept the current version to keep using Pawsome3D.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 mb-5">
              <a href="/legal/terms" target="_blank" rel="noopener noreferrer" className="min-h-12 flex items-center justify-center rounded-xl border border-outline-variant px-4 text-base font-bold text-primary">
                Read Terms
              </a>
              <a href="/legal/privacy" target="_blank" rel="noopener noreferrer" className="min-h-12 flex items-center justify-center rounded-xl border border-outline-variant px-4 text-base font-bold text-primary">
                Read Privacy Policy
              </a>
            </div>
            <button
              type="button"
              onClick={handleAcceptTerms}
              className="w-full min-h-14 rounded-xl bg-primary text-on-primary text-lg font-black"
            >
              I Agree
            </button>
          </section>
        </div>
      )}

      {/* Floating Bottom Navigator (only when signed in and past onboarding) */}
      {isAuthed && [Screen.DASHBOARD, Screen.ALBUMS, Screen.EDIT_MEMORY, Screen.REQUEST_MEMORY, Screen.SHARE_MEMORY, Screen.ALBUM_VIEW, Screen.MODELS, Screen.STORE, Screen.VOICE_TEST, Screen.BIM, Screen.PROFILE, Screen.COMMUNITY, Screen.ANIMATOR, Screen.PAWPRINTS, Screen.PRINT_SHOP, Screen.PAWLISHER, Screen.FURBIN, Screen.CREATE, Screen.WAGS_INBOX].includes(currentScreen) && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 grid gap-1 rounded-t-2xl border-t border-outline-variant/30 bg-surface-container-lowest/90 px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-[0_-8px_32px_0_rgba(68,42,34,0.08)] backdrop-blur-xl dark:bg-surface-dim/90 md:hidden"
          // Column count follows the nav length rather than being hard-coded,
          // so trimming MOBILE_NAV can't leave a stretched or overflowing grid.
          // Help was moved to the profile overflow menu (LIVE-1 follow-up) so a
          // paid module (Fur Reels) outranks a help link for primary navigation.
          style={{ gridTemplateColumns: `repeat(${MOBILE_NAV.length}, minmax(0, 1fr))` }}
        >
          {MOBILE_NAV.map((item) => {
            const NavIcon = SHELL_NAV_ICONS[item.id] || HelpCircle;
            return (
              <button
                key={item.id}
                onClick={() => item.screen === Screen.ANIMATOR ? openAnimationStudio() : setCurrentScreen(item.screen)}
                className={`flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 transition-colors ${currentScreen === item.screen ? "bg-primary text-on-primary" : "text-on-surface-variant hover:bg-surface-variant/50"}`}
              >
                {item.imageSrc
                  ? <img src={item.imageSrc} alt="" aria-hidden="true" className={`h-5 w-5 shrink-0 object-contain ${currentScreen === item.screen ? "invert" : "dark:invert"}`} />
                  : <NavIcon size={20} strokeWidth={1.9} aria-hidden="true" />}
                <span className="w-full truncate text-center text-[9px] font-bold">{item.label}</span>
              </button>
            );
          })}
        </div>
      )}

      </div>

      {/* Randy AI-chat bubble companion (only for signed-in users) */}
      {isAuthed && (
        <Suspense fallback={null}>
          <RandyChat
            onUnlockAchievement={handleUnlockAchievement}
            isDarkMode={isDarkMode}
            onNavigate={setCurrentScreen}
            onOpenCreditStore={() => setShowCreditStore(true)}
            onLaunchAR={() => setCurrentScreen(Screen.CREATE)} /* RD-6: AR entry gated; route to Create */
          />
        </Suspense>
      )}

      {/* PupCoins success toast */}
      {creditSuccessMsg && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-primary text-white px-5 py-3 rounded-2xl shadow-xl text-sm font-bold animate-fade-in flex items-center gap-2">
          <Zap size={16} className="fill-white" />
          {creditSuccessMsg}
        </div>
      )}

      {/* Help & Support Modal */}
      {showHelpModal && <HelpModal userEmail={userProfile.email || ""} onClose={() => setShowHelpModal(false)} />}

      {/* Credit Store Modal */}
      {showCreditStore && (
        <CreditStore
          currentCredits={userProfile.credits}
          onClose={() => setShowCreditStore(false)}
        />
      )}

      {/* Order Success Modal */}
      {showOrderSuccessModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-white dark:bg-slate-900 rounded-3xl p-6 max-w-sm w-full text-center shadow-2xl border border-outline-variant/30 text-on-surface">
            <span className="text-5xl animate-bounce mb-4 inline-block">🎉</span>
            <h3 className="text-lg font-extrabold text-primary mb-2">Order Confirmed!</h3>
            <p className="text-xs text-on-surface-variant leading-relaxed mb-4">
              Your payment was confirmed. The order is now being processed; its
              exact amount and status remain available in the order record.
            </p>
            <div className="bg-surface-container rounded-xl p-3 text-[10px] text-on-surface-variant font-mono mb-6 text-left break-all">
              <strong>Session ID:</strong> {successOrderSessionId}
            </div>
            <button
              onClick={() => {
                setShowOrderSuccessModal(false);
                setUserProfile((prev) => ({ ...prev, credits: Math.max(0, prev.credits - 800) }));
              }}
              className="w-full py-3 bg-primary text-white rounded-xl text-xs font-black uppercase shadow-md hover:bg-primary/95 active:scale-95 duration-100 transition-all cursor-pointer"
            >
              Back to Studio
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
