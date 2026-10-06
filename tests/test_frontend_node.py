"""Runs the node-based frontend tests under pytest and guards against known past regressions."""
import pathlib
import shutil
import subprocess

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
FE = ROOT / "frontend"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
@pytest.mark.parametrize("script", ["tests/test_frontend.js", "tests/test_logic.js"])
def test_node_suite(script):
    r = subprocess.run(["node", script], cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr


def test_service_worker_version_and_shell_include_logic():
    sw = (FE / "sw.js").read_text(encoding="utf-8")
    assert '"logic.js"' in sw
    assert 'VERSION = "v4"' in sw


def test_known_past_bugs_stay_fixed():
    api = (FE / "api.js").read_text(encoding="utf-8")
    assert "precision ?? 6" in api  # Transitous legGeometry.precision is 6
    assert "api.transitous.org/api/v5/plan" in api


def test_privacy_and_report_strings_present():
    html = (FE / "index.html").read_text(encoding="utf-8")
    assert "Ingen reklamer, ingen sporing" in html
    assert "Lær ruten" in html
    assert "Lavt dataforbrug" in html
    logic = (FE / "logic.js").read_text(encoding="utf-8")
    assert "openstreetmap.org/note/new" in logic
