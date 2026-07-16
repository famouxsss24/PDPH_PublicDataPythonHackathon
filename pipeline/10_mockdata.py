# -*- coding: utf-8 -*-
"""실데이터(파이프라인 산출물)에서 새 API 계약 v2 형태의 web/mock JSON을 추출한다.

실행: .venv 파이썬으로 프로젝트 루트에서. 산출:
  web/mock/routes_{hour}.json  (HOURS 5개 — 옵션 5종·세그먼트·스텝)
  web/mock/exposure.json       (노출 곡선 + best/worst)
  web/mock/shade_{hour}.json   (경로 주변 클립된 그림자 GeoJSON)
  web/mock/places.json         (OSM 장소 색인 복사)
"""
import json
import shutil
import sys
from pathlib import Path

import geopandas as gpd
import networkx as nx
import osmnx as ox

from gneulro.config import CRS_WGS, HOURS
from gneulro.departure import exposure_curve, recommend
from gneulro.graph import (
    BETA_SWEEP,
    DETOUR_LIMIT,
    _shade_weight,
    load_graph,
    route_stat,
    route_steps,
)

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(".")
OUT = ROOT / "web" / "mock"
OUT.mkdir(parents=True, exist_ok=True)

# ---- 데모 OD: 광운대학교 → 상계역 (색인에서 탐색, 없으면 폴백) ----
places = json.loads((ROOT / "data/processed/places.json").read_text(encoding="utf-8"))


def find_place(*names):
    for name in names:  # 정확일치 우선, 그다음 부분일치
        for p in places:
            if p["name"] == name:
                return p
    for name in names:
        for p in places:
            if name in p["name"]:
                return p
    return None


origin_p = find_place("인제대학교상계백병원")
dest_p = find_place("노원")
assert origin_p and dest_p, "데모 장소를 색인에서 찾지 못함"
print(f"OD: {origin_p['name']} → {dest_p['name']}")

G = load_graph()
orig = ox.distance.nearest_nodes(G, X=origin_p["lon"], Y=origin_p["lat"])
dest = ox.distance.nearest_nodes(G, X=dest_p["lon"], Y=dest_p["lat"])


def edge_between(u, v):
    return min(G.get_edge_data(u, v).values(), key=lambda a: a["length"])


def edge_coords(u, v, data):
    if "geometry" in data:
        return [(lat, lon) for lon, lat in data["geometry"].coords]
    return [
        (G.nodes[u]["y"], G.nodes[u]["x"]),
        (G.nodes[v]["y"], G.nodes[v]["x"]),
    ]


def segments(nodes, hour):
    """연속 엣지를 그늘 여부(shade>=0.5)로 병합한 세그먼트 목록."""
    segs = []
    for u, v in zip(nodes[:-1], nodes[1:]):
        d = edge_between(u, v)
        shaded = float(d.get(f"shade_{hour}", 0.0)) >= 0.5
        coords = [[round(la, 5), round(lo, 5)] for la, lo in edge_coords(u, v, d)]
        if segs and segs[-1]["shaded"] == shaded:
            segs[-1]["coords"].extend(coords[1:])
        else:
            segs.append({"shaded": shaded, "coords": coords})
    return segs


def build_options(hour):
    """계약 v2: 추천/최단/그늘우선/그늘30%+/50%+ 슬롯 → 중복 경로는 라벨 병합."""
    cand = {tuple(nx.shortest_path(G, orig, dest, weight="length")): None}
    for beta in BETA_SWEEP:
        cand.setdefault(
            tuple(nx.shortest_path(G, orig, dest, weight=_shade_weight(hour, beta))), None
        )
    stats = []
    for nodes in cand:
        s = route_stat(G, list(nodes), hour)
        s["nodes"] = nodes
        stats.append(s)
    stats.sort(key=lambda r: r["time_min"])
    shortest = stats[0]

    def cheapest_at_least(pct):
        hit = [r for r in stats if r["shade_pct"] >= pct]
        return min(hit, key=lambda r: r["time_min"]) if hit else None

    pool = [r for r in stats if r["time_min"] <= shortest["time_min"] * DETOUR_LIMIT + 0.5]
    slots = [
        ("추천", max(pool, key=lambda r: r["shade_pct"])),
        ("최단", shortest),
        ("그늘 우선", max(stats, key=lambda r: r["shade_pct"])),
        ("그늘 30%+", cheapest_at_least(30)),
        ("그늘 50%+", cheapest_at_least(50)),
    ]
    options, by_nodes = [], {}
    for label, r in slots:
        if r is None:
            continue
        if r["nodes"] in by_nodes:
            by_nodes[r["nodes"]]["labels"].append(label)
            continue
        opt = {
            "id": f"h{hour}-r{len(options)}",
            "labels": [label],
            "minutes": round(r["time_min"]),
            "distance_m": r["dist_m"],
            "shade_pct": r["shade_pct"],
            "extra_min": round(r["time_min"] - shortest["time_min"], 1),
            "segments": segments(list(r["nodes"]), hour),
            "steps": route_steps(G, list(r["nodes"])),
        }
        by_nodes[r["nodes"]] = opt
        options.append(opt)
    rec_id = next(o["id"] for o in options if "추천" in o["labels"])
    return {
        "options": options,
        "recommended_id": rec_id,
        "snapped": {
            "from": [round(G.nodes[orig]["y"], 5), round(G.nodes[orig]["x"], 5)],
            "to": [round(G.nodes[dest]["y"], 5), round(G.nodes[dest]["x"], 5)],
        },
        "meta": {"depart_hour": hour, "calc_date": "2026-08-06", "note": "맑은 날 물리계산, 구름 미반영"},
    }


all_coords = []
for hour in HOURS:
    data = build_options(hour)
    for o in data["options"]:
        for s in o["segments"]:
            all_coords.extend(s["coords"])
    (OUT / f"routes_{hour}.json").write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    kb = (OUT / f"routes_{hour}.json").stat().st_size // 1024
    print(f"routes_{hour}.json: 옵션 {len(data['options'])}개, {kb}KB")

# ---- 노출 곡선 (14시 추천 경로 고정 — 기존 departure 로직) ----
r14 = json.loads((OUT / "routes_14.json").read_text(encoding="utf-8"))
nodes14 = nx.shortest_path(G, orig, dest, weight=_shade_weight(14, 2.0))
curve = exposure_curve(G, nodes14)
(OUT / "exposure.json").write_text(
    json.dumps({"curve": curve, **recommend(curve)}, ensure_ascii=False), encoding="utf-8"
)
print(f"exposure.json: {len(curve)}포인트, best={recommend(curve)['best']}")

# ---- 그림자 GeoJSON: 경로 bbox + 여유로 클립 ----
lats = [c[0] for c in all_coords]
lons = [c[1] for c in all_coords]
pad_lat, pad_lon = 0.004, 0.005
bbox = (min(lons) - pad_lon, min(lats) - pad_lat, max(lons) + pad_lon, max(lats) + pad_lat)
print(f"clip bbox: {bbox}")


def round_coords(obj, nd=5):
    if isinstance(obj, list):
        return [round_coords(x, nd) for x in obj]
    return round(obj, nd)


from shapely.geometry import box  # noqa: E402

shadows = gpd.read_parquet(ROOT / "data/processed/shadows.parquet")
clip_box = box(*bbox)
for hour in HOURS:
    sub = shadows[shadows["hour"] == hour].copy()
    sub["geometry"] = sub.geometry.simplify(2.0)
    sub = sub.to_crs(CRS_WGS)
    sub["geometry"] = sub.geometry.intersection(clip_box)  # 병합 멀티폴리곤 → bbox로 실제 절단
    sub = sub[~sub.geometry.is_empty]
    fc = json.loads(sub.to_json())
    for f in fc["features"]:
        f["geometry"]["coordinates"] = round_coords(f["geometry"]["coordinates"])
        f["properties"] = {}
    (OUT / f"shade_{hour}.json").write_text(
        json.dumps(fc, separators=(",", ":")), encoding="utf-8"
    )
    print(f"shade_{hour}.json: {len(fc['features'])}피처, {(OUT / f'shade_{hour}.json').stat().st_size // 1024}KB")

# ---- 장소 색인 복사 ----
shutil.copy(ROOT / "data/processed/places.json", OUT / "places.json")
print("places.json 복사 완료")

# ---- 2D/3D mock: 노원구 전체 건물. bbox는 클라이언트의 빠른 뷰포트 필터에 사용한다. ----
source_buildings = gpd.read_parquet(ROOT / "data/processed/buildings.parquet")
for filename, simplify_m in (("buildings.json", 1.0), ("buildings_mobile.json", 3.0)):
    buildings = source_buildings.copy()
    buildings["geometry"] = buildings.geometry.simplify(simplify_m)
    buildings = buildings.to_crs(CRS_WGS)
    buildings = buildings[~buildings.geometry.is_empty]
    bounds = buildings.geometry.bounds
    building_fc = json.loads(buildings.to_json())
    for feature, feature_bounds in zip(
        building_fc["features"], bounds.itertuples(index=False, name=None), strict=True
    ):
        feature["bbox"] = [round(float(value), 5) for value in feature_bounds]
        feature["geometry"]["coordinates"] = round_coords(feature["geometry"]["coordinates"])
    (OUT / filename).write_text(
        json.dumps(building_fc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(f"{filename}: {len(building_fc['features'])}동")

frames = gpd.read_parquet(ROOT / "data/processed/shadows_anim.parquet")
frames["geometry"] = frames.geometry.simplify(3.0)
frames = frames.to_crs(CRS_WGS)
frames["geometry"] = frames.geometry.intersection(clip_box)
frames = frames[~frames.geometry.is_empty]
frame_fc = json.loads(frames.to_json())
for feature in frame_fc["features"]:
    feature["geometry"]["coordinates"] = round_coords(feature["geometry"]["coordinates"])
(OUT / "shade_frames.json").write_text(
    json.dumps(frame_fc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
)
print(f"shade_frames.json: {len(frame_fc['features'])}프레임")

print("mock 추출 완료 →", OUT.resolve())
