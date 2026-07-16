"""Solar-exposure proxy and official-shelter candidate tests."""

import geopandas as gpd
import networkx as nx
from shapely.geometry import Point

from gneulro.heat import (
    cooling_stop_candidates,
    departure_heat_curve,
    departure_heat_summary,
    first_lower_exposure,
    route_heat_exposure,
)


def _route_graph() -> nx.MultiDiGraph:
    graph = nx.MultiDiGraph()
    graph.add_node(1, x=127.0600, y=37.6500)
    graph.add_node(2, x=127.0610, y=37.6500)
    graph.add_node(3, x=127.0620, y=37.6500)
    graph.add_edge(1, 2, length=100.0, shade_14=0.0, shade_15=0.0)
    graph.add_edge(2, 3, length=100.0, shade_14=1.0, shade_15=1.0)
    return graph


def test_elder_mode_accumulates_more_exposure_and_time() -> None:
    graph = _route_graph()
    default = route_heat_exposure(graph, [1, 2, 3], 14.0, "default")
    elder = route_heat_exposure(graph, [1, 2, 3], 14.0, "elder")

    assert default["exposure_sun_min"] == 1.39
    assert elder["exposure_sun_min"] == 1.96
    assert elder["mode_time_min"] > default["mode_time_min"]
    assert default["gauge"][0]["budget_used_pct"] == 0
    assert default["gauge"][-1]["d_m"] == 200


def _cooling_spots() -> gpd.GeoDataFrame:
    rows = [
        {
            "spot_id": "public",
            "name": "공공 쉼터",
            "lat": 37.6501,
            "lon": 127.0615,
            "address": "노원구",
            "facility_type": "공공시설",
            "capacity": 30,
            "open_hours": None,
            "operating_note": None,
            "access_scope": "public",
            "source": "official",
            "source_url": "https://example.test/public",
            "geometry": Point(127.0615, 37.6501),
        },
        {
            "spot_id": "restricted",
            "name": "회원 쉼터",
            "lat": 37.6500,
            "lon": 127.0610,
            "address": "노원구",
            "facility_type": "회원이용시설",
            "capacity": 10,
            "open_hours": None,
            "operating_note": None,
            "access_scope": "restricted",
            "source": "official",
            "source_url": "https://example.test/restricted",
            "geometry": Point(127.0610, 37.6500),
        },
    ]
    return gpd.GeoDataFrame(rows, geometry="geometry", crs=4326)


def test_stop_candidates_exclude_restricted_facilities() -> None:
    stops = cooling_stop_candidates(
        _cooling_spots(),
        [(37.65, 127.06), (37.65, 127.062)],
        before_distance_m=220,
    )

    assert [stop["spot_id"] for stop in stops] == ["public"]
    assert stops[0]["availability"] == "check_before_visit"
    assert stops[0]["open_hours"] is None


def test_departure_curve_and_first_lower_exposure() -> None:
    graph = _route_graph()
    curve = departure_heat_curve(graph, [1, 2, 3], ["14:00", "15:00"], "elder")
    curve[1]["exposure_sun_min"] = curve[0]["exposure_sun_min"] - 0.1

    assert all("budget_used_pct" in point for point in curve)
    assert first_lower_exposure(curve, 14.0) == curve[1]


def test_departure_summary_keeps_legacy_curve_fields() -> None:
    summary = departure_heat_summary(
        _route_graph(),
        [1, 2, 3],
        [
            {"t": "14:00", "exposure_m": 100},
            {"t": "15:00", "exposure_m": 80},
        ],
        "elder",
        14.0,
    )

    assert [point["exposure_m"] for point in summary["curve"]] == [100, 80]
    assert summary["model"] == "sun_exposure_proxy_v1"
    assert summary["mode_label"] == "어르신 동행"
    assert summary["reference_time"] == "14:00"
    assert "의학적 안전 기준" in summary["disclaimer"]
