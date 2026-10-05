from __future__ import annotations

import io
import logging

from cv_service.config import Settings
from cv_service.providers.base import Counter, CountResult
from cv_service.providers.mock import MockCounter
from cv_service.schema import Signal, Source

logger = logging.getLogger("cv_service.sahi")

_CAR_LABELS = {"car", "truck", "bus"}
_PERSON_LABELS = {"person"}

class SahiCarCounter(Counter):

    name = "sahi"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._mock = MockCounter(Signal.CARS)
        self._model = None
        self._get_sliced_prediction = None
        self._real_available = False

        if settings.force_mock:
            logger.info("CV_FORCE_MOCK set -> SahiCarCounter runs in MOCK mode")
            return

        try:
            from sahi import AutoDetectionModel
            from sahi.predict import get_sliced_prediction

            self._model = AutoDetectionModel.from_pretrained(
                model_type="ultralytics",
                model_path=settings.yolo_model_path,
                confidence_threshold=0.3,
                device="cuda",
            )
            self._get_sliced_prediction = get_sliced_prediction
            self._real_available = True
            logger.info(
                "sahi+YOLO available -> car counts will be LIVE (weights=%s)",
                settings.yolo_model_path,
            )
        except Exception as exc:
            logger.warning("sahi/YOLO unavailable (%s) -> car counts will be MOCK", exc)
            self._real_available = False

    def count(self, image_bytes: bytes, capacity: int | None = None) -> CountResult:
        if not self._real_available:
            return self._mock.count(image_bytes, capacity)

        try:
            return self._count_live(image_bytes)
        except Exception as exc:
            logger.warning("sahi inference failed (%s) -> MOCK fallback", exc)
            return self._mock.count(image_bytes, capacity)

    def _count_live(self, image_bytes: bytes) -> CountResult:
        import numpy as np
        from PIL import Image

        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        arr = np.asarray(image)

        result = self._get_sliced_prediction(
            arr,
            self._model,
            slice_height=self.settings.sahi_slice_height,
            slice_width=self.settings.sahi_slice_width,
            overlap_height_ratio=self.settings.sahi_overlap_ratio,
            overlap_width_ratio=self.settings.sahi_overlap_ratio,
        )

        cars = 0
        people = 0
        confidences = []

        for pred in result.object_prediction_list:
            label = str(pred.category.name).lower()
            confidences.append(float(pred.score.value))
            if label in _CAR_LABELS:
                cars += 1
            elif label in _PERSON_LABELS:
                people += 1

        mean_conf = round(sum(confidences) / len(confidences), 3) if confidences else 0.0
        model = f"sahi+ultralytics/{self.settings.yolo_model_path}"
        return CountResult(
            count=cars,
            class_counts={"person": people, "car": cars},
            confidence=mean_conf,
            model=model,
            source=Source.LIVE,
        )
