"""SDI 계산 테스트 — 그늘 부족과 취약 인구를 결합한 지수를 산출한다."""

import geopandas as gpd
from shapely.geometry import box

from gneulro.config import CRS_METRIC
from gneulro.sdi import compute_sdi


def test_compute_sdi_adds_columns_and_ranks_cells():
    """그늘이 적은 셀일수록 더 높은 SDI를 갖는다."""
    grid = gpd.GeoDataFrame(
        {"cell_id": [0, 1], "shade_14": [0.2, 0.8]},
        geometry=[box(0, 0, 50, 50), box(50, 0, 100, 50)],
        crs=CRS_METRIC,
    )

    result = compute_sdi(grid)

    assert "pop_vuln" in result.columns
    assert "sdi" in result.columns
    assert result.loc[result["cell_id"] == 0, "sdi"].iloc[0] >= result.loc[result["cell_id"] == 1, "sdi"].iloc[0]
    assert result["sdi"].notna().all()
