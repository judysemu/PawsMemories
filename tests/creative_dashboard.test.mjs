import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CreativeDashboard } from "../src/components/studio/CreativeDashboard.tsx";

test("creative dashboard keeps one fixed viewport with independently scrollable rails", () => {
  const html = renderToStaticMarkup(React.createElement(CreativeDashboard, {
    title: "Studio",
    subtitle: "One continuous workspace",
    metrics: [{ label: "Stage", value: "Building", tone: "active" }],
    left: React.createElement("div", null, "Controls"),
    center: React.createElement("div", null, "Viewer"),
    right: React.createElement("div", null, "Status"),
    bottom: React.createElement("div", null, "Timeline"),
  }));

  assert.match(html, /data-creative-dashboard="true"/);
  assert.match(html, /h-\[calc\(100dvh-4rem\)\]/);
  assert.match(html, /data-dashboard-region="left"[^>]*overflow-y-auto/);
  assert.match(html, /data-dashboard-region="center"[^>]*overflow-hidden/);
  assert.match(html, /data-dashboard-region="right"[^>]*overflow-y-auto/);
  assert.match(html, /data-dashboard-region="bottom"/);
  assert.match(html, /Stage/);
  assert.match(html, /Building/);
});
