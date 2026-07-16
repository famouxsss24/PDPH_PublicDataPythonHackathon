"""Tests for the S-DoT model gate and shade feature construction."""

import numpy as np
import pandas as pd
import pytest

from gneulro.microclimate import evaluate_models, interpolate_shade


def test_interpolate_shade_clamps_and_interpolates() -> None:
    row = {
        "shade_10": 0.1,
        "shade_13": 0.4,
        "shade_14": 0.6,
        "shade_15": 0.8,
        "shade_17": 1.0,
    }
    assert interpolate_shade(row, 7) == pytest.approx(0.1)
    assert interpolate_shade(row, 11.5) == pytest.approx(0.25)
    assert interpolate_shade(row, 19) == pytest.approx(1.0)


def test_grouped_model_gate_passes_learnable_signal() -> None:
    rng = np.random.default_rng(42)
    rows = []
    for sensor_number in range(20):
        for hour in range(7, 20):
            shade = rng.uniform(0, 1)
            angle = 2 * np.pi * hour / 24
            rows.append(
                {
                    "sensor_id": f"sensor-{sensor_number:02d}",
                    "shade_ratio": shade,
                    "hour_sin": np.sin(angle),
                    "hour_cos": np.cos(angle),
                    "delta_t": 2.5 * (shade - 0.5) + rng.normal(0, 0.08),
                }
            )
    frame = pd.DataFrame(rows)
    metrics = evaluate_models(
        frame,
        feature_sets=(("test_signal", ("shade_ratio", "hour_sin", "hour_cos")),),
        max_splits=5,
    )

    result = metrics["candidates"]["test_signal"]
    assert metrics["eligible_for_product"] is True
    assert result["improved_folds"] == result["n_folds"]
    assert result["model_mae_c"] < result["baseline_mae_c"]
