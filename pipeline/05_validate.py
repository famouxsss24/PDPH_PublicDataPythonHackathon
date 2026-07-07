"""5단계: S-DoT 기온 데이터로 그늘율 효과를 보조 검증한다."""

from gneulro.store import Store
from gneulro.validate import run_validation


def main():
    """검증 실행 후 핵심 통계를 출력한다."""
    stats = run_validation(Store())
    print(
        f"[완료] n={stats['n']}, r={stats['pearson_r']:.3f}, p={stats['pearson_p']:.4f} "
        "→ reports/validation_scatter.png, validation_stats.json"
    )


if __name__ == "__main__":
    main()
