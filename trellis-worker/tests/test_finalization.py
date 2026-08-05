from __future__ import annotations

import base64
import hashlib
import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_ROOT))

from finalization import (  # noqa: E402
    BlenderClient,
    FinalizationConfig,
    FinalizationError,
    finalize_trellis_job,
)


JOB_ID = "11111111-1111-4111-8111-111111111111"
CLIP_JOB_ID = "22222222-2222-4222-8222-222222222222"


def triangle_glb(generator: str, clips: list[str] | None = None) -> bytes:
    document = {
        "asset": {"version": "2.0", "generator": generator},
        "accessors": [{"componentType": 5126, "count": 3, "type": "VEC3"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "mode": 4}]}],
        "nodes": [{"mesh": 0}],
        "scenes": [{"nodes": [0]}],
        "scene": 0,
        **({"animations": [{"name": name, "channels": [], "samplers": []} for name in clips]} if clips else {}),
    }
    encoded = json.dumps(document, separators=(",", ":")).encode("utf-8")
    padded = encoded + b" " * ((4 - len(encoded) % 4) % 4)
    total = 20 + len(padded)
    return (
        b"glTF"
        + (2).to_bytes(4, "little")
        + total.to_bytes(4, "little")
        + len(padded).to_bytes(4, "little")
        + bytes.fromhex("4a534f4e")
        + padded
    )


class FakeBlenderClient:
    def __init__(self, rigged: bytes, final: bytes, clips: list[str]):
        self.config = FinalizationConfig(
            blender_url="http://blender-worker:10000",
            worker_secret="test-worker-secret-value",
            allowed_hosts=frozenset({"blender-worker"}),
            poll_interval_seconds=0,
        )
        self.rigged = rigged
        self.final = final
        self.clips = clips
        self.calls: list[tuple[str, str, object]] = []
        self.polls = 0

    def request_json(self, method: str, route: str, payload, _timeout: int):
        self.calls.append((method, route, payload))
        if route == "/rig-pipeline/process":
            return {
                "rig": {"overallPass": True},
                "output": {
                    "glbBase64": base64.b64encode(self.rigged).decode("ascii"),
                    "sha256": hashlib.sha256(self.rigged).hexdigest(),
                    "sizeBytes": len(self.rigged),
                },
            }
        if route == "/bake-clips":
            return {"jobId": CLIP_JOB_ID, "status": "processing"}
        if route == f"/jobs/{CLIP_JOB_ID}":
            self.polls += 1
            if self.polls == 1:
                return {"status": "processing"}
            return {
                "status": "complete",
                "result": {
                    "rigged_glb_base64": base64.b64encode(self.final).decode("ascii"),
                    "clips": [{"name": name, "loop": True, "durationSec": 1} for name in self.clips],
                },
            }
        raise AssertionError(f"unexpected route {route}")


class FinalizationTests(unittest.TestCase):
    def test_internal_rig_and_clip_flow_writes_verified_artifacts(self):
        rigged = triangle_glb("rigged")
        final = triangle_glb("final", ["idle", "walk", "tail_wag"])
        client = FakeBlenderClient(rigged, final, ["idle", "walk", "tail_wag"])
        progress: list[int] = []
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / JOB_ID
            directory.mkdir(mode=0o700)
            result = finalize_trellis_job(
                JOB_ID,
                hashlib.sha256(triangle_glb("source")).hexdigest(),
                len(triangle_glb("source")),
                directory,
                client,
                progress.append,
            )
            self.assertEqual((directory / "rigged.glb").read_bytes(), rigged)
            self.assertEqual((directory / "final.glb").read_bytes(), final)
            self.assertEqual(result["artifact_sha256"], hashlib.sha256(final).hexdigest())
            self.assertEqual(result["clips"], ["idle", "tail_wag", "walk"])
        rig_request = client.calls[0][2]
        self.assertEqual(
            rig_request["source"]["locator"],
            f"artifact+local://model-builds/{JOB_ID}/master.glb",
        )
        self.assertEqual(progress, [15, 55, 75, 95])

    def test_missing_required_clip_fails_without_final_artifact(self):
        client = FakeBlenderClient(triangle_glb("rigged"), triangle_glb("final", ["idle"]), ["idle"])
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / JOB_ID
            directory.mkdir(mode=0o700)
            with self.assertRaisesRegex(FinalizationError, "idle or walk") as raised:
                finalize_trellis_job(
                    JOB_ID,
                    "a" * 64,
                    100,
                    directory,
                    client,
                )
            self.assertEqual(raised.exception.code, "REQUIRED_CLIPS_MISSING")
            self.assertFalse((directory / "final.glb").exists())

    def test_clip_manifest_cannot_claim_clips_absent_from_final_glb(self):
        client = FakeBlenderClient(
            triangle_glb("rigged"),
            triangle_glb("final", ["idle"]),
            ["idle", "walk"],
        )
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / JOB_ID
            directory.mkdir(mode=0o700)
            with self.assertRaises(FinalizationError) as raised:
                finalize_trellis_job(JOB_ID, "a" * 64, 100, directory, client)
            self.assertEqual(raised.exception.code, "FINAL_CLIPS_MISSING")
            self.assertFalse((directory / "final.glb").exists())

    def test_blender_client_rejects_non_allowlisted_origin(self):
        with self.assertRaises(FinalizationError) as raised:
            BlenderClient(FinalizationConfig(
                blender_url="https://outside.example",
                worker_secret="test-worker-secret-value",
                allowed_hosts=frozenset({"blender-worker"}),
            ))
        self.assertEqual(raised.exception.code, "BLENDER_URL_REJECTED")

    def test_rig_hash_mismatch_fails_before_clip_bake(self):
        rigged = triangle_glb("rigged")
        client = FakeBlenderClient(rigged, triangle_glb("final", ["idle", "walk"]), ["idle", "walk"])
        original_request = client.request_json

        def request_with_bad_hash(method, route, payload, timeout):
            response = original_request(method, route, payload, timeout)
            if route == "/rig-pipeline/process":
                response["output"]["sha256"] = "0" * 64
            return response

        client.request_json = request_with_bad_hash
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / JOB_ID
            directory.mkdir(mode=0o700)
            with self.assertRaises(FinalizationError) as raised:
                finalize_trellis_job(JOB_ID, "a" * 64, 100, directory, client)
            self.assertEqual(raised.exception.code, "BLENDER_ARTIFACT_HASH")
            self.assertFalse((directory / "rigged.glb").exists())
            self.assertFalse(any(route == "/bake-clips" for _, route, _ in client.calls))


if __name__ == "__main__":
    unittest.main()
