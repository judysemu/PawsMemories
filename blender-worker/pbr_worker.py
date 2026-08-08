"""
blender-worker/pbr_worker.py — Self-hosted PBR material generation worker

Replaces the fal.ai PATINA endpoint with an open-source PBR diffusion model
running on Azure Container Apps (Consumption-GPU-NC24-A100).

Exposes the same queue protocol that server/pbr/falPbr.ts already speaks.
"""

import hashlib
import io
import os
import time
import uuid
from enum import Enum
from threading import Lock, Thread
from typing import Any

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from PIL import Image

# ── Configuration ────────────────────────────────────────────────────────────

WORKER_SECRET = os.environ.get("WORKER_SECRET", "")
PORT = int(os.environ.get("PORT", "8080"))
MODEL_ID = os.environ.get(
    "PBR_MODEL_ID", "gvecchio/MatSynth"
)

# ── State ────────────────────────────────────────────────────────────────────


class JobStatus(str, Enum):
    IN_QUEUE = "IN_QUEUE"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


jobs: dict[str, dict[str, Any]] = {}
jobs_lock = Lock()

# ── Lazy model loading ───────────────────────────────────────────────────────

_pipeline = None
_pipeline_lock = Lock()


def get_pipeline():
    """Lazy-load the PBR diffusion pipeline on first request."""
    global _pipeline
    if _pipeline is not None:
        return _pipeline
    with _pipeline_lock:
        if _pipeline is not None:
            return _pipeline
        try:
            import torch
            from diffusers import StableDiffusionXLPipeline

            print(f"Loading PBR model: {MODEL_ID}", flush=True)
            device = "cuda" if torch.cuda.is_available() else "cpu"
            dtype = torch.float16 if device == "cuda" else torch.float32
            pipe = StableDiffusionXLPipeline.from_pretrained(
                MODEL_ID,
                torch_dtype=dtype,
                use_safetensors=True,
            )
            pipe = pipe.to(device)
            if device == "cuda":
                pipe.enable_model_cpu_offload()
            _pipeline = pipe
            print(f"PBR model loaded on {device}", flush=True)
        except Exception as e:
            print(f"Failed to load PBR model: {e}", flush=True)
            _pipeline = "FAILED"
            raise
    return _pipeline


# ── PBR generation worker ────────────────────────────────────────────────────


def generate_pbr_maps(
    job_id: str,
    prompt: str,
    seed: int,
    maps: list[str],
    width: int,
    height: int,
):
    """Background thread: generate PBR maps and store results."""
    try:
        with jobs_lock:
            jobs[job_id]["status"] = JobStatus.IN_PROGRESS

        import torch

        pipe = get_pipeline()
        if pipe == "FAILED":
            raise RuntimeError("PBR model failed to load")

        generator = torch.Generator().manual_seed(seed)
        device = "cuda" if torch.cuda.is_available() else "cpu"

        # Map-type suffixes for the PBR prompt engineering
        map_suffixes = {
            "basecolor": ", base color map, albedo, diffuse texture",
            "normal": ", normal map, bump map, surface detail",
            "roughness": ", roughness map, specular map, surface roughness",
            "metalness": ", metallic map, metalness, metal texture",
        }

        generated_images: list[dict[str, Any]] = []

        for map_type in maps:
            suffix = map_suffixes.get(map_type, "")
            full_prompt = f"{prompt}{suffix}, seamless tileable PBR texture, 4K quality"

            result = pipe(
                prompt=full_prompt,
                width=width,
                height=height,
                num_inference_steps=8,
                generator=generator,
                guidance_scale=7.5,
            )

            img: Image.Image = result.images[0]
            if img.size != (width, height):
                img = img.resize((width, height), Image.LANCZOS)

            # Store as PNG bytes
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            png_bytes = buf.getvalue()

            generated_images.append(
                {
                    "map_type": map_type,
                    "content_type": "image/png",
                    "bytes": png_bytes,
                }
            )

        with jobs_lock:
            jobs[job_id]["status"] = JobStatus.COMPLETED
            jobs[job_id]["result"] = {
                "images": generated_images,
                "seed": seed,
                "prompt": prompt,
            }

    except Exception as exc:
        with jobs_lock:
            jobs[job_id]["status"] = JobStatus.FAILED
            jobs[job_id]["error"] = str(exc)


# ── FastAPI app ──────────────────────────────────────────────────────────────

app = FastAPI(title="Paws PBR Worker", docs_url=None, redoc_url=None)


def check_secret(x_worker_secret: str = Header("")):
    if WORKER_SECRET and x_worker_secret != WORKER_SECRET:
        raise HTTPException(status_code=403, detail="Invalid worker secret")


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL_ID}


@app.post("/queue/submit")
async def queue_submit(request: Request, x_worker_secret: str = Header("")):
    check_secret(x_worker_secret)
    body = await request.json()
    inp = body.get("input", {})

    prompt = inp.get("prompt", "")
    seed = int(inp.get("seed", 42))
    maps = inp.get("maps", ["basecolor", "normal", "roughness", "metalness"])
    image_size = inp.get("image_size", {})
    width = int(image_size.get("width", 1024))
    height = int(image_size.get("height", 1024))

    job_id = str(uuid.uuid4())

    with jobs_lock:
        jobs[job_id] = {
            "status": JobStatus.IN_QUEUE,
            "created": time.time(),
            "result": None,
            "error": None,
        }

    thread = Thread(
        target=generate_pbr_maps,
        args=(job_id, prompt, seed, maps, width, height),
        daemon=True,
    )
    thread.start()

    return JSONResponse({"request_id": job_id})


@app.get("/queue/status")
async def queue_status(
    requestId: str = Query(...),  # noqa: N803
    x_worker_secret: str = Header(""),
):
    check_secret(x_worker_secret)
    with jobs_lock:
        job = jobs.get(requestId)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    result = {"status": job["status"]}
    if job["error"]:
        result["error"] = job["error"]
    return JSONResponse(result)


@app.get("/queue/result")
async def queue_result(
    requestId: str = Query(...),  # noqa: N803
    x_worker_secret: str = Header(""),
):
    check_secret(x_worker_secret)
    with jobs_lock:
        job = jobs.get(requestId)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] != JobStatus.COMPLETED:
        raise HTTPException(status_code=409, detail=f"Job is {job['status']}")

    result_data = job["result"]
    # Build output with self-hosted URLs for each map
    images_out = []
    for img_data in result_data["images"]:
        # Store PNG bytes keyed by job+map for the /output endpoint
        map_type = img_data["map_type"]
        output_key = f"{requestId}/{map_type}"
        with jobs_lock:
            if "_outputs" not in jobs[requestId]:
                jobs[requestId]["_outputs"] = {}
            jobs[requestId]["_outputs"][output_key] = img_data["bytes"]

        images_out.append(
            {
                "url": f"/output/{requestId}/{map_type}.png",
                "map_type": map_type,
                "content_type": "image/png",
            }
        )

    return JSONResponse(
        {
            "data": {
                "images": images_out,
                "seed": result_data["seed"],
                "prompt": result_data["prompt"],
            }
        }
    )


@app.get("/output/{job_id}/{map_name}")
async def get_output(
    job_id: str,
    map_name: str,
    x_worker_secret: str = Header(""),
):
    check_secret(x_worker_secret)
    # Strip .png extension if present
    map_type = map_name.replace(".png", "")
    output_key = f"{job_id}/{map_type}"
    with jobs_lock:
        job = jobs.get(job_id)
        if not job or "_outputs" not in job:
            raise HTTPException(status_code=404, detail="Output not found")
        png_bytes = job["_outputs"].get(output_key)
    if not png_bytes:
        raise HTTPException(status_code=404, detail="Map not found")
    return StreamingResponse(
        io.BytesIO(png_bytes),
        media_type="image/png",
        headers={"Content-Length": str(len(png_bytes))},
    )


if __name__ == "__main__":
    print(f"Starting PBR worker on port {PORT}", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=PORT)
