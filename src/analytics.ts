/**
 * Client-side page-view beacon.
 *
 * The app is a single-page application: the server sees one HTML request and
 * every subsequent route change happens in the browser. Server access logs
 * therefore cannot tell /barkley from /pawprints, which is why this exists at
 * all rather than being read off the host.
 *
 * It sends the path, the referrer, and any UTM tags. It does not send, store,
 * or generate an identifier of any kind — no cookie, no localStorage id, no
 * fingerprint. There is deliberately no notion of a "session" or a "returning
 * visitor" here, because building one means identifying people.
 */

import { captureCampaign } from "./campaignAttribution";

const ENDPOINT = "/api/analytics/pageview";

/**
 * UTM tags survive the first navigation.
 *
 * Someone arriving from an X post lands on /barkley?utm_source=x, then clicks
 * through to /pricing with no tags on the URL. Without carrying them, the
 * campaign appears to bounce every single time and the page that actually
 * converted looks like direct traffic. Held in memory only, so it lasts the
 * visit and vanishes with the tab.
 */
let campaign: { source?: string; medium?: string; campaign?: string } | null = null;

function readCampaign(search: string): void {
  const params = new URLSearchParams(search);
  const source = params.get("utm_source");
  if (!source) return;
  campaign = {
    source,
    medium: params.get("utm_medium") ?? undefined,
    campaign: params.get("utm_campaign") ?? undefined,
  };
}

/**
 * Record the current page.
 *
 * Failures are swallowed. Analytics must never surface an error to a visitor
 * or block a render — a missing row is a rounding error, a broken page is not.
 */
export function trackPageView(path?: string): void {
  if (typeof window === "undefined") return;

  try {
    const retainedLabels = captureCampaign(window.location.search);
    readCampaign(retainedLabels.toString());

    const body = JSON.stringify({
      path: path ?? window.location.pathname,
      // Only sent on the first view of a visit; afterwards document.referrer
      // still holds the original external referrer, which would double-count.
      referrer: document.referrer || null,
      utmSource: campaign?.source ?? null,
      utmMedium: campaign?.medium ?? null,
      utmCampaign: campaign?.campaign ?? null,
    });

    // sendBeacon survives the page being closed mid-navigation, which a fetch
    // does not. It is also fire-and-forget, so nothing awaits it.
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Never let instrumentation break a page.
  }
}
