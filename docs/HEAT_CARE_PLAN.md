# 폭염 보행 지원 — 평가 정렬형 구현 계획

> 확정 방향: 출발지의 현재 체감온도를 확인해 33°C 이상에서만 외출 연기를 안내하고, 그 밖에는 햇빛 노출이 적은 시간·경로·공식 쉼터를 중립적으로 비교한다.
> 작성 기준: 2026-07-16 · 현재 구현: [PROJECT_STATUS.md](PROJECT_STATUS.md) · 위험 규율: [COMPETITION_RISK_AUDIT.md](COMPETITION_RISK_AUDIT.md)

## 1. 문제 정의와 발표 문장

대상은 노원구 안에서 병원·약국·대중교통 환승·돌봄 등 취소하기 어려운 생활 보행을 하는 시민이며, 첫 데모 사용자는 어르신으로 고정한다.

서비스 판단 순서:

1. 현재 체감온도가 33°C 이상이면 외출을 미루도록 안내한다.
2. 물·양산·모자 등 개인 보호수단을 안내한다.
3. 이동이 불가피하면 노출이 적은 출발 시각을 제안한다.
4. 시간대별 건물·가로수 그림자로 경로 전체의 일사 노출을 계산한다.
5. 필요하면 공식 무더위쉼터를 경유 후보로 제시한다.

양산을 대체하거나 의학적 안전을 보장하지 않는다. 핵심 차별점은 시설 점 위치가 아니라 이동 과정의 연속적인 노출을 보행망 엣지 단위로 계산한다는 데 있다.

## 2. 평가 항목 대응

| 평가 항목 | 구현 증거 |
|---|---|
| 문제 정의 | 불가피한 생활 보행과 어르신 시나리오, 현재 체감온도에 따른 조건부 의사결정 |
| 데이터 분석·전처리 | 건물 12,273동, 가로수 12,430그루, 보행망 6,201노드, 그림자·격자·S-DoT·쉼터 파이프라인 |
| AI 모델 적합성 | S-DoT 상대 온도 편차 예측 모델을 센서 단위 교차검증하고 기준선 개선 시에만 사용 |
| 창의성·실용성 | 연속 경로 일사 노출 계산 + 출발시각 + 공식 쉼터 결합 |
| 발표·문서화 | 관측·물리 시뮬레이션·ML 추정을 분리하고 fresh-clone 재현성 보장 |

## 3. 핵심 용어와 안전 규율

- 마케팅 개념은 `Heat Budget`을 사용할 수 있으나 API·UI에서는 `일사 노출 부담 지수` 또는 `일사 노출 근사치`로 표시한다.
- `sun-minute`, 모드별 한도, 회복계수는 의학적 기준이 아닌 버전 관리되는 데모 파라미터다.
- `safe`, `안전`, `위험 없음`, `온열질환 예방 보장`을 응답·UI에 사용하지 않는다.
- API는 `feasible` 대신 `within_budget`을 사용하고 항상 `model`과 `disclaimer`를 동봉한다.
- 공식 무더위쉼터와 편의점을 같은 등급으로 취급하지 않는다. 편의점은 `일시적 실내 대피 후보`이며 이용 가능성을 보장하지 않는다.
- 2026-08-06 그림자는 맑은 하늘 가정의 물리 시뮬레이션이다. S-DoT 관측값이나 실측 그림자로 표현하지 않는다.

## 4. 제품 범위

### 대회 핵심

- 사용자 프리셋: `default`, `elder`
- 공식 무더위쉼터 데이터·API
- 시간 진행을 반영한 일사 노출 부담 적산
- 기존 경로 응답을 유지하면서 `mode=` 지정 시 `heat` 블록 추가
- 출발시각별 부담 비교
- 현재 체감온도 기반 조건부 외출 연기·양산·물 안내와 이동 경로 UI
- 어르신 병원·약국 이동 단일 발표 시나리오

### 조건부 후속

- `stroller`: 계단 회피 메타데이터 검증 후 추가
- `runner`, 러닝 순환 코스: 핵심 데모 완료 뒤 추가
- `dog`: 노면온도 데이터 부재 한계를 명시하고 확장 기능으로만 유지
- LLM 자연어 파싱·브리핑: 키 없이 규칙 폴백이 완성된 경우에만 추가
- 기상청 공식 특보 연동: 현재 Open-Meteo 모델 현재값과 구분해 후속 기능으로 검토

## 5. Phase A — AI 가능성 게이트

**상태: 구현 완료 · 제품 게이트 미통과**

### 목표

S-DoT이 단순 장식이 아니라 실제로 공간별 상대 온도 편차를 설명할 수 있는지 제품 개발 초기에 판정한다.

### 데이터와 타깃

- 관측: `data/raw/sdot/` 2026-06-15~07-05, 노원 센서 36개
- 시간 범위: 07~19시
- 타깃: `delta_t = 센서 기온 - 동일 시각 노원 센서 중앙값`
- 피처 v1: 시간 sin/cos, 센서가 속한 50m 격자의 시간대별 그늘율
- 피처 v2: 건물 면적률·평균 높이·가로수 밀도를 추가하되 전처리 근거와 결측률을 기록

### 검증

- `GroupKFold(groups=sensor_id)`로 공간 일반화 평가
- 기준선은 `delta_t=0`
- MAE, fold별 MAE, 기준선 대비 개선률을 저장
- 평균 개선률이 5%를 넘고 과반수 fold에서 기준선을 개선할 때만 `eligible_for_product=true`
- 통과하지 못하면 결과를 그대로 문서화하고 제품 K값에는 사용하지 않으며 `AI 추천` 문구를 금지한다.

### 산출물

- `src/gneulro/microclimate.py`
- `pipeline/12_microclimate.py`
- `reports/microclimate_metrics.json`
- `data/processed/microclimate_grid.parquet`은 게이트 통과 시에만 생성
- `tests/test_microclimate.py`

실행 결과는 센서 32개·8,309행이다. 선택 후보 `v1_shade_time`의 기준선 MAE는
`0.7232°C`, 모델 MAE는 `0.9605°C`, 평균 fold 개선률은 `-35.58%`, 개선 fold는
`0/5`였다. 따라서 `eligible_for_product=false`이며 제품용
`microclimate_grid.parquet`은 생성하지 않았다.

## 6. Phase B — 공식 무더위쉼터

**상태: 구현 완료 · 2026-07-16 공식 자료 검증**

- 원천은 서울 열린데이터광장 `OA-21065 서울시 무더위쉼터` 전체 CSV다.
- 행정안전부 전국 표준데이터는 원천 후보로 검토했으나 전체 API가 신청·서비스 키를 요구해, 새 clone 무키 실행 원칙에 맞는 서울시 공식 배포본을 사용한다.
- 노원구·서비스 bbox 필터, 좌표 검증, 중복 제거를 수행한다.
- 필드: `spot_id, name, type, lat, lon, node_id, node_distance_m, address, facility_type, capacity, open_hours, access_scope, access_note, operating_note, source, source_url, source_year, verified_at`.
- 운영시간이 불명확하면 `open_hours=null`로 두고 운영 중이라고 주장하지 않는다.
- 가장 가까운 보행 그래프 노드를 사전 계산한다.
- 처리된 `data/processed/cooling_spots.parquet`을 Git에 포함한다.
- `GET /api/cooling_spots?bbox=`에서 공식 쉼터 GeoJSON을 반환한다.
- `tests/test_cooling.py`에서 노원구 밖 0건, 필수 필드 결측 0건, bbox 필터를 검증한다.

현재 산출물은 노원구 297곳이며, 일반 이용 후보 `public` 38곳과 회원·특정계층
시설 `restricted` 259곳을 명시적으로 분리한다. 자동 경유 후보에는 `public`만 사용한다.

편의점은 별도 `candidate_type=convenience`로 추가할 수 있지만 핵심 경유 자동 삽입에는 공식 쉼터를 우선한다.

## 7. Phase C — 일사 노출 부담 엔진과 API

**상태: 구현 완료**

### 적산 모델

```text
edge_exposure_sun_min = edge_travel_min
                      × (1 - interpolated_shade_at_traversal_time)
                      × heat_level_factor
                      × mode_factor
```

- 경로를 걸으며 시간이 진행되므로 엣지마다 다른 시각의 그림자 값을 사용한다.
- v1은 상대 비교용 물리 근사다.
- 기존 `time_min`은 1.2m/s 기준으로 유지하고 모드별 시간은 `mode_time_min`에 추가한다.

### API

`GET /api/routes`에 선택적 `mode=`를 추가한다. 미지정 응답은 기존 스키마와 동일해야 한다.

```json
"heat": {
  "model": "sun_exposure_proxy_v1",
  "mode": "elder",
  "exposure_sun_min": 11.2,
  "budget_sun_min": 15,
  "budget_used_pct": 75,
  "within_budget": true,
  "mode_time_min": 18.4,
  "gauge": [{"d_m": 0, "budget_used_pct": 0}],
  "stops": [],
  "disclaimer": "의학적 안전 기준이 아닌 경로 간 상대 비교용 근사치"
}
```

- 공식 쉼터는 노출 한도 이전의 경로 120m 안에서 찾고, 없으면 240m로 한 번 확대한다.
- 최대 2곳까지만 삽입한다.
- 한도를 만족하지 못하면 `within_budget=false`와 출발시각 대안을 반환한다.
- 쉼터 체류 회복계수는 공식 수치가 아니므로 UI에서는 퍼센트 회복을 직접 주장하지 않고 계산 파라미터로만 사용한다.

## 8. Phase D — 출발시각과 프론트엔드

**상태: 구현 완료 · Orca 데스크톱/모바일 브라우저 검증 완료**

- `/api/departure?mode=`가 기존 `exposure_m`을 유지하면서 `budget_used_pct`, `within_budget`, `first_lower_exposure`를 추가한다.
- `/api/weather?lat=&lon=`이 Open-Meteo 모델 현재 기온·체감온도를 반환하고, 현재 체감온도 33°C 이상에서만 외출 미루기 문구를 활성화한다.
- 공식 기상청 폭염특보는 지속 기간과 영향도를 함께 판단하므로 이 현재값 판정을 공식 특보라고 표현하지 않는다.
- 날씨 공급자 장애 시 외출 자제 판정을 만들지 않고 물·양산·모자와 햇빛 노출이 적은 시간·경로 비교 안내로 폴백한다.
- 사용자가 `이동 경로 비교하기` 또는 `출발 시각 비교하기`를 선택할 수 있다.
- 핵심 모드는 `일반`, `어르신 동행` 두 개만 노출한다.
- 공식 쉼터는 별도 아이콘과 출처·운영정보를 표시한다.
- 경로 카드에는 예상 햇빛 노출 시간을, 상세 화면에는 햇빛 구간 비율과 `맑은 하늘 그림자 기반 예상치`를 표시한다.
- 지도 중심·경로·현재 위치를 가리지 않으며 데스크톱·모바일에서 지도 컨트롤·패널 겹침을 확인한다.
- 모바일·저사양 3D는 현재 시간 단일 그림자 프레임부터 표시하고 다른 시간은 선택할 때 지연 로드한다.
- 지도 장소 팝업은 330px 정보 카드로 유지하고 모바일 패널·지도 도구·attribution과 겹치지 않게 안전영역 안으로 이동한다.
- 경로 미리보기는 1×·2×·4×·8×·16× 속도를 제공하고 고속 재생 중 주변 장소 요청을 제한한다.

## 9. 완료 기준

- `.venv\Scripts\python.exe -m ruff check .`
- `.venv\Scripts\python.exe -m pytest -q`
- `web/js/*.js` 전부 `node --check`
- 기존 API 응답 회귀 테스트
- `/api/health`, `/api/weather`, `/api/cooling_spots`, `mode=elder` 경로, 출발시각 API 확인
- 데스크톱과 모바일 실제 브라우저 스크린샷·콘솔 오류 확인
- 처리 산출물을 Git에 포함하고 새 GitHub clone에서 live API 검증
- `PROJECT_STATUS.md`, `COMPETITION_RISK_AUDIT.md`, 이 계획의 Phase 상태를 같은 커밋에서 갱신

## 10. 권장 커밋 분할

1. `plan: align heat care with judging criteria`
2. `feat: evaluate microclimate model`
3. `feat: add official cooling shelters`
4. `feat: add sun exposure routing`
5. `feat: integrate essential-walk heat care UI`

각 단계는 테스트가 통과한 상태에서만 다음 단계로 넘어간다.

현재 작업에서는 사용자가 전체 변경을 확인한 뒤 직접 Git에 올리기로 했으므로 에이전트가 커밋·푸시하지 않는다.
