# Scrap Flow · ANPR / OCR Microservice

FastAPI service that extracts a vehicle number plate from the front-vehicle
image captured in the Inward workflow.

**Pipeline:**

```
vehicle detection (COCO YOLOv8n, narrows the frame)
  → plate localisation — trained YOLO detector AND classical blackhat
    morphology, pooled, best-first, full frame as last resort
  → per region: perspective correction (four-point warp) + deskew
  → preprocessing ladder: enhanced grey · sharpened · adaptive threshold ×2
    · Otsu · inverted Otsu · 2× upscale
  → PaddleOCR on every variant, all reads pooled as candidates
  → grammar-aware repair + scoring (plate.py) → best result
```

Front is processed first and short-circuits on a confident, structurally valid
read. Otherwise the rear is processed too and both candidate pools are fused:
**two independent reads that agree are the strongest evidence available** and
are reported as `agreed: true`.

OCR is *assistive*. Any failure returns `plate: null` so the app falls back to
manual entry, and **manual editing is always available** regardless of what the
service returns — it never gates the yard workflow.

## Where the accuracy comes from

`plate.py` holds the decision layer, deliberately free of cv2/torch/fastapi so
it is testable on any machine. Most real failures are not unreadable plates but
*nearly correct* reads — character confusions (0/O, 1/I, 8/B, 5/S) and stray
text from the bumper. Knowing the legal Indian plate grammar lets those reads be
repaired instead of discarded:

- **Grammar:** standard `AA-D(D)-A{0,3}-D{3,4}` and Bharat `DD-BH-DDDD-A{1,2}`.
- **Positional repair:** characters are coerced only at positions whose class
  the grammar fixes, and only if the result is a valid plate. When several
  layouts produce valid plates, the repair changing the **fewest characters**
  wins. An already-valid read is never rewritten.
- **Scoring:** structure and a real state code outweigh raw OCR confidence, so a
  crisp read of the "IND" hologram cannot beat a blurred read of the plate.
  All-letters or all-digits reads are rejected outright.

Tested by `python ocr-service/test_plate.py` (`npm run test:ocr`) — 54
assertions, no model weights or GPU required.

## Run locally

```bash
cd ocr-service
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # set OCR_SERVICE_SECRET to match the Next.js app
uvicorn main:app --reload --port 8000
```

Then in the Next.js app `.env`:

```
OCR_SERVICE_URL="http://localhost:8000"
OCR_SERVICE_SECRET="<same secret>"
```

## Number-plate model

**Nothing to do.** `run.py` calls `bootstrap_models.ensure_plate_model()` before
uvicorn binds the port, which fetches the pinned plate detector into `models/`,
verifies it against a pinned SHA-256, and writes it atomically. It is idempotent
(~0.15 s once the file is present) and never fatal: offline, proxied or
rate-limited machines log one line and start with classical localisation.

`main.get_detector()` re-resolves the path while unloaded, so a weight that
arrives after startup is picked up **without a restart**.

| Variable | Effect |
|---|---|
| `OCR_SKIP_MODEL_FETCH=1` | never download; use whatever is on disk |
| `OCR_PLATE_MODEL_URL` / `OCR_PLATE_MODEL_SHA256` | pin a different weight, e.g. an internally fine-tuned one |
| `YOLO_MODEL` | filename to look for (default `license_plate_detector.pt`) |
| `VEHICLE_MODEL` | generic `yolov8n.pt`, crops to the vehicle first so gate signage and background trucks are excluded |

The pinned weight was chosen by measurement, not by name — four candidates were
scored against the labelled corpus and the India-specific one was the *worst*
(false positive on a negative, truncated `HR55AC33`, missed `DL7CQ1939`). See
the 2026-07-27 entry in `docs/PROJECT_PROGRESS.md`.

Both models remain optional. Without the plate model the service falls back to
classical blackhat-morphology localisation rather than OCR-ing the entire frame.

## Endpoints

| Method | Path      | Body                              | Returns                          |
|--------|-----------|-----------------------------------|----------------------------------|
| GET    | `/health` | –                                 | `{status, detector, vehicle_detector, ocr}` |
| POST   | `/anpr`   | `{ "image": "data:...", "image_back": "data:..."? }` | `{ plate, confidence, crop, source, agreed, attempts }` |

`source` is `"front"`, `"back"` or `"both"`. `agreed` is true only when the two
images independently produced the same plate. `attempts` counts preprocessing
passes — a rising average means camera placement or lighting has drifted.

`/anpr` requires header `x-ocr-secret: <OCR_SERVICE_SECRET>`.

## Deploy

Container hosts (Render / Railway / Fly.io) suit the heavy ML image better than
Vercel. Build with the included `Dockerfile`, expose `$PORT`, set env vars.
