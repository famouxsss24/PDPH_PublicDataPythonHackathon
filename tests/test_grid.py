"""grid 수용 테스트 — 그늘율 계산이 기하학적으로 정확한지 검증한다."""

import geopandas as gpd
import pytest
from shapely.geometry import MultiPolygon, box

from gneulro.config import CRS_METRIC
from gneulro.grid import shade_ratio


def test_half_covered_cell():
    """셀 절반을 덮는 사각형 그림자 → 그늘율이 정확히 0.5여야 한다."""
    cell = box(0, 0, 50, 50)
    grid = gpd.GeoDataFrame(geometry=[cell], crs=CRS_METRIC)
    shadow = MultiPolygon([box(0, 0, 50, 25)])  # 아래 절반만 덮음
    ratio = shade_ratio(grid, shadow)
    assert ratio.iloc[0] == pytest.approx(0.5, abs=1e-6)
