"""4단계: 보행망을 내려받고 엣지별 그늘 가중치를 붙여 graphml로 저장한다."""

import geopandas as gpd

from gneulro.config import DATA_PROCESSED, HOURS, TREE_SHADE_RADIUS_M
from gneulro.graph import GRAPH_PATH, attach_edge_shade, build_graph, load_graph
from gneulro.store import Store


def main():
    """보행망 확보 → 시간대별 그림자를 엣지에 부여 → 저장 후 통계를 출력한다."""
    store = Store()
    G = load_graph() if GRAPH_PATH.exists() else build_graph()
    shadows = store.load_layer("shadows")
    tree_shade = None
    trees_path = DATA_PROCESSED / "trees.parquet"
    if trees_path.exists():
        trees = gpd.read_parquet(trees_path)
        tree_shade = trees.buffer(TREE_SHADE_RADIUS_M).union_all()
    shadows_by_hour = {
        hour: shadows.loc[shadows["hour"] == hour, "geometry"].iloc[0]
        for hour in HOURS
    }
    if tree_shade is not None:
        shadows_by_hour = {
            hour: shadow.union(tree_shade) for hour, shadow in shadows_by_hour.items()
        }
    G = attach_edge_shade(G, shadows_by_hour)

    values = [float(d.get("shade_14", 0.0)) for _, _, d in G.edges(data=True)]
    print(
        f"[완료] 노드 {len(G.nodes):,} / 엣지 {len(G.edges):,}, "
        f"평균 shade_14 = {sum(values) / len(values):.3f}"
        f" ({'건물+가로수' if tree_shade is not None else '건물'})"
    )


if __name__ == "__main__":
    main()
