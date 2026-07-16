"""한국 공공데이터 파일 로더 — 인코딩·좌표계·컬럼 매핑은 전부 이 모듈에서만 처리한다."""

from pathlib import Path

import geopandas as gpd
import pandas as pd

from gneulro.config import CRS_METRIC, CRS_WGS


def _resolve_data_path(path: str | Path) -> Path:
    """입력 경로가 파일이 아니면 같은 폴더의 첫 .shp/.csv 파일을 찾아 반환한다."""
    p = Path(path)
    if p.exists():
        return p

    if p.suffix.lower() == ".shp":
        candidates = sorted(p.parent.glob("*.shp"))
        if candidates:
            return candidates[0]
    elif p.suffix.lower() == ".csv":
        candidates = sorted(p.parent.glob("*.csv"))
        if candidates:
            return candidates[0]

    if p.suffix:
        raise FileNotFoundError(f"데이터 파일을 찾지 못했습니다: {p}")

    if p.name == "buildings":
        candidates = sorted(p.parent.glob("*.shp"))
        if candidates:
            return candidates[0]

    raise FileNotFoundError(f"데이터 경로를 찾지 못했습니다: {p}")

# 배포본마다 다른 컬럼명 후보 (매핑 결과는 로드 시 출력 — 다르면 사용자에게 확인)
# GIS건물통합정보(AL_D010) 실측 확인: 높이=A16(m, 다수 결측), 지상층수=A26. A15는 면적이라 층수 아님.
HEIGHT_CANDIDATES = ["height", "HEIGHT", "A16", "BULD_HG", "높이"]
FLOOR_CANDIDATES = ["GRND_FLR", "grnd_flr", "GROUND_FLO", "A26", "지상층수", "층수"]
LAT_CANDIDATES = [
    "위도",
    "lat",
    "LAT",
    "latitude",
    "Y좌표",
    "좌표(위도)",
    "위치_y",
    "y",
]
LON_CANDIDATES = [
    "경도",
    "lon",
    "lng",
    "LON",
    "longitude",
    "X좌표",
    "좌표(경도)",
    "위치_x",
    "x",
]


def find_col(df: pd.DataFrame, candidates: list[str]) -> str | None:
    """후보 이름 중 실제 존재하는 첫 컬럼명을 반환한다 (없으면 None)."""
    for name in candidates:
        if name in df.columns:
            return name
    return None


def read_csv_kr(path: str | Path, **kwargs) -> pd.DataFrame:
    """한국 공공 CSV를 utf-8로 읽고, 실패하면 cp949로 재시도한다."""
    path = _resolve_data_path(path)
    try:
        return pd.read_csv(path, encoding="utf-8", **kwargs)
    except UnicodeDecodeError:
        return pd.read_csv(path, encoding="cp949", **kwargs)


def read_shp_metric(path: str | Path) -> gpd.GeoDataFrame:
    """쉐이프파일을 읽어 계산용 좌표계(EPSG:5186)로 변환해 반환한다."""
    path = _resolve_data_path(path)
    gdf = gpd.read_file(path)
    if gdf.crs is None:
        print(f"[io] 경고: {path}에 좌표계 정보가 없어 EPSG:4326로 가정합니다.")
        gdf = gdf.set_crs(CRS_WGS, allow_override=True)
    return gdf.to_crs(CRS_METRIC)


def load_buildings(path: str | Path) -> gpd.GeoDataFrame:
    """건물 shp를 읽어 height/floors 표준 컬럼을 만든다. 컬럼을 못 찾으면 목록을 보여준다."""
    gdf = read_shp_metric(path)
    height_col = find_col(gdf, HEIGHT_CANDIDATES)
    floor_col = find_col(gdf, FLOOR_CANDIDATES)
    if height_col is None and floor_col is None:
        raise ValueError(
            f"높이/층수 컬럼을 찾지 못했습니다. 실제 컬럼: {list(gdf.columns)}\n"
            "→ SPEC §3에 따라 컬럼 매핑을 사용자에게 확인받으세요."
        )
    print(f"[io] 건물 컬럼 매핑: 높이={height_col}, 층수={floor_col} (다르면 알려주세요)")
    gdf["height"] = (
        pd.to_numeric(gdf[height_col], errors="coerce").fillna(0.0) if height_col else 0.0
    )
    gdf["floors"] = (
        pd.to_numeric(gdf[floor_col], errors="coerce").fillna(0.0) if floor_col else 0.0
    )
    return gdf


def load_trees(path: str | Path) -> gpd.GeoDataFrame:
    """가로수 CSV를 읽어 EPSG:5186 포인트 GeoDataFrame으로 변환한다."""
    df = read_csv_kr(path)
    lat_col = find_col(df, LAT_CANDIDATES)
    lon_col = find_col(df, LON_CANDIDATES)
    if lat_col is None or lon_col is None:
        raise ValueError(f"가로수 위경도 컬럼을 찾지 못했습니다. 실제 컬럼: {list(df.columns)}")
    points = gpd.GeoDataFrame(
        df, geometry=gpd.points_from_xy(df[lon_col], df[lat_col]), crs=CRS_WGS
    )
    return points.to_crs(CRS_METRIC)
