"""6단계: 격자별 SDI를 계산해 결과를 갱신하고 상위 셀 보고서를 만든다."""

from pathlib import Path

import pandas as pd

from gneulro.config import DATA_RAW, REPORTS
from gneulro.sdi import build_sdi_layer
from gneulro.store import Store


def main():
    """기존 grid_cells에 SDI를 붙이고 reports/top10.csv를 산출한다."""
    store = Store()
    grid = store.load_layer("grid_cells")
    grid = build_sdi_layer(
        grid,
        population_path=str(DATA_RAW / "population.csv"),
        shelters_path=str(DATA_RAW / "shelters.csv"),
    )
    store.save_layer(grid, "grid_cells")

    REPORTS.mkdir(exist_ok=True)
    top10 = grid[["cell_id", "sdi", "shade_14"]].sort_values("sdi", ascending=False).head(10)
    top10.to_csv(REPORTS / "top10.csv", index=False)
    print(f"[완료] SDI 계산 완료, 상위 {len(top10)}개 셀 저장 → reports/top10.csv")


if __name__ == "__main__":
    main()
