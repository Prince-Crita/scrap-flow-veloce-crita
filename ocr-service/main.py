"""
Scrap Flow · Veloce — ANPR / OCR microservice.

Pipeline per image:
  vehicle detection (narrow the frame)
    -> plate localisation (YOLO plate model, else classical morphology)
    -> up to N candidate regions, best first
    -> per region: perspective correction, then a ladder of preprocessing
       variants (enhanced grey, sharpened, adaptive threshold ×2, Otsu,
       inverted Otsu, 2× upscale)
    -> OCR each variant, pool every read as a candidate
    -> grammar-aware repair + scoring (plate.py) -> best result

Front is processed first. If it does not clear the acceptance bar the rear is
processed too, and finally both candidate pools are fused: two independent
reads that agree are the strongest evidence available.

OCR is *assistive*. Every failure path returns plate=null so the Next.js app
falls back to manual entry and the yard workflow is never blocked. Manual
editing is always available regardless of what this service returns.

Endpoints:
  GET  /health   -> liveness + component availability
  POST /anpr     -> { image, image_back? }  (data URLs)
                    returns { plate, confidence, crop, source, agreed, attempts }
Auth: shared secret via `x-ocr-secret` (matches OCR_SERVICE_SECRET).
"""

from __future__ import annotations

import base64
import os
from io import BytesIO
from typing import List, Optional, Tuple

import cv2
import numpy as np
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel

from plate import Candidate, Fragment, Verdict, assemble, best, clean_plate, fuse, is_structural

try:
    from ultralytics import YOLO  # type: ignore
except Exception:  # pragma: no cover
    YOLO = None

try:
    from paddleocr import PaddleOCR  # type: ignore
except Exception:  # pragma: no cover
    PaddleOCR = None

OCR_SECRET = os.environ.get("OCR_SERVICE_SECRET", "change-me-shared-secret")

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(SERVICE_DIR, "models")


def resolve_model(filename: str) -> Optional[str]:
    """
    Find a model weight, or return None.

    Searched in order: an absolute/explicit path, then `ocr-service/models/`, then
    `ocr-service/` itself, then the working directory.

    The point is that **dropping a weight file into `ocr-service/models/` upgrades
    accuracy with no code change and no redeploy** — the loaders below are lazy and
    re-check on every call until they succeed, so a file added while the service is
    running is picked up on the next request. Paths are resolved relative to this
    file rather than the process CWD, because the service is spawned by the Node
    app and must not depend on where that happened to be launched from.
    """
    if os.path.isabs(filename):
        return filename if os.path.exists(filename) else None
    for base in (MODELS_DIR, SERVICE_DIR, os.getcwd()):
        candidate = os.path.join(base, filename)
        if os.path.exists(candidate):
            return candidate
    return None


# Dedicated plate detector. Optional but the single biggest accuracy lever: with
# it, plate localisation is a trained detection instead of classical morphology.
YOLO_MODEL_NAME = os.environ.get("YOLO_MODEL", "license_plate_detector.pt")
# Generic COCO model used to find the vehicle first. Optional: if it is absent
# the whole frame is searched, which is the previous behaviour.
VEHICLE_MODEL_NAME = os.environ.get("VEHICLE_MODEL", "yolov8n.pt")

# Stop early once a read is this good — further passes cost latency at the
# weighbridge and cannot improve on a structurally valid, high-confidence plate.
ACCEPT_CONF = 0.88
# Below this the UI asks the operator to confirm; it never blocks them.
CONF_WARN = 0.80

# COCO class ids for things that carry a number plate.
VEHICLE_CLASSES = {2, 3, 5, 7}  # car, motorcycle, bus, truck

MAX_REGIONS = 3  # candidate plate regions per image

app = FastAPI(title="Scrap Flow ANPR", version="3.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_detector = None
_vehicle = None
_ocr = None


def get_detector():
    """
    Plate detector, loaded lazily and re-checked until found.

    Deliberately re-resolves the path on every call while still unloaded, so a
    weight dropped into `models/` after startup is picked up without a restart.
    Once loaded it is cached — YOLO construction is expensive.
    """
    global _detector
    if _detector is None and YOLO is not None:
        path = resolve_model(YOLO_MODEL_NAME)
        if path:
            try:
                _detector = YOLO(path)
            except Exception:
                # A corrupt or incompatible weight must not take the service down;
                # localisation falls back to morphology exactly as if it were absent.
                _detector = None
    return _detector


def get_vehicle_detector():
    """Vehicle detector. Same lazy, re-checking, never-fatal contract as above."""
    global _vehicle
    if _vehicle is None and YOLO is not None:
        path = resolve_model(VEHICLE_MODEL_NAME)
        if path:
            try:
                _vehicle = YOLO(path)
            except Exception:
                _vehicle = None
    return _vehicle


def get_ocr():
    global _ocr
    if _ocr is None and PaddleOCR is not None:
        _ocr = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
    return _ocr


class AnprRequest(BaseModel):
    image: str
    image_back: Optional[str] = None


class AnprResponse(BaseModel):
    plate: Optional[str] = None
    confidence: float = 0.0
    crop: Optional[str] = None
    source: Optional[str] = None  # "front" | "back" | "both"
    agreed: bool = False
    attempts: int = 0


# ---------------- image helpers ----------------
def decode_bgr(data_url: str) -> np.ndarray:
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]
    raw = base64.b64decode(data_url)
    pil = Image.open(BytesIO(raw)).convert("RGB")
    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)


def encode_jpeg(bgr: np.ndarray) -> str:
    ok, buf = cv2.imencode(".jpg", bgr)
    if not ok:
        return ""
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()


def enhance(gray: np.ndarray) -> np.ndarray:
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    g = clahe.apply(gray)
    return cv2.bilateralFilter(g, 11, 17, 17)  # denoise while keeping edges


def sharpen(gray: np.ndarray) -> np.ndarray:
    blur = cv2.GaussianBlur(gray, (0, 0), 3)
    return cv2.addWeighted(gray, 1.5, blur, -0.5, 0)  # unsharp mask


def deskew(gray: np.ndarray) -> np.ndarray:
    inv = cv2.bitwise_not(gray)
    coords = np.column_stack(np.where(inv > 127))
    if coords.shape[0] < 20:
        return gray
    angle = cv2.minAreaRect(coords.astype(np.float32))[-1]
    angle = 90 + angle if angle < -45 else angle
    if abs(angle) < 0.5 or abs(angle) > 30:
        return gray  # a >30° "skew" is a bad fit, not a tilted plate
    h, w = gray.shape
    m = cv2.getRotationMatrix2D((w // 2, h // 2), angle, 1.0)
    return cv2.warpAffine(gray, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def four_point_warp(bgr: np.ndarray) -> np.ndarray:
    """Best-effort perspective correction: find the plate's quadrilateral and
    warp it to a straight rectangle. Falls back to the original crop."""
    try:
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 50, 150)
        contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        contours = sorted(contours, key=cv2.contourArea, reverse=True)[:5]
        for c in contours:
            peri = cv2.arcLength(c, True)
            approx = cv2.approxPolyDP(c, 0.02 * peri, True)
            if len(approx) == 4 and cv2.contourArea(c) > 0.2 * bgr.shape[0] * bgr.shape[1]:
                pts = approx.reshape(4, 2).astype(np.float32)
                s = pts.sum(axis=1)
                d = np.diff(pts, axis=1)
                rect = np.array(
                    [pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]],
                    dtype=np.float32,
                )
                (tl, tr, br, bl) = rect
                wA = np.linalg.norm(br - bl)
                wB = np.linalg.norm(tr - tl)
                hA = np.linalg.norm(tr - br)
                hB = np.linalg.norm(tl - bl)
                maxW, maxH = int(max(wA, wB)), int(max(hA, hB))
                if maxW < 40 or maxH < 15:
                    return bgr
                dst = np.array([[0, 0], [maxW - 1, 0], [maxW - 1, maxH - 1], [0, maxH - 1]], dtype=np.float32)
                m = cv2.getPerspectiveTransform(rect, dst)
                return cv2.warpPerspective(bgr, m, (maxW, maxH))
    except Exception:
        pass
    return bgr


# ---------------- localisation ----------------
def detect_vehicle(bgr: np.ndarray) -> np.ndarray:
    """
    Narrow the frame to the vehicle before hunting for a plate.

    At a weighbridge the camera catches the gate, other trucks and painted
    signage; restricting the search to the vehicle removes most of the text
    that competes with the real plate. If no vehicle model is available, or
    nothing is found, the untouched frame is returned.
    """
    model = get_vehicle_detector()
    if model is None:
        return bgr
    try:
        results = model.predict(bgr, verbose=False)
        boxes = results[0].boxes if results else None
        if boxes is None or len(boxes) == 0:
            return bgr
        xyxy = boxes.xyxy.cpu().numpy()
        cls = boxes.cls.cpu().numpy().astype(int)
        conf = boxes.conf.cpu().numpy()
        keep = [i for i in range(len(cls)) if cls[i] in VEHICLE_CLASSES and conf[i] > 0.35]
        if not keep:
            return bgr
        # Largest vehicle — the one on the weighbridge, not one in the background.
        i = max(keep, key=lambda k: (xyxy[k][2] - xyxy[k][0]) * (xyxy[k][3] - xyxy[k][1]))
        x1, y1, x2, y2 = xyxy[i].astype(int)
        h, w = bgr.shape[:2]
        # Pad: plates sit at the very edge of the body and a tight box clips them.
        px, py = int(0.05 * (x2 - x1)), int(0.05 * (y2 - y1))
        x1, y1 = max(0, x1 - px), max(0, y1 - py)
        x2, y2 = min(w, x2 + px), min(h, y2 + py)
        crop = bgr[y1:y2, x1:x2]
        return crop if crop.size > 0 else bgr
    except Exception:
        return bgr


def localise_classical(bgr: np.ndarray) -> List[np.ndarray]:
    """
    Plate localisation without a trained detector.

    Number plates are high-contrast horizontal bars of text, which a blackhat
    morphology pass isolates well. This exists because the previous pipeline
    fell back to OCR-ing the *entire frame* whenever the YOLO weights were
    missing — the single biggest cause of "couldn't read plate automatically"
    on a machine where the model was never downloaded.
    """
    out: List[np.ndarray] = []
    try:
        h, w = bgr.shape[:2]
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        rect = cv2.getStructuringElement(cv2.MORPH_RECT, (25, 7))
        blackhat = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, rect)
        grad = cv2.Sobel(blackhat, cv2.CV_32F, 1, 0, ksize=-1)
        grad = np.absolute(grad)
        lo, hi = float(grad.min()), float(grad.max())
        if hi - lo < 1e-6:
            return out
        grad = (255 * ((grad - lo) / (hi - lo))).astype("uint8")
        grad = cv2.GaussianBlur(grad, (5, 5), 0)
        grad = cv2.morphologyEx(grad, cv2.MORPH_CLOSE, rect)
        thresh = cv2.threshold(grad, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1]
        thresh = cv2.erode(thresh, None, iterations=2)
        thresh = cv2.dilate(thresh, None, iterations=2)

        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        scored: List[Tuple[float, np.ndarray]] = []
        for c in contours:
            x, y, cw, chh = cv2.boundingRect(c)
            if chh == 0 or cw < 40 or chh < 12:
                continue
            ar = cw / float(chh)
            # Indian plates are ~2:1 (two-line) to ~5.5:1 (single-line).
            if not (1.8 <= ar <= 6.5):
                continue
            area = cw * chh
            if area < 0.0008 * w * h or area > 0.35 * w * h:
                continue
            pad = int(0.08 * chh)
            x1, y1 = max(0, x - pad), max(0, y - pad)
            x2, y2 = min(w, x + cw + pad), min(h, y + chh + pad)
            crop = bgr[y1:y2, x1:x2]
            if crop.size == 0:
                continue
            # Prefer larger, lower-in-frame regions: plates sit below the cab.
            scored.append((area * (0.5 + 0.5 * (y / max(1, h))), crop))
        scored.sort(key=lambda t: t[0], reverse=True)
        out = [c for _, c in scored[:MAX_REGIONS]]
    except Exception:
        pass
    return out


def candidate_regions(bgr: np.ndarray) -> List[np.ndarray]:
    """
    Ordered plate candidates, best guess first.

    The trained detector is tried first and its top boxes are used. Classical
    localisation is appended rather than used only as a replacement, so a weak
    detection does not lock out the morphology result. The full frame remains
    the last resort — it is a poor input, but it must never be the only one.
    """
    regions: List[np.ndarray] = []
    detector = get_detector()
    if detector is not None:
        try:
            results = detector.predict(bgr, verbose=False)
            boxes = results[0].boxes if results else None
            if boxes is not None and len(boxes) > 0:
                confs = boxes.conf.cpu().numpy()
                xyxy = boxes.xyxy.cpu().numpy()
                order = np.argsort(-confs)[:MAX_REGIONS]
                h, w = bgr.shape[:2]
                for idx in order:
                    x1, y1, x2, y2 = xyxy[idx].astype(int)
                    pad = int(0.06 * max(1, y2 - y1))
                    x1, y1 = max(0, x1 - pad), max(0, y1 - pad)
                    x2, y2 = min(w, x2 + pad), min(h, y2 + pad)
                    crop = bgr[y1:y2, x1:x2]
                    if crop.size > 0:
                        regions.append(crop)
        except Exception:
            pass

    regions.extend(localise_classical(bgr))
    regions.append(bgr)
    return regions[: MAX_REGIONS + 1]


# ---------------- preprocessing ladder ----------------
def preprocess_variants(bgr: np.ndarray) -> List[Tuple[str, np.ndarray]]:
    """
    Several readings of the same crop, cheapest and most-likely first.

    No single preprocessing wins on every plate: adaptive threshold rescues
    glare, Otsu rescues even lighting, inversion rescues white-on-black
    commercial plates, and upscaling rescues a plate photographed from too far
    back. Trying them in order and pooling the reads is what "retry with
    alternate preprocessing before failing" means in practice.
    """
    warped = four_point_warp(bgr)
    gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)

    # A too-small crop starves the OCR; scale it up before anything else.
    if gray.shape[0] < 48:
        f = max(2.0, 48.0 / max(1, gray.shape[0]))
        gray = cv2.resize(gray, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)

    base = deskew(sharpen(enhance(gray)))
    variants: List[Tuple[str, np.ndarray]] = [("enhanced", base)]

    try:
        variants.append(
            ("adaptive31", cv2.adaptiveThreshold(base, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 11))
        )
        variants.append(
            ("adaptive15", cv2.adaptiveThreshold(base, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 15, 7))
        )
        otsu = cv2.threshold(base, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1]
        variants.append(("otsu", otsu))
        # Commercial vehicles carry white-on-black plates; OCR engines are
        # trained on dark-on-light, so the inverse is a genuinely different read.
        variants.append(("otsu_inv", cv2.bitwise_not(otsu)))
        variants.append(("upscaled", cv2.resize(base, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)))
    except Exception:
        pass
    return variants


def run_ocr(gray: np.ndarray) -> List[Fragment]:
    """
    OCR one preprocessed image, keeping each text box's POSITION.

    The geometry used to be discarded. It is needed: a two-line plate arrives as two
    boxes, and putting them back together requires knowing which one is on top.
    A box's centre is enough — `plate.assemble` only needs a reading order.
    """
    ocr = get_ocr()
    if ocr is None:
        return []
    rgb = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR) if len(gray.shape) == 2 else gray
    try:
        result = ocr.ocr(rgb, cls=True)
    except Exception:
        return []
    out: List[Fragment] = []
    for line in result or []:
        for entry in line or []:
            try:
                text, conf = entry[1][0], float(entry[1][1])
            except Exception:
                continue
            y = x = 0.0
            try:
                pts = np.array(entry[0], dtype=float)
                y, x = float(pts[:, 1].mean()), float(pts[:, 0].mean())
            except Exception:
                # No geometry (or an unexpected shape) — the fragment is still a
                # usable single-line read, it just cannot take part in assembly.
                pass
            out.append(Fragment(text, conf, y, x))
    return out


def collect_candidates(data_url: str, source: str) -> Tuple[List[Candidate], Optional[str], int]:
    """
    Every read this image can produce, plus the crop shown back to the operator.

    Returns (candidates, crop_data_url, attempts). Attempts is reported so the
    proxy can log how hard the service had to work — a rising average is the
    early warning that camera placement has drifted.
    """
    bgr = decode_bgr(data_url)
    framed = detect_vehicle(bgr)

    candidates: List[Candidate] = []
    crop_out: Optional[str] = None
    attempts = 0

    for region in candidate_regions(framed):
        for name, img in preprocess_variants(region):
            attempts += 1
            reads = run_ocr(img)
            if not reads:
                continue
            if crop_out is None:
                crop_out = encode_jpeg(region)
            for frag in reads:
                cleaned = clean_plate(frag.text)
                if len(cleaned) >= 6:
                    candidates.append(Candidate(cleaned, frag.confidence, source, name))
            # Two-line plates: neither half reaches six characters on its own, so
            # without this a perfectly legible truck plate scores zero.
            for joined, conf in assemble(reads):
                candidates.append(Candidate(joined, conf, source, f"{name}+joined"))
            # A structurally valid, confident read on this region is as good as
            # it gets — stop burning latency on the remaining variants.
            v = best(candidates)
            if v.plate and is_structural(v.plate) and v.confidence >= ACCEPT_CONF:
                return candidates, crop_out or encode_jpeg(region), attempts

    if crop_out is None:
        crop_out = encode_jpeg(framed)
    return candidates, crop_out, attempts


# ---------------- endpoints ----------------
@app.get("/health")
def health():
    plate_model = resolve_model(YOLO_MODEL_NAME)
    return {
        "status": "ok",
        "detector": get_detector() is not None,
        "vehicle_detector": get_vehicle_detector() is not None,
        "ocr": get_ocr() is not None,
        # Where to put a missing weight. Without this an admin sees "detector:
        # false" with no way to know what file is wanted or where it belongs.
        "models_dir": MODELS_DIR,
        "plate_model_expected": YOLO_MODEL_NAME,
        "plate_model_found": plate_model,
    }


@app.post("/anpr", response_model=AnprResponse)
def anpr(req: AnprRequest, x_ocr_secret: str = Header(default="")):
    if x_ocr_secret != OCR_SECRET:
        raise HTTPException(status_code=401, detail="bad secret")

    attempts = 0
    front_cands: List[Candidate] = []
    back_cands: List[Candidate] = []
    front_crop: Optional[str] = None
    back_crop: Optional[str] = None

    try:
        front_cands, front_crop, a = collect_candidates(req.image, "front")
        attempts += a
    except Exception:
        pass

    front_verdict: Verdict = best(front_cands)

    # Front was good enough on its own — don't pay for the rear pass.
    if front_verdict.plate and is_structural(front_verdict.plate) and front_verdict.confidence >= ACCEPT_CONF:
        return AnprResponse(
            plate=front_verdict.plate,
            confidence=front_verdict.confidence,
            crop=front_crop,
            source="front",
            agreed=False,
            attempts=attempts,
        )

    if req.image_back:
        try:
            back_cands, back_crop, a = collect_candidates(req.image_back, "back")
            attempts += a
        except Exception:
            pass

    # Combined pass: agreement between the two views, else the best pooled read.
    verdict = fuse(front_cands, back_cands)

    crop = front_crop
    if verdict.source == "back":
        crop = back_crop or front_crop

    return AnprResponse(
        plate=verdict.plate,
        confidence=verdict.confidence,
        crop=crop,
        source=verdict.source,
        agreed=verdict.agreed,
        attempts=attempts,
    )
