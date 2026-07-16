"""Official cooling-shelter ingestion and walking-network linkage.

The tracked runtime artifact is deliberately small.  This module keeps the
official-source download reproducible while allowing a fresh clone to serve
the already processed GeoParquet without an API key or a raw-data checkout.
"""

from __future__ import annotations

import hashlib
import io
from datetime import date
from pathlib import Path

import geopandas as gpd
import networkx as nx
import pandas as pd
import requests

from gneulro.config import CRS_METRIC, CRS_WGS, NOWON_BBOX
from gneulro.io_utils import read_csv_kr

SOURCE_DATASET_ID = "OA-21065"
SOURCE_NAME = "서울특별시 서울 열린데이터광장 서울시 무더위쉼터"
SOURCE_PAGE_URL = (
    "https://data.seoul.go.kr/dataList/OA-21065/S/1/datasetView.do"
)
SOURCE_DOWNLOAD_URL = (
    "https://datafile.seoul.go.kr/bigfile/iot/sheet/csv/download.do"
)

SOURCE_COLUMNS = {
    "year": "시설년도",
    "location_code": "위치코드",
    "facility_type_primary": "시설구분1",
    "facility_type_secondary": "시설구분2",
    "name": "쉼터명칭",
    "road_address": "도로명주소",
    "lot_address": "지번주소",
    "capacity": "이용가능인원",
    "note": "비고",
    "lon": "경도",
    "lat": "위도",
}
REQUIRED_SOURCE_COLUMNS = frozenset(SOURCE_COLUMNS.values())

RUNTIME_COLUMNS = [
    "spot_id",
    "name",
    "type",
    "lat",
    "lon",
    "node_id",
    "node_distance_m",
    "address",
    "facility_type",
    "capacity",
    "open_hours",
    "access_scope",
    "access_note",
    "operating_note",
    "source",
    "source_url",
    "source_dataset_id",
    "source_year",
    "verified_at",
    "geometry",
]


def fetch_cooling_source(*, timeout: float = 60.0) -> pd.DataFrame:
    """Download the current Seoul cooling-shelter CSV without an API key."""
    payload = {
        "srvType": "S",
        "infId": SOURCE_DATASET_ID,
        "serviceKind": "0",
        "pageNo": "1",
        "ssUserId": "SAMPLE_VIEW",
        "strWhere": "",
        "strOrderby": "",
        "filterCol": "default",
        "txtFilter": "",
    }
    response = requests.post(
        SOURCE_DOWNLOAD_URL,
        data=payload,
        headers={"Referer": SOURCE_PAGE_URL},
        timeout=timeout,
    )
    response.raise_for_status()
    try:
        text = response.content.decode("cp949")
    except UnicodeDecodeError as exc:
        raise ValueError("공식 무더위쉼터 CSV를 CP949로 해석하지 못했습니다.") from exc
    frame = pd.read_csv(io.StringIO(text))
    _validate_source_columns(frame)
    return frame


def load_cooling_source(path: str | Path | None = None) -> pd.DataFrame:
    """Load an audited local export or fetch the current official CSV."""
    if path is None:
        return fetch_cooling_source()
    frame = read_csv_kr(path)
    _validate_source_columns(frame)
    return frame


def _validate_source_columns(frame: pd.DataFrame) -> None:
    missing = sorted(REQUIRED_SOURCE_COLUMNS - set(frame.columns))
    if missing:
        raise ValueError(f"무더위쉼터 원천 데이터 필수 컬럼이 없습니다: {missing}")


def _stable_spot_id(row: pd.Series) -> str:
    identity = "|".join(
        [
            str(row["location_code"]),
            row["name"],
            row["road_address"],
            f"{row['lat']:.6f}",
            f"{row['lon']:.6f}",
        ]
    )
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]
    return f"seoul-cooling-{digest}"


def normalise_cooling_spots(
    frame: pd.DataFrame,
    *,
    verified_at: str | date | None = None,
) -> gpd.GeoDataFrame:
    """Filter official rows to Nowon and create explicit access metadata."""
    _validate_source_columns(frame)
    rename = {source: target for target, source in SOURCE_COLUMNS.items()}
    work = frame.rename(columns=rename)[list(SOURCE_COLUMNS)].copy()

    text_columns = [
        "location_code",
        "facility_type_primary",
        "facility_type_secondary",
        "name",
        "road_address",
        "lot_address",
        "note",
    ]
    for column in text_columns:
        work[column] = work[column].fillna("").astype(str).str.strip()
    work["lat"] = pd.to_numeric(work["lat"], errors="coerce")
    work["lon"] = pd.to_numeric(work["lon"], errors="coerce")
    work["capacity"] = pd.to_numeric(work["capacity"], errors="coerce")
    work["year"] = pd.to_numeric(work["year"], errors="coerce")

    address_text = work["road_address"] + " " + work["lot_address"]
    west, south, east, north = NOWON_BBOX
    in_nowon = address_text.str.contains("노원구", regex=False)
    valid_coordinates = work["lon"].between(west, east) & work["lat"].between(south, north)
    work = work[in_nowon & valid_coordinates & work["name"].ne("")].copy()
    work = work.drop_duplicates(
        subset=["name", "road_address", "lot_address", "lat", "lon"],
        keep="last",
    ).reset_index(drop=True)
    if work.empty:
        raise ValueError("노원구 bbox 안의 공식 무더위쉼터를 찾지 못했습니다.")

    work["address"] = work["road_address"].where(
        work["road_address"].ne(""), work["lot_address"]
    )
    work["facility_type_secondary"] = work["facility_type_secondary"].replace(
        {"복지?문화?체육시설": "복지·문화·체육시설"}
    )
    work["facility_type"] = (
        work["facility_type_primary"] + " / " + work["facility_type_secondary"]
    ).str.strip(" /")
    public = work["facility_type_primary"].eq("공공시설")
    work["access_scope"] = public.map({True: "public", False: "restricted"})
    work["access_note"] = public.map(
        {
            True: "공공시설이지만 방문 전 실제 운영 여부를 확인해야 합니다.",
            False: "회원 또는 특정 계층 이용 시설로 일반 이용이 제한될 수 있습니다.",
        }
    )
    work["spot_id"] = work.apply(_stable_spot_id, axis=1)
    work["type"] = "official_cooling_shelter"
    work["open_hours"] = pd.Series(pd.NA, index=work.index, dtype="string")
    work["operating_note"] = work["note"].replace("", pd.NA).astype("string")
    work["source"] = SOURCE_NAME
    work["source_url"] = SOURCE_PAGE_URL
    work["source_dataset_id"] = SOURCE_DATASET_ID
    work["source_year"] = work["year"].round().astype("Int64")
    checked = verified_at or date.today()
    work["verified_at"] = checked.isoformat() if isinstance(checked, date) else str(checked)
    work["capacity"] = work["capacity"].round().astype("Int64")

    return gpd.GeoDataFrame(
        work,
        geometry=gpd.points_from_xy(work["lon"], work["lat"]),
        crs=CRS_WGS,
    )


def attach_nearest_graph_nodes(
    spots: gpd.GeoDataFrame,
    graph: nx.MultiDiGraph,
) -> gpd.GeoDataFrame:
    """Attach the nearest walking node and audited snap distance in metres."""
    if not graph.nodes:
        raise ValueError("쉼터를 연결할 보행 그래프가 비어 있습니다.")
    node_ids = list(graph.nodes)
    nodes = gpd.GeoDataFrame(
        {"node_id": [str(node_id) for node_id in node_ids]},
        geometry=gpd.points_from_xy(
            [float(graph.nodes[node_id]["x"]) for node_id in node_ids],
            [float(graph.nodes[node_id]["y"]) for node_id in node_ids],
        ),
        crs=CRS_WGS,
    ).to_crs(CRS_METRIC)
    metric = spots.to_crs(CRS_METRIC).copy()
    metric["_spot_order"] = range(len(metric))
    joined = gpd.sjoin_nearest(
        metric,
        nodes,
        how="left",
        distance_col="node_distance_m",
    )
    joined = (
        joined.sort_values(["_spot_order", "node_distance_m", "node_id"])
        .drop_duplicates("_spot_order")
        .sort_values("_spot_order")
    )
    joined["node_distance_m"] = joined["node_distance_m"].round(1)
    joined = joined.drop(columns=["_spot_order", "index_right"])
    if joined["node_id"].isna().any():
        raise ValueError("일부 무더위쉼터를 보행 그래프에 연결하지 못했습니다.")
    return gpd.GeoDataFrame(joined[RUNTIME_COLUMNS], geometry="geometry", crs=CRS_METRIC)


def prepare_cooling_spots(
    frame: pd.DataFrame,
    graph: nx.MultiDiGraph,
    *,
    verified_at: str | date | None = None,
) -> gpd.GeoDataFrame:
    """Create the complete runtime layer from official source rows."""
    spots = normalise_cooling_spots(frame, verified_at=verified_at)
    return attach_nearest_graph_nodes(spots, graph)


def run_cooling_spots(
    store,
    graph: nx.MultiDiGraph,
    *,
    source_path: str | Path | None = None,
    verified_at: str | date | None = None,
) -> gpd.GeoDataFrame:
    """Build and persist the tracked ``cooling_spots`` runtime layer."""
    source = load_cooling_source(source_path)
    spots = prepare_cooling_spots(source, graph, verified_at=verified_at)
    store.save_layer(spots, "cooling_spots")
    return spots


__all__ = [
    "RUNTIME_COLUMNS",
    "SOURCE_DATASET_ID",
    "SOURCE_DOWNLOAD_URL",
    "SOURCE_NAME",
    "SOURCE_PAGE_URL",
    "attach_nearest_graph_nodes",
    "fetch_cooling_source",
    "load_cooling_source",
    "normalise_cooling_spots",
    "prepare_cooling_spots",
    "run_cooling_spots",
]
