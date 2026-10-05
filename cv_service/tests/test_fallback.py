from __future__ import annotations

from cv_service.config import load_settings
from cv_service.providers.lwcc_people import LwccPeopleCounter
from cv_service.providers.sahi_cars import SahiCarCounter
from cv_service.schema import Source

def _mock_settings():
    s = load_settings()
    return s.__class__(**{**s.__dict__, "force_mock": True})

def test_lwcc_falls_back_to_mock(png_bytes):

    counter = LwccPeopleCounter(load_settings())
    result = counter.count(png_bytes)
    if not counter._real_available:
        assert result.source is Source.MOCK

    assert result.count >= 0
    assert result.class_counts["car"] == 0

def test_sahi_falls_back_to_mock(png_bytes):
    counter = SahiCarCounter(load_settings())
    result = counter.count(png_bytes)
    if not counter._real_available:
        assert result.source is Source.MOCK
    assert result.count >= 0

def test_force_mock_never_live(png_bytes):
    settings = _mock_settings()
    for counter in (LwccPeopleCounter(settings), SahiCarCounter(settings)):
        assert counter._real_available is False
        assert counter.count(png_bytes).source is Source.MOCK

def test_garbage_bytes_still_answers(png_bytes):

    counter = LwccPeopleCounter(load_settings())
    result = counter.count(b"not-an-image-just-bytes")
    assert result.count >= 0
    assert result.source is Source.MOCK
