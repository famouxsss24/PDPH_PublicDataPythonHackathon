"""graph 수용 테스트 — β(그늘 선호도)에 따라 경로 선택이 달라지는지 검증한다."""

import networkx as nx

from gneulro.graph import best_paths


def toy_graph() -> nx.MultiDiGraph:
    """3노드 2경로 장난감 그래프: 직행(150m, 그늘 0%) vs 우회(200m, 그늘 100%)."""
    G = nx.MultiDiGraph()
    G.add_node(1, x=0.0, y=0.0)
    G.add_node(2, x=0.001, y=0.001)
    G.add_node(3, x=0.002, y=0.0)
    # 직행 1→3: 짧지만 그늘 없음
    G.add_edge(1, 3, length=150.0, shade_14=0.0)
    # 우회 1→2→3: 길지만 전부 그늘
    G.add_edge(1, 2, length=100.0, shade_14=1.0)
    G.add_edge(2, 3, length=100.0, shade_14=1.0)
    return G


def test_beta_zero_picks_shortest():
    """β=0이면 그늘 경로도 최단경로와 동일해야 한다."""
    result = best_paths(toy_graph(), 1, 3, hour=14, beta=0.0)
    assert result["shortest"]["coords"] == result["shade"]["coords"]
    assert result["shortest"]["dist_m"] == 150


def test_beta_large_picks_shade():
    """β가 크면 그늘 경로는 우회(그늘 100%)를 선택해야 한다."""
    result = best_paths(toy_graph(), 1, 3, hour=14, beta=2.0)
    assert result["shade"]["dist_m"] == 200
    assert result["shade"]["shade_pct"] == 100
    assert result["shortest"]["dist_m"] == 150
