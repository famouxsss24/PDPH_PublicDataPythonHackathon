"""보행망·경로 — osmnx 도로망에 그늘 가중치를 붙이고 최단/그늘 경로를 계산한다."""

from math import atan2, cos, degrees, radians

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


def _edge_shade(data: dict, hour: int | float) -> float:
    """대표 시간대 엣지 그늘값을 임의 시각에 선형 보간한다."""
    value = float(hour)
    if value <= HOURS[0]:
        return float(data.get(f"shade_{HOURS[0]}", 0.0))
    if value >= HOURS[-1]:
        return float(data.get(f"shade_{HOURS[-1]}", 0.0))
    for left, right in zip(HOURS[:-1], HOURS[1:]):
        if left <= value <= right:
            fraction = (value - left) / (right - left)
            low = float(data.get(f"shade_{left}", 0.0))
            high = float(data.get(f"shade_{right}", 0.0))
            return low + (high - low) * fraction
    return 0.0


def _shade_weight(hour: int | float, beta: float):
    """그늘 가중치 함수(길이 × (1 + β × (1 - 그늘율)))를 만들어 반환한다."""

    def weight(u, v, d):
        # d = {엣지키: 속성dict} — 병렬 엣지 중 비용이 가장 작은 것 사용
        return min(
            a["length"] * (1 + beta * (1 - _edge_shade(a, hour)))
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


# ---- 그늘 등급별 경로 (β 스윕) ----
BETA_SWEEP = [0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 9.0]  # Pareto 근사용 β 후보
SHADE_TIERS = [40, 60, 80]  # 그늘 달성 등급(%)
DETOUR_LIMIT = 1.25  # 추천 경로가 감수할 최대 시간 배율 (최단 대비 +25%)


def _bearing(G: nx.MultiDiGraph, u: int, v: int) -> float:
    """두 노드 사이 진행 방위각(북=0° 시계방향)을 구한다. 위도 보정 포함."""
    p, q = G.nodes[u], G.nodes[v]
    dx = (q["x"] - p["x"]) * cos(radians(p["y"]))  # 경도차는 위도에 따라 축소
    dy = q["y"] - p["y"]
    return (degrees(atan2(dx, dy)) + 360.0) % 360.0


def _turn_word(prev_deg: float, cur_deg: float) -> str:
    """방위각 변화량을 직진/좌회전/우회전/유턴 안내어로 바꾼다."""
    d = (cur_deg - prev_deg + 540.0) % 360.0 - 180.0
    if abs(d) < 35.0:
        return "직진"
    if abs(d) > 150.0:
        return "유턴"
    return "우회전" if d > 0 else "좌회전"


def route_steps(G: nx.MultiDiGraph, nodes: list) -> list[dict]:
    """경로를 도로명 단위로 묶어 턴바이턴 안내 목록을 만든다."""
    steps: list[dict] = []
    prev_bearing = None
    for u, v in zip(nodes[:-1], nodes[1:]):
        data = min(G.get_edge_data(u, v).values(), key=lambda a: a["length"])
        name = data.get("name", "")
        if isinstance(name, list):  # osmnx는 도로명이 여러 개면 리스트로 준다
            name = name[0]
        bearing = _bearing(G, u, v)
        turn = "출발" if prev_bearing is None else _turn_word(prev_bearing, bearing)
        prev_bearing = bearing
        if steps and turn == "직진" and steps[-1]["name"] == (name or "골목길"):
            steps[-1]["dist_m"] += data["length"]  # 같은 길 직진은 하나로 합침
        else:
            steps.append({"turn": turn, "name": name or "골목길", "dist_m": data["length"]})
    for s in steps:
        s["dist_m"] = round(s["dist_m"])
    return steps


def route_segments(G: nx.MultiDiGraph, nodes: list, hour: int | float) -> list[dict]:
    """경로 엣지를 그늘/햇빛 구간으로 병합해 지도 색칠용 좌표를 만든다."""
    segments: list[dict] = []
    for u, v in zip(nodes[:-1], nodes[1:]):
        data = min(G.get_edge_data(u, v).values(), key=lambda item: item["length"])
        shaded = _edge_shade(data, hour) >= 0.5
        if "geometry" in data:
            coords = [[round(lat, 6), round(lon, 6)] for lon, lat in data["geometry"].coords]
        else:
            coords = [
                [round(G.nodes[u]["y"], 6), round(G.nodes[u]["x"], 6)],
                [round(G.nodes[v]["y"], 6), round(G.nodes[v]["x"], 6)],
            ]
        if segments and segments[-1]["shaded"] == shaded:
            segments[-1]["coords"].extend(coords[1:])
        else:
            segments.append({"shaded": shaded, "coords": coords})
    return segments


def route_options(
    G: nx.MultiDiGraph,
    start: tuple[float, float],
    end: tuple[float, float],
    hour: int | float,
    *,
    include_nodes: bool = False,
) -> dict:
    """최단경로 + β 스윕으로 얻은 그늘 대안들을 그늘 등급(40/60/80%+)으로 정리한다.

    반환 routes의 각 항목: route_stat + steps + labels(등급 배지) + delta_min(최단 대비).
    추천 = 시간이 최단×DETOUR_LIMIT 이내인 후보 중 그늘이 가장 높은 경로.
    """
    import osmnx as ox

    orig = ox.distance.nearest_nodes(G, X=start[1], Y=start[0])
    dest = ox.distance.nearest_nodes(G, X=end[1], Y=end[0])

    # 후보 수집: 최단 1개 + β별 그늘경로 (노드열이 같으면 중복 제거)
    cand: dict[tuple, None] = {tuple(nx.shortest_path(G, orig, dest, weight="length")): None}
    for beta in BETA_SWEEP:
        nodes = nx.shortest_path(G, orig, dest, weight=_shade_weight(hour, beta))
        cand.setdefault(tuple(nodes), None)

    routes = []
    for nodes in cand:
        stat = route_stat(G, list(nodes), hour)
        stat["steps"] = route_steps(G, list(nodes))
        stat["segments"] = route_segments(G, list(nodes), hour)
        stat["labels"] = []
        if include_nodes:
            stat["_nodes"] = list(nodes)
        routes.append(stat)
    routes.sort(key=lambda r: r["time_min"])

    shortest_time = routes[0]["time_min"]
    routes[0]["labels"].append("최단")
    for r in routes:
        r["delta_min"] = round(r["time_min"] - shortest_time, 1)
    for tier in SHADE_TIERS:  # 각 등급을 달성하는 가장 빠른 경로에 배지
        hit = [r for r in routes if r["shade_pct"] >= tier]
        if hit:
            min(hit, key=lambda r: r["time_min"])["labels"].append(f"그늘 {tier}%+")

    pool = [r for r in routes if r["time_min"] <= shortest_time * DETOUR_LIMIT + 0.5]
    recommended = max(pool, key=lambda r: r["shade_pct"])
    recommended["labels"].append("추천")

    keep = [r for r in routes if r["labels"]]  # 배지 없는 중간 후보는 버림
    return {"routes": keep, "recommended_idx": keep.index(recommended)}


def route_stat(G: nx.MultiDiGraph, nodes: list, hour: int | float) -> dict:
    """경로 노드 목록에서 좌표·거리·시간·그늘% 통계를 만든다."""
    dist = 0.0
    shaded = 0.0
    for u, v in zip(nodes[:-1], nodes[1:]):
        data = min(G.get_edge_data(u, v).values(), key=lambda a: a["length"])
        dist += data["length"]
        shaded += data["length"] * _edge_shade(data, hour)
    return {
        "coords": [(G.nodes[n]["y"], G.nodes[n]["x"]) for n in nodes],
        "dist_m": round(dist),
        "time_min": round(dist / WALK_SPEED_MPS / 60, 1),
        "shade_pct": round(shaded / dist * 100) if dist > 0 else 0,
    }
