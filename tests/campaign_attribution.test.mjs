import assert from "node:assert/strict";
import { test } from "node:test";
import { captureCampaign, withCampaignAttribution } from "../src/campaignAttribution.ts";
import { laborDayDiscountUrl } from "../src/components/Store.tsx";

test("campaign labels survive navigation without collecting click or visitor IDs", () => {
  globalThis.window = { location: { origin: "https://pawsome3d.com", search: "?utm_source=google&utm_medium=cpc&utm_campaign=labor_day&utm_content=shop&gclid=private-click" } };
  try {
    const signup = withCampaignAttribution("/sign-up");
    assert.match(signup, /utm_campaign=labor_day/);
    assert.doesNotMatch(signup, /gclid/);
    window.location.search = "";
    assert.match(withCampaignAttribution("/pricing"), /utm_source=google/);
    const discount = new URL(laborDayDiscountUrl("https://pawprints-by-pawsome3d.myshopify.com/products/example?variant=123"));
    const destination = new URL(discount.searchParams.get("redirect"), discount.origin);
    assert.equal(destination.searchParams.get("variant"), "123");
    assert.equal(destination.searchParams.get("utm_content"), "shop");
    assert.equal(destination.searchParams.has("gclid"), false);
    assert.equal(withCampaignAttribution("https://example.com/product"), "https://example.com/product");
    assert.equal(withCampaignAttribution("https://shop.myshopify.com.evil.test/product"), "https://shop.myshopify.com.evil.test/product");
    assert.equal(withCampaignAttribution("javascript:alert(1)"), "javascript:alert(1)");
    assert.equal(new URL(withCampaignAttribution("https://pawsome3d.com/store?utm_source=manual")).searchParams.get("utm_source"), "manual");
    captureCampaign("?utm_source=email&utm_campaign=second");
    assert.equal(captureCampaign("").has("utm_content"), false);
  } finally {
    delete globalThis.window;
    captureCampaign("?utm_source=");
  }
});
