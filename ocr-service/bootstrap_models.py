"""
Model acquisition. Runs before uvicorn binds, so a fresh checkout starts with a
working detector and nobody ever has to fetch a weight by hand.

Why this exists
---------------
`main.get_detector()` was already correct: it re-resolves the path on every call
while unloaded, so a weight appearing in `models/` is picked up without a
restart. What was missing was anything that ever put a weight there. The README
said "drop a YOLOv8 plate detector at license_plate_detector.pt", which is a
manual step — and until someone performed it, `/health` reported
`detector: false` and plate localisation silently fell back to classical
morphology. That is a working pipeline, but not the strongest one.

Design constraints, in order of importance:

  • NEVER fatal. No network, a proxy, an offline machine, a 404 from the host —
    every one of these must leave the service starting normally with the
    classical fallback. A model download is an optimisation, not a dependency.
  • Verified. A weight is loaded by `torch.load` and is executable content, so
    it is checked against a pinned SHA-256 and discarded on mismatch rather than
    trusted because the URL looked right.
  • Idempotent and quiet. If the file is already present and correct, this does
    nothing and costs one hash.
  • Atomic. Downloads land on a temp file and are renamed only after the hash
    matches, so an interrupted download can never leave a truncated .pt that
    YOLO would fail to load.

Which weight, and why this one
------------------------------
Four candidates were measured against the labelled corpus (see
docs/PROJECT_PROGRESS.md). The India-specific model — the one the name suggests
you would pick for Indian plates — was the worst of the four: it boxed a false
positive on a negative image, truncated HR55AC3348 to HR55AC33, and missed
DL7CQ1939 completely. The weight pinned below read both positives correctly at
the highest detection *and* OCR confidence of the four, with no false positive.

Set OCR_SKIP_MODEL_FETCH=1 to disable, or OCR_PLATE_MODEL_URL/_SHA256 to pin a
different weight (for example an internally fine-tuned one).
"""

from __future__ import annotations

import hashlib
import os
import shutil
import sys
import tempfile
import urllib.request

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.environ.get("OCR_MODELS_DIR", os.path.join(SERVICE_DIR, "models"))

PLATE_FILENAME = os.environ.get("YOLO_MODEL", "license_plate_detector.pt")
PLATE_URL = os.environ.get(
    "OCR_PLATE_MODEL_URL",
    "https://huggingface.co/Koushim/yolov8-license-plate-detection/resolve/main/best.pt",
)
PLATE_SHA256 = os.environ.get(
    "OCR_PLATE_MODEL_SHA256",
    "2d95861825bb4184404344c9cf809f40fd31dba785fe54e8ba5b9a3583789822",
)

TIMEOUT_S = int(os.environ.get("OCR_MODEL_FETCH_TIMEOUT", "180"))


def _log(msg: str) -> None:
    # stdout so the Node supervisor captures it in the same stream as uvicorn.
    print(f"[models] {msg}", flush=True)


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_plate_model() -> bool:
    """
    Make sure the plate detector is on disk. Returns True if it is available
    afterwards. Never raises.
    """
    if os.environ.get("OCR_SKIP_MODEL_FETCH") == "1":
        return False

    target = os.path.join(MODELS_DIR, PLATE_FILENAME)

    if os.path.exists(target):
        # A truncated or swapped file is worse than a missing one: YOLO would
        # fail to load it and the service would run without a detector while
        # /health claimed a weight was found.
        if not PLATE_SHA256:
            return True
        actual = _sha256(target)
        if actual == PLATE_SHA256:
            return True
        _log(f"{PLATE_FILENAME} present but hash {actual[:12]}… != expected; re-fetching")

    if not PLATE_URL:
        return False

    try:
        os.makedirs(MODELS_DIR, exist_ok=True)
    except OSError as e:
        _log(f"cannot create {MODELS_DIR}: {e}; continuing without a detector")
        return False

    tmp_path = None
    try:
        _log(f"fetching plate detector → {target}")
        req = urllib.request.Request(PLATE_URL, headers={"User-Agent": "scrapflow-anpr"})
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            fd, tmp_path = tempfile.mkstemp(dir=MODELS_DIR, suffix=".part")
            with os.fdopen(fd, "wb") as out:
                shutil.copyfileobj(resp, out)

        if PLATE_SHA256:
            actual = _sha256(tmp_path)
            if actual != PLATE_SHA256:
                _log(f"checksum mismatch ({actual[:12]}…); discarding download")
                return False

        os.replace(tmp_path, target)  # atomic within the same filesystem
        tmp_path = None
        _log(f"plate detector ready ({os.path.getsize(target):,} bytes)")
        return True
    except Exception as e:
        # Offline, proxied, rate-limited, DNS-blocked — all land here, and all
        # are survivable: localisation falls back to morphology.
        _log(f"could not fetch plate detector ({e.__class__.__name__}: {e}); "
             "continuing with classical localisation")
        return False
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(0 if ensure_plate_model() else 1)
