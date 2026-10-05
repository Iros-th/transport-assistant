from __future__ import annotations

import json
import os
import urllib.request
from typing import Optional

def cv_service_url() -> str:

    return os.environ.get("CV_SERVICE_URL", "http://127.0.0.1:8800")

def count_by_path(
    signal: str, image_path: str, capacity: Optional[int] = None, base_url: str | None = None
) -> dict:

    base = base_url or cv_service_url()
    payload = {"signal": signal, "image_path": image_path, "capacity": capacity}
    req = urllib.request.Request(
        f"{base}/count",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))

if __name__ == "__main__":
    import sys

    sig = sys.argv[1] if len(sys.argv) > 1 else "people"
    path = sys.argv[2] if len(sys.argv) > 2 else ""
    print(json.dumps(count_by_path(sig, path), indent=2))
