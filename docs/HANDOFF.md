# 그늘로(gneulro) — 세션 인계 (HANDOFF)

> **모든 LLM/세션이 이 파일만 읽고 이어서 작업할 수 있게 유지한다.**
> 상세 명세는 [SPEC.md](SPEC.md), 기획 배경은 [PLANNING.md](PLANNING.md) 참조.
> **최종 갱신: 2026-07-07**

---

## §0. 한 줄 현황

**코드 구현 완료 + 실데이터 배치·01_prepare 실행 성공(2026-07-07).** 노원구 건물 12,273동·가로수 12,430그루 산출 완료. **다음 = 02_shadows→03_grid→04_graph 실행.**

---

## §1. 프로젝트 한 줄 요약

노원구 건물 그림자를 물리 계산(pysolar 태양궤적)해 "최단경로 vs 그늘경로"를 비교하고 최적 출발시각을 추천하는 보행 내비. FastAPI + Leaflet.

---

## §2. 지금 상태

- **코드:** SPEC §2 구조대로 전 모듈 구현 완료(shadowcast/grid/graph/departure/validate/store, pipeline 01~06, api, web).
- **데이터:** `data/raw/` 비어 있음 → **아래 §3 데이터 계약대로 수동 다운로드 필요.**
- **미검증:** 실데이터로 파이프라인 end-to-end 아직 안 돌림. 건물 shp 컬럼 매핑 미확정.

---

## §3. 확정된 핵심 결정 (이번 세션 = 데이터 수집 가이드라인)

### 3-1. 데이터는 API가 아니라 "파일 다운로드" 원칙
- 이 파이프라인은 **1회 배치·고정일(CALC_DATE=8/6)·재현성 우선** → 실시간 API 불필요.
- 코드가 이미 `gpd.read_file → to_crs(5186)` 전제. 파일이 그대로 꽂힘.

### 3-2. 필수 데이터 (MVP 동작)
| 저장 경로 | 데이터 | 출처 | 확정 사항 |
|---|---|---|---|
| `raw/buildings/` | GIS건물통합정보(AL_D010, 서울전역 shp) | **공공데이터포털** `data.go.kr/data/15083092/fileData.do` | **[확정] 컬럼 A0~A28 코드형. 높이=A16(m,67%결측), 지상층수=A26.** CRS 이미 5186. 01_prepare가 nowon_boundary로 클립 |
| `raw/trees.csv` | 서울시 가로수 위치 | 열린데이터광장(xlsx, 자치구별 27시트) | **[확정] "노원구" 시트만 추출, 좌표(경도)/좌표(위도)→경도/위도 컬럼으로 CSV 변환.** openpyxl 필요 |

### 3-3. 검증 데이터
| 경로 | 데이터 | 확정 사항 |
|---|---|---|
| `raw/sdot/*.csv` | S-DoT 환경정보(OA-15969) | **기온 컬럼만** 사용. 기간=여름 주간(2026-07월분, 가능하면 8월초까지), HOURS[10·13·14·15·17]대. 우천·흐린날 제외 로깅 |

### 3-4. 가산 데이터
| 경로 | 데이터 | 확정 사항 |
|---|---|---|
| `raw/shelters.csv` | 무더위쉼터 | 전국 받아서 **주소 "노원구" 필터** 또는 boundary sjoin. 가산(06_sdi), MVP 후 |
| `raw/shade_shelters.csv` | **그늘막** = 전국그늘막쉼터 표준데이터 `data.go.kr/data/15129447/standard.do` | 가로수처럼 point buffer(3m) union. 테마 정합성 높음. **채택** |
| `raw/population.csv` | 노원구 동별 고령/아동 인구 | SDI(06_sdi)용 |

### 3-5. 날씨 API — "1회 스냅샷" 패턴으로만 (가산, MVP 후)
- **폭염특보:** 기상청_기상특보 조회서비스 `data.go.kr/data/15000415/openapi.do`
- **동네예보(기온):** 기상청_단기예보 조회서비스 `data.go.kr/data/15084084/openapi.do`
- 실시간 API라 배치와 충돌 → **한 번 호출해 `raw/weather_snapshot.json`으로 캐시 후 파일 취급**. 용도: departure "폭염일 β↑" 배지, 검증 보조.

### 3-6. 제외 결정 (스코프 이탈로 배제)
- 가축·어패류 폐사, 야외근로자 사망 데이터 → **도시 보행 내비와 무관, 제외.**
- 온열질환 통계 → 경로 입력 아님. README/발표 **동기 1줄용**으로만.
- 외부 시·구단위 폭염취약지도 → 우리 50m 격자가 더 정밀, **받지 않음.**

### 3-7. "이 지역 특히 뜨거움" 경고 = 신규 데이터 아님
- 이미 만드는 **SDI(저그늘+취약인구) / S-DoT 실측 고온셀**을 지도에 강조하는 **시각화**로 구현. 데이터 추가 0.

### 3-8. 태양/그림자 시뮬레이션 이해 (사용자 질문 정리)
- 태양 위치는 "실시간 예측"이 아니라 **pysolar 결정론적 천문계산**(날짜·시각·위경도로 정확). 이미 `sun_position()` 구현됨.
- 비싼 건 태양 계산이 아니라 **그림자 기하 union** → 대표 5시간만 사전계산, departure가 10분 보간.
- **그림자 타임랩스 시각화 채택 방향:** `reports/shadow_animation.gif`(matplotlib 6~19시 프레임→GIF, 증거·발표용, 오프라인·재현). web "▶재생" 버튼은 선택. **3D(Three.js/deck.gl)는 SPEC §8 위반(1파일·Leaflet·빌드없음)으로 배제.**

---

## §4. 알려진 함정 (SPEC §10 요약 — 데이터 넣을 때)
1. **CRS:** 연산 5186, 표시/입력 4326. shp는 로드 즉시 to_crs(5186).
2. **건물 shp 컬럼명 배포본별 상이** → 임의추측 금지, 매핑 확인받기.
3. **한국 CSV cp949·컬럼명 공백** → `io_utils.read_csv_kr`에서만 처리.
4. **건물 높이 0/결측 다수** → 층수×3.0m, 제외 통계 로깅.

---

## §5. 다음 할 일 (정확한 재개 지점)

1. ~~데이터 배치·01_prepare·매핑 확정~~ **완료(2026-07-07).** buildings.parquet(12,273동)·trees.parquet(12,430그루) 산출됨.
2. **`python pipeline/02_shadows.py`** → 03_grid → 04_graph 순차 실행. **여기가 첫 재개 포인트.**
   - 주의: 12,273동×5시간대 그림자 union이라 수 분 소요 가능. 각 단계 완료 로그(그늘면적㎢·그늘율%·엣지수) 확인.
3. API+web 브라우저 확인(클릭 2번 → 두 경로).
4. S-DoT 확보되면 05_validate.
5. (가산, MVP 후) 그늘막 union → SDI 핫스팟 시각화 → shadow_animation.gif → 날씨 스냅샷.

---

## §6. 실행 방법 (요약)
```bash
python -m venv .venv && .venv/Scripts/activate
pip install -e ".[dev]"
copy .env.example .env         # 파일 모드는 USE_POSTGIS=false
# data/raw/ 채운 뒤:
python pipeline/01_prepare.py  # 05_validate까지 순차
uvicorn api.main:app --reload  # http://localhost:8000
ruff check . && pytest
```

---

## §7. 진행 로그
- 2026-07-07 — **실데이터 배치 + 01_prepare 실행 성공.** 건물 매핑 확정(높이=A16·층수=A26, io_utils의 A15 오매핑 버그 수정), 01_prepare에 노원구 클립 추가, 가로수 xlsx 노원시트→trees.csv 변환. 노원 건물 12,273동·가로수 12,430그루 산출. ruff·pytest(9) 통과. — **다음: 02_shadows→03→04 실행.**
- 2026-07-07 — 코드 전체 구현 완료 후, **데이터 수집 가이드라인 확정**(파일 다운로드 원칙, 건물/가로수/S-DoT 출처·좌표계·기간, 그늘막 채택, 날씨=스냅샷 패턴, 폐사/근로자 데이터 제외, 핫스팟=SDI 시각화, 그림자 타임랩스 GIF 채택). — **다음: `raw/buildings`·`raw/trees.csv` 배치 후 01_prepare 실행 → 건물 컬럼 매핑 확정.**
