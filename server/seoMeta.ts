/**
 * Server-side per-route metadata injection.
 *
 * Problem this solves: `app.get('*')` served one static `dist/index.html` for
 * every route, so every page shipped `<link rel="canonical" href="https://pawsome3d.com/">`.
 * A canonical is a directive, not a hint — every landing page was telling Google
 * "I'm a duplicate of the homepage, index that instead", which contradicted and
 * overrode the sitemap. `og:url` had the same problem, so social shares all
 * resolved to the homepage too.
 *
 * `src/seo.ts` already sets correct per-screen titles, but only after JS runs.
 * Social scrapers (Facebook, LinkedIn, X, Slack, iMessage, WhatsApp) never run
 * JS, and JS-rendered metadata is a deferred second crawl pass for search.
 *
 * The fix is a string replace on the head before sending. No SSR, no prerender
 * service, no build change. Keep the strings here in sync with `src/seo.ts` so a
 * crawler that *does* render JS doesn't see the title change under it.
 */

export interface PageMeta {
  title: string;
  description: string;
  /** Absolute or root-relative image for OG/Twitter cards. Optional. */
  image?: string;
}

export const PAGE_META: Record<string, PageMeta> = {
  "/": {
    title: "Affordable 3D Pet Models in GLB Format | Pawsome3D",
    description:
      "Shop affordable 3D pet models in GLB format for pet owners and pet-industry professionals. Browse available models and purchase online from Pawsome3D.",
  },
  "/dog-3d-models": {
    title: "Dog 3D Models in GLB Format | Pawsome3D",
    description:
      "Download affordable dog 3D models in GLB format for personal and commercial use. Browse 3D dog models for pet businesses, creators, and dog lovers nationwide.",
  },
  "/cat-3d-models": {
    title: "Cat 3D Models in GLB Format | Pawsome3D",
    description:
      "Explore affordable cat 3D models in GLB format. Download 3D cat models GLB for pet apps, e-commerce, AR, and personalized pet keepsakes.",
  },
  "/pet-professionals": {
    title: "3D Pet Models for Businesses & Pet Industry | Pawsome3D",
    description:
      "High-quality 3D pet models for businesses, groomers, veterinarians, and pet brands. Commercial-use GLB files ready for websites, 3D renderers, and AR.",
  },
  "/glb-pet-models-guide": {
    title: "GLB Pet Model Guide: What Is a GLB File? | Pawsome3D",
    description:
      "Learn what a GLB pet model is, how pet GLB files work, and how to view or use 3D animal models in Blender, Unity, and web apps.",
  },
  "/denver": {
    title: "3D Pet Models in Denver | Pawsome3D",
    description:
      "Affordable 3D pet models in Denver. Serving Denver pet owners, local veterinary clinics, groomers, and pet industry professionals with fast GLB delivery.",
  },
  "/philadelphia": {
    title: "3D Pet Models in Philadelphia | Pawsome3D",
    description:
      "Affordable 3D pet models in Philadelphia. Serving Philly pet owners, local pet brands, groomers, and creative studios with versatile GLB pet models.",
  },
  "/pricing": {
    title: "Affordable Pet 3D Models & Pricing | Pawsome3D",
    description:
      "Transparent 3D pet model pricing for personal and commercial GLB files. Find affordable pet 3D models for owners, businesses, and creators.",
  },
  "/guides": {
    title: "3D Pet Model Guides, Tutorials & Answers | Pawsome3D",
    description:
      "Browse expert guides on GLB pet models, 3D file formats, Blender integration, AR viewing, and commercial 3D animal model usage.",
  },
  "/3d-pet-models": {
    title: "Custom 3D Printed Pet Models | Pawsome3D",
    description:
      "Create a personalized 3D pet model from photos and prepare it for printing as a meaningful keepsake.",
  },
  "/custom-dog-figurines": {
    title: "Custom Dog Figurines from Your Photos | Pawsome3D",
    description:
      "Create a personalized dog figurine with breed, pose, collar, tag, and memorial options.",
  },
  "/pet-memorial-models": {
    title: "Pet Memorial Models and Keepsakes | Pawsome3D",
    description:
      "Honor a beloved companion with a personalized memorial model designed for physical printing.",
  },
  "/how-it-works": {
    title: "How Custom 3D Pet Models Work | Pawsome3D",
    description:
      "Upload photos, personalize the model, check printability, and order your physical pet keepsake.",
  },
  "/print-shop": {
    title: "Print Shop: Custom Pet Keepsakes | Pawsome3D",
    description:
      "Order physical pet keepsakes — printed 3D figurines and Pawprints art — with your own photos. Add a shipping address and check out securely.",
  },
  "/pawprints": {
    title: "Personalized Pawprints Pet Art | Pawsome3D",
    description:
      "Create digital and printable pet keepsakes with your photos, message, and chosen occasion.",
  },
  "/create": {
    title: "Create Your Custom 3D Pet Model | Pawsome3D",
    description:
      "Upload a photo to generate a custom 3D pet model, personalize it, and prepare for printing.",
  },
};

const ORIGIN = (process.env.APP_URL || "https://pawsome3d.com").replace(/\/+$/, "");

/** Escape for safe insertion into an HTML attribute or text node. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Normalize a request path to a metadata key: strip the query string, strip a
 * trailing slash (except for root), and lowercase. `/Pricing/?utm=x` -> `/pricing`.
 */
export function normalizePath(pathname: string): string {
  const withoutQuery = pathname.split("?")[0].split("#")[0];
  const lowered = withoutQuery.toLowerCase();
  if (lowered.length > 1 && lowered.endsWith("/")) {
    return lowered.replace(/\/+$/, "") || "/";
  }
  return lowered || "/";
}

/**
 * Canonical URL for a path. Unknown routes still get a self-referential
 * canonical rather than inheriting the homepage's — that is the whole bug.
 */
export function canonicalFor(pathname: string): string {
  const normalized = normalizePath(pathname);
  return normalized === "/" ? `${ORIGIN}/` : `${ORIGIN}${normalized}`;
}

/**
 * Dynamic metadata resolver for parameterized paths (e.g. /product/shiba-inu-glb, /guides/what-is-a-glb-pet-model)
 */
function resolveDynamicMeta(pathname: string): PageMeta | null {
  if (pathname.startsWith("/product/")) {
    const slug = pathname.replace("/product/", "").replace(/-/g, " ");
    const titleCase = slug.replace(/\b\w/g, (l) => l.toUpperCase());
    return {
      title: `${titleCase} GLB 3D Pet Model | Pawsome3D`,
      description: `Buy and download the ${titleCase} 3D pet model in GLB format. Includes 4K PBR textures, AR preview, instant download, and commercial license options.`,
      image: "/brand/furball3d.jpg"
    };
  }
  if (pathname.startsWith("/guides/")) {
    const slug = pathname.replace("/guides/", "").replace(/-/g, " ");
    const titleCase = slug.replace(/\b\w/g, (l) => l.toUpperCase());
    return {
      title: `${titleCase} | Pawsome3D Guide`,
      description: `Comprehensive guide and answers on ${titleCase} for pet owners, 3D creators, and pet industry businesses.`,
      image: "/brand/furball3d.jpg"
    };
  }
  return null;
}

/**
 * Rewrite title, description, OG and Twitter tags, canonical link, and JSON-LD.
 */
export function injectMeta(html: string, pathname: string): string {
  const normalized = normalizePath(pathname);
  const url = canonicalFor(normalized);
  const meta = PAGE_META[normalized] || resolveDynamicMeta(normalized);

  // Always fix the canonical and og:url, even for routes without specific page copy.
  let out = html
    .replace(/(<link\s+rel="canonical"\s+href=")[^"]*(")/i, `$1${esc(url)}$2`)
    .replace(/(<meta\s+property="og:url"\s+content=")[^"]*(")/i, `$1${esc(url)}$2`);

  // Sitewide Organization Structured Data
  const orgJsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "Pawsome3D",
    "url": ORIGIN,
    "logo": `${ORIGIN}/brand/furball3d.jpg`,
    "description": "Pawsome3D provides affordable 3D pet models in GLB format for pet owners and pet-industry professionals across the United States.",
    "sameAs": [
      "https://facebook.com/pawsome3d",
      "https://instagram.com/pawsome3d"
    ]
  };

  const orgScript = `<script type="application/ld+json" id="schema-org">${JSON.stringify(orgJsonLd)}</script>`;
  if (!out.includes('id="schema-org"')) {
    out = out.replace("</head>", `${orgScript}\n</head>`);
  }

  // Product Structured Data for Product pages
  if (normalized.startsWith("/product/")) {
    const slug = normalized.replace("/product/", "").replace(/-/g, " ");
    const titleCase = slug.replace(/\b\w/g, (l) => l.toUpperCase());
    const productJsonLd = {
      "@context": "https://schema.org",
      "@type": "Product",
      "name": `${titleCase} GLB 3D Pet Model`,
      "image": `${ORIGIN}/featured-models/shiba-inu.webp`,
      "description": `High quality 3D pet model of ${titleCase} in binary glTF (.GLB) format. Fully textured and ready for WebGL, AR, Blender, and 3D printing.`,
      "sku": `P3D-${slug.toUpperCase().replace(/\s+/g, "-")}`,
      "brand": {
        "@type": "Brand",
        "name": "Pawsome3D"
      },
      "offers": {
        "@type": "Offer",
        "url": url,
        "priceCurrency": "USD",
        "price": "19.00",
        "availability": "https://schema.org/InStock",
        "itemCondition": "https://schema.org/NewCondition"
      }
    };
    const productScript = `<script type="application/ld+json" id="schema-product">${JSON.stringify(productJsonLd)}</script>`;
    if (!out.includes('id="schema-product"')) {
      out = out.replace("</head>", `${productScript}\n</head>`);
    }
  }

  if (!meta) return out;

  const title = esc(meta.title);
  const description = esc(meta.description);

  out = out
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`)
    .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/i, `$1${description}$2`)
    .replace(/(<meta\s+property="og:title"\s+content=")[^"]*(")/i, `$1${title}$2`)
    .replace(/(<meta\s+property="og:description"\s+content=")[^"]*(")/i, `$1${description}$2`)
    .replace(/(<meta\s+name="twitter:title"\s+content=")[^"]*(")/i, `$1${title}$2`)
    .replace(/(<meta\s+name="twitter:description"\s+content=")[^"]*(")/i, `$1${description}$2`);

  if (meta.image) {
    const image = esc(meta.image.startsWith("http") ? meta.image : `${ORIGIN}${meta.image}`);
    out = out
      .replace(/(<meta\s+property="og:image"\s+content=")[^"]*(")/i, `$1${image}$2`)
      .replace(/(<meta\s+name="twitter:image"\s+content=")[^"]*(")/i, `$1${image}$2`);
  }

  return out;
}
