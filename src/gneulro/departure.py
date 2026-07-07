"""출발 시각 추천 — 고정 경로의 시간대별 햇빛 노출량을 계산해 최적 출발시각을 찾는다."""

import networkx as nx

from gneulro.config import HOURS


def _route_exposure(G: nx.MultiDiGraph, route_nodes: list, hour: int) -> float:
    """경로의 특정 시간대 노출량 Σ(길이 × (1 - 그늘율))을 미터로 계산한다."""
    total = 0.0
    for u, v in zip(route_nodes[:-1], route_nodes[1:]):
        data = min(G.get_edge_data(u, v).values(), key=lambda a: a["length"])
        total += data["length"] * (1.0 - float(data.get(f"shade_{hour}", 0.0)))
    return total


def exposure_curve(G: nx.MultiDiGraph, route_nodes: list, hours: list[int] = HOURS) -> list[dict]:
    """시간대별 노출량을 계산하고 HOURS 사이를 10분 단위로 선형 보간한 곡선을 반환한다."""
    base = {h: _route_exposure(G, route_nodes, h) for h in hours}
    curve = []
    for h1, h2 in zip(hours[:-1], hours[1:]):
        span_min = (h2 - h1) * 60
        for m in range(0, span_min, 10):
            frac = m / span_min
            exposure = base[h1] + (base[h2] - base[h1]) * frac
            hh, mm = h1 + m // 60, m % 60
            curve.append({"t": f"{hh:02d}:{mm:02d}", "exposure_m": round(exposure)})
    curve.append({"t": f"{hours[-1]:02d}:00", "exposure_m": round(base[hours[-1]])})
    return curve


def recommend(curve: list[dict]) -> dict:
    """노출량이 가장 적은 시각(best)과 가장 많은 시각(worst)을 반환한다."""
    return {
        "best": min(curve, key=lambda c: c["exposure_m"]),
        "worst": max(curve, key=lambda c: c["exposure_m"]),
    }
