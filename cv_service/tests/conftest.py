from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from cv_service.app import create_app
from cv_service.config import load_settings

@pytest.fixture()
def png_bytes() -> bytes:

    img = Image.new("RGB", (64, 48), color=(120, 130, 140))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()

@pytest.fixture()
def client() -> TestClient:

    settings = load_settings()
    settings = settings.__class__(**{**settings.__dict__, "force_mock": True})
    return TestClient(create_app(settings))
