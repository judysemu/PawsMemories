import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../server/ai-video/finish.ts", import.meta.url), "utf8");

// These are source-shape assertions rather than behavioural ones because
// pollAndFinishFalVideoJob reaches straight into the pool, storage and the SMS
// carrier. What matters here is the ORDER of the steps and which of them sit
// inside the failing try — that ordering is the bug, and it is visible in the
// source without standing up four fakes.

const upload = source.indexOf("uploadBinaryFromUrl(");
const failCallsBeforeMark = source.slice(0, source.indexOf("markGenerationJobDoneOnce("))
  .split("failGenerationJobAndRefundOnce(").length - 1;
const markDone = source.indexOf("markGenerationJobDoneOnce(");
const attach = source.indexOf("setCreationVideoUrl(");
const sms = source.indexOf("sendSms(");

test("the fail-and-refund path is reachable only before the job is marked done", () => {
  // Refunding after markGenerationJobDoneOnce means reversing a paid, delivered
  // result — the customer keeps a playable video and gets their money back
  // while the job claims it failed.
  const afterMark = source.slice(markDone + 1);
  const refundAfterMark = afterMark.indexOf("failGenerationJobAndRefundOnce(");
  assert.equal(refundAfterMark, -1, "nothing after markGenerationJobDoneOnce may refund the job");
  assert.ok(failCallsBeforeMark >= 3, "generation, poll and upload failures must still refund");
});

test("sendSms cannot fail a finished video", () => {
  assert.ok(sms > markDone, "the notification must come after the job is settled");
  // It must be individually guarded, not merely late: a throw anywhere after
  // markGenerationJobDoneOnce would otherwise escape to the caller.
  const tail = source.slice(sms - 400, sms + 400);
  assert.match(tail, /try\s*\{/, "sendSms must sit in its own try");
  assert.match(tail, /catch/, "an SMS failure must be caught and logged, not thrown");
});

test("the upload happens before the job is marked done", () => {
  // Marking done first would leave a job claiming success with nothing stored.
  assert.ok(upload < markDone, "upload must precede markGenerationJobDoneOnce");
});

test("a creation that could not be attached is reported, not swallowed", () => {
  const afterAttach = source.slice(attach, attach + 700);
  assert.match(afterAttach, /ORPHANED VIDEO/, "a failed attach must be logged loudly enough to find later");
  assert.match(afterAttach, /url=/, "the log must carry the object URL so the orphan is recoverable");
});

test("losing the finalize race still returns a playable URL", () => {
  const raceBlock = source.slice(markDone, markDone + 600);
  assert.match(raceBlock, /getCreationVideoUrl\(/, "the loser must read back the settled URL");
  assert.match(raceBlock, /status: "done", videoUrl: settled/, "and return it as done rather than empty");
});

test("already_finalized remains available when there is genuinely no URL", () => {
  assert.match(source, /status: "already_finalized"/);
});
