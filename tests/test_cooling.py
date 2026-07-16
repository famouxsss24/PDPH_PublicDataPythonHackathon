"""Official cooling-shelter processing tests."""

import networkx as nx
import pandas as pd

from gneulro.cooling import RUNTIME_COLUMNS, prepare_cooling_spots


def _source_frame() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "시설년도": 2026,
                "위치코드": "11350621",
                "시설구분1": "공공시설",
                "시설구분2": "복지?문화?체육시설",
                "쉼터명칭": "노원 공공쉼터",
                "도로명주소": "서울특별시 노원구 노해로 1",
                "지번주소": "서울특별시 노원구 상계동 1",
                "이용가능인원": 40,
                "비고": "평일 탄력 운영",
                "경도": 127.0600,
                "위도": 37.6500,
            },
            {
                "시설년도": 2026,
                "위치코드": "11350622",
                "시설구분1": "특정계층이용시설",
                "시설구분2": "회원이용시설",
                "쉼터명칭": "회원 경로당",
                "도로명주소": "서울특별시 노원구 동일로 2",
                "지번주소": "서울특별시 노원구 중계동 2",
                "이용가능인원": None,
                "비고": "주말 미운영",
                "경도": 127.0800,
                "위도": 37.6700,
            },
            {
                "시설년도": 2026,
                "위치코드": "11350622",
                "시설구분1": "특정계층이용시설",
                "시설구분2": "회원이용시설",
                "쉼터명칭": "회원 경로당",
                "도로명주소": "서울특별시 노원구 동일로 2",
                "지번주소": "서울특별시 노원구 중계동 2",
                "이용가능인원": None,
                "비고": "주말 미운영",
                "경도": 127.0800,
                "위도": 37.6700,
            },
            {
                "시설년도": 2026,
                "위치코드": "11110600",
                "시설구분1": "공공시설",
                "시설구분2": "공공청사",
                "쉼터명칭": "노원구 밖 쉼터",
                "도로명주소": "서울특별시 종로구 세종대로 3",
                "지번주소": "서울특별시 종로구 세종로 3",
                "이용가능인원": 20,
                "비고": "",
                "경도": 126.9800,
                "위도": 37.5700,
            },
        ]
    )


def _walk_graph() -> nx.MultiDiGraph:
    graph = nx.MultiDiGraph()
    graph.add_node(100, x=127.0601, y=37.6501)
    graph.add_node(200, x=127.0801, y=37.6701)
    graph.add_edge(100, 200, length=3000.0)
    return graph


def test_prepare_cooling_spots_filters_deduplicates_and_links_graph() -> None:
    spots = prepare_cooling_spots(
        _source_frame(),
        _walk_graph(),
        verified_at="2026-07-16",
    )

    assert len(spots) == 2
    assert list(spots.columns) == RUNTIME_COLUMNS
    assert spots.crs.to_epsg() == 5186
    assert set(spots["node_id"]) == {"100", "200"}
    assert spots["node_distance_m"].max() < 20
    assert spots["spot_id"].is_unique
    assert spots["verified_at"].eq("2026-07-16").all()
    by_name = spots.set_index("name")
    assert by_name.loc["노원 공공쉼터", "facility_type"] == "공공시설 / 복지·문화·체육시설"


def test_access_limits_and_unknown_hours_are_explicit() -> None:
    spots = prepare_cooling_spots(_source_frame(), _walk_graph())
    by_name = spots.set_index("name")

    assert by_name.loc["노원 공공쉼터", "access_scope"] == "public"
    assert by_name.loc["회원 경로당", "access_scope"] == "restricted"
    assert "일반 이용이 제한" in by_name.loc["회원 경로당", "access_note"]
    assert spots["open_hours"].isna().all()
    assert by_name.loc["회원 경로당", "capacity"] is pd.NA
