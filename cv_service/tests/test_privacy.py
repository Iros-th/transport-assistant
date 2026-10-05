from __future__ import annotations

import io
import json

from PIL import Image

def _frame_with_marker(marker_rgb) -> bytes:
    img = Image.new("RGB", (32, 32), color=marker_rgb)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()

def test_no_image_bytes_in_response(client):
    raw = _frame_with_marker((7, 199, 42))
    r = client.post(
        "/count/upload",
        data={"signal": "people", "capacity": 40},
        files={"file": ("secret.png", raw, "image/png")},
    )
    assert r.status_code == 200
    text = r.text

    import base64

    assert base64.b64encode(raw).decode("ascii") not in text
    assert raw.hex() not in text.lower()

    assert "secret.png" not in text

def test_response_keys_carry_no_identity(client, png_bytes):
    r = client.post(
        "/count/upload",
        data={"signal": "cars"},
        files={"file": ("frame.png", png_bytes, "image/png")},
    )
    body = json.loads(r.text)
    forbidden = {
        "image",
        "image_data",
        "crop",
        "crops",
        "bbox",
        "boxes",
        "embedding",
        "embeddings",
        "faces",
        "face",
        "identity",
        "identities",
        "track",
        "tracks",
        "landmarks",
        "path",
        "image_path",
        "file",
        "filename",
    }
    assert forbidden.isdisjoint(set(body.keys()))

    assert set(body["class_counts"].keys()) == {"person", "car"}

def test_path_endpoint_does_not_echo_path(client, tmp_path, png_bytes):
    p = tmp_path / "sensitive_location_frame.png"
    p.write_bytes(png_bytes)
    r = client.post("/count", json={"signal": "people", "image_path": str(p)})
    assert r.status_code == 200
    assert "sensitive_location_frame" not in r.text
    assert str(p) not in r.text
