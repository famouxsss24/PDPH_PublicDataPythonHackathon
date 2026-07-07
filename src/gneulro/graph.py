"""보행망·경로 — osmnx 도로망에 그늘 가중치를 붙이고 최단/그늘 경로를 계산한다."""

import geopandas as gpd
import networkx as nx
from shapely import STRtree, get_parts
from shapely.geometry import LineString, MultiPolygon

from gneulro.config import (
    BETA_DEFAULT,
    CRS_METRIC,
    CRS_WGS,
    DATA_PROCESSED,
    HOURS,
    PLACE,
    WALK_SPEED_MPS,
)

GRAPH_PATH = DATA_PROCESSED / "walk_graph.graphml"


def build_graph() -> nx.MultiDiGraph:
    """osmnx로 노원구 보행망을 내려받아 graphml로 저장하고 반환한다."""
    import osmnx as ox

    G = ox.graph_from_place(PLACE, network_type="walk")
    DATA_PROCESSED.mkdir(parents=True, exist_ok=True)
    ox.save_graphml(G, GRAPH_PATH)
    return G


def load_graph() -> nx.MultiDiGraph:
    """저장된 graphml을 읽는다. 문자열화된 shade_* 속성은 float로 되돌린다."""
    import osmnx as ox

    dtypes = {f"shade_{h}": float for h in HOURS}
    return ox.load_graphml(GRAPH_PATH, edge_dtypes=dtypes)


def _edge_lines_metric(G: nx.MultiDiGraph) -> gpd.GeoSeries:
    """엣지 지오메트리(없으면 노드 직선)를 EPSG:5186 GeoSeries로 만든다."""
    lines = []
    for u, v, data in G.edges(data=True):
        if "geometry" in data:
            lines.append(data["geometry"])
        else:
            lines.append(
                LineString(
                    [(G.nodes[u]["x"], G.nodes[u]["y"]), (G.nodes[v]["x"], G.nodes[v]["y"])]
                )
            )
    return gpd.GeoSeries(lines, crs=CRS_WGS).to_crs(CRS_METRIC)


def attach_edge_shade(
    G: nx.MultiDiGraph, shadows_by_hour: dict[int, MultiPolygon]
) -> nx.MultiDiGraph:
    """엣지마다 시간대별 그늘 비율(shade_h ∈ [0,1]) 속성을 붙이고 graphml로 재저장한다."""
    import osmnx as ox

    lines = _edge_lines_metric(G)
    edge_datas = [data for _, _, data in G.edges(data=True)]
    for hour, shadow in shadows_by_hour.items():
        parts = get_parts(shadow)  # 병합된 그림자 → 개별 폴리곤 (서로 겹치지 않음)
        tree = STRtree(parts)
        for line, data in zip(lines, edge_datas):
            ratio = 0.0
            if line.length > 0:
                idx = tree.query(line)
                if len(idx) > 0:
                    shaded_len = sum(line.intersection(parts[i]).length for i in idx)
                    ratio = min(shaded_len / line.length, 1.0)
            data[f"shade_{hour}"] = round(ratio, 4)
    DATA_PROCESSED.mkdir(parents=True, exist_ok=True)
    ox.save_graphml(G, GRAPH_PATH)
    return G


def _shade_weight(hour: int, beta: float):
    """그늘 가중치 함수(길이 × (1 + β × (1 - 그늘율)))를 만들어 반환한다."""

    def weight(u, v, d):
        # d = {엣지키: 속성dict} — 병렬 엣지 중 비용이 가장 작은 것 사용
        return min(
            a["length"] * (1 + beta * (1 - float(a.get(f"shade_{hour}", 0.0))))
            for a in d.values()
        )

    return weight


def best_paths(G: nx.MultiDiGraph, orig: int, dest: int, hour: int, beta: float) -> dict:
    """두 노드 사이 최단경로와 그늘경로 통계를 계산한다 (route_pair의 핵심)."""
    shortest = nx.shortest_path(G, orig, dest, weight="length")
    shade = nx.shortest_path(G, orig, dest, weight=_shade_weight(hour, beta))
    return {
        "shortest": route_stat(G, shortest, hour),
        "shade": route_stat(G, shade, hour),
    }


def route_pair(
    G: nx.MultiDiGraph, start: tuple[float, float], end: tuple[float, float], hour: int, beta: float
) -> dict:
    """(lat, lon) 출발/도착을 가까운 노드로 스냅해 최단·그늘 경로 쌍을 반환한다."""
    import osmnx as ox

    orig = ox.distance.nearest_nodes(G, X=start[1], Y=start[0])
    dest = ox.distance.nearest_nodes(G, X=end[1], Y=end[0])
    return best_paths(G, orig, dest, hour, beta)


def shade_route_nodes(
    G: nx.MultiDiGraph,
    start: tuple[float, float],
    end: tuple[float, float],
    hour: int = 14,
    beta: float = BETA_DEFAULT,
) -> list:
    """그늘경로의 노드 목록을 반환한다 (출발시각 추천의 '경로 고정'용, 기본 14시)."""
    import osmnx as ox

    orig = ox.distance.nearest_nodes(G, X=start[1], Y=start[0])
    dest = ox.distance.nearest_nodes(G, X=end[1], Y=end[0])
    return nx.shortest_path(G, orig, dest, weight=_shade_weight(hour, beta))


def route_stat(G: nx.MultiDiGraph, nodes: list, hour: int) -> dict:
    """경로 노드 목록에서 좌표·거리·시간·그늘% 통계를 만든다."""
    dist = 0.0
    shaded = 0.0
    for u, v in zip(nodes[:-1], nodes[1:]):
        data = min(G.get_edge_data(u, v).values(), key=lambda a: a["length"])
        dist += data["length"]
        shaded += data["length"] * float(data.get(f"shade_{hour}", 0.0))
    return {
        "coords": [(G.nodes[n]["y"], G.nodes[n]["x"]) for n in nodes],
        "dist_m": round(dist),
        "time_min": round(dist / WALK_SPEED_MPS / 60, 1),
        "shade_pct": round(shaded / dist * 100) if dist > 0 else 0,
    }
