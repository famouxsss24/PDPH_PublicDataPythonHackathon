"""Relative solar-exposure proxy for unavoidable hot-weather walks.

The budgets in this module are versioned product-demo parameters, not medical
limits.  The calculation exists to compare routes and departure times under
the repository's clear-sky shadow simulation.
"""

from __future__ import annotations

from math import ceil

import geopandas as gpd
import networkx as nx
import pandas as pd
from shapely.geometry import LineString
from shapely.ops import substring

from gneulro.config import CRS_METRIC, CRS_WGS, HOURS
from gneulro.graph import _edge_shade

MODEL_VERSION = "sun_exposure_proxy_v1"
DISCLAIMER = "의학적 안전 기준이 아닌 경로 간 상대 비교용 맑은 하늘 물리 근사치"
MAX_GAUGE_POINTS = 48

MODE_PRESETS = {
    "default": {
        "label": "일반",
        "walk_speed_mps": 1.2,
        "budget_sun_min": 20.0,
        "mode_factor": 1.0,
    },
    "elder": {
        "label": "어르신 동행",
        "walk_speed_mps": 0.85,
        "budget_sun_min": 15.0,
        "mode_factor": 1.0,
    },
}


def get_heat_mode(mode: str) -> dict:
    """Return a copy of a supported mode or reject an unversioned preset."""
    if mode not in MODE_PRESETS:
        choices = ", ".join(MODE_PRESETS)
        raise ValueError(f"mode는 {choices} 중 하나여야 합니다.")
    return {"id": mode, **MODE_PRESETS[mode]}


def _downsample_gauge(points: list[dict], crossing_index: int | None) -> list[dict]:
    if len(points) <= MAX_GAUGE_POINTS:
        return points
    stride = ceil((len(points) - 2) / (MAX_GAUGE_POINTS - 2))
    indices = set(range(0, len(points), stride))
    indices.update({0, len(points) - 1})
    if crossing_index is not None:
        indices.add(crossing_index)
    return [points[index] for index in sorted(indices)]


def route_heat_exposure(
    graph: nx.MultiDiGraph,
    nodes: list,
    depart_hour: float,
    mode: str,
) -> dict:
    """Accumulate exposure while traversal time advances along each edge."""
    preset = get_heat_mode(mode)
    speed = float(preset["walk_speed_mps"])
    budget = float(preset["budget_sun_min"])
    mode_factor = float(preset["mode_factor"])
    distance_m = 0.0
    elapsed_min = 0.0
    exposure_sun_min = 0.0
    gauge = [{"d_m": 0, "budget_used_pct": 0.0, "exposure_sun_min": 0.0}]
    crossing_index = None
    crossing_distance_m = None
    traversal_hours = [float(depart_hour)]

    for u, v in zip(nodes[:-1], nodes[1:]):
        edge = min(graph.get_edge_data(u, v).values(), key=lambda item: item["length"])
        length_m = float(edge["length"])
        travel_min = length_m / speed / 60
        traversal_hour = depart_hour + (elapsed_min + travel_min / 2) / 60
        shade_ratio = _edge_shade(edge, traversal_hour)
        exposure_sun_min += travel_min * (1 - shade_ratio) * mode_factor
        elapsed_min += travel_min
        distance_m += length_m
        traversal_hours.append(traversal_hour)
        gauge.append(
            {
                "d_m": round(distance_m),
                "budget_used_pct": round(exposure_sun_min / budget * 100, 1),
                "exposure_sun_min": round(exposure_sun_min, 2),
            }
        )
        if crossing_index is None and exposure_sun_min > budget:
            crossing_index = len(gauge) - 1
            crossing_distance_m = distance_m

    outside_window = min(traversal_hours) < HOURS[0] or max(traversal_hours) > HOURS[-1]
    result = {
        "model": MODEL_VERSION,
        "mode": mode,
        "mode_label": preset["label"],
        "exposure_sun_min": round(exposure_sun_min, 2),
        "budget_sun_min": budget,
        "budget_used_pct": round(exposure_sun_min / budget * 100, 1),
        "within_budget": exposure_sun_min <= budget,
        "mode_time_min": round(elapsed_min, 1),
        "gauge": _downsample_gauge(gauge, crossing_index),
        "stops": [],
        "simulation_window": [HOURS[0], HOURS[-1]],
        "time_basis": "clamped_at_window_edge" if outside_window else "interpolated",
        "disclaimer": DISCLAIMER,
    }
    result["_budget_crossing_m"] = crossing_distance_m
    return result


def _optional_value(value):
    if value is None or pd.isna(value):
        return None
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def cooling_stop_candidates(
    cooling_spots: gpd.GeoDataFrame,
    route_coords: list[tuple[float, float]],
    *,
    before_distance_m: float,
    primary_radius_m: float = 120.0,
    expanded_radius_m: float = 240.0,
    limit: int = 2,
) -> list[dict]:
    """Find public official shelters near the route before budget crossing."""
    if len(route_coords) < 2 or cooling_spots.empty or before_distance_m <= 0:
        return []
    public = cooling_spots[cooling_spots["access_scope"] == "public"].copy()
    if public.empty:
        return []

    line_wgs = LineString([(lon, lat) for lat, lon in route_coords])
    line = gpd.GeoSeries([line_wgs], crs=CRS_WGS).to_crs(CRS_METRIC).iloc[0]
    route_limit = min(float(before_distance_m), float(line.length))
    eligible_line = substring(line, 0, route_limit)
    if public.crs is None:
        raise ValueError("무더위쉼터 레이어에 좌표계가 없습니다.")
    public = public.to_crs(CRS_METRIC)
    public["distance_from_route_m"] = public.geometry.distance(eligible_line)
    public["d_m"] = public.geometry.apply(line.project)
    public = public[public["d_m"] <= route_limit].copy()

    radius = primary_radius_m
    candidates = public[public["distance_from_route_m"] <= radius].copy()
    if candidates.empty:
        radius = expanded_radius_m
        candidates = public[public["distance_from_route_m"] <= radius].copy()
    if candidates.empty:
        return []

    candidates["distance_to_limit_m"] = route_limit - candidates["d_m"]
    chosen = candidates.nsmallest(limit, ["distance_to_limit_m", "distance_from_route_m"])
    chosen = chosen.sort_values("d_m")
    stops = []
    for _, row in chosen.iterrows():
        stops.append(
            {
                "spot_id": row["spot_id"],
                "name": row["name"],
                "lat": float(row["lat"]),
                "lon": float(row["lon"]),
                "d_m": round(float(row["d_m"])),
                "distance_from_route_m": round(float(row["distance_from_route_m"]), 1),
                "search_radius_m": round(radius),
                "address": row["address"],
                "facility_type": row["facility_type"],
                "capacity": _optional_value(row["capacity"]),
                "open_hours": _optional_value(row["open_hours"]),
                "operating_note": _optional_value(row["operating_note"]),
                "access_scope": row["access_scope"],
                "availability": "check_before_visit",
                "source": row["source"],
                "source_url": row["source_url"],
            }
        )
    return stops


def route_heat_block(
    graph: nx.MultiDiGraph,
    nodes: list,
    depart_hour: float,
    mode: str,
    cooling_spots: gpd.GeoDataFrame | None = None,
) -> dict:
    """Build one API heat block and optional public-shelter candidates."""
    result = route_heat_exposure(graph, nodes, depart_hour, mode)
    crossing_distance = result.pop("_budget_crossing_m")
    if crossing_distance is not None and cooling_spots is not None:
        coords = [(float(graph.nodes[node]["y"]), float(graph.nodes[node]["x"])) for node in nodes]
        result["stops"] = cooling_stop_candidates(
            cooling_spots,
            coords,
            before_distance_m=crossing_distance,
        )
    return result


def departure_heat_curve(
    graph: nx.MultiDiGraph,
    nodes: list,
    times: list[str],
    mode: str,
) -> list[dict]:
    """Evaluate the moving-time exposure proxy for existing departure points."""
    curve = []
    for label in times:
        hour_text, minute_text = label.split(":", maxsplit=1)
        hour = int(hour_text) + int(minute_text) / 60
        heat = route_heat_exposure(graph, nodes, hour, mode)
        heat.pop("_budget_crossing_m")
        curve.append(
            {
                "t": label,
                "exposure_sun_min": heat["exposure_sun_min"],
                "budget_used_pct": heat["budget_used_pct"],
                "within_budget": heat["within_budget"],
                "mode_time_min": heat["mode_time_min"],
            }
        )
    return curve


def _decimal_hour(point: dict) -> float:
    hour_text, minute_text = point["t"].split(":", maxsplit=1)
    return int(hour_text) + int(minute_text) / 60


def first_lower_exposure(curve: list[dict], reference_hour: float) -> dict | None:
    """Return the first later curve point with lower proxy exposure."""
    if not curve:
        return None

    reference_index = min(
        range(len(curve)),
        key=lambda index: abs(_decimal_hour(curve[index]) - reference_hour),
    )
    reference = curve[reference_index]["exposure_sun_min"]
    for point in curve[reference_index + 1 :]:
        if point["exposure_sun_min"] < reference:
            return point
    return None


def departure_heat_summary(
    graph: nx.MultiDiGraph,
    nodes: list,
    base_curve: list[dict],
    mode: str,
    reference_hour: float,
) -> dict:
    """Combine the legacy distance curve with one self-contained heat response."""
    preset = get_heat_mode(mode)
    heat_curve = departure_heat_curve(
        graph,
        nodes,
        [point["t"] for point in base_curve],
        mode,
    )
    curve = [
        {**distance_point, **heat_point}
        for distance_point, heat_point in zip(base_curve, heat_curve)
    ]
    reference = min(curve, key=lambda point: abs(_decimal_hour(point) - reference_hour))
    return {
        "curve": curve,
        "best": min(curve, key=lambda point: point["exposure_sun_min"]),
        "worst": max(curve, key=lambda point: point["exposure_sun_min"]),
        "model": MODEL_VERSION,
        "mode": mode,
        "mode_label": preset["label"],
        "budget_sun_min": preset["budget_sun_min"],
        "budget_used_pct": reference["budget_used_pct"],
        "within_budget": reference["within_budget"],
        "first_lower_exposure": first_lower_exposure(curve, reference_hour),
        "reference_time": reference["t"],
        "disclaimer": DISCLAIMER,
    }


__all__ = [
    "DISCLAIMER",
    "MODEL_VERSION",
    "MODE_PRESETS",
    "cooling_stop_candidates",
    "departure_heat_curve",
    "departure_heat_summary",
    "first_lower_exposure",
    "get_heat_mode",
    "route_heat_block",
    "route_heat_exposure",
]
