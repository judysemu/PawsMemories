import { Screen } from "./types";

const BRAND = "Pawsome3D";

const PUBLIC_METADATA: Partial<Record<Screen, { title: string; desc: string }>> = {
  [Screen.DASHBOARD]: {
    title: `Affordable 3D Pet Models in GLB Format | ${BRAND}`,
    desc: "Shop affordable 3D pet models in GLB format for pet owners and pet-industry professionals. Browse available models and purchase online from Pawsome3D."
  },
  [Screen.LANDING_DOGS]: {
    title: `Dog 3D Models in GLB Format | ${BRAND}`,
    desc: "Download affordable dog 3D models in GLB format for personal and commercial use. Browse 3D dog models for pet businesses, creators, and dog lovers nationwide."
  },
  [Screen.LANDING_CATS]: {
    title: `Cat 3D Models in GLB Format | ${BRAND}`,
    desc: "Explore affordable cat 3D models in GLB format. Download 3D cat models GLB for pet apps, e-commerce, AR, and personalized pet keepsakes."
  },
  [Screen.LANDING_PROFESSIONALS]: {
    title: `3D Pet Models for Businesses & Pet Industry | ${BRAND}`,
    desc: "High-quality 3D pet models for businesses, groomers, veterinarians, and pet brands. Commercial-use GLB files ready for websites, 3D renderers, and AR."
  },
  [Screen.LANDING_GLB_GUIDE]: {
    title: `GLB Pet Model Guide: What Is a GLB File? | ${BRAND}`,
    desc: "Learn what a GLB pet model is, how pet GLB files work, and how to view or use 3D animal models in Blender, Unity, and web apps."
  },
  [Screen.LANDING_DENVER]: {
    title: `3D Pet Models in Denver | ${BRAND}`,
    desc: "Affordable 3D pet models in Denver. Serving Denver pet owners, local veterinary clinics, groomers, and pet industry professionals with fast GLB delivery."
  },
  [Screen.LANDING_PHILADELPHIA]: {
    title: `3D Pet Models in Philadelphia | ${BRAND}`,
    desc: "Affordable 3D pet models in Philadelphia. Serving Philly pet owners, local pet brands, groomers, and creative studios with versatile GLB pet models."
  },
  [Screen.PRICING]: {
    title: `Affordable Pet 3D Models & Pricing | ${BRAND}`,
    desc: "Transparent 3D pet model pricing for personal and commercial GLB files. Find affordable pet 3D models for owners, businesses, and creators."
  },
  [Screen.GUIDES_HUB]: {
    title: `3D Pet Model Guides, Tutorials & Answers | ${BRAND}`,
    desc: "Browse expert guides on GLB pet models, 3D file formats, Blender integration, AR viewing, and commercial 3D animal model usage."
  },
  [Screen.PRODUCT_VIEW]: {
    title: `GLB 3D Pet Model | ${BRAND}`,
    desc: "Download high quality 3D pet models in binary glTF (.GLB) format. Fully textured and ready for WebGL, AR, Blender, and 3D printing."
  },
  [Screen.LANDING_MODELS]: {
    title: `Custom 3D Printed Pet Models | ${BRAND}`,
    desc: "Create a personalized 3D pet model from photos and prepare it for printing as a meaningful keepsake."
  },
  [Screen.LANDING_MEMORIALS]: {
    title: `Pet Memorial Models and Keepsakes | ${BRAND}`,
    desc: "Honor a beloved companion with a personalized memorial model designed for physical printing."
  },
  [Screen.PAWPRINTS]: {
    title: `Personalized Pawprints Pet Art | ${BRAND}`,
    desc: "Create digital and printable pet keepsakes with your photos, message, and chosen occasion."
  },
  [Screen.HOW_IT_WORKS]: {
    title: `How Custom 3D Pet Models Work | ${BRAND}`,
    desc: "Upload photos, personalize the model, check printability, and order your physical pet keepsake."
  },
  [Screen.CREATE]: {
    title: `Create Your Custom 3D Pet Model | ${BRAND}`,
    desc: "Upload a photo to generate a custom 3D pet model, personalize it, and prepare for printing."
  },
  [Screen.SIGN_UP]: {
    title: `Sign Up or Log In | ${BRAND}`,
    desc: "Create a Pawsome3D account or log in to build and order personalized pet models."
  },
  [Screen.PRINT_SHOP]: {
    title: `Print Shop: Custom Pet Keepsakes | ${BRAND}`,
    desc: "Order physical pet keepsakes — printed 3D figurines and Pawprints art — with your own photos. Add a shipping address and check out securely."
  }
};

const PRIVATE_TITLES: Partial<Record<Screen, string>> = {
  [Screen.MODELS]: "Furball3D Model Builder",
  [Screen.ANIMATOR]: "Fur Reels - AI Pet Videos",
  [Screen.PAWLISHER]: "Fido's Styles",
  [Screen.FURBIN]: "Fur Bin",
  [Screen.ALBUMS]: "My Albums",
  [Screen.PROFILE]: "Profile",
  [Screen.STORE]: "Store",
  [Screen.VOICE_TEST]: "Voice and Lip-Sync Test",
  [Screen.BIM]: "Scaled BIM Preview",
  [Screen.COMMUNITY]: "Community",
};

function upsertMeta(selector: string, attributes: Record<string, string>) {
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    element = document.createElement("meta");
    document.head.appendChild(element);
  }
  Object.entries(attributes).forEach(([name, value]) => element!.setAttribute(name, value));
}

function upsertCanonical(href: string) {
  let element = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!element) {
    element = document.createElement("link");
    element.rel = "canonical";
    document.head.appendChild(element);
  }
  element.href = href;
}

function upsertJsonLd(id: string, data: any | null) {
  let element = document.head.querySelector<HTMLScriptElement>(`script#${id}`);
  if (!data) {
    if (element) element.remove();
    return;
  }
  if (!element) {
    element = document.createElement("script");
    element.id = id;
    element.type = "application/ld+json";
    document.head.appendChild(element);
  }
  element.textContent = JSON.stringify(data);
}

/** Keeps crawl metadata consistent with this client-routed application. */
export function syncSeoMetadata(screen: Screen, isAuthenticated: boolean) {
  const publicMeta = PUBLIC_METADATA[screen];
  const isPublicPage = !!publicMeta;
  
  const title = isPublicPage ? publicMeta.title : `${PRIVATE_TITLES[screen] || "Pawsome3D"} | ${BRAND}`;
  const description = isPublicPage
    ? publicMeta.desc
    : "Private Pawsome3D studio workspace.";
  const canonical = `${window.location.origin}${window.location.pathname}`;
  const robots = isPublicPage
    ? "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1"
    : "noindex,nofollow,noarchive";

  document.title = title;
  upsertMeta('meta[name="description"]', { name: "description", content: description });
  upsertMeta('meta[name="robots"]', { name: "robots", content: robots });
  upsertMeta('meta[property="og:title"]', { property: "og:title", content: title });
  upsertMeta('meta[property="og:description"]', { property: "og:description", content: description });
  upsertMeta('meta[name="twitter:title"]', { name: "twitter:title", content: title });
  upsertMeta('meta[name="twitter:description"]', { name: "twitter:description", content: description });
  
  // Ensure we add a placeholder image for public pages if required (can be generic for now)
  if (isPublicPage) {
    upsertMeta('meta[property="og:image"]', { property: "og:image", content: `${window.location.origin}/MAIN4.jpg` });
    upsertMeta('meta[name="twitter:card"]', { name: "twitter:card", content: "summary_large_image" });
  }

  upsertCanonical(canonical);

  // Structured Data
  if (screen === Screen.DASHBOARD) {
    upsertJsonLd("schema-org", {
      "@context": "https://schema.org",
      "@type": "Organization",
      "name": "Pawsome3D",
      "url": "https://pawsome3d.com",
      "logo": "https://pawsome3d.com/brand/pawsome-logo.png"
    });
    upsertJsonLd("schema-website", {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": "Pawsome3D",
      "url": "https://pawsome3d.com"
    });
  } else {
    upsertJsonLd("schema-org", null);
    upsertJsonLd("schema-website", null);
  }
}
