"""입력 데이터 로더의 호환성 테스트."""

import geopandas as gpd
from shapely.geometry import Point

from gneulro.io_utils import load_buildings


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
