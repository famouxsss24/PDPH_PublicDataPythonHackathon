"""장소 검색 — 카카오 로컬 API(상호명·주소·건물명)와 OSM 오프라인 색인(폴백)을 제공한다."""

import json
import re

import geopandas as gpd
import requests
from shapely.geometry import box

from gneulro.config import CRS_METRIC, CRS_WGS, DATA_PROCESSED, DATA_RAW, NOWON_BBOX, PLACE

PLACES_PATH = DATA_PROCESSED / "places.json"

# (카테고리, 아이콘, OSM 태그) — 위쪽일수록 검색 결과에서 우선한다.
_INDEX_TAGS = {
    "amenity", "boundary", "building", "craft", "healthcare", "leisure", "office",
    "place", "public_transport", "railway", "shop", "tourism",
}


def _tag(row, name: str) -> str:
    """GeoPandas의 빈 OSM 태그(None/NaN)를 거짓인 빈 문자열로 통일한다."""
    value = row.get(name)
    if value is None or value != value:
        return ""
    return str(value).strip()


def _category(row) -> tuple[str, str]:
    """OSM 속성을 시민이 이해하는 검색 분류와 아이콘으로 바꾼다."""
    amenity = _tag(row, "amenity")
    if _tag(row, "railway") in {"station", "halt", "subway_entrance"}:
        return "역", "🚇"
    if _tag(row, "place") or _tag(row, "boundary") == "administrative":
        return "행정", "🗺️"
    if amenity in {"school", "university", "college", "kindergarten"}:
        return "학교", "🏫"
    if amenity in {"hospital", "clinic", "doctors", "dentist"} or _tag(row, "healthcare"):
        return "병원", "🏥"
    if amenity in {"townhall", "police", "fire_station", "library", "community_centre"}:
        return "공공", "🏛️"
    if amenity in {"restaurant", "fast_food", "food_court"}:
        return "음식점", "🍽️"
    if amenity in {"cafe", "bar", "pub"}:
        return "카페", "☕"
    if _tag(row, "leisure") in {"park", "garden", "playground"}:
        return "공원", "🌳"
    if _tag(row, "leisure") in {"sports_centre", "fitness_centre"} or _tag(row, "sport"):
        return "체육시설", "🏋️"
    if _tag(row, "shop") or _tag(row, "office") or _tag(row, "craft"):
        return "상점", "🏪"
    if _tag(row, "building") == "apartments":
        return "아파트", "🏢"
    if _tag(row, "building"):
        return "건물", "🏢"
    return "장소", "📍"


def _address(row) -> str:
    full = _tag(row, "addr:full")
    if full:
        return full
    pieces = [
        _tag(row, "addr:city"),
        _tag(row, "addr:district"),
        _tag(row, "addr:street"),
        _tag(row, "addr:housenumber"),
    ]
    return " ".join(piece for piece in pieces if piece)


def build_places() -> list[dict]:
    """OSM의 이름 있는 건물·상호·시설·행정구역을 한 번에 조회해 검색 색인을 만든다."""
    import osmnx as ox

    entries: list[dict] = []
    seen: set[tuple[str, float, float]] = set()
    try:
        ox.settings.requests_timeout = 45
        gdf = ox.features_from_place(PLACE, {"name": True})
    except Exception as exc:
        print(f"[places] OSM 조회 실패({exc.__class__.__name__}) — 기존 색인 유지")
        return load_places()
    gdf = gdf[gdf["name"].notna()].copy()
    present_tags = [tag for tag in _INDEX_TAGS if tag in gdf.columns]
    if present_tags:
        gdf = gdf[gdf[present_tags].notna().any(axis=1)]
    points = gdf.to_crs(CRS_METRIC).geometry.centroid
    points = gpd.GeoSeries(points, crs=CRS_METRIC).to_crs(CRS_WGS)
    for (_, row), point in zip(gdf.iterrows(), points):
        name = str(row["name"]).strip()
        if not name or name == "nan":
            continue
        key = (name.casefold(), round(point.y, 5), round(point.x, 5))
        if key in seen:
            continue
        seen.add(key)
        cat, icon = _category(row)
        entry = {
            "name": name, "cat": cat, "icon": icon,
            "lat": round(point.y, 6), "lon": round(point.x, 6),
        }
        address = _address(row)
        if address:
            entry["address"] = address
        entries.append(entry)
    priority = {"역": 0, "행정": 1, "학교": 2, "공공": 3, "병원": 4, "공원": 5}
    entries.sort(key=lambda entry: (priority.get(entry["cat"], 10), entry["name"]))
    print(f"[places] 이름 있는 장소 {len(entries):,}곳 색인")
    return entries


def build_building_addresses() -> list[dict]:
    """GIS건물통합정보의 노원구 지번을 좌표가 있는 오프라인 주소 색인으로 만든다."""
    source = next((DATA_RAW / "buildings").glob("*.shp"), None)
    if source is None:
        return []
    west, south, east, north = NOWON_BBOX
    bbox = gpd.GeoSeries([box(west, south, east, north)], crs=CRS_WGS).to_crs(CRS_METRIC)
    buildings = gpd.read_file(
        source,
        bbox=tuple(bbox.total_bounds),
        columns=["A4", "A5"],
        encoding="cp949",
    )
    buildings = buildings[buildings["A4"].fillna("").str.contains("노원구")].copy()
    points = buildings.geometry.centroid.to_crs(CRS_WGS)
    entries = []
    seen = set()
    for (_, row), point in zip(buildings.iterrows(), points):
        address = " ".join(
            part
            for part in [str(row.get("A4") or "").strip(), str(row.get("A5") or "").strip()]
            if part and part != "nan"
        )
        key = (address, round(point.y, 5), round(point.x, 5))
        if not address or key in seen:
            continue
        seen.add(key)
        entries.append(
            {
                "name": address,
                "cat": "주소",
                "icon": "📮",
                "address": address,
                "lat": round(point.y, 6),
                "lon": round(point.x, 6),
            }
        )
    print(f"[places] 공공 건물 지번 {len(entries):,}건 색인")
    return entries


def save_places(entries: list[dict]) -> None:
    """장소 목록을 places.json으로 저장한다."""
    DATA_PROCESSED.mkdir(parents=True, exist_ok=True)
    PLACES_PATH.write_text(json.dumps(entries, ensure_ascii=False), encoding="utf-8")


def load_places() -> list[dict]:
    """저장된 places.json을 읽는다 (없으면 빈 목록)."""
    if not PLACES_PATH.exists():
        return []
    return json.loads(PLACES_PATH.read_text(encoding="utf-8"))


# 카카오 카테고리 그룹 코드 → 아이콘 (없는 코드는 📍)
_KAKAO_ICONS = {
    "MT1": "🛒", "CS2": "🏪", "PS3": "🧸", "SC4": "🏫", "AC5": "📚", "PK6": "🅿️",
    "OL7": "⛽", "SW8": "🚇", "BK9": "🏦", "CT1": "🎭", "AG2": "🏢", "PO3": "🏛️",
    "AT4": "🏞️", "AD5": "🏨", "FD6": "🍽️", "CE7": "☕", "HP8": "🏥", "PM9": "💊",
}
_KAKAO_KEYWORD_URL = "https://dapi.kakao.com/v2/local/search/keyword.json"
_KAKAO_ADDRESS_URL = "https://dapi.kakao.com/v2/local/search/address.json"
_KAKAO_REVERSE_URL = "https://dapi.kakao.com/v2/local/geo/coord2address.json"


def kakao_places(query: str, api_key: str, limit: int = 12) -> list[dict]:
    """카카오 로컬 API로 검색한다 — 키워드(상호명·건물명) 우선, 없으면 주소 검색.

    결과는 노원구 bbox로 제한하며, 로컬 색인(search_places)과 같은 dict 형태로 반환한다.
    네트워크·키 오류는 requests 예외로 올라가고 호출부(api)가 로컬 색인으로 폴백한다.
    """
    headers = {"Authorization": f"KakaoAK {api_key}"}
    west, south, east, north = NOWON_BBOX
    res = requests.get(
        _KAKAO_KEYWORD_URL,
        params={"query": query, "rect": f"{west},{south},{east},{north}", "size": 15},
        headers=headers, timeout=3,
    )
    res.raise_for_status()
    docs = res.json()["documents"]
    if docs:
        hits = []
        for d in docs[:limit]:
            hit = {
                "name": d["place_name"],
                "cat": d["category_group_name"] or d["category_name"].split(" > ")[-1] or "장소",
                "icon": _KAKAO_ICONS.get(d["category_group_code"], "📍"),
                "lat": float(d["y"]), "lon": float(d["x"]),
            }
            if d.get("address_name"):
                hit["address"] = d["address_name"]
            if d.get("road_address_name"):
                hit["road_address"] = d["road_address_name"]
            hits.append(hit)
        return hits
    # 상호명으로 못 찾으면 지번/도로명 주소로 재시도 (rect 미지원 → 응답을 bbox 필터)
    res = requests.get(
        _KAKAO_ADDRESS_URL, params={"query": query, "size": 30}, headers=headers, timeout=3
    )
    res.raise_for_status()
    hits = [
        {"name": d["address_name"], "cat": "주소", "icon": "📮",
         "lat": float(d["y"]), "lon": float(d["x"])}
        for d in res.json()["documents"]
        if west <= float(d["x"]) <= east and south <= float(d["y"]) <= north
    ]
    return hits[:limit]


def kakao_reverse(lat: float, lon: float, api_key: str) -> dict | None:
    """좌표를 카카오 도로명/지번 주소로 바꾼다."""
    response = requests.get(
        _KAKAO_REVERSE_URL,
        params={"x": lon, "y": lat},
        headers={"Authorization": f"KakaoAK {api_key}"},
        timeout=3,
    )
    response.raise_for_status()
    documents = response.json().get("documents", [])
    if not documents:
        return None
    document = documents[0]
    road = document.get("road_address") or {}
    address = document.get("address") or {}
    name = road.get("building_name") or road.get("address_name") or address.get("address_name")
    if not name:
        return None
    result = {"name": name, "cat": "주소", "lat": lat, "lon": lon}
    if address.get("address_name"):
        result["address"] = address["address_name"]
    if road.get("address_name"):
        result["road_address"] = road["address_name"]
    return result


def _normalize_search_text(value: object) -> str:
    """주소 약칭과 구분자 차이를 없앤 검색 비교 문자열을 만든다."""
    text = str(value or "").casefold()
    for source, target in (
        ("서울특별시", "서울"),
        ("서울시", "서울"),
        ("노원구청", "노원구청"),
    ):
        text = text.replace(source, target)
    return re.sub(r"[^0-9a-z가-힣]", "", text)


def search_places(query: str, entries: list[dict], limit: int = 12) -> list[dict]:
    """이름·분류·주소와 역/동 접미어 별칭을 함께 검색한다."""
    q = _normalize_search_text(query)
    if not q:
        return []
    tokens = [
        token
        for token in (_normalize_search_text(part) for part in re.findall(r"[0-9A-Za-z가-힣-]+", query))
        if token
    ]
    scored = []
    for index, entry in enumerate(entries):
        name = _normalize_search_text(entry["name"])
        aliases = [name]
        if entry.get("cat") == "역" and not name.endswith("역"):
            aliases.append(f"{name}역")
        if entry.get("cat") in {"동네", "행정"} and not name.endswith("동"):
            aliases.append(f"{name}동")
        fields = [
            *aliases,
            _normalize_search_text(entry.get("cat", "")),
            _normalize_search_text(entry.get("address", "")),
            _normalize_search_text(entry.get("road_address", "")),
        ]
        haystack = "".join(fields)
        token_match = bool(tokens) and all(token in haystack for token in tokens)
        if q not in haystack and not token_match:
            continue
        if q in aliases:
            score = 0
        elif any(alias.startswith(q) for alias in aliases):
            score = 1
        elif all(token in name for token in tokens):
            score = 2
        else:
            score = 3
        address_penalty = 0 if entry.get("road_address") or entry.get("address") else 1
        scored.append((score, address_penalty, index, entry))
    scored.sort(key=lambda item: (item[0], item[1], item[2]))
    results = []
    seen = set()
    for _, _, _, entry in scored:
        key = _normalize_search_text(entry.get("name", ""))
        if key in seen:
            continue
        seen.add(key)
        results.append(entry)
        if len(results) >= limit:
            break
    return results


def popular_places(entries: list[dict], limit: int = 8) -> list[dict]:
    """빈 검색창에 노출할 역·행정구역 중심의 빠른 선택 목록."""
    preferred = [entry for entry in entries if entry.get("cat") in {"역", "행정", "동네"}]
    return preferred[:limit]


def merge_places(*groups: list[dict], limit: int = 12) -> list[dict]:
    """서로 다른 검색 공급자의 중복 결과를 이름·근사 좌표 기준으로 합친다."""
    merged = []
    seen = set()
    for group in groups:
        for entry in group:
            key = (entry["name"].casefold(), round(float(entry["lat"]), 4), round(float(entry["lon"]), 4))
            if key in seen:
                continue
            seen.add(key)
            merged.append(entry)
            if len(merged) >= limit:
                return merged
    return merged


def nearest_place(lat: float, lon: float, entries: list[dict], max_distance_m: float = 350) -> dict | None:
    """클릭 좌표에서 가장 가까운 색인 장소를 반환한다."""
    if not entries:
        return None
    lat_scale = 111_000
    lon_scale = 111_000 * 0.79
    nearest = min(
        entries,
        key=lambda entry: ((float(entry["lat"]) - lat) * lat_scale) ** 2
        + ((float(entry["lon"]) - lon) * lon_scale) ** 2,
    )
    distance = (((float(nearest["lat"]) - lat) * lat_scale) ** 2
                + ((float(nearest["lon"]) - lon) * lon_scale) ** 2) ** 0.5
    return nearest if distance <= max_distance_m else None


def nearby_places(
    lat: float,
    lon: float,
    entries: list[dict],
    radius_m: float = 240,
    limit: int = 7,
) -> list[dict]:
    """보행 위치 주변의 이름 있는 건물·시설을 가까운 순서로 반환한다."""
    lat_scale = 111_000
    lon_scale = 111_000 * 0.79
    candidates = []
    seen = set()
    for index, entry in enumerate(entries):
        if entry.get("cat") in {"주소", "행정", "동네"}:
            continue
        name = str(entry.get("name", "")).strip()
        if not name or name.casefold() in seen:
            continue
        distance = (((float(entry["lat"]) - lat) * lat_scale) ** 2
                    + ((float(entry["lon"]) - lon) * lon_scale) ** 2) ** 0.5
        if distance > radius_m:
            continue
        seen.add(name.casefold())
        candidates.append((distance, index, {**entry, "distance_m": round(distance)}))
    candidates.sort(key=lambda item: (item[0], item[1]))
    return [entry for _, _, entry in candidates[:limit]]
