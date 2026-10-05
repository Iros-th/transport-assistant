# CV Counting Service — Integration Guide

Privacy-by-design computer-vision microservice for the transportation
assistant. It turns a video/image/webcam **frame** into **anonymous counts
only** for two signals:

- **`people`** — dense crowd count inside a bus (occlusion-heavy) via
  [`lwcc`](https://github.com/tersekmatija/lwcc) (MIT), pretrained CSRNet /
  DM-Count.
- **`cars`** — parking-lot detection + count (cars and people) via
  [SAHI](https://github.com/obss/sahi) (MIT) tiling over a YOLO model.

The service runs on its own port (default **8800** / `${CV_SERVICE_PORT}`),
separate from the backend, and answers with counts, a confidence, provenance,
and timing — never images, crops, boxes tied to individuals, embeddings, or
identities.

---

## 1. What runs where

| Environment | Reality | Path |
|---|---|---|
| This sandbox / any CPU-only box | Linux, 2 vCPU, **no GPU, no webcam, no CV models** | **MOCK** — service boots and serves deterministic counts |
| Your machine | **Windows 11 + NVIDIA GPU + conda** | **LIVE** — real inference once the extras are installed |

The same code runs in both. Providers import the heavy libraries lazily and
fall back to MOCK if `lwcc` / `torch` / `sahi` / a YOLO checkpoint is missing,
if inference errors, or if `CV_FORCE_MOCK=1`. The `source` field on every
response tells you which path produced the number (`LIVE` or `MOCK`).

> **What was verified here:** the service was booted on the GPU-less sandbox
> via the MOCK path and all endpoints were exercised; the full test suite
> (16 tests) passes. **Real GPU inference on real bus/parking video was NOT
> run here** — there is no GPU, webcam, or model weights in this environment.
> That step is **USER-VERIFY** on your Windows box (Section 7).

---

## 2. Windows + conda + GPU setup (LIVE path)

Host Python 3.14 is too new for the CV wheels — create a dedicated **3.10 or
3.11** environment.

```powershell
# 1. Create and activate the env
conda create -n transport-cv python=3.11 -y
conda activate transport-cv

# 2. Install PyTorch with a CUDA build matching your driver.
#    Pick the index-url for your CUDA version from https://pytorch.org/get-started/locally/
pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu124

# 3. Base service deps
pip install -r cv_service\requirements-cv.txt

# 4. Real-inference extras (crowd counting + sliced detection + YOLO backend)
pip install lwcc==0.0.4 sahi==0.11.20 ultralytics==8.3.55

# 5. Confirm the GPU is visible to torch
python -c "import torch; print('CUDA available:', torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU only')"
```

**Models:**

- `lwcc` downloads its pretrained CSRNet / DM-Count weights automatically on
  first use. Select which with `CV_LWCC_MODEL_NAME` (`CSRNet` or `DM-Count`)
  and `CV_LWCC_MODEL_WEIGHTS` (`SHA`, `SHB`, `QNRF`).
- SAHI needs a local YOLO `.pt`. The Ultralytics package fetches `yolov8n.pt`
  on first use; point `CV_YOLO_MODEL_PATH` at whichever checkpoint you use.

---

## 3. Running the service

```powershell
# From transport-assistant\  (the folder that contains cv_service\)
conda activate transport-cv

# LIVE (real inference on your GPU box)
$env:CV_SERVICE_PORT = "8800"
python -m uvicorn cv_service.app:app --host 0.0.0.0 --port $env:CV_SERVICE_PORT

# MOCK (no models needed — CPU only, for dev/CI/demo)
$env:CV_FORCE_MOCK = "1"
python -m uvicorn cv_service.app:app --host 0.0.0.0 --port 8800
```

Boot command (this is exactly what was run on the sandbox, MOCK path):

```bash
CV_FORCE_MOCK=1 CV_SERVICE_PORT=8800 \
  python -m uvicorn cv_service.app:app --host 0.0.0.0 --port 8800
```

Check which path each signal will take:

```bash
curl http://127.0.0.1:8800/health
# {"status":"ok",...,"people_mode":"LIVE"|"MOCK","cars_mode":"LIVE"|"MOCK"}
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CV_SERVICE_PORT` | `8800` | Port to serve on |
| `CV_SERVICE_HOST` | `0.0.0.0` | Bind host |
| `CV_FORCE_MOCK` | `false` | Force deterministic MOCK counts everywhere |
| `CV_LWCC_MODEL_NAME` | `CSRNet` | lwcc model (`CSRNet` / `DM-Count`) |
| `CV_LWCC_MODEL_WEIGHTS` | `SHA` | lwcc weight set (`SHA`/`SHB`/`QNRF`) |
| `CV_YOLO_MODEL_PATH` | `yolov8n.pt` | YOLO checkpoint SAHI loads |
| `CV_SAHI_SLICE_HEIGHT` | `512` | SAHI tile height |
| `CV_SAHI_SLICE_WIDTH` | `512` | SAHI tile width |
| `CV_SAHI_OVERLAP_RATIO` | `0.2` | SAHI tile overlap |
| `CV_MAX_UPLOAD_BYTES` | `26214400` | Reject frames larger than this (25 MB) |

---

## 4. HTTP contract (what the backend consumes)

### `GET /health`
Returns service status and, per signal, whether it will answer `LIVE` or
`MOCK`.

### `POST /count` — JSON, image referenced by a server-visible path
```json
{ "signal": "people", "image_path": "/frames/bus_42.jpg", "capacity": 60 }
```
`signal` is `people` | `cars`. `capacity` is optional (bus seats+standing, or
parking spaces); it is echoed back untouched — the service does **not** compute
occupancy, so the backend derives any ratio itself.

### `POST /count/upload` — multipart, upload the frame bytes directly
Form fields: `signal` (required), `capacity` (optional), `file` (the image).
The uploaded bytes are processed in memory and discarded; they are never
written to disk or logged.

### Response (identical for both endpoints)
```json
{
  "count": 2,
  "class_counts": { "person": 2, "car": 0 },
  "confidence": 0.5,
  "model": "mock-people",
  "source": "MOCK",
  "signal": "people",
  "capacity": 60,
  "timestamp": "2026-09-29T17:32:53.625072+00:00",
  "latency_ms": 0.11
}
```

| Field | Type | Meaning |
|---|---|---|
| `count` | int ≥ 0 | Primary count for the requested signal (people, or cars) |
| `class_counts` | `{person:int, car:int}` | Per-class tally — only these two classes |
| `confidence` | float 0–1 | Method confidence (density estimate or mean detection score) |
| `model` | string | Estimator that produced the count |
| `source` | `LIVE` \| `MOCK` | Matches `core.enums.DataSource`; backend maps straight through |
| `signal` | `people` \| `cars` | Echo of the request |
| `capacity` | int \| null | Echo of supplied capacity (no image data) |
| `timestamp` | ISO-8601 UTC | When the count was produced |
| `latency_ms` | float | Inference wall-time |

The response schema is **closed**: a test asserts the key set is exactly these
fields, so no image data, path, crop, box, or embedding can leak into it.

Errors: `400` empty/invalid request, `404` `image_path` not found, `413` frame
too large, `422` invalid `signal`.

---

## 5. Connecting to the backend (`${CV_SERVICE_URL}`)

Point the backend at the service with `CV_SERVICE_URL` (e.g.
`http://127.0.0.1:8800`). `cv_service/client.py` is a dependency-free reference
client:

```python
from cv_service.client import count_by_path
res = count_by_path("people", "/frames/bus_42.jpg", capacity=60)
# res["count"], res["source"], res["class_counts"]["person"], ...
```

For webcam/live frames, grab a frame upstream and POST it to `/count/upload`;
the service treats every request as a single independent frame and keeps no
state between calls.

The `source` value (`LIVE`/`MOCK`) mirrors `core.enums.DataSource`, so the
backend can record provenance without translation and decide, for example, to
treat MOCK counts as `UNAVAILABLE` for real routing.

---

## 6. Licensing — read before shipping

| Component | License | Note |
|---|---|---|
| `lwcc` | MIT | Fine to ship |
| SAHI | MIT | Fine to ship |
| **Ultralytics YOLOv8 / YOLOv11** | **AGPL-3.0** | ⚠️ Copyleft |

SAHI is MIT, but the YOLO backend it loads (Ultralytics YOLOv8/v11) is
**AGPL-3.0**. AGPL's network clause means that if you ship a networked product
built on it, you may be obligated to release your own source under AGPL, or buy
an Ultralytics commercial license.

**Permissive swap for shipping:** keep SAHI (it is model-agnostic) and replace
the detector with a permissively licensed one, for example:

- **YOLO-NAS** (Deci / `super-gradients`, Apache-2.0),
- an **MMDetection** model (Apache-2.0), or
- a **Detectron2** model (Apache-2.0), or a plain **torchvision** detector
  (e.g. Faster R-CNN, BSD-3).

SAHI supports multiple backends via `AutoDetectionModel.from_pretrained(model_type=...)`,
so the swap is confined to `cv_service/providers/sahi_cars.py` (the
`model_type` and `model_path`) — the service contract does not change. The
crowd-counting path (`lwcc`) is already MIT and needs no change.

---

## 7. Expected latency & USER-VERIFY

**Latency (LIVE, rough, single frame on a modern NVIDIA GPU):**

- `people` / lwcc CSRNet: ~30–120 ms per frame.
- `cars` / SAHI+YOLO: **higher and variable** — SAHI runs one detection pass
  per tile, so a 512-px tiling of a large lot image can be several hundred ms
  to a few seconds depending on resolution, tile count, and model size. Tune
  `CV_SAHI_SLICE_*` and use a small YOLO (`yolov8n`) for speed, a larger one
  for accuracy. First call to either includes a one-time model load/warm-up.
- MOCK path: sub-millisecond (as measured here, `latency_ms` ≈ 0.04–0.11).

**USER-VERIFY (cannot be run in this environment — no GPU/webcam/models):**

1. Install the real-inference extras (Section 2) in a py3.10/3.11 conda env.
2. `GET /health` shows `people_mode: "LIVE"` and `cars_mode: "LIVE"`.
3. POST a **real crowded-bus image** to `/count/upload` with `signal=people`
   and confirm `source: "LIVE"` and a plausible crowd count.
4. POST a **real parking-lot image** with `signal=cars` and confirm `source:
   "LIVE"`, a plausible car count, and that SAHI recovers small/distant cars a
   single pass misses.
5. Measure real `latency_ms` on your hardware and tune SAHI tiling.
6. Confirm the licensing decision (Section 6) before any external release.

---

## 8. Privacy statement

This service is designed so it *cannot* identify anyone.

**Processed (transiently, in memory):** one image frame per request, decoded
only long enough to estimate counts. For the path endpoint the file is read;
for the upload endpoint the bytes live only as a local variable for the
duration of the call.

**Produced and returned:** integer counts (`count`, `class_counts` for exactly
`person` and `car`), a scalar `confidence`, the `model` name, `source`,
`signal`, echoed `capacity`, a `timestamp`, and `latency_ms`. Nothing else.

**Stored:** nothing. No frames, no crops, no detections, no density maps, no
bounding boxes, no filenames. The upload endpoint never writes the frame to
disk; the lwcc path uses a temp file only because lwcc's API takes a path, and
deletes it in a `finally` block before returning. Intermediate artifacts
(lwcc's density map, SAHI's boxes) are reduced to counts and discarded within
the provider.

**Never collected:** no face recognition, no facial landmarks, no
re-identification or tracking across frames, no biometric templates or
embeddings, no per-individual coordinates, no personally identifying
information. Bounding boxes computed internally by the detector are tallied by
class and dropped; they never leave the provider and are never returned or
logged.

A test (`tests/test_privacy.py`) embeds a unique marker in a frame and asserts
it never appears in the serialized response, and asserts the response key set
contains none of `image`, `crop`, `bbox`, `embedding`, `face`, `identity`,
`track`, `path`, `filename`, etc.
