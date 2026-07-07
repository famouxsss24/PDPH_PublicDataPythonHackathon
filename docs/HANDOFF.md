# 그늘로(gneulro) — 세션 인계 (HANDOFF)

> **모든 LLM/세션이 이 파일만 읽고 이어서 작업할 수 있게 유지한다.**
> 상세 명세는 [SPEC.md](SPEC.md), 기획 배경은 [PLANNING.md](PLANNING.md) 참조.
> **최종 갱신: 2026-07-08**

---

## §0. 한 줄 현황

**MVP + 내비게이션 v2 완성 (2026-07-08).** 장소검색·내위치·그늘등급별 경로·턴바이턴·3D 그림자 근거뷰까지 구현·검증 완료. **다음 = S-DoT 검증(05) 또는 가산기능(그늘막·SDI).**

---

## §1. 프로젝트 한 줄 요약

노원구 건물 그림자를 물리 계산(pysolar 태양궤적)해 "최단경로 vs 그늘경로"를 비교하고 최적 출발시각을 추천하는 보행 내비. FastAPI + Leaflet.

---

## §2. 지금 상태

- **코드:** 전 모듈 구현 + 실데이터 end-to-end 검증 완료. 웹 UI 리디자인판(main `e7d871f` 푸시됨).
- **데이터:** `data/raw/`에 건물 shp·trees.csv 배치 완료, `data/processed/`에 산출물(parquet·graphml) 존재 → **서버 바로 뜸.**
- **미완:** S-DoT 미확보(05_validate 대기), 가산기능(그늘막 union·06_sdi·날씨 스냅샷) 미착수.
- 원천 파일은 `dataset/`(gitignore)에 보관: 그늘막 xlsx·무더위쉼터 csv·인구 csv 이미 받아둠.

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
- **그림자 타임랩스 시각화:** `pipeline/07_timelapse.py` → `reports/shadow_timelapse.gif`로 **구현 완료**(07~19시 13프레임). web ▶재생 버튼도 구현됨. **3D(Three.js/deck.gl)는 배제 유지**(1파일·Leaflet·빌드없음 원칙).

---

## §4. 알려진 함정 (SPEC §10 요약 — 데이터 넣을 때)
1. **CRS:** 연산 5186, 표시/입력 4326. shp는 로드 즉시 to_crs(5186).
2. **건물 shp 컬럼명 배포본별 상이** → 임의추측 금지, 매핑 확인받기.
3. **한국 CSV cp949·컬럼명 공백** → `io_utils.read_csv_kr`에서만 처리.
4. **건물 높이 0/결측 다수** → 층수×3.0m, 제외 통계 로깅.

---

## §5. 다음 할 일 (정확한 재개 지점)

1. ~~01~04 파이프라인 + 웹 검증~~ **전부 완료(2026-07-07).** 산출 지표:
   - 그림자: 13시 5.54㎢(최소)~17시 8.67㎢ / 격자 14,663셀·14시 평균 그늘율 16.7%
   - 보행망: 6,201노드·17,380엣지·평균 shade_14=0.164 (격자와 교차 일치)
   - 경로 분기 검증: 상계 1900m·6% → 1978m·28% / 중계 1924m·12% → 2061m·35%
   - `reports/shadow_timelapse.gif` (07~19시 13프레임, 태양 나침반)
2. **S-DoT 데이터 받으면 05_validate 실행.** ← 첫 재개 포인트
3. (가산) 그늘막(`dataset/`에 있음) union → 무더위쉼터 sjoin → 06_sdi + 핫스팟 시각화 → 날씨 스냅샷.

### 웹 UI 사용법 (내비 v2)
- 실행: `uvicorn api.main:app --port 8000` → http://localhost:8000
- **출발/도착**: 장소검색(자동완성, 785곳: 역·동·학교·아파트…) / 📍내 위치(파란점+방향) / 지도 클릭 / 공유링크 `/?from=lat,lon&to=lat,lon`
- **경로**: β 슬라이더 제거 → **그늘 등급 옵션**(최단/그늘40·60·80%+/추천 배지) 리스트에서 선택. 추천 = 최단×1.25 이내 중 그늘 최대 (`graph.route_options`)
- **길 안내**: 도로명 턴바이턴 (`graph.route_steps`, 방위각 이산화)
- **🏙️ 3D 근거**(`/3d.html?from&to&hour`): MapLibre GL(토큰 불필요) 3D 압출 건물 + 그림자 프레임(07~18시, `shadows_anim`) 크로스페이드 스윕 + 경로 프로그레시브 드로잉
- 신규 API: `/api/places?q=` `/api/routes` `/api/buildings` `/api/shade_frames`
- 신규 파이프라인: `08_places.py`(OSM 장소색인), `09_shadow_frames.py`(매시 그림자)
- **주의: SPEC §8의 "JS 150줄" 제한은 사용자 지시로 해제됨** (1파일·CDN·빌드없음은 유지)
- 비공개 노트: `docs/학습노트.md` (gitignore — 푸시 금지 유지)

---

## §6. 실행 방법

### 서버만 띄우기 (데이터 이미 있음 — 이 PC 기준, 이것만 하면 됨)
```powershell
cd "C:\Users\famouxsss24\Desktop\광운대_정융 유명현\개인 프로젝트\PDPH(PublicDataPythonHackathon)"
.venv\Scripts\activate
uvicorn api.main:app --port 8000
```
→ 브라우저 http://localhost:8000 · 종료 = Ctrl+C · 포트 겹치면 `--port 8001`

### 처음부터 (새 PC/클론 시)
```bash
python -m venv .venv && .venv/Scripts/activate
pip install -e ".[dev]"
copy .env.example .env         # USE_POSTGIS=false 로 변경 (파일 모드)
# data/raw/ 채운 뒤 (§3 데이터 계약):
python pipeline/01_prepare.py  # → 02 → 03 → 04 순차
uvicorn api.main:app --port 8000
ruff check . && pytest
```

---

## §7. 진행 로그
- 2026-07-08 — **내비 v2 + 3D 근거뷰.** 장소검색(OSM 785곳)·내위치(watchPosition+방향콘)·그늘등급별 경로(β스윕 Pareto, route_options)·턴바이턴(route_steps)·3D 뷰(MapLibre, 압출건물+그림자 크로스페이드+경로 드로잉). 테스트 11개 통과, 스크린샷 검증. 학습노트(docs/학습노트.md, gitignore) 작성. — **다음: S-DoT → 05_validate.**
- 2026-07-08 — 핸드오프 정리: §2 현황 최신화, §6에 "서버만 띄우기"(사용자 직접 실행법) 추가, 3-8 타임랩스 구현완료 반영. — **다음: S-DoT 확보 → 05_validate.**
- 2026-07-07 — **MVP 완성.** 02~04 실행(grid.shade_ratio STRtree 최적화로 03 병목 해결), scikit-learn 의존성 추가(osmnx nearest_nodes 요구), 웹 UI 전면 리디자인(CARTO 타일·글래스 카드·경로 애니메이션·출발시각 차트·타임랩스 재생·공유링크), 07_timelapse.py 신규(GIF 13프레임), 헤드리스 브라우저 스크린샷으로 시각 검증. ruff·pytest(9) 통과. — **다음: S-DoT 확보 → 05_validate.**
- 2026-07-07 — **실데이터 배치 + 01_prepare 실행 성공.** 건물 매핑 확정(높이=A16·층수=A26, io_utils의 A15 오매핑 버그 수정), 01_prepare에 노원구 클립 추가, 가로수 xlsx 노원시트→trees.csv 변환. 노원 건물 12,273동·가로수 12,430그루 산출. ruff·pytest(9) 통과. — **다음: 02_shadows→03→04 실행.**
- 2026-07-07 — 코드 전체 구현 완료 후, **데이터 수집 가이드라인 확정**(파일 다운로드 원칙, 건물/가로수/S-DoT 출처·좌표계·기간, 그늘막 채택, 날씨=스냅샷 패턴, 폐사/근로자 데이터 제외, 핫스팟=SDI 시각화, 그림자 타임랩스 GIF 채택). — **다음: `raw/buildings`·`raw/trees.csv` 배치 후 01_prepare 실행 → 건물 컬럼 매핑 확정.**
