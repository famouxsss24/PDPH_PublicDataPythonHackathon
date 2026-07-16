"""Stage 13: build the official Nowon cooling-shelter runtime layer."""

from __future__ import annotations

import argparse

from gneulro.cooling import run_cooling_spots
from gneulro.graph import load_graph
from gneulro.store import Store


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        help="선택적 공식 CSV 경로. 생략하면 서울열린데이터광장에서 내려받습니다.",
    )
    parser.add_argument(
        "--verified-at",
        help="검증일(YYYY-MM-DD). 생략하면 실행 날짜를 기록합니다.",
    )
    args = parser.parse_args()

    spots = run_cooling_spots(
        Store(),
        load_graph(),
        source_path=args.source,
        verified_at=args.verified_at,
    )
    public_count = int((spots["access_scope"] == "public").sum())
    restricted_count = int((spots["access_scope"] == "restricted").sum())
    print(
        f"[cooling] {len(spots)} official Nowon shelters: "
        f"public={public_count}, restricted={restricted_count}"
    )
    print(
        "[cooling] nearest walking-node distance: "
        f"median={spots['node_distance_m'].median():.1f} m, "
        f"max={spots['node_distance_m'].max():.1f} m"
    )
    print("[cooling] output: data/processed/cooling_spots.parquet")


if __name__ == "__main__":
    main()
