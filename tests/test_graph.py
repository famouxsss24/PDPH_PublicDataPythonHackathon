"""graph 수용 테스트 — β(그늘 선호도)에 따라 경로 선택이 달라지는지 검증한다."""

import networkx as nx

from gneulro.graph import _edge_shade, _turn_word, best_paths, route_segments, route_steps


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


def test_turn_word_thresholds():
    """방위각 변화량이 직진/좌·우회전/유턴으로 올바르게 분류돼야 한다."""
    assert _turn_word(0, 10) == "직진"
    assert _turn_word(0, 90) == "우회전"
    assert _turn_word(0, 270) == "좌회전"  # 270° = -90°
    assert _turn_word(0, 180) == "유턴"
    assert _turn_word(350, 10) == "직진"  # 0° 경계 넘어도 직진


def test_route_steps_merges_straight():
    """같은 도로명 직진 구간은 한 안내로 합쳐져야 한다."""
    G = nx.MultiDiGraph()
    for i, (x, y) in enumerate([(0, 0), (0, 0.001), (0, 0.002), (0.001, 0.002)]):
        G.add_node(i, x=x, y=y)
    G.add_edge(0, 1, length=100.0, name="동일로")
    G.add_edge(1, 2, length=100.0, name="동일로")  # 같은 길 직진 → 병합
    G.add_edge(2, 3, length=50.0, name="상계로")  # 우회전
    steps = route_steps(G, [0, 1, 2, 3])
    assert len(steps) == 2
    assert steps[0]["name"] == "동일로" and steps[0]["dist_m"] == 200
    assert steps[1]["turn"] == "우회전" and steps[1]["name"] == "상계로"


def test_route_segments_merges_same_exposure():
    """연속된 같은 노출 상태는 합치고 햇빛/그늘 경계는 분리해야 한다."""
    graph = nx.MultiDiGraph()
    coordinates = [(127.0, 37.0), (127.001, 37.0), (127.002, 37.0), (127.003, 37.0)]
    for node, (x, y) in enumerate(coordinates):
        graph.add_node(node, x=x, y=y)
    graph.add_edge(0, 1, length=80.0, shade_14=0.1)
    graph.add_edge(1, 2, length=80.0, shade_14=0.2)
    graph.add_edge(2, 3, length=80.0, shade_14=0.9)

    segments = route_segments(graph, [0, 1, 2, 3], 14)

    assert [segment["shaded"] for segment in segments] == [False, True]
    assert len(segments[0]["coords"]) == 3
    assert segments[0]["coords"][-1] == segments[1]["coords"][0]


def test_edge_shade_interpolates_departure_time():
    """대표 프레임 사이의 10분 단위 출발 시각은 엣지 그늘값을 보간해야 한다."""
    edge = {"shade_14": 0.2, "shade_15": 0.8}
    assert _edge_shade(edge, 14.0) == 0.2
    assert _edge_shade(edge, 14.5) == 0.5
    assert _edge_shade(edge, 15.0) == 0.8
