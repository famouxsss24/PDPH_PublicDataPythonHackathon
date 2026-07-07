"""2단계: 건물 그림자를 시간대별로 계산해 shadows 레이어로 저장한다."""

from datetime import datetime, time

import geopandas as gpd

from gneulro.config import CALC_DATE, CRS_METRIC, HOURS, TZ
from gneulro.shadowcast import building_shadows, dissolve_shadows
from gneulro.store import Store


def main():
    """HOURS 각 시간대의 병합 그림자를 계산해 저장하고 면적을 출력한다."""
    store = Store()
    buildings = store.load_layer("buildings")
    rows = []
    for hour in HOURS:
        when = datetime.combine(CALC_DATE, time(hour), tzinfo=TZ)
        shadows = building_shadows(buildings, when)
        merged = dissolve_shadows(shadows)
        rows.append(
            {
                "calc_date": str(CALC_DATE),
                "hour": hour,
                "computed_at": datetime.now(TZ).isoformat(),
                "geometry": merged,
            }
        )
        print(f"[{hour:02d}시] 그림자 총면적 {merged.area / 1e6:.2f}㎢")
    store.save_layer(gpd.GeoDataFrame(rows, crs=CRS_METRIC), "shadows")
    print(f"[완료] shadows 저장 ({len(rows)}개 시간대)")


if __name__ == "__main__":
    main()
