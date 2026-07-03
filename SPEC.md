# 그늘로(gneulro) — 구현 명세서 (SPEC)
**대상 독자: 구현 담당 AI(Claude Opus) 및 팀원. 기획 배경은 [PLANNING.md](PLANNING.md) 참조.**

이 문서는 "무엇을 어떤 계약으로 만들 것인가"를 고정한다. 구현자는 이 명세를 벗어나는 설계 변경이
필요하면 **임의로 바꾸지 말고 사용자에게 질문**한다 (claude_rules ①).

---

## 0. 구현자 작업 규칙 (claude_rules 적용판)

1. 모호하면 질문. 특히 데이터 컬럼명이 명세와 다를 때 임의 추측 금지.
2. 로직은 `src/gneulro/`에만. `pipeline/`은 호출, `api/`는 변환, `web/`은 표시. 계층 침범 금지.
3. 오버엔지니어링 금지: 인증, 캐시서버, ORM(SQLAlchemy 모델 클래스), React, 비동기 큐 전부 금지.
   함수는 30줄 이내 지향, 조기 추상화 금지 (같은 코드 3번 나오기 전엔 헬퍼 만들지 않기).
4. 공용 모듈(config, db) 수정 시 영향 범위를 먼저 확인하고 보고.
5. 매 단계 완료 시: `ruff check .` + `pytest` 통과 → 실행 로그 요약 출력.
6. 커밋은 단계(Phase) 단위, 메시지는 한국어 요약. main에는 완결 상태만.
7. **사용자는 파이썬 초급자다.** 모든 함수에 한 줄 한국어 docstring, 트릭성 원라이너 대신 명시적 코드.

## 1. 기술 스택 (버전 고정)

```
python 3.11 / geopandas≥0.14 shapely≥2.0 pyproj / pysolar / osmnx≥1.9 networkx
fastapi uvicorn / lightgbm shap (가산) / statsmodels(선형회귀) / matplotlib
PostgreSQL 16 + PostGIS 3.4 (Docker) / psycopg2-binary geoalchemy2(to_postgis 의존)
개발도구: ruff, pytest
프론트: Leaflet 1.9 CDN (빌드 도구 없음, 순수 HTML+JS 1파일)
```

## 2. 저장소 구조 (이대로 생성)

```
gneulro/
├── compose.yml               # postgis 서비스 1개 (port 5432, volume)
├── pyproject.toml            # deps + [tool.ruff] line-length=100
├── .env.example              # POSTGRES_URL=postgresql://gneulro:gneulro@localhost:5432/gneulro
│                             # USE_POSTGIS=true
├── README.md
├── data/
│   ├── raw/                  # 수동 다운로드 (아래 §3) — gitignore
│   └── processed/            # 파이프라인 산출물 — gitignore
├── reports/                  # 검증 그래프·통계 산출물
├── src/gneulro/
│   ├── __init__.py
│   ├── config.py
│   ├── io_utils.py           # 한국 공공 CSV 로더 등
│   ├── shadowcast.py
│   ├── grid.py
│   ├── graph.py
│   ├── departure.py
│   ├── validate.py
│   ├── sdi.py                # (가산, 마지막)
│   └── store.py              # PostGIS/Parquet 이중 백엔드
├── pipeline/
│   ├── 01_prepare.py  02_shadows.py  03_grid.py  04_graph.py
│   ├── 05_validate.py  06_sdi.py
├── api/main.py
├── web/index.html
└── tests/
    ├── test_shadowcast.py  test_grid.py  test_graph.py  test_departure.py
```

## 3. 입력 데이터 계약 (data/raw/ — 사용자가 수동 다운로드)

| 경로 | 내용 | 주의 |
|---|---|---|
| raw/buildings/ | GIS건물통합정보 노원구 .shp 세트 (국가공간정보포털) | 컬럼명이 배포본마다 다름(예: HEIGHT/높이, GRND_FLR/지상층수). **로드 후 컬럼 목록을 출력하고 매핑을 사용자에게 확인받을 것** |
| raw/trees.csv | 서울시 가로수 위치 (열린데이터광장) | 위도/경도 컬럼, cp949 가능 |
| raw/sdot/*.csv | S-DoT 환경정보 2026-07월분 (OA-15969) | 대용량. 기온 컬럼만 사용. 센서목록(위치) 파일 별도 |
| raw/population.csv | 노원구 동별 고령(65+)·아동(0-9) 인구 | 가산 기능용 |
| raw/shelters.csv | 무더위쉼터 (공공데이터포털) | 가산 기능용 |

공통 로더 `io_utils.read_csv_kr(path)`: utf-8 → 실패 시 cp949 재시도. shp는 `gpd.read_file` 후 즉시 `to_crs(5186)`.

## 4. config.py (단일 진실 공급원 — 하드코딩 금지, 전부 여기서 import)

```python
from datetime import date
from zoneinfo import ZoneInfo
from pathlib import Path

CRS_METRIC = 5186            # 계산용 (미터, 중부원점)
CRS_WGS = 4326               # 표시·API 응답용
TZ = ZoneInfo("Asia/Seoul")
CALC_DATE = date(2026, 8, 6) # 대표일 = 본선일
HOURS = [10, 13, 14, 15, 17] # 사전계산 시간대
PLACE = "Nowon-gu, Seoul, South Korea"

GRID_SIZE_M = 50
TREE_SHADE_RADIUS_M = 3.0
MIN_SUN_ALT_DEG = 10.0       # 이하이면 그림자 계산 생략(길이 폭주 방지)
MAX_SHADOW_LEN_M = 300.0     # 그림자 길이 상한(클램프)
FLOOR_HEIGHT_M = 3.0         # 층수→높이 환산
WALK_SPEED_MPS = 1.2
BETA_DEFAULT = 2.0

DATA_RAW = Path("data/raw"); DATA_PROCESSED = Path("data/processed")
REPORTS = Path("reports")
# DB 설정은 .env에서 (POSTGRES_URL, USE_POSTGIS)
```

## 5. 모듈 명세

### 5.1 shadowcast.py — 그림자 엔진

```python
def sun_position(lat: float, lon: float, when: datetime) -> tuple[float, float]:
    """(태양고도, 방위각[북=0° 시계방향])을 도 단위로 반환. when은 tz-aware 필수 — naive면 ValueError."""

def shadow_polygon(footprint: Polygon, height_m: float, alt_deg: float, azi_deg: float) -> Polygon | None:
    """건물 1개의 그림자(건물 자신 포함). alt<=MIN_SUN_ALT_DEG면 None."""

def building_shadows(buildings: gpd.GeoDataFrame, when: datetime) -> gpd.GeoDataFrame:
    """노원구 전 건물 그림자. 태양각은 지역 중심점 1회 계산(노원구 규모에서 공간차 무시 가능)."""

def dissolve_shadows(shadows: gpd.GeoDataFrame) -> MultiPolygon:
    """union_all()로 병합 후 simplify(1.0). 시간대별 최종 레이어."""
```

알고리즘 (EPSG:5186 입력 전제, 도로 진입 전 assert로 CRS 검사):
```
L  = min(height_m / tan(radians(alt)), MAX_SHADOW_LEN_M)
dx = L * sin(radians(azi + 180)); dy = L * cos(radians(azi + 180))
shadow = convex_hull( footprint ∪ translate(footprint, dx, dy) )   # MVP 1차 근사(오목건물 과대추정 — README 한계 명시)
```

높이 결정 규칙: `height > 0`이면 그대로, 아니면 `floors * FLOOR_HEIGHT_M`, 둘 다 없으면 제외(제외 수 로깅).

**수용 테스트 (tests/test_shadowcast.py):**
- 높이 10, alt=45° → 그림자 끝이 정확히 10m 이동
- 8/6 12:30 KST 서울에서 azimuth ∈ (150°, 210°) — **pysolar 방위각 규약 가드** (깨지면 dx/dy 식 수정 금지, 원인 보고)
- 같은 시각 그림자 중심이 건물 중심보다 북쪽(y 증가)
- naive datetime 입력 시 ValueError

### 5.2 grid.py — 격자 그늘율

```python
def nowon_boundary() -> gpd.GeoDataFrame:      # osmnx.geocode_to_gdf(PLACE) → to_crs(5186)
def make_grid(boundary, size_m=GRID_SIZE_M) -> gpd.GeoDataFrame   # cell_id, geom(Polygon)
def shade_ratio(grid, shadow: MultiPolygon) -> pd.Series          # 셀별 교차면적/셀면적 ∈ [0,1]
```
가로수 그늘: trees buffer(TREE_SHADE_RADIUS_M)를 그림자 레이어에 union 후 격자 계산.
**테스트:** 셀 절반을 덮는 사각형 그림자 → ratio == 0.5 (±1e-6).

### 5.3 graph.py — 보행망·경로

```python
def build_graph() -> nx.MultiDiGraph:
    """osmnx.graph_from_place(PLACE, network_type='walk'). graphml 저장."""

def attach_edge_shade(G, shadows_by_hour: dict[int, MultiPolygon]) -> nx.MultiDiGraph:
    """엣지별 shade_{h} ∈ [0,1] 속성 부여 후 graphml 재저장.
    방법: 엣지 geometry(5186 변환)를 그림자와 line-intersection → 그늘 길이/전체 길이.
    성능: 그림자 explode → shapely.STRtree로 후보만 교차 검사."""

def route_pair(G, start: tuple[float,float], end: tuple[float,float], hour: int, beta: float) -> dict:
    """start/end는 (lat, lon). osmnx.distance.nearest_nodes로 스냅.
    최단: weight='length' / 그늘: weight=lambda u,v,d: d['length']*(1+beta*(1-d.get(f'shade_{hour}', 0)))
    반환: {'shortest': RouteStat, 'shade': RouteStat} — RouteStat = coords[(lat,lon)], dist_m, time_min, shade_pct"""
```
- shade_pct = Σ(len×shade)/Σlen ×100, time_min = dist / WALK_SPEED_MPS / 60
- graphml은 속성이 문자열로 저장됨 → 로드 후 float 캐스팅 유틸 필수 (흔한 함정)

**테스트:** 장난감 그래프(3노드 2경로)에서 β=0이면 두 경로 동일, β 크면 그늘 경로 선택.

### 5.4 departure.py — 출발 시각 추천

```python
def exposure_curve(G, route_nodes: list, hours=HOURS) -> list[dict]:
    """경로 고정(14시 그늘경로 기준), 시간대별 노출량 exposure_m = Σ len×(1-shade_h) 계산.
    HOURS 사이는 10분 단위 선형 보간. 반환: [{'t':'10:00','exposure_m':690}, ...]"""

def recommend(curve) -> dict:   # {'best': {...}, 'worst': {...}}
```
**테스트:** 보간값이 양 끝점 사이 단조 구간에서 경계 내에 있는지.

### 5.5 validate.py — S-DoT 보조 검증 (클레임: "보조적 확인", '증명' 표현 금지)

1. 센서 위치 → 소속 격자 cell 매칭(sjoin) → 시간대별 (그늘율, 평균기온) 테이블
2. 피어슨 상관 + `statsmodels` OLS: `temp ~ shade_ratio + C(hour)` (시각 통제)
3. 산출: `reports/validation_scatter.png`, `reports/validation_stats.json` (r, p-value, 회귀계수)
4. (가산) LightGBM + SHAP summary plot — MVP 완료 전 착수 금지

### 5.6 store.py — 저장소 추상화 (PostGIS ↔ Parquet 폴백)

```python
class Store:                       # 환경변수 USE_POSTGIS로 분기. 인터페이스 동일.
    def save_layer(self, gdf, name: str) -> None      # to_postgis / to_parquet
    def load_layer(self, name: str) -> gpd.GeoDataFrame
    def layer_geojson(self, name: str, simplify_m: float = 2.0) -> dict
        """4326 변환 + simplify 후 FeatureCollection dict (API 응답용)"""
```
DDL (PostGIS 모드 초기화 스크립트, geopandas가 테이블 생성하므로 인덱스만 수동):
```sql
CREATE INDEX IF NOT EXISTS shadows_geom_idx ON shadows USING GIST (geom);
CREATE INDEX IF NOT EXISTS grid_cells_geom_idx ON grid_cells USING GIST (geom);
```
테이블: buildings(id, geom, height_eff, floors) / shadows(calc_date, hour, geom, computed_at)
/ grid_cells(cell_id, geom, shade_10…shade_17, pop_vuln, sdi) / sensors(id, geom) / readings(sensor_id, ts, temp)
SRID는 전부 5186 (컬럼 정의 고정, 행별 crs 컬럼 없음).

## 6. 파이프라인 (각 스크립트 = src 함수 호출 + 저장 + 요약 로그 print)

| 스크립트 | 입력 | 출력 | 완료 기준 로그 |
|---|---|---|---|
| 01_prepare | raw/buildings, trees | Store: buildings / processed/trees.parquet | 건물 수, 높이결측 제외 수 |
| 02_shadows | buildings | Store: shadows (HOURS×1행) | 시간대별 그림자 총면적 ㎢ |
| 03_grid | shadows, trees | Store: grid_cells | 14시 평균 그늘율 % |
| 04_graph | shadows | processed/walk_graph.graphml | 노드/엣지 수, 평균 shade_14 |
| 05_validate | grid_cells, sdot | reports/* | r, p-value |
| 06_sdi (가산) | grid_cells, population, shelters | grid_cells.sdi 갱신 + reports/top10.csv | Top-10 목록 |

## 7. API 명세 (api/main.py — FastAPI)

기동: `uvicorn api.main:app --reload` / 시작 시 graphml·grid GeoJSON 메모리 로드(전역 1회).
정적 서빙: `app.mount("/", StaticFiles(directory="web", html=True))` — 라우터 정의 **뒤에** 마운트.

| 엔드포인트 | 파라미터 | 응답 (JSON) |
|---|---|---|
| GET /api/shade | hour∈HOURS | GeoJSON FeatureCollection (4326, simplify 2m) |
| GET /api/grid | hour | 격자 GeoJSON (속성: shade_{hour}) |
| GET /api/route | start_lat,start_lon,end_lat,end_lon, hour=14, beta=2.0 | 아래 예시 |
| GET /api/departure | start_lat…end_lon | {"curve":[{"t","exposure_m"}…], "best":{…}, "worst":{…}} |

`/api/route` 응답 예시 (pydantic 모델로 정의):
```json
{"hour":14,"beta":2.0,
 "shortest":{"coords":[[37.6205,127.0587],…],"dist_m":980,"time_min":13.6,"shade_pct":31},
 "shade":  {"coords":[…],"dist_m":1150,"time_min":16.0,"shade_pct":78}}
```
오류 규약: 파라미터 이상 422(자동), 스냅 실패·경로 없음 404 + `{"detail": 한국어 메시지}`.

## 8. 프론트 명세 (web/index.html — 1파일, JS ≤150줄)

- Leaflet CDN + OSM 타일, 초기 뷰: 광운대(37.6195, 127.0596), zoom 15
- UI: 상단 바(시간대 select, β 슬라이더 0~3 step 0.5, 초기화 버튼) / 우측 패널(경로 비교표, 출발시각 추천)
- 동작: ① 로드 시 `/api/shade?hour=14` 폴리곤 표시(남색, fillOpacity 0.35)
  ② 지도 클릭 1회차=출발 마커, 2회차=도착 마커 → `/api/route` 호출
  ③ 최단경로 = 빨강 실선, 그늘경로 = 파랑 굵은 실선 + 패널에 거리/시간/그늘% 비교표
  ④ 경로 표시 후 자동으로 `/api/departure` → 시각별 노출량 가로 막대(HTML div, 차트 라이브러리 금지) + "추천 출발 HH:MM"
  ⑤ hour/β 변경 시 재호출
- 3회 클릭 시 초기화. fetch 실패 시 alert 대신 패널에 한국어 오류 문구.

## 9. 구현 순서 (Phase별 완료 정의 = DoD)

| Phase | 작업 | DoD |
|---|---|---|
| 0 | 스캐폴딩(§2), config, compose.yml, ruff/pytest 세팅 | `pytest`(0 tests OK)·`ruff check` 통과 |
| 1 | **PoC**: shadowcast + 테스트 4종 → 건물 10개(01_prepare 부분 실행) 그림자 matplotlib PNG | 테스트 green + PNG 그림자가 북쪽 방향 |
| 2 | 01·02·03 전체 파이프라인 + Store(parquet 모드 먼저) | 노원구 14시 그늘 지도 PNG |
| 3 | PostGIS 모드 + 04_graph | graphml에 shade_* 속성 확인 |
| 4 | API(/shade,/grid,/route) + web 지도·경로 비교 | 브라우저에서 클릭 2번 → 두 경로 표시 |
| 5 | departure + web 패널 | 추천 출발시각 표시 |
| 6 | 05_validate + README(아키텍처 그림·실행법) | reports 산출 + 신규 클론 후 README만으로 재현 |
| 7 | (가산·MVP 완료 후에만) LightGBM/SHAP → 06_sdi | - |

각 Phase 종료 시: 커밋 + 사용자에게 결과물(PNG/스크린샷) 보고 후 다음 Phase 진행.

## 10. 알려진 함정 (구현 전 필독)

1. **CRS**: 연산은 5186, Leaflet/pysolar/osmnx 좌표는 4326(lat,lon 순서 주의 — osmnx nearest_nodes는 (x=lon, y=lat)).
2. **pysolar**: naive datetime 금지. 방위각 규약은 §5.1 가드 테스트로 확정 후 진행.
3. **graphml 문자열화**: 저장→로드 시 shade_* 가 str이 됨. 로드 직후 float 변환.
4. **한국 CSV**: cp949 인코딩, 컬럼명 공백·괄호 → `io_utils`에서만 처리, 본 로직에 인코딩 코드 금지.
5. **대용량 union**: shapely 2의 `union_all()` 사용 (구식 cascaded_union 금지). 느리면 grid별 부분 union.
6. **건물 높이 0/결측 다수**: §5.1 높이 규칙 적용, 제외 통계 반드시 로깅 (질의응답 대비).
7. **S-DoT 결측·이상치**: 기온 -40~50℃ 범위 밖 제거, 센서별 결측률 50%↑ 제외 — 처리 내역을 validate 로그로 남김(보고서 재료).
