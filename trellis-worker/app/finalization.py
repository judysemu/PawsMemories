from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit


MAX_GLB_BYTES = 70 * 1024 * 1024
MAX_JSON_BYTES = 100 * 1024 * 1024
REQUIRED_CLIPS = frozenset({"idle", "walk"})


class FinalizationError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class FinalizationConfig:
    blender_url: str
    worker_secret: str
    allowed_hosts: frozenset[str]
    profile_id: str = "quadruped.dog.medium"
    rig_timeout_seconds: int = 1800
    clip_timeout_seconds: int = 600
    poll_interval_seconds: float = 2.0
    max_json_bytes: int = MAX_JSON_BYTES
    max_glb_bytes: int = MAX_GLB_BYTES

    @classmethod
    def from_environment(cls, worker_secret: str) -> "FinalizationConfig":
        allowed = frozenset(
            host.strip().lower()
            for host in os.environ.get(
                "BLENDER_INTERNAL_HOSTS",
                "blender-worker,localhost,127.0.0.1,::1",
            ).split(",")
            if host.strip()
        )
        return cls(
            blender_url=os.environ.get("BLENDER_WORKER_URL", "http://blender-worker:10000"),
            worker_secret=worker_secret,
            allowed_hosts=allowed,
            profile_id=os.environ.get("BLENDER_RIG_PROFILE", "quadruped.dog.medium"),
            rig_timeout_seconds=int(os.environ.get("BLENDER_RIG_TIMEOUT_SECONDS", "1800")),
            clip_timeout_seconds=int(os.environ.get("BLENDER_CLIP_TIMEOUT_SECONDS", "600")),
            poll_interval_seconds=float(os.environ.get("BLENDER_POLL_INTERVAL_SECONDS", "2")),
        )


def inspect_glb(data: bytes, maximum: int = MAX_GLB_BYTES) -> dict[str, object]:
    if not isinstance(data, bytes) or len(data) < 20 or len(data) > maximum:
        raise FinalizationError("INVALID_GLB", "GLB output is missing or outside the byte limit")
    if data[:4] != b"glTF" or int.from_bytes(data[4:8], "little") != 2:
        raise FinalizationError("INVALID_GLB", "GLB output has an invalid header")
    if int.from_bytes(data[8:12], "little") != len(data):
        raise FinalizationError("INVALID_GLB", "GLB output length does not match its header")
    offset = 12
    document: dict[str, object] | None = None
    while offset < len(data):
        if offset + 8 > len(data):
            raise FinalizationError("INVALID_GLB", "GLB chunk header is truncated")
        chunk_bytes = int.from_bytes(data[offset:offset + 4], "little")
        chunk_type = int.from_bytes(data[offset + 4:offset + 8], "little")
        offset += 8
        if chunk_bytes % 4 or offset + chunk_bytes > len(data):
            raise FinalizationError("INVALID_GLB", "GLB chunk is invalid")
        if chunk_type == 0x4E4F534A and document is None:
            try:
                decoded = json.loads(
                    data[offset:offset + chunk_bytes].rstrip(b" \x00").decode("utf-8"),
                    parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
                )
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
                raise FinalizationError("INVALID_GLB", "GLB JSON chunk is invalid") from error
            if not isinstance(decoded, dict):
                raise FinalizationError("INVALID_GLB", "GLB JSON document must be an object")
            document = decoded
        offset += chunk_bytes
    asset = document.get("asset") if document is not None else None
    if offset != len(data) or document is None or not isinstance(asset, dict) or asset.get("version") != "2.0":
        raise FinalizationError("INVALID_GLB", "GLB does not contain a valid glTF 2.0 document")
    for collection in (document.get("buffers", []), document.get("images", [])):
        if not isinstance(collection, list):
            raise FinalizationError("INVALID_GLB", "GLB resource collection is invalid")
        for entry in collection:
            uri = entry.get("uri") if isinstance(entry, dict) else None
            if isinstance(uri, str) and not uri.startswith("data:"):
                raise FinalizationError("EXTERNAL_URI_REJECTED", "Final GLB must not reference external assets")
    return document


def validate_glb(data: bytes, maximum: int = MAX_GLB_BYTES) -> None:
    inspect_glb(data, maximum)


def artifact_envelope(data: bytes) -> dict[str, object]:
    validate_glb(data)
    return {
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
    }


class BlenderClient:
    def __init__(self, config: FinalizationConfig):
        self.config = config
        parsed = urlsplit(config.blender_url)
        hostname = (parsed.hostname or "").lower()
        if (
            parsed.scheme not in {"http", "https"}
            or not hostname
            or hostname not in config.allowed_hosts
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
        ):
            raise FinalizationError(
                "BLENDER_URL_REJECTED",
                "Blender worker URL must be an allowlisted internal service origin",
            )
        if len(config.worker_secret) < 16:
            raise FinalizationError("BLENDER_AUTH_NOT_CONFIGURED", "Blender worker authentication is not configured")
        self.origin = config.blender_url.rstrip("/")

    def request_json(
        self,
        method: str,
        route: str,
        payload: dict[str, object] | None,
        timeout_seconds: int,
    ) -> dict[str, object]:
        body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            f"{self.origin}{route}",
            data=body,
            method=method,
            headers={
                "accept": "application/json",
                "content-type": "application/json",
                "x-worker-secret": self.config.worker_secret,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                declared = int(response.headers.get("content-length", "0") or "0")
                if declared > self.config.max_json_bytes:
                    raise FinalizationError("BLENDER_RESPONSE_TOO_LARGE", "Blender response exceeded the byte limit")
                raw = response.read(self.config.max_json_bytes + 1)
                if len(raw) > self.config.max_json_bytes:
                    raise FinalizationError("BLENDER_RESPONSE_TOO_LARGE", "Blender response exceeded the byte limit")
        except urllib.error.HTTPError as error:
            raise FinalizationError("BLENDER_HTTP_ERROR", f"Blender worker returned HTTP {error.code}") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise FinalizationError("BLENDER_UNAVAILABLE", "Blender worker request failed") from error
        try:
            decoded = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise FinalizationError("BLENDER_INVALID_RESPONSE", "Blender worker returned invalid JSON") from error
        if not isinstance(decoded, dict):
            raise FinalizationError("BLENDER_INVALID_RESPONSE", "Blender worker response must be an object")
        return decoded


def _decode_output(
    envelope: dict[str, object],
    field: str,
    expected_sha256: str | None,
    expected_bytes: int | None,
    maximum: int,
) -> bytes:
    encoded = envelope.get(field)
    if not isinstance(encoded, str) or len(encoded) > ((maximum + 2) // 3) * 4 + 8:
        raise FinalizationError("BLENDER_INVALID_ARTIFACT", "Blender worker returned no bounded GLB")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise FinalizationError("BLENDER_INVALID_ARTIFACT", "Blender worker returned invalid base64") from error
    validate_glb(data, maximum)
    actual_sha256 = hashlib.sha256(data).hexdigest()
    if expected_sha256 is not None and actual_sha256 != expected_sha256:
        raise FinalizationError("BLENDER_ARTIFACT_HASH", "Blender artifact hash does not match its envelope")
    if expected_bytes is not None and len(data) != expected_bytes:
        raise FinalizationError("BLENDER_ARTIFACT_SIZE", "Blender artifact size does not match its envelope")
    return data


def _atomic_write(directory: Path, filename: str, data: bytes) -> Path:
    if directory.is_symlink() or not directory.is_dir():
        raise FinalizationError("JOB_DIRECTORY_INVALID", "TRELLIS job directory is unavailable")
    temporary = directory / f".{filename}.{uuid.uuid4().hex}.tmp"
    try:
        with temporary.open("xb") as output:
            os.chmod(temporary, 0o600)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        destination = directory / filename
        temporary.replace(destination)
        return destination
    finally:
        temporary.unlink(missing_ok=True)


def finalize_trellis_job(
    job_id: str,
    source_sha256: str,
    source_bytes: int,
    job_directory: Path,
    client: BlenderClient,
    progress: Callable[[int], None] = lambda _value: None,
) -> dict[str, object]:
    try:
        parsed_job_id = uuid.UUID(job_id)
    except ValueError as error:
        raise FinalizationError("JOB_ID_INVALID", "TRELLIS job ID is invalid") from error
    if str(parsed_job_id) != job_id or not re.fullmatch(r"[0-9a-f]{64}", source_sha256) or source_bytes < 20:
        raise FinalizationError("SOURCE_DESCRIPTOR_INVALID", "TRELLIS source descriptor is invalid")

    attempt_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"paws:trellis2:finalize:{job_id}:v1"))
    rig_request = {
        "contractVersion": 1,
        "jobUuid": job_id,
        "attemptUuid": attempt_id,
        "idempotencyKey": f"trellis2-finalize-{job_id}-v1",
        "profileId": client.config.profile_id,
        "classification": "quadruped",
        "requestFacial": False,
        "requestedFacialTargets": [],
        "source": {
            "signedUrl": f"trellis2://jobs/{job_id}/master.glb",
            "sha256": source_sha256,
            "sizeBytes": source_bytes,
        },
        "budgets": {
            "maxJoints": 128,
            "maxInfluences": 4,
            "maxTriangles": 1_000_000,
            "maxTextureDimension": 4096,
        },
        "accessories": [],
    }
    progress(15)
    rigged_response = client.request_json(
        "POST",
        "/rig-pipeline/process",
        rig_request,
        client.config.rig_timeout_seconds,
    )
    rig = rigged_response.get("rig")
    output = rigged_response.get("output")
    if not isinstance(rig, dict) or rig.get("overallPass") is not True or not isinstance(output, dict):
        raise FinalizationError("RIG_VALIDATION_FAILED", "Blender rig did not pass its measured validation rules")
    output_sha256 = output.get("sha256")
    output_bytes = output.get("sizeBytes")
    if not isinstance(output_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", output_sha256) or not isinstance(output_bytes, int):
        raise FinalizationError("BLENDER_INVALID_ARTIFACT", "Blender rig artifact envelope is invalid")
    rigged = _decode_output(
        output,
        "glbBase64",
        output_sha256,
        output_bytes,
        client.config.max_glb_bytes,
    )
    rigged_path = _atomic_write(job_directory, "rigged.glb", rigged)
    progress(55)

    clip_start = client.request_json(
        "POST",
        "/bake-clips",
        {"rigged_glb_base64": base64.b64encode(rigged).decode("ascii"), "avatar_type": "dog"},
        60,
    )
    clip_job_id = clip_start.get("jobId")
    try:
        clip_job_id = str(uuid.UUID(str(clip_job_id)))
    except ValueError as error:
        raise FinalizationError("CLIP_JOB_INVALID", "Blender returned an invalid clip job ID") from error

    deadline = time.monotonic() + client.config.clip_timeout_seconds
    clip_response: dict[str, object] | None = None
    while time.monotonic() < deadline:
        status = client.request_json("GET", f"/jobs/{clip_job_id}", None, 30)
        if status.get("status") == "complete":
            result = status.get("result")
            if isinstance(result, dict):
                clip_response = result
                break
            raise FinalizationError("CLIP_RESULT_INVALID", "Blender returned no clip result")
        if status.get("status") == "failed":
            raise FinalizationError("CLIP_BAKE_FAILED", "Blender clip bake failed")
        progress(75)
        time.sleep(client.config.poll_interval_seconds)
    if clip_response is None:
        raise FinalizationError("CLIP_BAKE_TIMEOUT", "Blender clip bake timed out")

    clips = clip_response.get("clips")
    if not isinstance(clips, list) or len(clips) > 64:
        raise FinalizationError("CLIP_MANIFEST_INVALID", "Blender returned an invalid clip manifest")
    clip_names = {
        entry.get("name")
        for entry in clips
        if isinstance(entry, dict) and isinstance(entry.get("name"), str)
    }
    if not REQUIRED_CLIPS.issubset(clip_names):
        raise FinalizationError("REQUIRED_CLIPS_MISSING", "Final GLB is missing required idle or walk clips")
    final_glb = _decode_output(
        clip_response,
        "rigged_glb_base64",
        None,
        None,
        client.config.max_glb_bytes,
    )
    final_document = inspect_glb(final_glb, client.config.max_glb_bytes)
    animations = final_document.get("animations", [])
    if not isinstance(animations, list):
        raise FinalizationError("FINAL_CLIPS_MISSING", "Final GLB animation inventory is invalid")
    final_clip_names = {
        entry.get("name")
        for entry in animations
        if isinstance(entry, dict) and isinstance(entry.get("name"), str)
    }
    if not REQUIRED_CLIPS.issubset(final_clip_names):
        raise FinalizationError("FINAL_CLIPS_MISSING", "Final GLB bytes do not contain required idle or walk clips")
    final_path = _atomic_write(job_directory, "final.glb", final_glb)
    progress(95)
    return {
        "artifact_path": str(final_path),
        "artifact_sha256": hashlib.sha256(final_glb).hexdigest(),
        "artifact_bytes": len(final_glb),
        "rigged_path": str(rigged_path),
        "rigged_sha256": hashlib.sha256(rigged).hexdigest(),
        "rigged_bytes": len(rigged),
        "clip_job_id": clip_job_id,
        "clips": sorted(clip_names),
    }
