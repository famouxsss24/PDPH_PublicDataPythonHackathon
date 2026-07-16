# 그늘로 (gneulro)

노원구 건물 높이와 가로수, 태양 위치를 이용해 햇빛 노출이 적은 도보 경로를 비교하는 시민용 내비게이션이다.

처음 보는 사람을 위한 [구현 가이드와 학습 노트](docs/PROJECT_GUIDE.md), 현재 구현과 데이터 의미를 기록한 [프로젝트 현황](docs/PROJECT_STATUS.md), 심사 전 확인할 [경진대회 위험 감사](docs/COMPETITION_RISK_AUDIT.md), 확정 [UI 계획](docs/UI_PLAN.md)을 기준으로 한다.

## 현재 화면 흐름

`장소·주소 검색 → 최대 5개 경로 비교 → 도보 안내 → 3D 그림자 근거 화면`

- 출발·도착 자동완성, 지도 보조 선택, 순서 교환
- 추천/최단/그늘 우선 경로와 시간대별 그늘 구간
- 기본 GPS 추적과 별도 경로 미리보기, 진행 방향 부채꼴, 지도 회전 마커, 한국어 음성 안내, 주변 건물·상호 라벨
- 라이트/다크 모드, 모바일 추적 카메라, 수동 지도 탐색
- 높이 기반 3D 건물과 현재 시각 우선 표시·07~18시 그림자 애니메이션

## 실행

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -e ".[dev]"
Copy-Item .env.example .env
# 파일 저장 모드는 .env에서 USE_POSTGIS=false
.venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000
```

브라우저에서 http://127.0.0.1:8000 을 연다.

### 새 clone 데모 모드

새 clone은 실제 데이터 파이프라인에서 생성해 추적 중인 `web/mock` 스냅샷으로 즉시 동작한다. 원천 공공데이터, PostGIS, Kakao 키 없이도 장소 검색·경로 비교·3D 화면을 사용할 수 있다. 파이프라인 산출물을 준비한 뒤에만 `http://127.0.0.1:8000/?api=1`로 live API를 명시적으로 사용한다.

## 데이터 파이프라인

```powershell
.venv\Scripts\python.exe pipeline\01_prepare.py
.venv\Scripts\python.exe pipeline\02_shadows.py
.venv\Scripts\python.exe pipeline\03_grid.py
.venv\Scripts\python.exe pipeline\04_graph.py
.venv\Scripts\python.exe pipeline\08_places.py
.venv\Scripts\python.exe pipeline\09_shadow_frames.py
.venv\Scripts\python.exe pipeline\10_mockdata.py
```

S-DoT 보조 분석은 `.venv\Scripts\python.exe pipeline\05_validate.py`로 실행한다. 현재 결과는 냉각 효과를 입증하지 않으므로 문서의 한계를 먼저 확인해야 한다.

## 검증

```powershell
.venv\Scripts\python.exe -m ruff check .
.venv\Scripts\python.exe -m pytest -q
Get-ChildItem web\js\*.js | ForEach-Object { node --check $_.FullName }
```

## 주의

- 서비스 범위는 노원구다.
- 2026-08-06 그림자는 맑은 하늘 가정의 물리 시뮬레이션이며 실측·실시간 그림자가 아니다.
- Kakao Local을 활성화하지 않으면 OSM과 공공 지번 색인으로 폴백하므로 일부 상호가 검색되지 않는다.
- `web/mock`은 손으로 만든 가짜 데이터가 아니라 실데이터 산출물의 정적 스냅샷이다.
