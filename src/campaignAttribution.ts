/** Campaign labels only: no cookies, browser storage, click IDs or visitor IDs. */
const CAMPAIGN_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
let campaign = new URLSearchParams();

export function captureCampaign(search: string): URLSearchParams {
  const incoming = new URLSearchParams(search);
  if (incoming.has("utm_source")) {
    campaign = new URLSearchParams();
    for (const key of CAMPAIGN_KEYS) {
      const value = incoming.get(key)?.trim().slice(0, 200);
      if (value) campaign.set(key, value);
    }
  }
  return new URLSearchParams(campaign);
}

/** Carry public campaign labels through full navigation and the Shopify handoff. */
export function withCampaignAttribution(href: string): string {
  if (typeof window === "undefined") return href;
  try {
    const target = new URL(href, window.location.origin);
    const sameOrigin = target.origin === window.location.origin;
    const shopify = target.protocol === "https:" && target.hostname.endsWith(".myshopify.com");
    if ((!sameOrigin && !shopify) || !["http:", "https:"].includes(target.protocol) || target.username || target.password) return href;
    const labels = captureCampaign(window.location.search);
    for (const [key, value] of labels) {
      if (!target.searchParams.has(key)) target.searchParams.set(key, value);
    }
    return href.startsWith("/") && !href.startsWith("//")
      ? `${target.pathname}${target.search}${target.hash}`
      : target.href;
  } catch {
    return href;
  }
}
