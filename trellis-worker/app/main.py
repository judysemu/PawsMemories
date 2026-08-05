from __future__ import annotations

import hashlib
import hmac
import os
import sqlite3
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from PIL import Image, UnidentifiedImageError


MODEL_PATH = Path(os.environ.get("TRELLIS_MODEL_PATH", "/models/TRELLIS.2-4B"))
JOBS_ROOT = Path(os.environ.get("TRELLIS_JOBS_DIR", "/jobs"))
DATABASE_PATH = JOBS_ROOT / "jobs.sqlite3"
MAX_UPLOAD_BYTES = int(os.environ.get("TRELLIS_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
MAX_IMAGE_PIXELS = int(os.environ.get("TRELLIS_MAX_IMAGE_PIXELS", "40000000"))
WORKER_SECRET = os.environ.get("WORKER_SHARED_SECRET", "").strip()
PRELOAD_MODEL = os.environ.get("TRELLIS_PRELOAD", "true").lower() == "true"

if not WORKER_SECRET:
    raise RuntimeError("WORKER_SHARED_SECRET is required")

JOBS_ROOT.mkdir(parents=True, exist_ok=True)
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

app = FastAPI(title="Paws TRELLIS.2 Worker", version="1.0.0")
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="trellis-job")
pipeline_lock = threading.Lock()
pipeline = None
pipeline_error: str | None = None


def database() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH, timeout=30)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_database() -> None:
    with database() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY,
              status TEXT NOT NULL,
              pipeline_type TEXT NOT NULL,
              seed INTEGER NOT NULL,
              decimation_target INTEGER NOT NULL,
              texture_size INTEGER NOT NULL,
              progress INTEGER NOT NULL DEFAULT 0,
              error TEXT,
              artifact_path TEXT,
              artifact_sha256 TEXT,
              artifact_bytes INTEGER,
              created_at REAL NOT NULL,
              updated_at REAL NOT NULL
            )
            """
        )
        connection.execute(
            "UPDATE jobs SET status='failed', error='WORKER_RESTARTED', updated_at=? "
            "WHERE status IN ('queued','running')",
            (time.time(),),
        )


def update_job(job_id: str, **values: object) -> None:
    values["updated_at"] = time.time()
    assignments = ", ".join(f"{column}=?" for column in values)
    with database() as connection:
        connection.execute(
            f"UPDATE jobs SET {assignments} WHERE id=?",
            (*values.values(), job_id),
        )


def read_job(job_id: str) -> sqlite3.Row:
    with database() as connection:
        row = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="JOB_NOT_FOUND")
    return row


def require_worker_secret(x_worker_secret: str | None = Header(default=None)) -> None:
    supplied = (x_worker_secret or "").encode("utf-8")
    expected = WORKER_SECRET.encode("utf-8")
    if not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="UNAUTHORIZED")


def load_pipeline():
    global pipeline, pipeline_error
    if pipeline is not None:
        return pipeline
    with pipeline_lock:
        if pipeline is not None:
            return pipeline
        try:
            if not MODEL_PATH.is_dir():
                raise RuntimeError(f"Model directory is missing: {MODEL_PATH}")
            from trellis2.pipelines import Trellis2ImageTo3DPipeline

            loaded = Trellis2ImageTo3DPipeline.from_pretrained(str(MODEL_PATH))
            loaded.cuda()
            pipeline = loaded
            pipeline_error = None
            return pipeline
        except Exception as error:  # surfaced through readiness without leaking a traceback
            pipeline_error = f"{type(error).__name__}: {error}"
            raise


def validate_image(path: Path) -> None:
    try:
        with Image.open(path) as candidate:
            candidate.verify()
        with Image.open(path) as candidate:
            width, height = candidate.size
            if width < 128 or height < 128:
                raise ValueError("IMAGE_TOO_SMALL")
            if width * height > MAX_IMAGE_PIXELS:
                raise ValueError("IMAGE_TOO_LARGE")
            if candidate.format not in {"JPEG", "PNG", "WEBP"}:
                raise ValueError("UNSUPPORTED_IMAGE_FORMAT")
    except (UnidentifiedImageError, OSError) as error:
        raise ValueError("INVALID_IMAGE") from error


def generate_job(
    job_id: str,
    input_path: Path,
    pipeline_type: str,
    seed: int,
    decimation_target: int,
    texture_size: int,
) -> None:
    output_path = input_path.parent / "master.glb"
    try:
        update_job(job_id, status="running", progress=5)
        model = load_pipeline()
        update_job(job_id, progress=15)

        with Image.open(input_path) as source:
            source.load()
            image = source.convert("RGBA" if source.mode == "RGBA" else "RGB")

        mesh = model.run(image, seed=seed, pipeline_type=pipeline_type)[0]
        update_job(job_id, progress=80)
        mesh.simplify(16777216)

        import o_voxel

        glb = o_voxel.postprocess.to_glb(
            vertices=mesh.vertices,
            faces=mesh.faces,
            attr_volume=mesh.attrs,
            coords=mesh.coords,
            attr_layout=mesh.layout,
            voxel_size=mesh.voxel_size,
            aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
            decimation_target=decimation_target,
            texture_size=texture_size,
            remesh=True,
            remesh_band=1,
            remesh_project=0,
            verbose=True,
        )
        glb.export(str(output_path), extension_webp=True)

        artifact = output_path.read_bytes()
        if len(artifact) < 20 or artifact[:4] != b"glTF":
            raise RuntimeError("EXPORT_INVALID_GLB")
        digest = hashlib.sha256(artifact).hexdigest()
        update_job(
            job_id,
            status="succeeded",
            progress=100,
            artifact_path=str(output_path),
            artifact_sha256=digest,
            artifact_bytes=len(artifact),
            error=None,
        )
    except Exception as error:
        update_job(job_id, status="failed", error=f"{type(error).__name__}: {error}"[:1000])
    finally:
        input_path.unlink(missing_ok=True)


@app.on_event("startup")
def startup() -> None:
    initialize_database()
    if PRELOAD_MODEL:
        executor.submit(load_pipeline)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz", dependencies=[Depends(require_worker_secret)])
def readyz():
    try:
        import torch

        cuda_ready = torch.cuda.is_available()
        gpu_name = torch.cuda.get_device_name(0) if cuda_ready else None
    except Exception:
        cuda_ready = False
        gpu_name = None
    ready = cuda_ready and MODEL_PATH.is_dir() and pipeline_error is None
    body = {
        "status": "ready" if ready else "not_ready",
        "cuda": cuda_ready,
        "gpu": gpu_name,
        "modelPresent": MODEL_PATH.is_dir(),
        "modelLoaded": pipeline is not None,
        "modelRevision": "75fbf0183001ed9876c8dbb35de6b68552ee08bd",
        "error": pipeline_error,
    }
    return JSONResponse(status_code=200 if ready else 503, content=body)


@app.post("/v1/jobs", status_code=202, dependencies=[Depends(require_worker_secret)])
async def create_job(
    image: UploadFile = File(...),
    pipeline_type: Literal["512", "1024", "1024_cascade", "1536_cascade"] = Form("1024_cascade"),
    seed: int = Form(42, ge=0, le=2_147_483_647),
    decimation_target: int = Form(1_000_000, ge=10_000, le=1_000_000),
    texture_size: Literal[1024, 2048, 4096] = Form(4096),
):
    job_id = str(uuid.uuid4())
    job_dir = JOBS_ROOT / job_id
    job_dir.mkdir(mode=0o700)
    input_path = job_dir / "input.bin"
    total = 0
    with input_path.open("wb") as output:
        while chunk := await image.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                input_path.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="IMAGE_TOO_LARGE")
            output.write(chunk)
    try:
        validate_image(input_path)
    except ValueError as error:
        input_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=str(error)) from error

    now = time.time()
    with database() as connection:
        connection.execute(
            "INSERT INTO jobs "
            "(id,status,pipeline_type,seed,decimation_target,texture_size,progress,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (job_id, "queued", pipeline_type, seed, decimation_target, texture_size, 0, now, now),
        )
    executor.submit(
        generate_job,
        job_id,
        input_path,
        pipeline_type,
        seed,
        decimation_target,
        texture_size,
    )
    return {"id": job_id, "status": "queued"}


@app.get("/v1/jobs/{job_id}", dependencies=[Depends(require_worker_secret)])
def get_job(job_id: str):
    row = read_job(job_id)
    return {
        "id": row["id"],
        "status": row["status"],
        "progress": row["progress"],
        "error": row["error"],
        "artifact": (
            {
                "url": f"/v1/jobs/{job_id}/artifact",
                "sha256": row["artifact_sha256"],
                "bytes": row["artifact_bytes"],
            }
            if row["status"] == "succeeded"
            else None
        ),
    }


@app.get("/v1/jobs/{job_id}/artifact", dependencies=[Depends(require_worker_secret)])
def get_artifact(job_id: str):
    row = read_job(job_id)
    if row["status"] != "succeeded" or not row["artifact_path"]:
        raise HTTPException(status_code=409, detail="ARTIFACT_NOT_READY")
    artifact_path = Path(row["artifact_path"])
    if not artifact_path.is_file() or artifact_path.parent != JOBS_ROOT / job_id:
        raise HTTPException(status_code=410, detail="ARTIFACT_MISSING")
    return FileResponse(
        artifact_path,
        media_type="model/gltf-binary",
        filename=f"{job_id}.glb",
        headers={"X-Artifact-SHA256": row["artifact_sha256"]},
    )
