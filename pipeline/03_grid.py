"""3단계: 50m 격자를 만들고 시간대별 그늘율(가로수 포함)을 붙여 grid_cells로 저장한다."""

import geopandas as gpd

from gneulro.config import DATA_PROCESSED, HOURS, TREE_SHADE_RADIUS_M
from gneulro.grid import make_grid, nowon_boundary, shade_ratio
from gneulro.store import Store


def main():
    """격자 생성 → 그림자+가로수 그늘율 계산 → 저장 후 14시 평균을 출력한다."""
    store = Store()
    shadows = store.load_layer("shadows")
    grid = make_grid(nowon_boundary())

    tree_shade = None
    trees_path = DATA_PROCESSED / "trees.parquet"
    if trees_path.exists():
        trees = gpd.read_parquet(trees_path)
        tree_shade = trees.buffer(TREE_SHADE_RADIUS_M).union_all()

    for hour in HOURS:
        shadow = shadows.loc[shadows["hour"] == hour, "geometry"].iloc[0]
        if tree_shade is not None:
            shadow = shadow.union(tree_shade)
        grid[f"shade_{hour}"] = shade_ratio(grid, shadow)

    store.save_layer(grid, "grid_cells")
    print(f"[완료] 격자 {len(grid)}셀, 14시 평균 그늘율 {grid['shade_14'].mean() * 100:.1f}%")


if __name__ == "__main__":
    main()
