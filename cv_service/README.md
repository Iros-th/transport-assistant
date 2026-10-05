# cv_service — privacy-by-design counting microservice

Turns a frame into **anonymous counts only** for two signals — `people` (dense
crowd count in a bus, via lwcc) and `cars` (parking-lot detection+count, via
SAHI over YOLO). Runs on its own port (default `8800` / `${CV_SERVICE_PORT}`),
separate from the backend. No face recognition, no identity, no biometric
storage; frames are processed transiently and discarded.

Full setup, HTTP contract, GPU/Windows install, licensing, latency, and the
privacy statement: **[docs/CV_INTEGRATION.md](docs/CV_INTEGRATION.md)**.

## Quick start (MOCK path — no GPU/models needed)

```bash
pip install -r requirements-cv.txt          # base tier only
CV_FORCE_MOCK=1 python -m uvicorn cv_service.app:app --host 0.0.0.0 --port 8800
curl http://127.0.0.1:8800/health
```

## Layout

```
cv_service/
  app.py                 FastAPI app: /health, /count, /count/upload
  schema.py              counts-only wire schema (no image fields anywhere)
  config.py              env-driven settings
  registry.py            maps signal -> provider, built once at startup
  client.py              dependency-free reference client for the backend
  providers/
    base.py              Counter interface + CountResult (no pixels)
    mock.py              deterministic MockCounter (tests/demo/CPU)
    lwcc_people.py       LwccPeopleCounter (guarded import -> MOCK fallback)
    sahi_cars.py         SahiCarCounter   (guarded import -> MOCK fallback)
  tests/                 mock path, schema, graceful fallback, privacy
  requirements-cv.txt    base tier + marked real-inference extras
  docs/CV_INTEGRATION.md integration guide
```

## Tests

```bash
python -m pytest cv_service/tests    # 16 tests, all mock-path (no GPU needed)
```
