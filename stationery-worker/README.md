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
```

The worker uses signed upload capabilities from the main app, so storage
credentials stay on the main app and are not copied into this container.

Run from the repository with Node 24:

```bash
npm run stationery:worker
```

Expose it through a reverse proxy as `https://stationery.mypets.cc`, then set
`STATIONERY_RENDER_WORKER_URL=https://stationery.mypets.cc/v1/jobs` in the main
application. The worker uploads a private output, registers the asset through
the signed internal callback, and completes the render job with an immutable
manifest.
