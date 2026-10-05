"""One click on "Find ruter" must produce one request per endpoint.

Static checks on the frontend source: exactly one submit binding for the plan form,
and the API layer coalesces identical in-flight requests.
"""
import pathlib
import re

FRONTEND = pathlib.Path(__file__).resolve().parents[1] / "frontend"


def test_plan_form_has_exactly_one_submit_listener():
    app = (FRONTEND / "app.js").read_text(encoding="utf-8")
    bindings = re.findall(r'''\$\(['"]#?plan-form['"]\)\.addEventListener\(['"]submit['"]''', app)
    assert len(bindings) == 1


def test_api_coalesces_in_flight_requests():
    api = (FRONTEND / "api.js").read_text(encoding="utf-8")
    assert "inFlightRequests[key]" in api
    assert re.search(r"delete inFlightRequests\[key\]", api), "in-flight entry must be cleared when settled"
