"""Stage 12: evaluate the S-DoT spatial microclimate product gate."""

from gneulro.microclimate import run_microclimate
from gneulro.store import Store


def main() -> None:
    metrics = run_microclimate(Store())
    selected = metrics["selected_candidate"]
    result = metrics["candidates"][selected]
    status = "PASS" if metrics["eligible_for_product"] else "FAIL"
    print(
        f"[microclimate] {status}: {selected}, "
        f"MAE={result['model_mae_c']:.3f} C, "
        f"baseline={result['baseline_mae_c']:.3f} C, "
        f"mean fold improvement={result['mean_fold_improvement_pct']:.1f}%"
    )
    print("[microclimate] metrics: reports/microclimate_metrics.json")
    if metrics["eligible_for_product"]:
        print("[microclimate] product grid: data/processed/microclimate_grid.parquet")
    else:
        print("[microclimate] product grid withheld because the gate did not pass")


if __name__ == "__main__":
    main()
