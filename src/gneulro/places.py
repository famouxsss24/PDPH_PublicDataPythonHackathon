"""장소 색인 — OSM에서 역·동네·학교·공원·아파트 등 이름 있는 장소를 뽑아 검색용 JSON을 만든다."""

import json

import geopandas as gpd

from gneulro.config import CRS_METRIC, CRS_WGS, DATA_PROCESSED, PLACE

PLACES_PATH = DATA_PROCESSED / "places.json"

# (카테고리, 아이콘, OSM 태그) — 위쪽일수록 검색 결과에서 우선한다.
_TAG_SETS = [
    ("역", "🚇", {"railway": "station"}),
    ("동네", "🏘️", {"place": ["neighbourhood", "quarter", "suburb"]}),
    ("학교", "🏫", {"amenity": ["school", "university", "college"]}),
    ("병원", "🏥", {"amenity": "hospital"}),
    ("공원", "🌳", {"leisure": "park"}),
    ("아파트", "🏢", {"building": "apartments"}),
    ("공공", "🏛️", {"amenity": ["townhall", "police", "fire_station", "library", "community_centre"]}),
]


def build_places() -> list[dict]:
    """OSM에서 카테고리별 장소를 조회해 {이름, 분류, 아이콘, 위경도} 목록으로 만든다."""
    import osmnx as ox

    entries: list[dict] = []
    seen: set[str] = set()
    for cat, icon, tags in _TAG_SETS:
        try:
            gdf = ox.features_from_place(PLACE, tags)
        except Exception as exc:  # 해당 태그 결과가 없으면 이 카테고리만 건너뛴다
            print(f"[places] {cat} 조회 실패({exc.__class__.__name__}) — 건너뜀")
            continue
        if "name" not in gdf.columns:
            continue
        gdf = gdf[gdf["name"].notna()]
        # 폴리곤(건물·공원)은 중심점으로 — 미터 좌표계에서 centroid 후 위경도로 복귀
        pts = gdf.to_crs(CRS_METRIC).geometry.centroid
        pts = gpd.GeoSeries(pts, crs=CRS_METRIC).to_crs(CRS_WGS)
        added = 0
        for name, pt in zip(gdf["name"], pts):
            key = str(name).strip()
            if not key or key in seen:
                continue
            seen.add(key)
            entries.append(
                {"name": key, "cat": cat, "icon": icon,
                 "lat": round(pt.y, 6), "lon": round(pt.x, 6)}
            )
            added += 1
        print(f"[places] {cat}: {added}곳 (누적 {len(entries)})")
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


def search_places(query: str, entries: list[dict], limit: int = 12) -> list[dict]:
    """이름에 검색어가 포함된 장소를 등록 순서(카테고리 우선순위)대로 최대 limit개 반환한다."""
    q = query.strip().lower()
    if not q:
        return []
    hits = [e for e in entries if q in e["name"].lower()]
    # 이름이 검색어로 시작하는 항목을 앞으로 (예: "노원" → "노원역"이 "월계노원..."보다 먼저)
    hits.sort(key=lambda e: (not e["name"].lower().startswith(q),))
    return hits[:limit]
