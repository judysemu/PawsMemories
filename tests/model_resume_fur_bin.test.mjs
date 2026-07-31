import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as libraryWorkflows from "../src/components/fur-bin-v5/workflows.ts";
import * as furBinScreenModule from "../src/components/FurBinScreen.tsx";

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("paid and in-progress Pet GLB orders remain reopenable after refresh", async () => {
  const studio = await read("src/components/PetModelStudio.tsx");
  assert.match(studio, /Recent model orders/);
  assert.doesNotMatch(studio, /recentOrders\.filter\(\(item\) => \["approved", "delivered"\]/);
  assert.match(studio, /item\.order\.state\.replaceAll\("_", " "\)/);
  assert.match(studio, /onClick=\{\(\) => selectOrder\(item\)\}/);
});

test("only the newest Fur Bin request may commit after out-of-order responses", async () => {
  assert.equal(typeof libraryWorkflows.createLatestLibraryRequestGate, "function");
  assert.equal(typeof libraryWorkflows.loadLatestLibraryPage, "function");

  const first = deferred();
  const second = deferred();
  const api = {
    searchItems: ({ query }) => query === "first" ? first.promise : second.promise,
  };
  const gate = libraryWorkflows.createLatestLibraryRequestGate();
  const commits = [];
  const sink = {
    start: () => commits.push(["start"]),
    success: (result) => commits.push(["success", result.items[0].title]),
    failure: (error) => commits.push(["failure", error.message]),
    finish: () => commits.push(["finish"]),
  };

  const older = libraryWorkflows.loadLatestLibraryPage(api, { query: "first", page: 1, limit: 40 }, gate, sink);
  const newer = libraryWorkflows.loadLatestLibraryPage(api, { query: "second", page: 1, limit: 40 }, gate, sink);
  second.resolve({ items: [{ title: "newer" }], total: 1, page: 1, limit: 40 });
  await newer;
  first.resolve({ items: [{ title: "older" }], total: 1, page: 1, limit: 40 });
  await older;

  assert.deepEqual(commits, [
    ["start"],
    ["start"],
    ["success", "newer"],
    ["finish"],
  ]);
});

test("Fur Bin pagination reaches beyond 40 items and clamps reduced result pages", () => {
  assert.equal(typeof libraryWorkflows.libraryPageCount, "function");
  assert.equal(typeof libraryWorkflows.clampLibraryPage, "function");
  assert.equal(libraryWorkflows.libraryPageCount(81, 40), 3);
  assert.equal(libraryWorkflows.clampLibraryPage(81, 3, 40), 3);
  assert.equal(libraryWorkflows.clampLibraryPage(12, 3, 40), 1);
});

test("secure Pet GLB download links are bound to the selected order and exact version", async () => {
  const studio = await read("src/components/PetModelStudio.tsx");
  assert.match(studio, /downloadRequestIdRef/);
  assert.match(studio, /activeDownloadIdentityRef/);
  assert.match(studio, /setDownloadUrl\(null\)/);
  assert.match(studio, /body\.versionId === approvedVersionId/);
  assert.match(studio, /requestId === downloadRequestIdRef\.current/);
});

test("legacy creation deduplication suppresses only the matching stable source identity", async () => {
  assert.equal(typeof furBinScreenModule.legacyCreationIsRepresented, "function");
  const creation = { id: 42, media_type: "model" };
  const unrelated = [{ id: 7, source_type: "creation" }];
  const equivalent = [...unrelated, { id: 42, source_type: "creation" }];
  assert.equal(furBinScreenModule.legacyCreationIsRepresented(creation, unrelated), false);
  assert.equal(furBinScreenModule.legacyCreationIsRepresented(creation, equivalent), true);
  const [server, api] = await Promise.all([read("server.ts"), read("src/api.ts")]);
  assert.match(server, /c\.id, 'creation' AS source_type/);
  assert.match(api, /source_type: "creation" \| "avatar" \| "pet_glb_order"/);
});

test("Fur Bin search response returns normalized page and limit evidence", async () => {
  const [service, types, client, experience] = await Promise.all([
    read("server/fur-bin/service.ts"),
    read("src/components/fur-bin-v5/types.ts"),
    read("src/components/fur-bin-v5/client.ts"),
    read("src/components/fur-bin-v5/FurBinV5Experience.tsx"),
  ]);
  assert.match(service, /return \{ items: publicItems, total: result\.total, page, limit \}/);
  assert.match(types, /page: number;\s+limit: number;/);
  assert.match(client, /page: Number\.isSafeInteger\(result\.page\)/);
  assert.match(experience, /libraryRequestGateRef\.current\.invalidate\(\)/);
  assert.match(experience, /aria-label="Previous library page"/);
  assert.match(experience, /aria-label="Next library page"/);
});
