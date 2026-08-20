# Bug sweep — video generation

Swept 2026-08-20 against production data and a live end-to-end trace.

## The pipeline is healthy right now

Job 47 was traced the whole way and every stage is correct:

| Stage | State |
| --- | --- |
| `generation_jobs` id=47 | `status=done`, not refunded |
| Upload to Backblaze | `videos/1787187567243-…mp4`, 28.9 MB |
| `creations.video_url` (id 58) | set to the S3 virtual-host URL |
| `creations.media_type` | `video` |
| Public fetch of that URL | HTTP 206, `content-type: video/mp4`, range requests supported |

Range support matters: without it a `<video>` element cannot seek, and a 28.9 MB
file would have to buffer fully before playing.

So there is no defect in *this* run. The bugs below are latent — they do not
fire every time, which is precisely why they are worth writing down.

## 1. A notification failure destroys a successful job

`server/ai-video/finish.ts` runs the whole success path inside one `try`:

```ts
const videoUrl = await uploadBinaryFromUrl(...);
if (!await markGenerationJobDoneOnce(getPool(), job.id)) return { status: "already_finalized" };
if (job.creation_id) await setCreationVideoUrl(job.creation_id, job.user_phone, videoUrl);
await sendSms(job.user_phone, `🐾 … Your pet video animation is ready! …`);
return { status: "done", videoUrl };
} catch (err) {
  await failGenerationJobAndRefundOnce(getPool(), job.id, message);   // ← also catches sendSms
  return { status: "failed", error: message };
}
```

If `sendSms` throws — carrier outage, unroutable number, expired Plivo/Telnyx
credential — the job has *already* been marked done and the creation has
*already* been given its URL. The catch then marks the same job failed and
issues a refund.

The result is a customer who has a finished, playable video attached to their
creation, a job row saying it failed, and a refund they were not owed. The video
is real; the accounting is not.

**This is the highest-severity finding.** It is invisible while SMS is healthy,
and it fires for everyone the moment SMS is not.

## 2. A misattributed creation loses its video silently

`setCreationVideoUrl` returns a boolean:

```ts
const [result] = await getPool().query(
  `UPDATE creations SET video_url = ?, media_type = 'video' WHERE id = ? AND user_phone = ?`, …);
return result.affectedRows === 1;
```

`finish.ts` ignores it. If the `creation_id`/`user_phone` pair does not match —
a reassigned creation, a phone change, a job whose creation was deleted — the
UPDATE affects zero rows, the function returns `false`, and nothing notices.

The video is uploaded, billed, and marked done, and no creation ever points at
it. It becomes an orphan in the bucket that the customer cannot reach and
nobody knows exists.

## 3. A racing poller returns no URL

Two pollers can finish the same job — the client-driven poll route and the
background sweep both call `pollAndFinishFalVideoJob`. The loser gets:

```ts
if (!await markGenerationJobDoneOnce(getPool(), job.id)) {
  return { status: "already_finalized" };
}
```

`already_finalized` carries no `videoUrl`. A client that happens to lose the
race is told the job is finished but is handed nothing to play, even though the
URL is sitting in the creation row.

## 4. Historical failures, no money impact

Seven video jobs are `failed`. The two most recent (45, 46) died with
`MuAPI poll failed (404): {"detail":"Request ID not found"}` — the stale
Passenger worker incident, already fixed by stamping `tmp/restart.txt` into
every archive.

Checked for a money bug and there is none: both carry `credits_reserved=0`, so
no refund was owed and none was missed.

## Recommended repair spec

**R1 — Move notification outside the success path.** `sendSms` must not be able
to fail a job that has already succeeded. Send it after the outcome is
committed, with its own catch, and treat a delivery failure as a log line. A
customer not receiving a text is a minor annoyance; a customer's finished video
being marked failed and refunded is a data-integrity fault.

**R2 — Honour `setCreationVideoUrl`'s return value.** A `false` means the video
has no home. Log it with the job id, creation id and object key so the orphan is
recoverable, and do not report `done` as though the customer can see it.

**R3 — Return the URL on `already_finalized`.** Read the creation's `video_url`
and hand it back, so whichever poller loses the race still gives the client
something to display.

**R4 — Keep the fail path narrow.** Only errors from generation and upload
should trigger `failGenerationJobAndRefundOnce`. Everything after
`markGenerationJobDoneOnce` is post-success bookkeeping and must degrade, never
reverse the outcome.

### Backup / follow-up actions

1. **Sweep the bucket for orphans.** List `videos/` in `pawsmemories-media` and
   diff against `creations.video_url`. Anything unreferenced is a video that was
   generated and paid for and never delivered — the symptom R2 prevents going
   forward but does not cure retroactively.
2. **Add a delivery check to the runtime-log routine.** A job reaching `done`
   whose creation has a null `video_url` is a contradiction that should be
   alerted on, not discovered by a customer.
3. **If SMS keeps failing, drop it from this path entirely.** The video appears
   in the album regardless; the text is a courtesy. Coupling a courtesy to a
   refund decision is the actual defect, and removing the coupling is cheaper
   than making SMS reliable.
4. **Watch file size.** 28.9 MB for one clip is heavy for mobile playback and
   for egress. If clips trend upward, add a transcode step before upload rather
   than after customers start complaining about buffering.
