# Stationery worker

This is the deterministic render service for Stationery v2. It is separate
from the OpenRouter/Hermes agent. Hermes may be used for orchestration, but it
does not receive the signed render contract or decide asset identity.

Required environment:

```env
STATIONERY_WORKER_PORT=8090
STATIONERY_WORKER_VERSION=1.0.0
STATIONERY_RENDER_WORKER_SECRET=<same secret as the main app>
STATIONERY_CALLBACK_BASE_URL=https://pawsome3d.com
MEDIA_PRIVATE_BUCKET_NAME=...
MEDIA_BUCKET_URL=...
MEDIA_PRIVATE_BUCKET_NAME=...
MEDIA_PRIVATE_BUCKET_KEY=...
MEDIA_PRIVATE_BUCKET_SECRET=...
```

Run from the repository with Node 24:

```bash
npm run stationery:worker
```

Expose it through a reverse proxy as `https://stationery.mypets.cc`, then set
`STATIONERY_RENDER_WORKER_URL=https://stationery.mypets.cc/v1/jobs` in the main
application. The worker uploads a private output, registers the asset through
the signed internal callback, and completes the render job with an immutable
manifest.
