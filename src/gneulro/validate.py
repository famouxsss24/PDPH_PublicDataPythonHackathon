"""S-DoT 보조 검증 — 그늘율과 기온의 관계를 상관·회귀로 확인한다 ('증명'이 아닌 보조 확인)."""

import json
from pathlib import Path

import geopandas as gpd
import pandas as pd

from gneulro.config import CRS_METRIC, CRS_WGS, DATA_RAW, HOURS, REPORTS
from gneulro.io_utils import LAT_CANDIDATES, LON_CANDIDATES, find_col, read_csv_kr

TEMP_MIN, TEMP_MAX = -40.0, 50.0  # 이 범위 밖 기온은 이상치로 제거
MAX_MISSING_RATE = 0.5  # 결측률 50% 이상 센서 제외
SERIAL_CANDIDATES = ["시리얼", "시리얼번호", "serial", "SERIAL_NO", "모델시리얼", "기기일련번호"]
TEMP_CANDIDATES = ["기온", "온도", "temp", "기온(℃)", "온도평균"]
TIME_CANDIDATES = ["측정시간", "전송시간", "등록일시", "측정일시", "date", "전송시간(측정시간)"]


def load_sdot(sdot_dir: Path) -> tuple[gpd.GeoDataFrame, pd.DataFrame]:
    """sdot 폴더 CSV들을 센서 위치(GeoDataFrame)와 기온 측정값(DataFrame)으로 나눠 읽는다."""
    sensors = None
    readings = []
    files = sorted(sdot_dir.glob("*.csv"))
    if not files:
        raise FileNotFoundError(f"{sdot_dir}에 S-DoT CSV가 없습니다 (SPEC §3 참고).")
    for path in files:
        df = read_csv_kr(path)
        temp_col = find_col(df, TEMP_CANDIDATES)
        lat_col = find_col(df, LAT_CANDIDATES)
        if lat_col and temp_col is None:  # 위경도만 있으면 센서 목록 파일
            lon_col = find_col(df, LON_CANDIDATES)
            serial_col = find_col(df, SERIAL_CANDIDATES)
            if lon_col is None or serial_col is None:
                raise ValueError(f"{path.name}: 센서목록 컬럼 인식 실패. 실제: {list(df.columns)}")
            sensors = gpd.GeoDataFrame(
                {"sensor_id": df[serial_col].astype(str)},
                geometry=gpd.points_from_xy(df[lon_col], df[lat_col]),
                crs=CRS_WGS,
            ).to_crs(CRS_METRIC)
        elif temp_col:  # 기온이 있으면 측정값 파일
            serial_col = find_col(df, SERIAL_CANDIDATES)
            time_col = find_col(df, TIME_CANDIDATES)
            if serial_col is None or time_col is None:
                raise ValueError(f"{path.name}: 측정값 컬럼 인식 실패. 실제: {list(df.columns)}")
            readings.append(
                pd.DataFrame(
                    {
                        "sensor_id": df[serial_col].astype(str),
                        "ts": pd.to_datetime(df[time_col], errors="coerce"),
                        "temp": pd.to_numeric(df[temp_col], errors="coerce"),
                    }
                )
            )
    if sensors is None or not readings:
        raise ValueError("센서 위치 파일 또는 기온 측정값 파일을 찾지 못했습니다.")
    return sensors, pd.concat(readings, ignore_index=True)


def clean_readings(readings: pd.DataFrame) -> pd.DataFrame:
    """이상치(-40~50℃ 밖) 제거·결측률 50%↑ 센서 제외 후 처리 내역을 출력한다."""
    n_before = len(readings)
    readings = readings.dropna(subset=["ts"])
    missing_rate = readings.groupby("sensor_id")["temp"].apply(lambda s: s.isna().mean())
    bad_sensors = missing_rate[missing_rate >= MAX_MISSING_RATE].index
    readings = readings[~readings["sensor_id"].isin(bad_sensors)]
    readings = readings.dropna(subset=["temp"])
    readings = readings[(readings["temp"] >= TEMP_MIN) & (readings["temp"] <= TEMP_MAX)]
    print(
        f"[validate] 정제: {n_before} → {len(readings)}행 "
        f"(결측률 초과 센서 {len(bad_sensors)}개 제외)"
    )
    return readings


def run_validation(store) -> dict:
    """센서-격자 매칭 → 상관·회귀 분석 → reports/validation_*.png/json을 산출한다."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import statsmodels.formula.api as smf
    from scipy.stats import pearsonr

    sensors, readings = load_sdot(DATA_RAW / "sdot")
    readings = clean_readings(readings)
    grid = store.load_layer("grid_cells")
    matched = gpd.sjoin(sensors, grid, how="inner", predicate="within")
    print(f"[validate] 격자 매칭 센서: {len(matched)}/{len(sensors)}개")

    readings["hour"] = readings["ts"].dt.hour
    readings = readings[readings["hour"].isin(HOURS)]
    mean_temp = readings.groupby(["sensor_id", "hour"])["temp"].mean().reset_index()

    shade_cols = [f"shade_{h}" for h in HOURS]
    rows = mean_temp.merge(matched[["sensor_id", *shade_cols]], on="sensor_id")
    rows["shade_ratio"] = [row[f"shade_{int(row.hour)}"] for _, row in rows.iterrows()]
    df = rows[["shade_ratio", "temp", "hour"]].dropna()
    if len(df) < 10:
        raise ValueError(f"분석 표본이 너무 적습니다 ({len(df)}행) — 데이터를 확인하세요.")

    r, p = pearsonr(df["shade_ratio"], df["temp"])
    model = smf.ols("temp ~ shade_ratio + C(hour)", data=df).fit()

    REPORTS.mkdir(exist_ok=True)
    plt.figure(figsize=(6, 4))
    plt.scatter(df["shade_ratio"], df["temp"], s=12, alpha=0.6)
    plt.xlabel("shade ratio")
    plt.ylabel("temp (C)")
    plt.title(f"Shade vs Temperature (r={r:.3f}, n={len(df)})")
    plt.tight_layout()
    plt.savefig(REPORTS / "validation_scatter.png", dpi=150)
    plt.close()

    stats = {
        "n": int(len(df)),
        "pearson_r": float(r),
        "pearson_p": float(p),
        "ols_shade_coef": float(model.params["shade_ratio"]),
        "ols_shade_p": float(model.pvalues["shade_ratio"]),
    }
    (REPORTS / "validation_stats.json").write_text(
        json.dumps(stats, indent=2), encoding="utf-8"
    )
    return stats
