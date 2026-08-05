#!/usr/bin/env python3
"""Stage a content-pinned TRELLIS model bundle and write a hash inventory."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from huggingface_hub import snapshot_download


GATED_ACCESS = {"auto", "manual"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--public-only", action="store_true")
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inventory(directory: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or ".cache" in path.parts:
            continue
        entries.append(
            {
                "path": path.relative_to(directory).as_posix(),
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
            }
        )
    return entries


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        delete=False,
    ) as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")
        temporary = Path(handle.name)
    os.replace(temporary, path)


def patch_runtime_pipeline(models_root: Path) -> None:
    pipeline_path = models_root / "TRELLIS.2-4B" / "pipeline.json"
    upstream_path = models_root / "TRELLIS.2-4B" / "pipeline.upstream.json"
    if not pipeline_path.is_file():
        raise RuntimeError("Pinned TRELLIS pipeline.json is missing")
    upstream_bytes = pipeline_path.read_bytes()
    if not upstream_path.exists():
        upstream_path.write_bytes(upstream_bytes)
    else:
        upstream_bytes = upstream_path.read_bytes()
    pipeline = json.loads(upstream_bytes)
    pipeline_args = pipeline["args"]
    pipeline_args["models"]["sparse_structure_decoder"] = (
        "../TRELLIS-image-large/ckpts/ss_dec_conv3d_16l8_fp16"
    )
    pipeline_args["image_cond_model"]["args"]["model_name"] = (
        "/models/dinov3-vitl16-pretrain-lvd1689m"
    )
    pipeline_args["rembg_model"]["args"]["model_name"] = "/models/RMBG-2.0"
    write_json_atomic(pipeline_path, pipeline)


def main() -> int:
    args = parse_args()
    lock = json.loads(args.lock.read_text(encoding="utf-8"))
    expected_source_revision = lock["source"]["revision"]
    if args.source_revision != expected_source_revision:
        raise RuntimeError(
            f"Source revision mismatch: expected {expected_source_revision}, "
            f"got {args.source_revision}"
        )

    token = os.environ.get("HF_TOKEN", "").strip() or None
    if not args.public_only and not token:
        raise RuntimeError(
            "HF_TOKEN is required for a complete bundle; use --public-only to "
            "stage the ungated subset explicitly"
        )

    models_root = args.output / "models"
    models_root.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    skipped: list[str] = []

    for model in lock["models"]:
        access = model["access"]
        if args.public_only and access in GATED_ACCESS:
            skipped.append(model["repoId"])
            results.append(
                {
                    "repoId": model["repoId"],
                    "revision": model["revision"],
                    "access": access,
                    "status": "awaiting_access",
                    "files": [],
                }
            )
            continue

        destination = models_root / model["localDir"]
        snapshot_download(
            repo_id=model["repoId"],
            revision=model["revision"],
            local_dir=destination,
            allow_patterns=model.get("files"),
            token=token,
        )
        results.append(
            {
                "repoId": model["repoId"],
                "revision": model["revision"],
                "access": access,
                "status": "staged",
                "files": inventory(destination),
            }
        )

    patch_runtime_pipeline(models_root)
    for result in results:
        if result["repoId"] == "microsoft/TRELLIS.2-4B":
            result["files"] = inventory(models_root / "TRELLIS.2-4B")

    manifest = {
        "schemaVersion": 1,
        "state": "incomplete" if skipped else "complete",
        "runtimeNetworkPolicy": "offline",
        "source": {
            "repository": lock["source"]["repository"],
            "revision": args.source_revision,
        },
        "models": results,
        "awaitingAccess": skipped,
    }
    write_json_atomic(args.output / "trellis2-staging-manifest.json", manifest)
    print(
        json.dumps(
            {
                "state": manifest["state"],
                "staged": sum(result["status"] == "staged" for result in results),
                "awaitingAccess": len(skipped),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
