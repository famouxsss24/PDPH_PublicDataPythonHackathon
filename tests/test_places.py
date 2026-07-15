"""places 수용 테스트 — 카카오 응답 파싱과 노원 bbox 필터를 검증한다 (네트워크 모킹)."""

import math

from gneulro import places
from gneulro.config import NOWON_BBOX


class FakeResponse:
    def __init__(self, documents):
        self._documents = documents

    def raise_for_status(self):
        pass

    def json(self):
        return {"documents": self._documents}


def test_kakao_keyword_parsing(monkeypatch):
    """키워드 검색 결과가 로컬 색인과 같은 {name, cat, icon, lat, lon} 형태로 변환된다."""
    doc = {
        "place_name": "그랑디 오피스텔", "category_group_name": "", "category_group_code": "",
        "category_name": "부동산 > 주거시설 > 오피스텔", "x": "127.0600", "y": "37.6550",
    }
    monkeypatch.setattr(places.requests, "get", lambda *a, **k: FakeResponse([doc]))
    hits = places.kakao_places("그랑디", api_key="test")
    assert hits == [{"name": "그랑디 오피스텔", "cat": "오피스텔", "icon": "📍",
                     "lat": 37.655, "lon": 127.06}]


def test_kakao_address_fallback_filters_bbox(monkeypatch):
    """키워드 결과가 없으면 주소 검색으로 넘어가고, 노원구 bbox 밖 주소는 걸러진다."""
    inside = {"address_name": "서울 노원구 상계동 1", "x": "127.0600", "y": "37.6550"}
    outside = {"address_name": "부산 해운대구 우동 1", "x": "129.1600", "y": "35.1600"}
    responses = iter([FakeResponse([]), FakeResponse([inside, outside])])
    monkeypatch.setattr(places.requests, "get", lambda *a, **k: next(responses))
    hits = places.kakao_places("상계동 1", api_key="test")
    assert [h["name"] for h in hits] == ["서울 노원구 상계동 1"]
    assert all(NOWON_BBOX[0] <= h["lon"] <= NOWON_BBOX[2] for h in hits)


def test_nearby_places_filters_addresses_and_sorts_by_distance():
    entries = [
        {"name": "먼 학교", "cat": "학교", "lat": 37.6510, "lon": 127.0600},
        {"name": "가까운 병원", "cat": "병원", "lat": 37.6501, "lon": 127.0600},
        {"name": "서울 노원구 상계동 1", "cat": "주소", "lat": 37.65001, "lon": 127.0600},
    ]

    hits = places.nearby_places(37.65, 127.06, entries, radius_m=300, limit=5)

    assert [hit["name"] for hit in hits] == ["가까운 병원", "먼 학교"]
    assert hits[0]["distance_m"] < hits[1]["distance_m"]


def test_local_search_normalizes_seoul_address_variants():
    entries = [
        {
            "name": "서울특별시 노원구 상계동 123-4",
            "address": "서울특별시 노원구 상계동 123-4",
            "cat": "주소",
            "lat": 37.65,
            "lon": 127.06,
        }
    ]

    assert places.search_places("서울 노원구 상계동", entries) == entries
    assert places.search_places("노원구 123-4", entries) == entries


def test_osm_nan_tags_do_not_become_category_or_address_text():
    row = {
        "amenity": "school",
        "place": math.nan,
        "boundary": math.nan,
        "addr:full": math.nan,
        "addr:city": "서울특별시",
        "addr:district": math.nan,
    }

    assert places._category(row)[0] == "학교"
    assert places._address(row) == "서울특별시"


def test_search_deduplicates_names_and_prefers_address():
    entries = [
        {"name": "노원구청", "cat": "공공", "lat": 37.65, "lon": 127.05},
        {
            "name": "노원구청",
            "cat": "공공",
            "address": "서울특별시 노원구 노해로 437",
            "lat": 37.65,
            "lon": 127.06,
        },
    ]

    assert places.search_places("노원구청", entries) == [entries[1]]
