"""departure 수용 테스트 — 선형 보간값이 양 끝점 범위 안에 있는지 검증한다."""

import networkx as nx

from gneulro.departure import exposure_curve, recommend


def line_graph() -> nx.MultiDiGraph:
    """2노드 1엣지(100m) 그래프. 10시 그늘 0%, 13시 그늘 100%."""
    G = nx.MultiDiGraph()
    G.add_node(1, x=0.0, y=0.0)
    G.add_node(2, x=0.001, y=0.0)
    G.add_edge(1, 2, length=100.0, shade_10=0.0, shade_13=1.0)
    return G


def test_interpolation_within_bounds():
    """보간 구간(10~13시)의 노출량은 양 끝값(0~100m) 사이여야 한다."""
    curve = exposure_curve(line_graph(), [1, 2], hours=[10, 13])
    assert curve[0] == {"t": "10:00", "exposure_m": 100}  # 그늘 0% → 노출 100m
    assert curve[-1] == {"t": "13:00", "exposure_m": 0}  # 그늘 100% → 노출 0m
    for point in curve:
        assert 0 <= point["exposure_m"] <= 100


def test_recommend_best_worst():
    """추천 결과: best는 노출 최소(13:00), worst는 노출 최대(10:00)."""
    curve = exposure_curve(line_graph(), [1, 2], hours=[10, 13])
    rec = recommend(curve)
    assert rec["best"]["t"] == "13:00"
    assert rec["worst"]["t"] == "10:00"
