"""shadowcast 수용 테스트 — 그림자 물리 법칙과 pysolar 방위각 규약을 검증한다."""

from datetime import datetime

import pytest
from shapely.geometry import box

from gneulro.config import TZ
from gneulro.shadowcast import shadow_polygon, sun_position

SEOUL_LAT, SEOUL_LON = 37.5665, 126.9780
NOON_0806 = datetime(2026, 8, 6, 12, 30, tzinfo=TZ)


def test_shadow_length_45deg():
    """높이 10m, 태양고도 45° → 그림자 끝이 정확히 10m 이동해야 한다."""
    footprint = box(0, 0, 10, 10)
    # 방위각 180°(남쪽 태양) → 그림자는 북쪽(+y)으로 10m
    shadow = shadow_polygon(footprint, height_m=10.0, alt_deg=45.0, azi_deg=180.0)
    assert shadow is not None
    assert shadow.bounds[3] == pytest.approx(20.0, abs=1e-6)  # maxy = 10 + 10
    assert shadow.bounds[1] == pytest.approx(0.0, abs=1e-6)  # miny 그대로

def test_pysolar_azimuth_convention():
    """8/6 12:30 KST 서울의 태양 방위각은 남쪽 근방(150°~210°)이어야 한다 — 규약 가드."""
    alt, azi = sun_position(SEOUL_LAT, SEOUL_LON, NOON_0806)
    assert alt > 30.0  # 한여름 정오 무렵이므로 태양이 높이 떠 있음
    assert 150.0 < azi < 210.0

def test_shadow_points_north_at_noon():
    """정오 무렵(태양 남쪽) 그림자 중심은 건물 중심보다 북쪽(y 증가)이어야 한다."""
    alt, azi = sun_position(SEOUL_LAT, SEOUL_LON, NOON_0806)
    footprint = box(0, 0, 10, 10)
    shadow = shadow_polygon(footprint, height_m=20.0, alt_deg=alt, azi_deg=azi)
    assert shadow is not None
    assert shadow.centroid.y > footprint.centroid.y

def test_naive_datetime_rejected():
    """tz 정보가 없는 naive datetime은 ValueError를 내야 한다."""
    with pytest.raises(ValueError):
        sun_position(SEOUL_LAT, SEOUL_LON, datetime(2026, 8, 6, 12, 30))
