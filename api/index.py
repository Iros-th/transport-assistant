"""Vercel serverless entrypoint (Python runtime).

Vercel routes /api/* here (see vercel.json); the FastAPI app registers every
route under both "/" and "/api". Runs in demo mode with no CV service and no
secrets: CV_SERVICE_URL is intentionally unused by the /api/demo/* routes.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.main import app  # noqa: E402,F401
