from __future__ import annotations

import io
import logging

from cv_service.config import Settings
from cv_service.providers.base import Counter, CountResult
from cv_service.providers.mock import MockCounter
from cv_service.schema import Signal, Source

logger = logging.getLogger("cv_service.lwcc")

class LwccPeopleCounter(Counter):

    name = "lwcc"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._mock = MockCounter(Signal.PEOPLE)
        self._model = None
        self._real_available = False
        self._lwcc = None

        if settings.force_mock:
            logger.info("CV_FORCE_MOCK set -> LwccPeopleCounter runs in MOCK mode")
            return

        try:
            from lwcc import LWCC

            self._lwcc = LWCC
            self._real_available = True
            logger.info(
                "lwcc available -> people counts will be LIVE (model=%s, weights=%s)",
                settings.lwcc_model_name,
                settings.lwcc_model_weights,
            )
        except Exception as exc:
            logger.warning("lwcc unavailable (%s) -> people counts will be MOCK", exc)
            self._real_available = False

    def count(self, image_bytes: bytes, capacity: int | None = None) -> CountResult:
        if not self._real_available:
            return self._mock.count(image_bytes, capacity)

        try:
            return self._count_live(image_bytes)
        except Exception as exc:

            logger.warning("lwcc inference failed (%s) -> MOCK fallback", exc)
            return self._mock.count(image_bytes, capacity)

    def _count_live(self, image_bytes: bytes) -> CountResult:

        import os
        import tempfile

        from PIL import Image

        Image.open(io.BytesIO(image_bytes)).verify()

        tmp_path = None
        try:
            fd, tmp_path = tempfile.mkstemp(suffix=".jpg")
            with os.fdopen(fd, "wb") as fh:
                fh.write(image_bytes)

            estimate = self._lwcc.get_count(
                tmp_path,
                model_name=self.settings.lwcc_model_name,
                model_weights=self.settings.lwcc_model_weights,
            )
            people = int(round(float(estimate)))
            people = max(0, people)
        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)

        model = f"lwcc/{self.settings.lwcc_model_name}-{self.settings.lwcc_model_weights}"
        return CountResult(
            count=people,
            class_counts={"person": people, "car": 0},

            confidence=0.70,
            model=model,
            source=Source.LIVE,
        )
