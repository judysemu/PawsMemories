import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Fur Bin is a private pet library without showcase or Keep/Toss decisions", () => {
  const experience = read("src/components/fur-bin-v5/FurBinV5Experience.tsx");
  assert.doesNotMatch(experience, /Canonical model library/i);
  assert.doesNotMatch(experience, /Public showcase/i);
  assert.doesNotMatch(experience, /Keep it|Toss it/i);
  assert.match(experience, /Retry full build/);
  assert.match(experience, /Delete/);
  assert.match(experience, /PetModelViewer/);
});

test("delete is soft-tracked and offers an optional defect message to admin", () => {
  const repository = read("server/fur-bin/repository.ts");
  const service = read("server/fur-bin/service.ts");
  const routes = read("server/fur-bin/routes.ts");
  const server = read("server.ts");
  assert.match(repository, /SET status = 'deleted'/);
  assert.match(service, /submitDefectReport/);
  assert.match(service, /context_json/);
  assert.match(routes, /\/items\/:uuid\/defect-report/);
  assert.match(server, /fbi\.status != 'deleted'/);
  assert.doesNotMatch(`${service}\n${routes}`, /auto.?refund/i);
});

test("the customer model flow gates exact artifacts and retries rejected stages at full price", () => {
  const studio = read("src/components/PetModelStudio.tsx");
  const service = read("server/pet-generation/service.ts");
  assert.match(studio, /stage\.state === "awaiting_customer_approval"/);
  assert.match(studio, /artifactSha256: stage\.artifactSha256/);
  assert.match(service, /must not manufacture customer approval or queue another charge/);
  assert.doesNotMatch(studio, /first.*retry free|second.*retry free/i);
  assert.match(service, /const retryPrice = stagePrice\(current\.stage\)/);
});

test("Fur Reels uses the supplied transparent icon and Fur Bin follows it", () => {
  const shell = read("src/shellNavigation.ts");
  const app = read("src/App.tsx");
  assert.match(shell, /fur-reels-icon\.png/);
  assert.match(app, /item\.imageSrc/);
  assert.match(app, /item\.imageSrc[\s\S]*?h-5 w-5/);
  assert.ok(shell.indexOf('id: "animate"') < shell.indexOf('id: "fur-bin"'));
});
