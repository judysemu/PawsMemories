#!/usr/bin/env python3
"""Run the accepted TRELLIS worker code once, without opening an HTTP service."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path, PurePosixPath


EXPECTED_LOCK_SHA256 = "fb8c7a52240cb1393d9ccff0e9acb1db560eb6b57c03302d732ee700badba487"
EXPECTED_STAGING_MANIFEST_SHA256 = "e3a4d702026090228807307c073f4171dbefd4db456a28a92e8a014669c0819c"
EXPECTED_SOURCE_REVISION = "75fbf0183001ed9876c8dbb35de6b68552ee08bd"
EXPECTED_MODELS = {
    "microsoft/TRELLIS.2-4B": ("af44b45f2e35a493886929c6d786e563ec68364d", "TRELLIS.2-4B"),
    "microsoft/TRELLIS-image-large": ("25e0d31ffbebe4b5a97464dd851910efc3002d96", "TRELLIS-image-large"),
    "facebook/dinov3-vitl16-pretrain-lvd1689m": ("ea8dc2863c51be0a264bab82070e3e8836b02d51", "dinov3-vitl16-pretrain-lvd1689m"),
    "briaai/RMBG-2.0": ("5df4c9c76d8170882c34f6986e848ee07fd0ba43", "RMBG-2.0"),
}
MAX_MANIFEST_BYTES = 8 * 1024 * 1024


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bounded_path(root: Path, relative: str) -> Path:
    parsed = PurePosixPath(relative)
    if parsed.is_absolute() or not parsed.parts or ".." in parsed.parts:
        raise RuntimeError("MODEL_MANIFEST_PATH_INVALID")
    target = root.joinpath(*parsed.parts)
    resolved_root = root.resolve()
    resolved_target = target.resolve()
    if resolved_target.parent != resolved_root and resolved_root not in resolved_target.parents:
        raise RuntimeError("MODEL_MANIFEST_PATH_ESCAPE")
    if target.is_symlink() or not target.is_file():
        raise RuntimeError("MODEL_FILE_INVALID")
    return target


def verify_models(bundle: Path, expected_manifest_sha256: str) -> Path:
    manifest_path = bundle / "trellis2-staging-manifest.json"
    if not manifest_path.is_file() or manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
        raise RuntimeError("MODEL_MANIFEST_MISSING")
    if sha256_file(manifest_path) != expected_manifest_sha256:
        raise RuntimeError("MODEL_MANIFEST_HASH_MISMATCH")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("state") != "complete"
        or manifest.get("runtimeNetworkPolicy") != "offline"
        or manifest.get("lockSha256") != EXPECTED_LOCK_SHA256
        or manifest.get("source", {}).get("revision") != EXPECTED_SOURCE_REVISION
        or manifest.get("awaitingAccess") != []
    ):
        raise RuntimeError("MODEL_MANIFEST_NOT_ACCEPTED")

    models_root = bundle / "models"
    entries = manifest.get("models")
    if not isinstance(entries, list) or {entry.get("repoId") for entry in entries if isinstance(entry, dict)} != set(EXPECTED_MODELS):
        raise RuntimeError("MODEL_SET_MISMATCH")
    for entry in entries:
        repo_id = entry.get("repoId")
        revision, local_dir = EXPECTED_MODELS[repo_id]
        if (
            entry.get("revision") != revision
            or entry.get("localDir") != local_dir
            or entry.get("status") != "staged"
            or not isinstance(entry.get("files"), list)
            or not entry["files"]
        ):
            raise RuntimeError("MODEL_REVISION_MISMATCH")
        model_root = models_root / local_dir
        recorded_paths: set[str] = set()
        for recorded in entry["files"]:
            relative = recorded.get("path") if isinstance(recorded, dict) else None
            if not isinstance(relative, str) or relative in recorded_paths:
                raise RuntimeError("MODEL_FILE_MANIFEST_INVALID")
            recorded_paths.add(relative)
            target = bounded_path(model_root, relative)
            if target.stat().st_size != recorded.get("bytes") or sha256_file(target) != recorded.get("sha256"):
                raise RuntimeError("MODEL_FILE_HASH_MISMATCH")
        actual_paths = {
            path.relative_to(model_root).as_posix()
            for path in model_root.rglob("*")
            if path.is_file() and ".cache" not in path.parts
        }
        if actual_paths != recorded_paths:
            raise RuntimeError("MODEL_FILE_SET_MISMATCH")
    return models_root


def bind_model_root(models_root: Path) -> None:
    runtime_root = Path("/models")
    runtime_root.mkdir(parents=True, exist_ok=True)
    for _, local_dir in EXPECTED_MODELS.values():
        target = runtime_root / local_dir
        source = models_root / local_dir
        if target.is_symlink() and target.resolve() == source.resolve():
            continue
        if target.exists() or target.is_symlink():
            raise RuntimeError("RUNTIME_MODEL_PATH_OCCUPIED")
        target.symlink_to(source, target_is_directory=True)


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    path.chmod(0o600)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--models-bundle", required=True, type=Path)
    parser.add_argument("--models-manifest-sha256", required=True)
    parser.add_argument("--output-dir", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    runtime_repository_revision = os.environ.get("PAWS_RUNTIME_REPOSITORY_REVISION", "")
    if re.fullmatch(r"[0-9a-f]{40}", runtime_repository_revision) is None:
        raise RuntimeError("RUNTIME_REPOSITORY_REVISION_INVALID")
    runtime_revision_file = Path(
        os.environ.get("PAWS_RUNTIME_REVISION_FILE", "/app/PAWS_RUNTIME_REVISION")
    )
    try:
        image_runtime_revision = runtime_revision_file.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise RuntimeError("IMAGE_RUNTIME_REVISION_MISSING") from error
    if image_runtime_revision != runtime_repository_revision:
        raise RuntimeError("IMAGE_RUNTIME_REVISION_MISMATCH")
    if not args.input.is_file() or not args.models_bundle.is_dir():
        raise RuntimeError("FINITE_JOB_INPUT_MISSING")
    if not len(args.models_manifest_sha256) == 64 or any(character not in "0123456789abcdef" for character in args.models_manifest_sha256):
        raise RuntimeError("MODEL_MANIFEST_HASH_INVALID")
    if args.models_manifest_sha256 != EXPECTED_STAGING_MANIFEST_SHA256:
        raise RuntimeError("MODEL_MANIFEST_NOT_ACCEPTED")

    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA_NOT_AVAILABLE")
    source_head = subprocess.check_output(
        ["git", "-C", "/opt/trellis2", "rev-parse", "HEAD"], text=True, timeout=10
    ).strip()
    if source_head != EXPECTED_SOURCE_REVISION:
        raise RuntimeError("TRELLIS_SOURCE_IMAGE_MISMATCH")

    models_root = verify_models(args.models_bundle.resolve(), args.models_manifest_sha256)
    bind_model_root(models_root)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="paws-trellis-once-") as temporary:
        job_root = Path(temporary) / "jobs"
        job_root.mkdir(mode=0o700)
        os.environ.update(
            {
                "WORKER_SHARED_SECRET": secrets.token_urlsafe(32),
                "TRELLIS_MODEL_PATH": "/models/TRELLIS.2-4B",
                "TRELLIS_JOBS_DIR": str(job_root),
                "TRELLIS_PRELOAD": "false",
                "TRELLIS_MODEL_REVISION": EXPECTED_MODELS["microsoft/TRELLIS.2-4B"][0],
                "TRELLIS_SOURCE_REVISION": EXPECTED_SOURCE_REVISION,
                "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
            }
        )
        sys.path.insert(0, "/app")
        import main as worker

        worker.initialize_database()
        job_id = str(uuid.uuid4())
        job_dir = job_root / job_id
        job_dir.mkdir(mode=0o700)
        input_copy = job_dir / "input.bin"
        shutil.copyfile(args.input, input_copy)
        worker.validate_image(input_copy)
        now = time.time()
        with worker.database() as connection:
            connection.execute(
                "INSERT INTO jobs "
                "(id,status,pipeline_type,seed,decimation_target,texture_size,progress,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (job_id, "queued", "1024_cascade", 42, 1_000_000, 4096, 0, now, now),
            )
        worker.generate_job(job_id, input_copy, "1024_cascade", 42, 1_000_000, 4096)
        with sqlite3.connect(worker.DATABASE_PATH) as connection:
            row = connection.execute(
                "SELECT status,error,artifact_path,artifact_sha256,artifact_bytes FROM jobs WHERE id=?",
                (job_id,),
            ).fetchone()
        if row is None or row[0] != "succeeded":
            raise RuntimeError(f"TRELLIS_GENERATION_FAILED:{(row[1] if row else 'missing result')[:200]}")
        artifact = Path(row[2])
        if sha256_file(artifact) != row[3] or artifact.stat().st_size != row[4]:
            raise RuntimeError("TRELLIS_ARTIFACT_INTEGRITY_FAILED")
        output = args.output_dir / "master.glb"
        shutil.copyfile(artifact, output)
        output.chmod(0o600)
        write_json(
            args.output_dir / "base-metadata.json",
            {
                "schemaVersion": "paws.azureml-trellis-once.v1",
                "status": "PASS",
                "provider": "trellis2",
                "runtimeRepositoryRevision": runtime_repository_revision,
                "sourceRevision": EXPECTED_SOURCE_REVISION,
                "modelRevision": EXPECTED_MODELS["microsoft/TRELLIS.2-4B"][0],
                "inputSha256": sha256_file(args.input),
                "outputSha256": row[3],
                "outputBytes": row[4],
                "gpu": torch.cuda.get_device_name(0),
                "externalGenerativeProviderCalls": 0,
            },
        )
    print("TRELLIS_ONESHOT_PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
