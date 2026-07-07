"""건물 그림자 엔진 — 태양 고도·방위각으로 건물 그림자 폴리곤을 계산한다."""

from datetime import datetime
from math import cos, radians, sin, tan

import geopandas as gpd
from pysolar.solar import get_altitude, get_azimuth
from shapely.affinity import translate
from shapely.geometry import MultiPolygon, Polygon

from gneulro.config import (
    CRS_METRIC,
    CRS_WGS,
    FLOOR_HEIGHT_M,
    MAX_SHADOW_LEN_M,
    MIN_SUN_ALT_DEG,
)


def sun_position(lat: float, lon: float, when: datetime) -> tuple[float, float]:
    """(태양고도, 방위각[북=0° 시계방향])을 도 단위로 반환한다. when은 tz-aware 필수."""
    if when.tzinfo is None:
        raise ValueError("when은 시간대(tz) 정보가 있는 datetime이어야 합니다.")
    alt_deg = get_altitude(lat, lon, when)
    azi_deg = get_azimuth(lat, lon, when)
    return alt_deg, azi_deg


def shadow_polygon(
    footprint: Polygon, height_m: float, alt_deg: float, azi_deg: float
) -> Polygon | None:
    """건물 1개의 그림자(건물 자신 포함) 폴리곤을 계산한다. 태양이 너무 낮으면 None."""
    if alt_deg <= MIN_SUN_ALT_DEG:
        return None
    shadow_len = min(height_m / tan(radians(alt_deg)), MAX_SHADOW_LEN_M)
    # 그림자는 태양 반대 방향(방위각+180°)으로 늘어난다.
    dx = shadow_len * sin(radians(azi_deg + 180.0))
    dy = shadow_len * cos(radians(azi_deg + 180.0))
    moved = translate(footprint, xoff=dx, yoff=dy)
    return footprint.union(moved).convex_hull


def effective_heights(buildings: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """높이 규칙(height>0 → 그대로, 아니면 층수×환산계수)으로 height_eff를 만들고 결측은 제외한다."""
    df = buildings.copy()
    height = df.get("height")
    floors = df.get("floors")
    df["height_eff"] = 0.0
    if height is not None:
        df.loc[height > 0, "height_eff"] = height[height > 0]
    if floors is not None:
        no_height = df["height_eff"] <= 0
        df.loc[no_height & (floors > 0), "height_eff"] = floors[floors > 0] * FLOOR_HEIGHT_M
    excluded = int((df["height_eff"] <= 0).sum())
    if excluded:
        print(f"[shadowcast] 높이 정보 없음으로 제외된 건물: {excluded}동 / 전체 {len(df)}동")
    return df[df["height_eff"] > 0].copy()


def building_shadows(buildings: gpd.GeoDataFrame, when: datetime) -> gpd.GeoDataFrame:
    """전 건물의 그림자 GeoDataFrame을 만든다. 태양각은 지역 중심점에서 1회만 계산한다."""
    assert buildings.crs is not None and buildings.crs.to_epsg() == CRS_METRIC, (
        "buildings는 EPSG:5186 좌표계여야 합니다."
    )
    # 지역 중심점을 위경도로 변환해 태양 위치를 1회 계산 (노원구 규모에서 공간차 무시 가능)
    center = gpd.GeoSeries([buildings.union_all().centroid], crs=CRS_METRIC).to_crs(CRS_WGS)[0]
    alt_deg, azi_deg = sun_position(center.y, center.x, when)

    geoms = []
    for row in buildings.itertuples():
        shadow = shadow_polygon(row.geometry, row.height_eff, alt_deg, azi_deg)
        if shadow is not None:
            geoms.append(shadow)
    return gpd.GeoDataFrame(geometry=geoms, crs=CRS_METRIC)


def dissolve_shadows(shadows: gpd.GeoDataFrame) -> MultiPolygon:
    """그림자들을 하나로 병합(union_all)하고 1m 단순화한 MultiPolygon을 반환한다."""
    merged = shadows.geometry.union_all().simplify(1.0)
    if isinstance(merged, Polygon):
        merged = MultiPolygon([merged])
    return merged
