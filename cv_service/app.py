from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import ValidationError

from cv_service import __version__
from cv_service.config import Settings, load_settings
from cv_service.registry import Registry
from cv_service.schema import (
    ClassCounts,
    CountRequest,
    CountResponse,
    HealthResponse,
    Signal,
)

logging.basicConfig(level=os.environ.get("CV_LOG_LEVEL", "INFO"))
logger = logging.getLogger("cv_service.app")

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _build_response(
    signal: Signal, result, capacity: int | None, latency_ms: float
) -> CountResponse:
    return CountResponse(
        count=result.count,
        class_counts=ClassCounts(
            person=result.class_counts.get("person", 0),
            car=result.class_counts.get("car", 0),
        ),
        confidence=result.confidence,
        model=result.model,
        source=result.source,
        signal=signal,
        capacity=capacity,
        timestamp=_now_iso(),
        latency_ms=round(latency_ms, 2),
    )

def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    registry = Registry(settings)

    app = FastAPI(
        title="Transport Assistant — CV Counting Service",
        version=__version__,
        description=(
            "Privacy-by-design counting service. Turns a frame into anonymous "
            "counts only. No face recognition, no identity, no biometric "
            "storage; frames are processed transiently and discarded."
        ),
    )
    app.state.settings = settings
    app.state.registry = registry

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(
            status="ok",
            version=__version__,
            force_mock=settings.force_mock,
            people_provider=registry.provider_name(Signal.PEOPLE),
            people_mode=registry.mode_for(Signal.PEOPLE),
            cars_provider=registry.provider_name(Signal.CARS),
            cars_mode=registry.mode_for(Signal.CARS),
        )

    def _count_bytes(signal: Signal, data: bytes, capacity: int | None) -> CountResponse:
        if not data:
            raise HTTPException(status_code=400, detail="Empty image payload.")
        if len(data) > settings.max_upload_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"Frame exceeds max size ({settings.max_upload_bytes} bytes).",
            )
        counter = registry.counter_for(signal)
        start = time.perf_counter()
        result = counter.count(data, capacity)
        latency_ms = (time.perf_counter() - start) * 1000.0

        return _build_response(signal, result, capacity, latency_ms)

    @app.post("/count", response_model=CountResponse)
    def count_by_path(req: CountRequest) -> CountResponse:
        if not req.image_path:
            raise HTTPException(
                status_code=400,
                detail="image_path is required for /count; use /count/upload for bytes.",
            )
        if not os.path.isfile(req.image_path):
            raise HTTPException(status_code=404, detail="image_path not found on server.")
        with open(req.image_path, "rb") as fh:
            data = fh.read()
        return _count_bytes(req.signal, data, req.capacity)

    @app.post("/count/upload", response_model=CountResponse)
    async def count_by_upload(
        signal: Signal = Form(...),
        capacity: int | None = Form(None),
        file: UploadFile = File(...),
    ) -> CountResponse:
        data = await file.read()

        return _count_bytes(signal, data, capacity)

    return app

app = create_app()
