"""입력 데이터 로더의 호환성 테스트."""

import geopandas as gpd
import pandas as pd
from shapely.geometry import Point

from gneulro.io_utils import load_buildings, load_trees


def test_load_buildings_accepts_nested_shapefile_without_prj(tmp_path):
    """PRJ가 없더라도 중첩 폴더의 shp를 읽어 높이/층수 컬럼을 만들 수 있어야 한다."""
    data_dir = tmp_path / "nested" / "buildings"
    data_dir.mkdir(parents=True)
    path = data_dir / "sample.shp"

    gdf = gpd.GeoDataFrame(
        {"height": [10.0], "GRND_FLR": [2]},
        geometry=[Point(127.0, 37.6)],
        crs="EPSG:4326",
    )
    gdf.to_file(path, driver="ESRI Shapefile")
    (data_dir / "sample.prj").unlink(missing_ok=True)

    loaded = load_buildings(path)

    assert loaded.crs.to_epsg() == 5186
    assert loaded["height"].iloc[0] == 10.0
    assert loaded["floors"].iloc[0] == 2.0


def test_load_trees_accepts_korean_column_names(tmp_path):
    """가로수 CSV의 한국식 컬럼명도 읽을 수 있어야 한다."""
    path = tmp_path / "trees.csv"
    pd.DataFrame(
        {
            "좌표(경도)": [127.0],
            "좌표(위도)": [37.6],
        }
    ).to_csv(path, index=False, encoding="utf-8")

    loaded = load_trees(path)

    assert len(loaded) == 1
    assert loaded.crs.to_epsg() == 5186
