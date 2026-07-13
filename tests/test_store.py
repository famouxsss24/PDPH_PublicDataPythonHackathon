"""저장소 백엔드 전환 동작 테스트."""

from sqlalchemy.exc import OperationalError

from gneulro.store import Store


def test_store_falls_back_to_parquet_when_postgis_unavailable(monkeypatch):
    """PostGIS 연결이 실패하면 parquet 모드로 자동 전환해야 한다."""
    monkeypatch.setenv("USE_POSTGIS", "true")
    monkeypatch.setenv("POSTGRES_URL", "postgresql://gneulro:gneulro@localhost:5432/gneulro")

    def failing_create_engine(*args, **kwargs):
        raise OperationalError("boom", None, None)

    monkeypatch.setattr("sqlalchemy.create_engine", failing_create_engine)

    store = Store()

    assert store.use_postgis is False
    assert store.engine is None
