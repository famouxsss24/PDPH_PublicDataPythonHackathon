"""1단계: 원천 데이터(건물 shp, 가로수 CSV)를 표준화하고 노원구로 클립해 저장한다."""

import geopandas as gpd

from gneulro.config import DATA_PROCESSED, DATA_RAW
from gneulro.grid import nowon_boundary
from gneulro.io_utils import load_buildings, load_trees
from gneulro.shadowcast import effective_heights
from gneulro.store import Store


def clip_to_area(gdf: gpd.GeoDataFrame, boundary: gpd.GeoDataFrame, predicate: str):
    """경계와 겹치는(또는 내부의) 피처만 남긴다. 원천이 서울 전역일 때 노원구로 좁힌다."""
    kept = gdf.sjoin(boundary[["geometry"]], predicate=predicate)
    kept = kept[~kept.index.duplicated()].drop(columns="index_right")
    return kept.reset_index(drop=True)


def main():
    """건물·가로수를 읽어 노원구로 클립하고 Store와 parquet로 저장한 뒤 요약을 출력한다."""
    shp_files = sorted((DATA_RAW / "buildings").glob("*.shp"))
    if not shp_files:
        print(f"[중단] {DATA_RAW / 'buildings'}에 .shp가 없습니다. SPEC §3을 보고 내려받으세요.")
        return
    boundary = nowon_boundary()

    buildings = load_buildings(shp_files[0])
    seoul = len(buildings)
    buildings = clip_to_area(buildings, boundary, "intersects")  # 건물은 경계 걸친 것도 포함
    print(f"[clip] 건물 노원구 클립: 서울 {seoul}동 → 노원 {len(buildings)}동")
    total = len(buildings)
    buildings = effective_heights(buildings)
    buildings = buildings[["height_eff", "floors", "geometry"]].reset_index(names="id")

    store = Store()
    store.save_layer(buildings, "buildings")
    print(f"[완료] 건물 {len(buildings)}/{total}동 저장 (높이결측 제외 {total - len(buildings)}동)")

    trees_csv = DATA_RAW / "trees.csv"
    if trees_csv.exists():
        trees = load_trees(trees_csv)
        seoul_trees = len(trees)
        trees = clip_to_area(trees, boundary, "within")  # 가로수는 경계 내부만
        DATA_PROCESSED.mkdir(parents=True, exist_ok=True)
        trees[["geometry"]].to_parquet(DATA_PROCESSED / "trees.parquet")
        print(f"[완료] 가로수 서울 {seoul_trees} → 노원 {len(trees)}그루 저장")
    else:
        print("[경고] trees.csv 없음 — 가로수 그늘 없이 진행합니다.")


if __name__ == "__main__":
    main()
