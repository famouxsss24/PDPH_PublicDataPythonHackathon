"""FastAPI 서버 — 사전계산된 그늘·격자 레이어와 보행망으로 경로 API를 제공한다."""

import json

import networkx as nx
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from gneulro.config import BETA_DEFAULT, CRS_WGS, HOURS
from gneulro.departure import exposure_curve, recommend
from gneulro.graph import load_graph, route_pair, shade_route_nodes
from gneulro.store import Store

app = FastAPI(title="그늘로 API", description="태양을 피하는 그늘 경로 내비게이션")

# ---- 시작 시 전역 1회 로드 (SPEC §7) ----
try:
    store = Store()
    G = load_graph()
    _shadows = store.load_layer("shadows")
    _grid = store.load_layer("grid_cells")
except Exception as exc:
    raise RuntimeError(
        "사전계산 데이터가 없습니다. pipeline 01~04를 먼저 실행하세요."
    ) from exc

_shade_cache: dict[int, dict] = {}
_grid_cache: dict[int, dict] = {}


def _check_hour(hour: int) -> None:
    """hour가 사전계산 시간대가 아니면 422를 낸다."""
    if hour not in HOURS:
        raise HTTPException(422, detail=f"hour는 {HOURS} 중 하나여야 합니다.")


def _shade_geojson(hour: int) -> dict:
    """시간대별 그림자 GeoJSON을 만들어 메모리 캐시에서 재사용한다."""
    if hour not in _shade_cache:
        sub = _shadows[_shadows["hour"] == hour].copy()
        sub["geometry"] = sub.geometry.simplify(2.0)
        _shade_cache[hour] = json.loads(sub.to_crs(CRS_WGS).to_json())
    return _shade_cache[hour]


def _grid_geojson(hour: int) -> dict:
    """시간대별 격자 GeoJSON(shade_{hour} 속성)을 캐시에서 재사용한다."""
    if hour not in _grid_cache:
        sub = _grid[["cell_id", f"shade_{hour}", "geometry"]].copy()
        sub["geometry"] = sub.geometry.simplify(2.0)
        _grid_cache[hour] = json.loads(sub.to_crs(CRS_WGS).to_json())
    return _grid_cache[hour]


class RouteStat(BaseModel):
    """경로 1개의 좌표·거리·시간·그늘 비율."""

    coords: list[tuple[float, float]]
    dist_m: int
    time_min: float
    shade_pct: int


class RouteResponse(BaseModel):
    """최단경로와 그늘경로 비교 응답."""

    hour: int
    beta: float
    shortest: RouteStat
    shade: RouteStat


@app.get("/api/shade")
def api_shade(hour: int = 14) -> dict:
    """시간대별 그림자 GeoJSON을 반환한다."""
    _check_hour(hour)
    return _shade_geojson(hour)


@app.get("/api/grid")
def api_grid(hour: int = 14) -> dict:
    """시간대별 격자 그늘율 GeoJSON을 반환한다."""
    _check_hour(hour)
    return _grid_geojson(hour)


@app.get("/api/route", response_model=RouteResponse)
def api_route(
    start_lat: float,
    start_lon: float,
    end_lat: float,
    end_lon: float,
    hour: int = 14,
    beta: float = BETA_DEFAULT,
):
    """최단경로와 그늘경로를 함께 계산해 비교 통계와 좌표를 반환한다."""
    _check_hour(hour)
    try:
        result = route_pair(G, (start_lat, start_lon), (end_lat, end_lon), hour, beta)
    except nx.NetworkXNoPath:
        raise HTTPException(404, detail="두 지점을 잇는 보행 경로를 찾지 못했습니다.") from None
    except nx.NodeNotFound:
        raise HTTPException(404, detail="출발/도착 지점을 도로망에 연결하지 못했습니다.") from None
    return {"hour": hour, "beta": beta, **result}


@app.get("/api/departure")
def api_departure(start_lat: float, start_lon: float, end_lat: float, end_lon: float) -> dict:
    """14시 그늘경로를 고정한 뒤 시간대별 노출량 곡선과 추천 출발시각을 반환한다."""
    try:
        nodes = shade_route_nodes(G, (start_lat, start_lon), (end_lat, end_lon))
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        raise HTTPException(404, detail="경로를 찾지 못해 출발시각을 추천할 수 없습니다.") from None
    curve = exposure_curve(G, nodes)
    return {"curve": curve, **recommend(curve)}


# 정적 파일은 라우터 정의 '뒤에' 마운트해야 /api/* 가 먼저 매칭된다 (SPEC §7)
app.mount("/", StaticFiles(directory="web", html=True), name="web")
