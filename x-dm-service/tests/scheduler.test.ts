/**
 * Tests for the scheduled-post endpoint.
 *
 * This route can publish to a public timeline, so the properties that matter
 * are about refusing to: no credential, no post; wrong credential, no post;
 * and a decided "no" must not look like a failure a scheduler should retry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const query = vi.fn();
vi.mock('../src/db.js', () => ({ getPool: () => ({ query }) }));

const publishPost = vi.fn();
vi.mock('../src/poster.js', () => ({ publishPost }));

const { createSchedulerRouter } = await import('../src/routes/scheduler.js');

const SECRET = 'scheduler-fixture-secret-value'; // gitleaks:allow - immutable test fixture

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use('/admin', createSchedulerRouter());
  return a;
}

beforeEach(() => {
  query.mockReset().mockResolvedValue([[], []]);
  publishPost.mockReset().mockResolvedValue({ status: 'posted', tweetId: '1', dedupeKey: 'k' });
  process.env.X_POST_SCHEDULER_SECRET = SECRET;
});

describe('authorization', () => {
  it('refuses when no secret is configured, rather than running open', async () => {
    // An endpoint that publishes to a public timeline must never be reachable
    // without a credential — including when the operator forgot to set one.
    delete process.env.X_POST_SCHEDULER_SECRET;
    const res = await request(app()).post('/admin/post').send({});
    expect(res.status).toBe(503);
    expect(publishPost).not.toHaveBeenCalled();
  });

  it('rejects a missing bearer', async () => {
    const res = await request(app()).post('/admin/post').send({});
    expect(res.status).toBe(401);
    expect(publishPost).not.toHaveBeenCalled();
  });

  it('rejects a wrong bearer', async () => {
    const res = await request(app())
      .post('/admin/post')
      .set('Authorization', 'Bearer not-the-secret')
      .send({});
    expect(res.status).toBe(401);
    expect(publishPost).not.toHaveBeenCalled();
  });

  it('rejects a secret passed without the Bearer prefix', async () => {
    const res = await request(app()).post('/admin/post').set('Authorization', SECRET).send({});
    expect(res.status).toBe(401);
  });

  it('rejects a prefix of the real secret', async () => {
    // Length is compared before the byte loop, so a shorter guess cannot pass.
    const res = await request(app())
      .post('/admin/post')
      .set('Authorization', `Bearer ${SECRET.slice(0, 10)}`)
      .send({});
    expect(res.status).toBe(401);
  });

  it('accepts the correct bearer', async () => {
    const res = await request(app())
      .post('/admin/post')
      .set('Authorization', `Bearer ${SECRET}`)
      .send({});
    expect(res.status).toBe(200);
    expect(publishPost).toHaveBeenCalledOnce();
  });
});

describe('behaviour', () => {
  const auth = { Authorization: `Bearer ${SECRET}` };

  it('rejects an unknown campaign and names the known ones', async () => {
    const res = await request(app()).post('/admin/post').set(auth).send({ campaign: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.known).toContain('barkley');
    expect(publishPost).not.toHaveBeenCalled();
  });

  it('defaults to the barkley campaign', async () => {
    await request(app()).post('/admin/post').set(auth).send({});
    expect(publishPost.mock.calls[0][0].campaign).toBe('barkley');
  });

  it('answers 200 for a skipped post, so a scheduler does not retry', async () => {
    // A non-2xx makes a scheduler retry, and retrying a cadence hold is the
    // exact burst the hold exists to prevent.
    publishPost.mockResolvedValue({ status: 'skipped', reason: 'cadence floor', dedupeKey: 'k' });
    const res = await request(app()).post('/admin/post').set(auth).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('skipped');
    expect(res.body.reason).toMatch(/cadence/);
  });

  it('answers 200 for a failed post but reports the reason', async () => {
    publishPost.mockResolvedValue({ status: 'failed', reason: 'X rejected the post (403)', dedupeKey: 'k' });
    const res = await request(app()).post('/admin/post').set(auth).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.reason).toMatch(/403/);
  });

  it('reports rotation state so exhaustion is visible', async () => {
    const res = await request(app()).post('/admin/post').set(auth).send({});
    expect(res.body).toHaveProperty('variantsExhausted');
    expect(res.body.variantCount).toBeGreaterThan(1);
  });

  it('passes the campaign target so the card renders', async () => {
    await request(app()).post('/admin/post').set(auth).send({});
    expect(publishPost.mock.calls[0][0].targetUrl).toMatch(/pawsome3d\.com\/barkley/);
  });

  it('surfaces a database failure as 500 rather than a silent success', async () => {
    query.mockRejectedValue(new Error('connection lost'));
    const res = await request(app()).post('/admin/post').set(auth).send({});
    expect(res.status).toBe(500);
  });
});

describe('status endpoint', () => {
  it('requires the same credential', async () => {
    const res = await request(app()).get('/admin/post/status');
    expect(res.status).toBe(401);
  });

  it('reports whether posting is enabled and what campaigns exist', async () => {
    process.env.X_POSTING_ENABLED = 'true';
    const res = await request(app())
      .get('/admin/post/status')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.postingEnabled).toBe(true);
    expect(res.body.campaigns).toContain('barkley');
  });
});
