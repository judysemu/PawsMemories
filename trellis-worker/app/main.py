from __future__ import annotations

import hashlib
import hmac
import json
import os
import sqlite3
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath
from typing import Literal

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from PIL import Image, UnidentifiedImageError

from finalization import BlenderClient, FinalizationConfig, FinalizationError, finalize_trellis_job


MODEL_PATH = Path(os.environ.get("TRELLIS_MODEL_PATH", "/models/TRELLIS.2-4B"))
MODEL_MANIFEST_PATH = Path(
    os.environ.get("TRELLIS_MODEL_MANIFEST", "/models/trellis2-staging-manifest.json")
)
EXPECTED_MODEL_MANIFEST_SHA256 = "e3a4d702026090228807307c073f4171dbefd4db456a28a92e8a014669c0819c"
EXPECTED_MODEL_LOCK_SHA256 = "fb8c7a52240cb1393d9ccff0e9acb1db560eb6b57c03302d732ee700badba487"
JOBS_ROOT = Path(os.environ.get("TRELLIS_JOBS_DIR", "/jobs"))
DATABASE_PATH = JOBS_ROOT / "jobs.sqlite3"
MAX_UPLOAD_BYTES = int(os.environ.get("TRELLIS_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
MAX_IMAGE_PIXELS = int(os.environ.get("TRELLIS_MAX_IMAGE_PIXELS", "40000000"))
WORKER_SECRET = os.environ.get("WORKER_SHARED_SECRET", "").strip()
PRELOAD_MODEL = os.environ.get("TRELLIS_PRELOAD", "true").lower() == "true"
MODEL_REVISION = os.environ.get("TRELLIS_MODEL_REVISION", "unknown")
SOURCE_REVISION = os.environ.get("TRELLIS_SOURCE_REVISION", "unknown")
EXPECTED_BLENDER_VERSION = os.environ.get("BLENDER_VERSION", "5.1.2").strip()
EXPECTED_BLENDER_REVISION = os.environ.get("BLENDER_WORKER_REVISION", "").strip()
RUNTIME_REVISION_FILE = Path(
    os.environ.get("PAWS_RUNTIME_REVISION_FILE", "/app/PAWS_RUNTIME_REVISION")
)
try:
    IMAGE_RUNTIME_REVISION = RUNTIME_REVISION_FILE.read_text(encoding="utf-8").strip()
except OSError:
    IMAGE_RUNTIME_REVISION = None
BLENDER_READINESS_TIMEOUT_SECONDS = max(
    1,
    min(30, int(os.environ.get("BLENDER_READINESS_TIMEOUT_SECONDS", "5"))),
)

if not WORKER_SECRET:
    raise RuntimeError("WORKER_SHARED_SECRET is required")

JOBS_ROOT.mkdir(parents=True, exist_ok=True)
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

app = FastAPI(title="Paws TRELLIS.2 Worker", version="1.0.0")
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="trellis-job")
pipeline_lock = threading.Lock()
pipeline = None
pipeline_error: str | None = None
model_bundle_verified = False


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
        existing_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(jobs)").fetchall()
        }
        finalization_columns = {
            "finalization_status": "TEXT NOT NULL DEFAULT 'not_requested'",
            "finalization_progress": "INTEGER NOT NULL DEFAULT 0",
            "finalization_error": "TEXT",
            "final_artifact_path": "TEXT",
            "final_artifact_sha256": "TEXT",
            "final_artifact_bytes": "INTEGER",
            "rigged_artifact_path": "TEXT",
            "rigged_artifact_sha256": "TEXT",
            "rigged_artifact_bytes": "INTEGER",
            "clip_job_id": "TEXT",
            "clips_json": "TEXT",
        }
        for column, definition in finalization_columns.items():
            if column not in existing_columns:
                connection.execute(f"ALTER TABLE jobs ADD COLUMN {column} {definition}")
        connection.execute(
            "UPDATE jobs SET status='failed', error='WORKER_RESTARTED', updated_at=? "
            "WHERE status IN ('queued','running')",
            (time.time(),),
        )
        connection.execute(
            "UPDATE jobs SET finalization_status='failed', finalization_error='WORKER_RESTARTED', updated_at=? "
            "WHERE finalization_status IN ('queued','running')",
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


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_model_bundle() -> None:
    if not MODEL_MANIFEST_PATH.is_file() or MODEL_MANIFEST_PATH.stat().st_size > 8 * 1024 * 1024:
        raise RuntimeError("MODEL_MANIFEST_MISSING")
    if sha256_file(MODEL_MANIFEST_PATH) != EXPECTED_MODEL_MANIFEST_SHA256:
        raise RuntimeError("MODEL_MANIFEST_HASH_MISMATCH")
    manifest = json.loads(MODEL_MANIFEST_PATH.read_text(encoding="utf-8"))
    entries = manifest.get("models")
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("state") != "complete"
        or manifest.get("runtimeNetworkPolicy") != "offline"
        or manifest.get("lockSha256") != EXPECTED_MODEL_LOCK_SHA256
        or manifest.get("source", {}).get("revision") != SOURCE_REVISION
        or manifest.get("awaitingAccess") != []
        or not isinstance(entries, list)
        or len(entries) != 4
    ):
        raise RuntimeError("MODEL_MANIFEST_NOT_ACCEPTED")
    model_root = MODEL_PATH.parent.resolve()
    for entry in entries:
        local_dir = entry.get("localDir") if isinstance(entry, dict) else None
        files = entry.get("files") if isinstance(entry, dict) else None
        if not isinstance(local_dir, str) or not isinstance(files, list) or not files:
            raise RuntimeError("MODEL_MANIFEST_ENTRY_INVALID")
        entry_root = (model_root / local_dir).resolve()
        if entry_root.parent != model_root or not entry_root.is_dir():
            raise RuntimeError("MODEL_DIRECTORY_INVALID")
        recorded_paths: set[str] = set()
        for recorded in files:
            relative = recorded.get("path") if isinstance(recorded, dict) else None
            parsed = PurePosixPath(relative) if isinstance(relative, str) else None
            if parsed is None or parsed.is_absolute() or ".." in parsed.parts or relative in recorded_paths:
                raise RuntimeError("MODEL_FILE_MANIFEST_INVALID")
            recorded_paths.add(relative)
            target = entry_root.joinpath(*parsed.parts)
            resolved = target.resolve()
            if (
                (resolved.parent != entry_root and entry_root not in resolved.parents)
                or target.is_symlink()
                or not target.is_file()
                or target.stat().st_size != recorded.get("bytes")
                or sha256_file(target) != recorded.get("sha256")
            ):
                raise RuntimeError("MODEL_FILE_HASH_MISMATCH")
        actual_paths = {
            path.relative_to(entry_root).as_posix()
            for path in entry_root.rglob("*")
            if path.is_file() and ".cache" not in path.relative_to(entry_root).parts
        }
        if actual_paths != recorded_paths:
            raise RuntimeError("MODEL_FILE_SET_MISMATCH")


def load_pipeline():
    global pipeline, pipeline_error, model_bundle_verified
    if pipeline is not None:
        return pipeline
    with pipeline_lock:
        if pipeline is not None:
            return pipeline
        try:
            if not MODEL_PATH.is_dir():
                raise RuntimeError(f"Model directory is missing: {MODEL_PATH}")
            verify_model_bundle()
            model_bundle_verified = True
            from trellis2.pipelines import Trellis2ImageTo3DPipeline

            loaded = Trellis2ImageTo3DPipeline.from_pretrained(str(MODEL_PATH))
            loaded.cuda()
            pipeline = loaded
            pipeline_error = None
            return pipeline
        except Exception as error:  # surfaced through readiness without leaking a traceback
            model_bundle_verified = False
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


def finalize_job(job_id: str) -> None:
    try:
        row = read_job(job_id)
        if row["status"] != "succeeded" or not row["artifact_sha256"] or not row["artifact_bytes"]:
            raise FinalizationError("SOURCE_NOT_READY", "TRELLIS base artifact is not ready")
        update_job(job_id, finalization_status="running", finalization_progress=5, finalization_error=None)
        client = BlenderClient(FinalizationConfig.from_environment(WORKER_SECRET))
        result = finalize_trellis_job(
            job_id=job_id,
            source_sha256=row["artifact_sha256"],
            source_bytes=row["artifact_bytes"],
            job_directory=JOBS_ROOT / job_id,
            client=client,
            progress=lambda value: update_job(job_id, finalization_progress=value),
        )
        update_job(
            job_id,
            finalization_status="succeeded",
            finalization_progress=100,
            finalization_error=None,
            final_artifact_path=result["artifact_path"],
            final_artifact_sha256=result["artifact_sha256"],
            final_artifact_bytes=result["artifact_bytes"],
            rigged_artifact_path=result["rigged_path"],
            rigged_artifact_sha256=result["rigged_sha256"],
            rigged_artifact_bytes=result["rigged_bytes"],
            clip_job_id=result["clip_job_id"],
            clips_json=json.dumps(result["clips"], separators=(",", ":")),
        )
    except Exception as error:
        code = error.code if isinstance(error, FinalizationError) else type(error).__name__
        update_job(
            job_id,
            finalization_status="failed",
            finalization_error=f"{code}: {error}"[:1000],
        )


@app.on_event("startup")
def startup() -> None:
    initialize_database()
    if PRELOAD_MODEL:
        executor.submit(load_pipeline)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


def aggregate_readiness() -> tuple[bool, dict[str, object]]:
    try:
        import torch

        cuda_ready = torch.cuda.is_available()
        gpu_name = torch.cuda.get_device_name(0) if cuda_ready else None
    except Exception:
        cuda_ready = False
        gpu_name = None
    blender_status = {
        "status": "not_ready",
        "bridgeConnected": False,
        "version": None,
        "revision": None,
    }
    try:
        blender = BlenderClient(FinalizationConfig.from_environment(WORKER_SECRET))
        health = blender.request_json(
            "GET",
            "/health",
            None,
            BLENDER_READINESS_TIMEOUT_SECONDS,
        )
        actual_version = health.get("blenderVersion")
        actual_revision = health.get("workerRevision")
        bridge_connected = health.get("bridge") == "connected"
        blender_ready = (
            health.get("status") == "ok"
            and bridge_connected
            and health.get("revisionVerified") is True
            and bool(EXPECTED_BLENDER_REVISION)
            and actual_version == EXPECTED_BLENDER_VERSION
            and actual_revision == EXPECTED_BLENDER_REVISION
        )
        blender_status = {
            "status": "ready" if blender_ready else "not_ready",
            "bridgeConnected": bridge_connected,
            "version": actual_version if isinstance(actual_version, str) else None,
            "revision": actual_revision if isinstance(actual_revision, str) else None,
        }
    except Exception:
        blender_ready = False
    runtime_revision_verified = (
        isinstance(IMAGE_RUNTIME_REVISION, str)
        and len(IMAGE_RUNTIME_REVISION) == 40
        and all(character in "0123456789abcdef" for character in IMAGE_RUNTIME_REVISION)
        and IMAGE_RUNTIME_REVISION == EXPECTED_BLENDER_REVISION
    )
    ready = (
        cuda_ready
        and MODEL_PATH.is_dir()
        and model_bundle_verified
        and pipeline is not None
        and pipeline_error is None
        and runtime_revision_verified
        and blender_ready
    )
    body = {
        "status": "ready" if ready else "not_ready",
        "cuda": cuda_ready,
        "gpu": gpu_name,
        "modelPresent": MODEL_PATH.is_dir(),
        "modelLoaded": pipeline is not None,
        "modelBundleVerified": model_bundle_verified,
        "modelRevision": MODEL_REVISION,
        "sourceRevision": SOURCE_REVISION,
        "runtimeRepositoryRevision": IMAGE_RUNTIME_REVISION,
        "runtimeRevisionVerified": runtime_revision_verified,
        "blender": blender_status,
        "error": pipeline_error,
    }
    return ready, body


def require_aggregate_readiness() -> None:
    ready, _body = aggregate_readiness()
    if not ready:
        raise HTTPException(status_code=503, detail="INHOUSE_PIPELINE_NOT_READY")


@app.get("/readyz", dependencies=[Depends(require_worker_secret)])
def readyz():
    ready, body = aggregate_readiness()
    return JSONResponse(status_code=200 if ready else 503, content=body)


@app.post("/v1/jobs", status_code=202, dependencies=[Depends(require_worker_secret)])
async def create_job(
    image: UploadFile = File(...),
    pipeline_type: Literal["512", "1024", "1024_cascade", "1536_cascade"] = Form("1024_cascade"),
    seed: int = Form(42, ge=0, le=2_147_483_647),
    decimation_target: int = Form(1_000_000, ge=10_000, le=1_000_000),
    texture_size: Literal[1024, 2048, 4096] = Form(4096),
):
    # Reject before receiving a potentially large upload, then prove readiness
    # again immediately before accepting the durable job.
    require_aggregate_readiness()
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

    try:
        require_aggregate_readiness()
    except HTTPException:
        input_path.unlink(missing_ok=True)
        try:
            job_dir.rmdir()
        except OSError:
            pass
        raise
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
    clips = []
    if row["clips_json"]:
        try:
            clips = json.loads(row["clips_json"])
        except json.JSONDecodeError:
            clips = []
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
        "finalization": {
            "status": row["finalization_status"],
            "progress": row["finalization_progress"],
            "error": row["finalization_error"],
            "clips": clips,
            "artifact": (
                {
                    "url": f"/v1/jobs/{job_id}/final-artifact",
                    "sha256": row["final_artifact_sha256"],
                    "bytes": row["final_artifact_bytes"],
                }
                if row["finalization_status"] == "succeeded"
                else None
            ),
        },
    }


@app.post("/v1/jobs/{job_id}/finalize", status_code=202, dependencies=[Depends(require_worker_secret)])
def request_finalization(job_id: str):
    row = read_job(job_id)
    if row["status"] != "succeeded":
        raise HTTPException(status_code=409, detail="BASE_ARTIFACT_NOT_READY")
    if row["finalization_status"] == "succeeded" and row["final_artifact_path"]:
        return JSONResponse(status_code=200, content={"id": job_id, "status": "succeeded"})
    require_aggregate_readiness()
    now = time.time()
    with database() as connection:
        claimed = connection.execute(
            "UPDATE jobs SET finalization_status='queued', finalization_progress=0, "
            "finalization_error=NULL, final_artifact_path=NULL, final_artifact_sha256=NULL, "
            "final_artifact_bytes=NULL, clip_job_id=NULL, clips_json=NULL, updated_at=? "
            "WHERE id=? AND status='succeeded' AND finalization_status IN ('not_requested','failed')",
            (now, job_id),
        ).rowcount
    if claimed != 1:
        current = read_job(job_id)
        return {"id": job_id, "status": current["finalization_status"]}
    executor.submit(finalize_job, job_id)
    return {"id": job_id, "status": "queued"}


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


@app.get("/v1/jobs/{job_id}/final-artifact", dependencies=[Depends(require_worker_secret)])
def get_final_artifact(job_id: str):
    row = read_job(job_id)
    if row["finalization_status"] != "succeeded" or not row["final_artifact_path"]:
        raise HTTPException(status_code=409, detail="FINAL_ARTIFACT_NOT_READY")
    artifact_path = Path(row["final_artifact_path"])
    if not artifact_path.is_file() or artifact_path.parent != JOBS_ROOT / job_id or artifact_path.name != "final.glb":
        raise HTTPException(status_code=410, detail="FINAL_ARTIFACT_MISSING")
    return FileResponse(
        artifact_path,
        media_type="model/gltf-binary",
        filename=f"{job_id}-final.glb",
        headers={"X-Artifact-SHA256": row["final_artifact_sha256"]},
    )
