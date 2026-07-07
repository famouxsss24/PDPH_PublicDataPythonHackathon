"""1단계: 원천 데이터(건물 shp, 가로수 CSV)를 표준화해 저장한다."""

from gneulro.config import DATA_PROCESSED, DATA_RAW
from gneulro.io_utils import load_buildings, load_trees
from gneulro.shadowcast import effective_heights
from gneulro.store import Store


def main():
    """건물·가로수를 읽어 Store와 parquet로 저장하고 요약을 출력한다."""
    shp_files = sorted((DATA_RAW / "buildings").glob("*.shp"))
    if not shp_files:
        print(f"[중단] {DATA_RAW / 'buildings'}에 .shp가 없습니다. SPEC §3을 보고 내려받으세요.")
        return
    buildings = load_buildings(shp_files[0])
    total = len(buildings)
    buildings = effective_heights(buildings)
    buildings = buildings[["height_eff", "floors", "geometry"]].reset_index(names="id")

    store = Store()
    store.save_layer(buildings, "buildings")
    print(f"[완료] 건물 {len(buildings)}/{total}동 저장 (높이결측 제외 {total - len(buildings)}동)")

    trees_csv = DATA_RAW / "trees.csv"
    if trees_csv.exists():
        trees = load_trees(trees_csv)
        DATA_PROCESSED.mkdir(parents=True, exist_ok=True)
        trees[["geometry"]].to_parquet(DATA_PROCESSED / "trees.parquet")
        print(f"[완료] 가로수 {len(trees)}그루 저장")
    else:
        print("[경고] trees.csv 없음 — 가로수 그늘 없이 진행합니다.")


if __name__ == "__main__":
    main()
