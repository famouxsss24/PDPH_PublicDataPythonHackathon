"""격자 그늘율 — 노원구를 50m 격자로 나누고 셀별 그늘 비율을 계산한다."""

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import MultiPolygon, box

from gneulro.config import CRS_METRIC, GRID_SIZE_M, PLACE


def nowon_boundary() -> gpd.GeoDataFrame:
    """osmnx로 노원구 행정경계를 조회해 EPSG:5186으로 반환한다."""
    import osmnx as ox

    return ox.geocode_to_gdf(PLACE).to_crs(CRS_METRIC)


def make_grid(boundary: gpd.GeoDataFrame, size_m: float = GRID_SIZE_M) -> gpd.GeoDataFrame:
    """경계 범위를 size_m 간격 정사각 격자로 나눠 cell_id를 붙여 반환한다."""
    minx, miny, maxx, maxy = boundary.total_bounds
    cells = [
        box(x, y, x + size_m, y + size_m)
        for x in np.arange(minx, maxx, size_m)
        for y in np.arange(miny, maxy, size_m)
    ]
    grid = gpd.GeoDataFrame(geometry=cells, crs=CRS_METRIC)
    # 경계와 겹치는 셀만 남긴다
    area = boundary.union_all()
    grid = grid[grid.intersects(area)].reset_index(drop=True)
    grid.insert(0, "cell_id", grid.index)
    return grid


def shade_ratio(grid: gpd.GeoDataFrame, shadow: MultiPolygon) -> pd.Series:
    """셀별 그늘율(교차면적/셀면적, 0~1)을 계산해 Series로 반환한다."""
    inter_area = grid.geometry.intersection(shadow).area
    return (inter_area / grid.geometry.area).clip(0.0, 1.0)
