"""9단계(가산): 3D 뷰 애니메이션용 매시(07~19시) 그림자 프레임을 계산해 저장한다."""

from datetime import datetime, time

import geopandas as gpd

from gneulro.config import CALC_DATE, CRS_METRIC, TZ
from gneulro.shadowcast import building_shadows, dissolve_shadows
from gneulro.store import Store

FRAME_HOURS = list(range(7, 20))  # 07시~19시 매시 1프레임


def main():
    """시간대별 병합 그림자를 shadows_anim 레이어로 저장한다 (web/3d.html 애니메이션용)."""
    store = Store()
    buildings = store.load_layer("buildings")
    rows = []
    for hour in FRAME_HOURS:
        when = datetime.combine(CALC_DATE, time(hour), tzinfo=TZ)
        shadows = building_shadows(buildings, when)
        if len(shadows) == 0:  # 태양 고도가 낮아 그림자 생략된 시각
            continue
        merged = dissolve_shadows(shadows)
        rows.append({"hour": hour, "geometry": merged})
        print(f"[{hour:02d}시] 그림자 {merged.area / 1e6:.2f}㎢")
    store.save_layer(gpd.GeoDataFrame(rows, crs=CRS_METRIC), "shadows_anim")
    print(f"[완료] shadows_anim 저장 ({len(rows)}프레임)")


if __name__ == "__main__":
    main()
