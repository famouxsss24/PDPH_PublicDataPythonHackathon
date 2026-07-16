"""Evaluate whether S-DoT observations support a spatial microclimate model.

The target is a sensor's temperature deviation from the Nowon network median at
the same hour. Sensor IDs are kept out of the feature set and are used as the
groups in cross-validation so the score measures generalisation to unseen
locations rather than memorisation of a sensor.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Sequence

import geopandas as gpd
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error
from sklearn.model_selection import GroupKFold

from gneulro.config import DATA_PROCESSED, DATA_RAW, HOURS, REPORTS
from gneulro.validate import clean_readings, load_sdot

MODEL_VERSION = "sdot_relative_temperature_hgb_v1"
TARGET_NAME = "delta_t"
BASELINE_NAME = "same_time_nowon_median"
MIN_HOUR = 7
MAX_HOUR = 19
MAX_ABS_DELTA_C = 8.0
MIN_NETWORK_SENSORS = 10
GATE_IMPROVEMENT_PCT = 5.0

V1_FEATURES = ("shade_ratio", "hour_sin", "hour_cos")
V2_FEATURES = (
    *V1_FEATURES,
    "building_coverage",
    "building_height_mean",
    "tree_density_ha",
)


def interpolate_shade(values: pd.Series | dict, hour: int | float) -> float:
    """Interpolate a grid row's precomputed shade ratio at ``hour``.

    Hours outside the physical simulation range are clamped to the nearest
    simulated hour. This is explicit because the current shadow assets only
    contain the five times in :data:`gneulro.config.HOURS`.
    """
    shade = [float(values[f"shade_{item}"]) for item in HOURS]
    return float(np.interp(float(hour), HOURS, shade))


def add_context_features(
    cells: gpd.GeoDataFrame,
    buildings: gpd.GeoDataFrame,
    trees: gpd.GeoDataFrame,
) -> gpd.GeoDataFrame:
    """Add auditable urban-form features to grid cells.

    Building coverage and mean height are intersection-area weighted. Tree
    density is the number of source tree points per hectare.
    """
    result = cells.copy()
    if buildings.crs != result.crs:
        buildings = buildings.to_crs(result.crs)
    if trees.crs != result.crs:
        trees = trees.to_crs(result.crs)

    building_coverage: list[float] = []
    building_height_mean: list[float] = []
    tree_density_ha: list[float] = []
    building_index = buildings.sindex
    tree_index = trees.sindex

    for cell in result.geometry:
        cell_area = float(cell.area)
        building_ids = building_index.query(cell, predicate="intersects")
        nearby_buildings = buildings.iloc[building_ids]
        if nearby_buildings.empty or cell_area <= 0:
            coverage = 0.0
            mean_height = 0.0
        else:
            areas = nearby_buildings.geometry.intersection(cell).area.to_numpy(dtype=float)
            total_area = float(areas.sum())
            heights = (
                pd.to_numeric(nearby_buildings["height_eff"], errors="coerce")
                .fillna(0.0)
                .to_numpy(dtype=float)
            )
            coverage = min(total_area / cell_area, 1.0)
            mean_height = float(np.average(heights, weights=areas)) if total_area else 0.0

        tree_ids = tree_index.query(cell, predicate="intersects")
        density = float(len(tree_ids) * 10_000 / cell_area) if cell_area > 0 else 0.0
        building_coverage.append(coverage)
        building_height_mean.append(mean_height)
        tree_density_ha.append(density)

    result["building_coverage"] = building_coverage
    result["building_height_mean"] = building_height_mean
    result["tree_density_ha"] = tree_density_ha
    return result


def prepare_training_frame(
    sensors: gpd.GeoDataFrame,
    readings: pd.DataFrame,
    grid: gpd.GeoDataFrame,
    buildings: gpd.GeoDataFrame,
    trees: gpd.GeoDataFrame,
    *,
    min_hour: int = MIN_HOUR,
    max_hour: int = MAX_HOUR,
    min_network_sensors: int = MIN_NETWORK_SENSORS,
) -> pd.DataFrame:
    """Create hourly, network-centred training rows for sensors inside Nowon."""
    shade_columns = [f"shade_{hour}" for hour in HOURS]
    matched = gpd.sjoin(
        sensors,
        grid[["cell_id", *shade_columns, "geometry"]],
        how="inner",
        predicate="within",
    )
    matched = matched.drop_duplicates("sensor_id")
    sensor_cells = grid[grid["cell_id"].isin(matched["cell_id"])].copy()
    sensor_cells = add_context_features(sensor_cells, buildings, trees)
    matched = matched.drop(columns=["index_right", *shade_columns]).merge(
        sensor_cells.drop(columns="geometry"),
        on="cell_id",
        how="inner",
    )

    relevant = readings[readings["sensor_id"].isin(matched["sensor_id"])].copy()
    relevant = relevant[relevant["ts"].notna() & relevant["temp"].notna()]
    relevant["time_bin"] = relevant["ts"].dt.floor("h")
    relevant["hour"] = relevant["time_bin"].dt.hour
    relevant = relevant[relevant["hour"].between(min_hour, max_hour)]
    hourly = (
        relevant.groupby(["sensor_id", "time_bin"], as_index=False)["temp"]
        .mean()
        .sort_values(["time_bin", "sensor_id"])
    )
    hourly["network_count"] = hourly.groupby("time_bin")["sensor_id"].transform("nunique")
    hourly = hourly[hourly["network_count"] >= min_network_sensors].copy()
    hourly["network_median_temp"] = hourly.groupby("time_bin")["temp"].transform("median")
    hourly[TARGET_NAME] = hourly["temp"] - hourly["network_median_temp"]
    hourly = hourly[hourly[TARGET_NAME].abs() <= MAX_ABS_DELTA_C]
    hourly["hour"] = hourly["time_bin"].dt.hour

    frame = hourly.merge(matched.drop(columns="geometry"), on="sensor_id", how="inner")
    frame["shade_ratio"] = [
        interpolate_shade(row, row["hour"]) for _, row in frame.iterrows()
    ]
    angle = 2 * np.pi * frame["hour"] / 24
    frame["hour_sin"] = np.sin(angle)
    frame["hour_cos"] = np.cos(angle)
    return frame.reset_index(drop=True)


def _new_model() -> HistGradientBoostingRegressor:
    return HistGradientBoostingRegressor(
        learning_rate=0.06,
        max_iter=180,
        max_leaf_nodes=15,
        l2_regularization=0.2,
        random_state=42,
    )


def _evaluate_feature_set(
    frame: pd.DataFrame,
    features: Sequence[str],
    *,
    n_splits: int,
) -> dict:
    splitter = GroupKFold(n_splits=n_splits)
    fold_metrics = []
    all_actual: list[float] = []
    all_prediction: list[float] = []

    x = frame[list(features)]
    y = frame[TARGET_NAME]
    groups = frame["sensor_id"]
    for fold_number, (train_index, test_index) in enumerate(
        splitter.split(x, y, groups), start=1
    ):
        model = _new_model()
        model.fit(x.iloc[train_index], y.iloc[train_index])
        prediction = model.predict(x.iloc[test_index])
        actual = y.iloc[test_index].to_numpy(dtype=float)
        baseline_mae = float(mean_absolute_error(actual, np.zeros_like(actual)))
        model_mae = float(mean_absolute_error(actual, prediction))
        improvement = (
            (baseline_mae - model_mae) / baseline_mae * 100 if baseline_mae > 0 else 0.0
        )
        test_groups = sorted(groups.iloc[test_index].astype(str).unique())
        fold_metrics.append(
            {
                "fold": fold_number,
                "test_sensors": test_groups,
                "n_train": int(len(train_index)),
                "n_test": int(len(test_index)),
                "baseline_mae_c": round(baseline_mae, 4),
                "model_mae_c": round(model_mae, 4),
                "improvement_pct": round(improvement, 2),
                "improved": model_mae < baseline_mae,
            }
        )
        all_actual.extend(actual.tolist())
        all_prediction.extend(prediction.tolist())

    actual_array = np.asarray(all_actual)
    prediction_array = np.asarray(all_prediction)
    baseline_mae = float(mean_absolute_error(actual_array, np.zeros_like(actual_array)))
    model_mae = float(mean_absolute_error(actual_array, prediction_array))
    mean_fold_improvement = float(
        np.mean([item["improvement_pct"] for item in fold_metrics])
    )
    improved_folds = sum(item["improved"] for item in fold_metrics)
    return {
        "features": list(features),
        "baseline_mae_c": round(baseline_mae, 4),
        "model_mae_c": round(model_mae, 4),
        "aggregate_improvement_pct": round(
            (baseline_mae - model_mae) / baseline_mae * 100, 2
        ),
        "mean_fold_improvement_pct": round(mean_fold_improvement, 2),
        "improved_folds": int(improved_folds),
        "n_folds": n_splits,
        "folds": fold_metrics,
    }


def evaluate_models(
    frame: pd.DataFrame,
    *,
    feature_sets: Iterable[tuple[str, Sequence[str]]] | None = None,
    max_splits: int = 5,
) -> dict:
    """Compare feature sets with sensor-group CV and apply the product gate."""
    sensor_count = int(frame["sensor_id"].nunique())
    if sensor_count < 3:
        raise ValueError(f"At least 3 matched sensors are required; got {sensor_count}.")
    n_splits = min(max_splits, sensor_count)
    candidates = feature_sets or (
        ("v1_shade_time", V1_FEATURES),
        ("v2_urban_form", V2_FEATURES),
    )
    results = {
        name: _evaluate_feature_set(frame, features, n_splits=n_splits)
        for name, features in candidates
    }
    selected_name = min(results, key=lambda name: results[name]["model_mae_c"])
    selected = results[selected_name]
    eligible = (
        selected["mean_fold_improvement_pct"] > GATE_IMPROVEMENT_PCT
        and selected["improved_folds"] > selected["n_folds"] / 2
    )
    return {
        "model_version": MODEL_VERSION,
        "target": "sensor temperature - same-hour Nowon sensor median",
        "baseline": BASELINE_NAME,
        "validation": "GroupKFold by sensor_id",
        "gate": {
            "minimum_mean_fold_improvement_pct": GATE_IMPROVEMENT_PCT,
            "requires_majority_folds_improved": True,
        },
        "selected_candidate": selected_name,
        "eligible_for_product": bool(eligible),
        "candidates": results,
    }


def _predict_grid(
    model: HistGradientBoostingRegressor,
    grid: gpd.GeoDataFrame,
    features: Sequence[str],
) -> gpd.GeoDataFrame:
    result = grid.copy()
    for hour in HOURS:
        rows = result.copy()
        rows["shade_ratio"] = [interpolate_shade(row, hour) for _, row in rows.iterrows()]
        rows["hour_sin"] = np.sin(2 * np.pi * hour / 24)
        rows["hour_cos"] = np.cos(2 * np.pi * hour / 24)
        prediction = model.predict(rows[list(features)])
        result[f"delta_t_{hour}"] = np.clip(prediction, -4.0, 4.0)
    result["model_version"] = MODEL_VERSION
    return result


def run_microclimate(store) -> dict:
    """Run the feasibility gate and persist metrics plus eligible grid output."""
    sensors, readings = load_sdot(DATA_RAW / "sdot")
    readings = clean_readings(readings)
    grid = store.load_layer("grid_cells")
    buildings = store.load_layer("buildings")
    trees = store.load_layer("trees")
    frame = prepare_training_frame(sensors, readings, grid, buildings, trees)
    metrics = evaluate_models(frame)
    metrics["data"] = {
        "source_period_start": frame["time_bin"].min().isoformat(),
        "source_period_end": frame["time_bin"].max().isoformat(),
        "hours": [MIN_HOUR, MAX_HOUR],
        "matched_sensors": int(frame["sensor_id"].nunique()),
        "training_rows": int(len(frame)),
        "max_abs_delta_c": MAX_ABS_DELTA_C,
        "shade_source": "2026-08-06 clear-sky physical simulation",
        "temperature_source": "S-DoT observations",
    }

    REPORTS.mkdir(parents=True, exist_ok=True)
    metrics_path = REPORTS / "microclimate_metrics.json"
    metrics_path.write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    output_path = DATA_PROCESSED / "microclimate_grid.parquet"
    if not metrics["eligible_for_product"]:
        output_path.unlink(missing_ok=True)
        return metrics

    selected = metrics["selected_candidate"]
    features = metrics["candidates"][selected]["features"]
    model = _new_model()
    model.fit(frame[features], frame[TARGET_NAME])
    full_grid = add_context_features(grid, buildings, trees)
    predicted = _predict_grid(model, full_grid, features)
    store.save_layer(predicted, "microclimate_grid")
    return metrics


__all__ = [
    "V1_FEATURES",
    "V2_FEATURES",
    "add_context_features",
    "evaluate_models",
    "interpolate_shade",
    "prepare_training_frame",
    "run_microclimate",
]
