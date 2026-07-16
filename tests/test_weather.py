from gneulro import weather


class FakeResponse:
    def __init__(self, apparent_temperature: float):
        self.apparent_temperature = apparent_temperature

    def raise_for_status(self):
        return None

    def json(self):
        return {
            "current": {
                "time": "2026-07-16T14:30",
                "temperature_2m": 31.4,
                "apparent_temperature": self.apparent_temperature,
                "relative_humidity_2m": 68,
                "is_day": 1,
                "weather_code": 1,
            }
        }


def _weather(monkeypatch, apparent_temperature: float):
    weather.clear_weather_cache()
    monkeypatch.setattr(
        weather.requests,
        "get",
        lambda *args, **kwargs: FakeResponse(apparent_temperature),
    )
    return weather.current_weather(37.654, 127.0567, timestamp=600)


def test_current_apparent_temperature_at_threshold_recommends_deferral(monkeypatch):
    result = _weather(monkeypatch, 33.0)

    assert result["temperature_c"] == 31.4
    assert result["apparent_temperature_c"] == 33.0
    assert result["recommend_defer_outdoor"] is True
    assert result["threshold"]["value_c"] == 33.0


def test_current_apparent_temperature_below_threshold_is_neutral(monkeypatch):
    result = _weather(monkeypatch, 32.9)

    assert result["recommend_defer_outdoor"] is False
    assert result["data_kind"] == "model_current_conditions"
