"""FastAPI 서버 — 사전계산된 그늘·격자 레이어와 보행망으로 경로 API를 제공한다."""

import json
import os
from datetime import datetime, time
from zoneinfo import ZoneInfo

import geopandas as gpd
import networkx as nx
import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from shapely.geometry import box

from gneulro.config import BETA_DEFAULT, CALC_DATE, CRS_WGS, HOURS, NOWON_BBOX, TZ
from gneulro.departure import exposure_curve, recommend
from gneulro.graph import load_graph, route_options, route_pair, shade_route_nodes
from gneulro.places import (
    kakao_places,
    kakao_reverse,
    load_places,
    merge_places,
    nearby_places,
    nearest_place,
    popular_places,
    search_places,
)
from gneulro.shadowcast import sun_position
from gneulro.store import Store

app = FastAPI(title="그늘로 API", description="태양을 피하는 그늘 경로 내비게이션")
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)  # 수 MB GeoJSON 압축


@app.middleware("http")
async def cache_policy(request, call_next):
    """프론트는 재검증하고, 불변에 가까운 3D 장면 데이터는 짧게 재사용한다."""
    response = await call_next(request)
    scene_paths = ("/api/buildings", "/api/shade_frame", "/api/shade_frames", "/api/sun_positions")
    if request.url.path.startswith(scene_paths):
        response.headers["Cache-Control"] = "public, max-age=3600, stale-while-revalidate=86400"
    elif not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response

# ---- 시작 시 전역 1회 로드 (SPEC §7) ----
try:
    store = Store()
    G = load_graph()
    _shadows = store.load_layer("shadows")
    _grid = store.load_layer("grid_cells")
except Exception as exc:
    # The repository deliberately ships the browser-ready snapshot, not the
    # large licensed source and GeoParquet artifacts. Keep a fresh clone runnable.
    store = None
    G = None
    _shadows = None
    _grid = None
    _startup_data_error = str(exc)
else:
    _startup_data_error = None

_shade_cache: dict[int, dict] = {}
_grid_cache: dict[int, dict] = {}
try:
    _places = load_places()  # Local places are optional in snapshot mode.
except Exception:
    _places = []
_kakao_key = os.getenv("KAKAO_REST_KEY", "").strip()  # Store()가 .env를 이미 로드함
_kakao_cache: dict[str, list[dict]] = {}
_kakao_status = "configured" if _kakao_key else "not_configured"
_kakao_last_error: str | None = None


def _require_live_data() -> None:
    """Explain how to enable live endpoints when this clone has only the snapshot."""
    if _startup_data_error:
        raise HTTPException(
            503,
            detail=(
                "Live API data is not installed. Open the default snapshot mode, "
                "or run the documented data pipeline before using ?api=1."
            ),
        )


def _record_kakao_error(exc: requests.RequestException) -> None:
    """비밀키나 원문 응답을 노출하지 않고 검색 공급자 장애 유형만 기록한다."""
    global _kakao_status, _kakao_last_error
    status_code = getattr(getattr(exc, "response", None), "status_code", None)
    if status_code in {401, 403}:
        _kakao_status = "authorization_required"
        _kakao_last_error = f"http_{status_code}"
    elif status_code == 429:
        _kakao_status = "quota_exceeded"
        _kakao_last_error = "http_429"
    else:
        _kakao_status = "unavailable"
        _kakao_last_error = f"http_{status_code}" if status_code else "network_error"


def _check_hour(hour: int) -> None:
    """hour가 사전계산 시간대가 아니면 422를 낸다."""
    if hour not in HOURS:
        raise HTTPException(422, detail=f"hour는 {HOURS} 중 하나여야 합니다.")


def _parse_depart_at(depart_at: str | None, fallback_hour: int) -> float:
    """now 또는 HH:MM을 경로 가중치 보간용 소수 시각으로 바꾼다."""
    if depart_at is None:
        _check_hour(fallback_hour)
        return float(fallback_hour)
    if depart_at == "now":
        now = datetime.now(ZoneInfo("Asia/Seoul"))
        return now.hour + now.minute / 60
    try:
        hour_text, minute_text = depart_at.split(":", maxsplit=1)
        hour_value, minute_value = int(hour_text), int(minute_text)
    except (ValueError, AttributeError):
        raise HTTPException(422, detail="depart_at은 now 또는 HH:MM 형식이어야 합니다.") from None
    if not (0 <= hour_value <= 23 and 0 <= minute_value <= 59):
        raise HTTPException(422, detail="depart_at 시각 범위가 올바르지 않습니다.")
    return hour_value + minute_value / 60


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


_static_cache: dict[str, dict] = {}
_static_layers: dict[str, gpd.GeoDataFrame] = {}


def _parse_bbox(bbox_text: str | None) -> tuple[float, float, float, float] | None:
    if not bbox_text:
        return None
    try:
        bounds = tuple(float(value) for value in bbox_text.split(","))
    except ValueError:
        raise HTTPException(422, detail="bbox는 west,south,east,north 형식이어야 합니다.") from None
    if len(bounds) != 4 or bounds[0] >= bounds[2] or bounds[1] >= bounds[3]:
        raise HTTPException(422, detail="bbox 범위가 올바르지 않습니다.")
    west, south, east, north = NOWON_BBOX
    clipped = (
        max(west, bounds[0]),
        max(south, bounds[1]),
        min(east, bounds[2]),
        min(north, bounds[3]),
    )
    if clipped[0] >= clipped[2] or clipped[1] >= clipped[3]:
        raise HTTPException(422, detail="bbox가 노원구 데이터 범위와 겹치지 않습니다.")
    return clipped


def _viewport_geojson(
    name: str,
    bounds: tuple[float, float, float, float],
    simplify_m: float,
    property_filter: tuple[str, object] | None = None,
) -> dict:
    filter_key = f":{property_filter[0]}={property_filter[1]}" if property_filter else ""
    key = f"{name}:{','.join(f'{value:.4f}' for value in bounds)}:{simplify_m}{filter_key}"
    if key in _static_cache:
        return _static_cache[key]
    if name not in _static_layers:
        _static_layers[name] = store.load_layer(name)
    layer = _static_layers[name]
    if property_filter:
        field, value = property_filter
        layer = layer[layer[field] == value]
    clip_geometry = gpd.GeoSeries([box(*bounds)], crs=CRS_WGS).to_crs(layer.crs).iloc[0]
    subset = layer[layer.intersects(clip_geometry)].copy()
    subset.geometry = subset.geometry.intersection(clip_geometry)
    subset = subset[~subset.geometry.is_empty]
    _static_cache[key] = store.to_geojson(subset, simplify_m=simplify_m)
    return _static_cache[key]


@app.get("/api/buildings")
def api_buildings(bbox: str | None = None, lod: str = "standard") -> dict:
    """3D 압출용 건물 footprint + height_eff GeoJSON (1m 단순화, 시작 후 첫 호출에 캐시)."""
    _require_live_data()
    bounds = _parse_bbox(bbox)
    if bounds:
        return _viewport_geojson("buildings", bounds, 2.5 if lod == "mobile" else 1.0)
    if "buildings" not in _static_cache:
        _static_cache["buildings"] = store.layer_geojson("buildings", simplify_m=1.0)
    return _static_cache["buildings"]


@app.get("/api/shade_frames")
def api_shade_frames(bbox: str | None = None, lod: str = "standard") -> dict:
    """그림자 애니메이션 프레임(07~19시 매시) GeoJSON — 09_shadow_frames 산출물."""
    _require_live_data()
    bounds = _parse_bbox(bbox)
    if bounds:
        try:
            return _viewport_geojson("shadows_anim", bounds, 4.5 if lod == "mobile" else 2.5)
        except Exception:
            raise HTTPException(
                503, detail="그림자 프레임이 아직 없습니다. pipeline/09_shadow_frames.py를 실행하세요."
            ) from None
    if "frames" not in _static_cache:
        try:
            _static_cache["frames"] = store.layer_geojson("shadows_anim", simplify_m=3.0)
        except Exception:
            raise HTTPException(
                503, detail="그림자 프레임이 아직 없습니다. pipeline/09_shadow_frames.py를 실행하세요."
            ) from None
    return _static_cache["frames"]


@app.get("/api/shade_frame")
def api_shade_frame(hour: int = 14, bbox: str | None = None, lod: str = "standard") -> dict:
    """07~18시 애니메이션 중 한 프레임만 반환해 메인 지도의 전송량을 줄인다."""
    _require_live_data()
    if hour < 7 or hour > 18:
        raise HTTPException(422, detail="그림자 탐험 시간은 7~18시여야 합니다.")
    bounds = _parse_bbox(bbox)
    if bounds:
        try:
            frame = _viewport_geojson(
                "shadows_anim",
                bounds,
                4.5 if lod == "mobile" else 2.5,
                property_filter=("hour", hour),
            )
        except Exception:
            raise HTTPException(
                503, detail="그림자 프레임이 아직 없습니다. pipeline/09_shadow_frames.py를 실행하세요."
            ) from None
        if not frame["features"]:
            raise HTTPException(404, detail=f"{hour}시 그림자 프레임이 없습니다.")
        return frame
    key = f"frame_{hour}"
    if key not in _static_cache:
        frames = api_shade_frames()
        features = [feature for feature in frames["features"] if feature["properties"]["hour"] == hour]
        if not features:
            raise HTTPException(404, detail=f"{hour}시 그림자 프레임이 없습니다.")
        _static_cache[key] = {"type": "FeatureCollection", "features": features}
    return _static_cache[key]


@app.get("/api/health")
def api_health() -> dict:
    """프론트가 실데이터 사용 가능 여부를 확인하는 가벼운 상태 응답."""
    if _startup_data_error:
        return {
            "status": "demo",
            "data_mode": "snapshot",
            "live_api_ready": False,
            "detail": "Tracked browser snapshot is ready; live pipeline artifacts are not installed.",
        }
    return {
        "status": "ok",
        "buildings": int(len(store.load_layer("buildings"))),
        "route_graph": {"nodes": G.number_of_nodes(), "edges": G.number_of_edges()},
        "hours": HOURS,
        "shadow_animation": True,
        "place_search": {
            "local_entries": len(_places),
            "kakao": _kakao_status,
            "last_error": _kakao_last_error,
        },
    }


@app.get("/api/sun_positions")
def api_sun_positions() -> dict:
    """3D 조명 애니메이션용 07~18시 태양 고도와 방위각."""
    positions = []
    for hour in range(7, 19):
        when = datetime.combine(CALC_DATE, time(hour=hour), tzinfo=TZ)
        altitude, azimuth = sun_position(37.65, 127.065, when)
        positions.append({
            "hour": hour,
            "altitude": round(altitude, 2),
            "azimuth": round(azimuth, 2),
        })
    return {"date": CALC_DATE.isoformat(), "positions": positions}


@app.get("/api/places")
def api_places(q: str = "") -> dict:
    """장소 검색 — 카카오 상호/주소 결과와 OSM 로컬 색인을 합친다."""
    global _kakao_status, _kakao_last_error
    q = q.strip()
    if not q:
        return {
            "results": popular_places(_places),
            "source": "local",
            "provider_status": _kakao_status,
        }
    local_results = search_places(q, _places)
    if _kakao_key:
        try:
            if q not in _kakao_cache:
                if len(_kakao_cache) > 500:  # 타이핑 자동완성 캐시 무한 증가 방지
                    _kakao_cache.clear()
                _kakao_cache[q] = kakao_places(q, _kakao_key)
            _kakao_status = "active"
            _kakao_last_error = None
            return {
                "results": merge_places(_kakao_cache[q], local_results),
                "source": "kakao+local",
                "provider_status": _kakao_status,
            }
        except requests.RequestException as exc:
            _record_kakao_error(exc)
    return {
        "results": local_results,
        "source": "local",
        "provider_status": _kakao_status,
    }


@app.get("/api/reverse")
def api_reverse(lat: float, lon: float) -> dict:
    """지도 클릭 좌표를 건물명·장소명 또는 주소로 바꾼다."""
    west, south, east, north = NOWON_BBOX
    if not (west <= lon <= east and south <= lat <= north):
        raise HTTPException(422, detail="노원구 안의 위치를 선택해주세요.")
    if _kakao_key:
        try:
            result = kakao_reverse(lat, lon, _kakao_key)
            if result:
                return result
        except requests.RequestException:
            pass
    result = nearest_place(lat, lon, _places)
    if result:
        return {**result, "lat": lat, "lon": lon}
    return {"name": "지도에서 선택한 위치", "cat": "위치", "lat": lat, "lon": lon}


@app.get("/api/nearby")
def api_nearby(lat: float, lon: float, radius_m: int = 240, limit: int = 7) -> dict:
    """도보 안내 위치 주변의 이름 있는 건물·시설 라벨을 반환한다."""
    west, south, east, north = NOWON_BBOX
    if not (west <= lon <= east and south <= lat <= north):
        raise HTTPException(422, detail="노원구 안의 위치를 선택해주세요.")
    radius = max(80, min(radius_m, 400))
    result_limit = max(1, min(limit, 10))
    return {"results": nearby_places(lat, lon, _places, radius, result_limit)}


@app.get("/api/routes")
def api_routes(
    start_lat: float,
    start_lon: float,
    end_lat: float,
    end_lon: float,
    hour: int = 14,
    depart_at: str | None = None,
) -> dict:
    """최단 + 그늘 등급별(40/60/80%+) 경로 목록과 추천 경로를 반환한다."""
    _require_live_data()
    route_hour = _parse_depart_at(depart_at, hour)
    try:
        result = route_options(G, (start_lat, start_lon), (end_lat, end_lon), route_hour)
    except nx.NetworkXNoPath:
        raise HTTPException(404, detail="두 지점을 잇는 보행 경로를 찾지 못했습니다.") from None
    except nx.NodeNotFound:
        raise HTTPException(404, detail="출발/도착 지점을 도로망에 연결하지 못했습니다.") from None
    return {"hour": route_hour, "depart_at_used": depart_at or f"{hour:02d}:00", **result}


@app.get("/api/departure")
def api_departure(start_lat: float, start_lon: float, end_lat: float, end_lon: float) -> dict:
    """14시 그늘경로를 고정한 뒤 시간대별 노출량 곡선과 추천 출발시각을 반환한다."""
    _require_live_data()
    try:
        nodes = shade_route_nodes(G, (start_lat, start_lon), (end_lat, end_lon))
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        raise HTTPException(404, detail="경로를 찾지 못해 출발시각을 추천할 수 없습니다.") from None
    curve = exposure_curve(G, nodes)
    return {"curve": curve, **recommend(curve)}


# 정적 파일은 라우터 정의 '뒤에' 마운트해야 /api/* 가 먼저 매칭된다 (SPEC §7)
app.mount("/", StaticFiles(directory="web", html=True), name="web")
