from __future__ import annotations

from cv_service.config import Settings
from cv_service.providers.base import Counter
from cv_service.providers.lwcc_people import LwccPeopleCounter
from cv_service.providers.sahi_cars import SahiCarCounter
from cv_service.schema import Signal, Source

class Registry:

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._people = LwccPeopleCounter(settings)
        self._cars = SahiCarCounter(settings)

    def counter_for(self, signal: Signal) -> Counter:
        return self._people if signal is Signal.PEOPLE else self._cars

    def mode_for(self, signal: Signal) -> Source:

        counter = self.counter_for(signal)
        return Source.LIVE if getattr(counter, "_real_available", False) else Source.MOCK

    def provider_name(self, signal: Signal) -> str:
        return self.counter_for(signal).name
