"""Key-free current-weather gateway for the heat-care prompt.

The app uses the KMA heat-advisory apparent-temperature level (33°C) as a
simple current-condition trigger.  It does not claim that this endpoint is an
official KMA warning: Open-Meteo provides model-based current conditions, and
an official warning also considers duration and expected impacts.
"""

from __future__ import annotations

from functools import lru_cache
from math import isfinite
from time import time

import requests

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
PROVIDER_NAME = "Open-Meteo"
PROVIDER_URL = "https://open-meteo.com/en/docs"
HEAT_ADVISORY_APPARENT_C = 33.0
CACHE_SECONDS = 600


class WeatherUnavailableError(RuntimeError):
    """Raised when current weather cannot be fetched or parsed safely."""


def _finite_number(value: object, field: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise WeatherUnavailableError(f"날씨 응답의 {field} 값이 올바르지 않습니다.") from exc
    if not isfinite(number):
        raise WeatherUnavailableError(f"날씨 응답의 {field} 값이 올바르지 않습니다.")
    return number


@lru_cache(maxsize=24)
def _cached_current_weather(lat: float, lon: float, cache_bucket: int) -> dict:
    del cache_bucket  # The value only gives the LRU entry a ten-minute lifetime.
    try:
        response = requests.get(
            OPEN_METEO_URL,
            params={
                "latitude": lat,
                "longitude": lon,
                "current": (
                    "temperature_2m,apparent_temperature,relative_humidity_2m,"
                    "is_day,weather_code"
                ),
                "temperature_unit": "celsius",
                "timezone": "Asia/Seoul",
            },
            headers={"User-Agent": "gneulro/0.1 (+current-weather)"},
            timeout=4,
        )
        response.raise_for_status()
        current = response.json()["current"]
        temperature = _finite_number(current["temperature_2m"], "temperature_2m")
        apparent = _finite_number(current["apparent_temperature"], "apparent_temperature")
        humidity = _finite_number(current["relative_humidity_2m"], "relative_humidity_2m")
    except (requests.RequestException, KeyError, TypeError, ValueError) as exc:
        raise WeatherUnavailableError("현재 날씨를 불러오지 못했습니다.") from exc

    return {
        "temperature_c": round(temperature, 1),
        "apparent_temperature_c": round(apparent, 1),
        "relative_humidity_pct": round(humidity),
        "current_at": current.get("time"),
        "is_day": bool(current.get("is_day", 1)),
        "weather_code": current.get("weather_code"),
        "recommend_defer_outdoor": apparent >= HEAT_ADVISORY_APPARENT_C,
        "threshold": {
            "metric": "apparent_temperature",
            "value_c": HEAT_ADVISORY_APPARENT_C,
            "basis": "KMA heat-advisory apparent-temperature level",
        },
        "provider": PROVIDER_NAME,
        "provider_url": PROVIDER_URL,
        "data_kind": "model_current_conditions",
        "location": {"lat": lat, "lon": lon},
    }


def current_weather(lat: float, lon: float, *, timestamp: float | None = None) -> dict:
    """Return a rounded, ten-minute-cached current-condition response."""
    latitude = _finite_number(lat, "latitude")
    longitude = _finite_number(lon, "longitude")
    cache_bucket = int((time() if timestamp is None else timestamp) // CACHE_SECONDS)
    # Weather-model grids are much coarser than a street address.  A 0.01° key
    # avoids duplicate upstream calls for nearby points in the same district.
    return _cached_current_weather(round(latitude, 2), round(longitude, 2), cache_bucket)


def clear_weather_cache() -> None:
    """Clear weather responses for tests and controlled refreshes."""
    _cached_current_weather.cache_clear()


__all__ = [
    "HEAT_ADVISORY_APPARENT_C",
    "WeatherUnavailableError",
    "clear_weather_cache",
    "current_weather",
]
