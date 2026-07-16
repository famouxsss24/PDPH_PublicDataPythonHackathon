"""저장소 추상화 — USE_POSTGIS 환경변수에 따라 PostGIS 또는 GeoParquet에 저장한다."""

import json
import os
from pathlib import Path

import geopandas as gpd
from sqlalchemy.exc import OperationalError

from gneulro.config import CRS_WGS, DATA_PROCESSED


def _round_coords(obj: list | float, ndigits: int = 5) -> list | float:
    """GeoJSON 좌표 배열(중첩 리스트)의 실수를 재귀적으로 반올림한다."""
    if isinstance(obj, list):
        return [_round_coords(x, ndigits) for x in obj]
    return round(obj, ndigits)


def _load_env() -> None:
    """프로젝트 루트의 .env 파일을 읽어 환경변수로 등록한다 (이미 있으면 유지)."""
    env_path = Path(".env")
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


class Store:
    """공간 레이어 저장/로드를 담당한다. PostGIS와 Parquet 두 백엔드의 인터페이스가 같다."""

    def __init__(self):
        """환경변수(USE_POSTGIS, POSTGRES_URL)를 읽어 백엔드를 결정한다."""
        _load_env()
        self.use_postgis = os.getenv("USE_POSTGIS", "false").lower() == "true"
        self.engine = None
        if self.use_postgis:
            from sqlalchemy import create_engine

            try:
                self.engine = create_engine(os.environ["POSTGRES_URL"])
            except OperationalError:
                self._fallback_to_parquet("초기화")

    def _fallback_to_parquet(self, stage: str) -> None:
        """PostGIS 연결 실패 시 parquet 백엔드로 전환한다."""
        print(f"[store] PostGIS {stage} 실패 — parquet 모드로 fallback합니다.")
        self.use_postgis = False
        self.engine = None

    def save_layer(self, gdf: gpd.GeoDataFrame, name: str) -> None:
        """레이어를 PostGIS 테이블 또는 processed/{name}.parquet로 저장한다."""
        if self.use_postgis:
            try:
                gdf.to_postgis(name, self.engine, if_exists="replace", index=False)
            except OperationalError:
                self._fallback_to_parquet("저장")
        DATA_PROCESSED.mkdir(parents=True, exist_ok=True)
        if not self.use_postgis:
            gdf.to_parquet(DATA_PROCESSED / f"{name}.parquet")

    def load_layer(self, name: str) -> gpd.GeoDataFrame:
        """저장된 레이어를 GeoDataFrame으로 읽는다."""
        if self.use_postgis:
            try:
                return gpd.read_postgis(f'SELECT * FROM "{name}"', self.engine, geom_col="geometry")
            except OperationalError:
                self._fallback_to_parquet("읽기")
        parquet_path = DATA_PROCESSED / f"{name}.parquet"
        if parquet_path.exists():
            return gpd.read_parquet(parquet_path)
        raise FileNotFoundError(
            f"{parquet_path}가 없습니다. 먼저 data/raw에 공공데이터를 넣고 pipeline/01_prepare.py를 실행하세요."
        )

    def to_geojson(self, gdf: gpd.GeoDataFrame, simplify_m: float = 2.0) -> dict:
        """GeoDataFrame을 단순화한 WGS84 GeoJSON dict로 직렬화한다."""
        gdf = gdf.copy()
        gdf.geometry = gdf.geometry.simplify(simplify_m)
        gdf = gdf.to_crs(CRS_WGS)
        fc = json.loads(gdf.to_json())
        for feat in fc["features"]:  # 소수점 15자리 좌표가 응답을 3배 키움 → 5자리(약 1m)로 절삭
            feat["geometry"]["coordinates"] = _round_coords(feat["geometry"]["coordinates"])
        return fc

    def layer_geojson(self, name: str, simplify_m: float = 2.0) -> dict:
        """레이어를 4326 변환·단순화 후 GeoJSON FeatureCollection dict로 반환한다 (API용)."""
        return self.to_geojson(self.load_layer(name), simplify_m)
