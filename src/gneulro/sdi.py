"""그리드별 SDI(Shade-Density Index) 계산 — 그늘 부족과 취약 인구를 결합한다."""

from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import pandas as pd

from gneulro.config import DATA_RAW
from gneulro.io_utils import LAT_CANDIDATES, LON_CANDIDATES, find_col, read_csv_kr


def _choose_shade_column(grid: gpd.GeoDataFrame) -> str:
    """shade_14 같은 기존 컬럼을 우선 사용하고, 없으면 첫 번째 shade_* 컬럼을 반환한다."""
    if "shade_14" in grid.columns:
        return "shade_14"
    shade_cols = [col for col in grid.columns if col.startswith("shade_")]
    if shade_cols:
        return shade_cols[0]
    return "shade_14"


def _load_population(path) -> pd.DataFrame | None:
    """인구 데이터 CSV가 있으면 읽어 반환한다."""
    if not path.exists():
        return None
    return read_csv_kr(path)


def _load_shelters(path) -> gpd.GeoDataFrame | None:
    """쉼터 CSV가 있으면 위경도 기반 GeoDataFrame으로 읽어 반환한다."""
    if not path.exists():
        return None
    df = read_csv_kr(path)
    lat_col = find_col(df, LAT_CANDIDATES)
    lon_col = find_col(df, LON_CANDIDATES)
    if lat_col is None or lon_col is None:
        return None
    return gpd.GeoDataFrame(
        df,
        geometry=gpd.points_from_xy(df[lon_col], df[lat_col]),
        crs=4326,
    )


def _estimate_pop_vuln(population: pd.DataFrame | None, shelters: gpd.GeoDataFrame | None) -> float:
    """인구/쉼터 데이터가 없으면 기본 취약도 1.0을 사용한다."""
    if population is None:
        return 1.0

    numeric_cols = [
        col
        for col in population.columns
        if col not in {"id", "cell_id", "행정동", "동", "읍면동", "구분", "name", "지역"}
        and pd.api.types.is_numeric_dtype(population[col])
    ]
    if not numeric_cols:
        return 1.0

    vuln = population[numeric_cols].sum(axis=1).fillna(0.0)
    return float(vuln.max() / max(vuln.sum(), 1.0)) if not vuln.empty else 1.0


def compute_sdi(
    grid: gpd.GeoDataFrame,
    population: pd.DataFrame | None = None,
    shelters: gpd.GeoDataFrame | None = None,
) -> gpd.GeoDataFrame:
    """격자별 SDI = (1 - 그늘비율) × 취약도 지수로 계산한다."""
    result = grid.copy()
    shade_col = _choose_shade_column(result)
    shade = result[shade_col].fillna(0.0)
    pop_vuln = _estimate_pop_vuln(population, shelters)

    result["pop_vuln"] = pop_vuln
    result["sdi"] = (1.0 - shade.clip(0.0, 1.0)) * pop_vuln
    result["sdi"] = result["sdi"].fillna(0.0)
    return result


def build_sdi_layer(
    grid: gpd.GeoDataFrame,
    population_path: str | None = None,
    shelters_path: str | None = None,
) -> gpd.GeoDataFrame:
    """CSV 파일 경로를 받아 바로 SDI가 붙은 격자 GeoDataFrame을 반환한다."""
    population = _load_population(Path(population_path) if population_path else DATA_RAW / "population.csv")
    shelters = _load_shelters(Path(shelters_path) if shelters_path else DATA_RAW / "shelters.csv")
    return compute_sdi(grid, population=population, shelters=shelters)
