import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../server.ts", import.meta.url), "utf8");

test("production SPA serves the homepage explicitly before the wildcard route", () => {
  const explicitHome = serverSource.indexOf('app.get("/", serveSpaShell)');
  const wildcard = serverSource.indexOf('app.get("*", serveSpaShell)');
  assert.ok(explicitHome >= 0, "explicit production homepage route is required");
  assert.ok(wildcard > explicitHome, "homepage route must be registered before the wildcard");
});
