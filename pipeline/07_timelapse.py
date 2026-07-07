"""7단계(가산): 하루 그림자 타임랩스 GIF를 만든다 — 발표·검증 증거용."""

from datetime import datetime, time
from math import cos, radians, sin

import matplotlib

matplotlib.use("Agg")  # 창 없이 파일로만 렌더
import matplotlib.font_manager as fm
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation, PillowWriter

from gneulro.config import CALC_DATE, CRS_WGS, REPORTS, TZ
from gneulro.grid import nowon_boundary
from gneulro.shadowcast import building_shadows, dissolve_shadows, sun_position
from gneulro.store import Store

FRAME_HOURS = list(range(7, 20))  # 07시~19시 매시 1프레임
INK = "#1a2340"
SHADE = "#2f3e7c"
SUN = "#ff8a3d"


def _korean_font() -> str | None:
    """설치된 한글 폰트 이름을 찾는다 (없으면 None → 영문 대체)."""
    for name in ("Malgun Gothic", "NanumGothic", "Pretendard"):
        if any(f.name == name for f in fm.fontManager.ttflist):
            return name
    return None


def main():
    """시간대별 그림자 프레임을 렌더해 reports/shadow_timelapse.gif로 저장한다."""
    store = Store()
    buildings = store.load_layer("buildings")
    boundary = nowon_boundary()
    center = boundary.to_crs(CRS_WGS).geometry.iloc[0].centroid  # 태양 방위 표시용

    font = _korean_font()
    if font:
        plt.rcParams["font.family"] = font

    print(f"[timelapse] {len(FRAME_HOURS)}개 프레임 그림자 계산 시작 (건물 {len(buildings):,}동)")
    frames = []
    for hour in FRAME_HOURS:
        when = datetime.combine(CALC_DATE, time(hour), tzinfo=TZ)
        alt, azi = sun_position(center.y, center.x, when)
        shadows = building_shadows(buildings, when)
        merged = dissolve_shadows(shadows) if len(shadows) else None
        frames.append((hour, alt, azi, merged))
        area = merged.area / 1e6 if merged else 0.0
        print(f"  {hour:02d}시: 고도 {alt:5.1f}° 방위 {azi:5.1f}° 그림자 {area:.2f}㎢")

    fig, ax = plt.subplots(figsize=(9.6, 8.4), dpi=100)
    minx, miny, maxx, maxy = boundary.total_bounds

    def draw(idx: int):
        hour, alt, azi, merged = frames[idx]
        ax.clear()
        ax.set_facecolor("#fdf6ec")  # 여름 오후의 크림색 배경
        boundary.boundary.plot(ax=ax, color=INK, linewidth=1.2)
        buildings.plot(ax=ax, color="#d8d3c8", linewidth=0)
        if merged is not None:
            import geopandas as gpd

            gpd.GeoSeries([merged], crs=buildings.crs).plot(ax=ax, color=SHADE, alpha=0.55)

        # 좌상단: 시계 + 태양 고도
        title = "노원구 건물 그림자 시뮬레이션" if font else "Nowon Building Shadow Simulation"
        ax.text(0.02, 0.975, f"{title} · {CALC_DATE}", transform=ax.transAxes,
                fontsize=13, fontweight="bold", color=INK, va="top")
        ax.text(0.02, 0.925, f"{hour:02d}:00", transform=ax.transAxes,
                fontsize=30, fontweight="bold", color=SUN, va="top")
        alt_label = "태양 고도" if font else "sun alt"
        ax.text(0.02, 0.845, f"{alt_label} {alt:.0f}°", transform=ax.transAxes,
                fontsize=11, color=INK, va="top")

        # 우상단: 태양 방위 나침반 (해가 있는 쪽에 ●)
        cx, cy, r = 0.93, 0.92, 0.05
        ax.add_patch(plt.Circle((cx, cy), r, transform=ax.transAxes,
                                fill=False, color=INK, linewidth=1))
        sx = cx + r * 0.75 * sin(radians(azi))
        sy = cy + r * 0.75 * cos(radians(azi))
        ax.add_patch(plt.Circle((sx, sy), 0.012, transform=ax.transAxes, color=SUN))
        ax.text(cx, cy + r + 0.012, "N", transform=ax.transAxes,
                fontsize=8, ha="center", color=INK)

        ax.set_xlim(minx - 300, maxx + 300)
        ax.set_ylim(miny - 300, maxy + 300)
        ax.set_aspect("equal")
        ax.axis("off")

    REPORTS.mkdir(parents=True, exist_ok=True)
    out = REPORTS / "shadow_timelapse.gif"
    anim = FuncAnimation(fig, draw, frames=len(frames), interval=700)
    anim.save(out, writer=PillowWriter(fps=1.4))
    plt.close(fig)
    print(f"[완료] {out} 저장 ({len(frames)}프레임)")


if __name__ == "__main__":
    main()
