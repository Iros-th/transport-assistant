from __future__ import annotations

import os
from dataclasses import dataclass

def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default

def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}

@dataclass(frozen=True)
class Settings:

    port: int
    host: str

    force_mock: bool

    lwcc_model_name: str
    lwcc_model_weights: str
    yolo_model_path: str

    sahi_slice_height: int
    sahi_slice_width: int
    sahi_overlap_ratio: float

    max_upload_bytes: int

def load_settings() -> Settings:

    return Settings(
        port=_env_int("CV_SERVICE_PORT", 8800),
        host=os.environ.get("CV_SERVICE_HOST", "0.0.0.0"),
        force_mock=_env_bool("CV_FORCE_MOCK", False),
        lwcc_model_name=os.environ.get("CV_LWCC_MODEL_NAME", "CSRNet"),
        lwcc_model_weights=os.environ.get("CV_LWCC_MODEL_WEIGHTS", "SHA"),
        yolo_model_path=os.environ.get("CV_YOLO_MODEL_PATH", "yolov8n.pt"),
        sahi_slice_height=_env_int("CV_SAHI_SLICE_HEIGHT", 512),
        sahi_slice_width=_env_int("CV_SAHI_SLICE_WIDTH", 512),
        sahi_overlap_ratio=float(os.environ.get("CV_SAHI_OVERLAP_RATIO", "0.2")),
        max_upload_bytes=_env_int("CV_MAX_UPLOAD_BYTES", 25 * 1024 * 1024),
    )
