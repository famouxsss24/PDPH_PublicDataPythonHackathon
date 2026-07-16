# 그늘로 (gneulro)

노원구 건물 높이와 가로수, 태양 위치를 이용해 햇빛 노출이 적은 도보 경로를 비교하는 시민용 내비게이션이다.

처음 보는 사람을 위한 [구현 가이드와 학습 노트](docs/PROJECT_GUIDE.md), 현재 구현과 데이터 의미를 기록한 [프로젝트 현황](docs/PROJECT_STATUS.md), 심사 전 확인할 [경진대회 위험 감사](docs/COMPETITION_RISK_AUDIT.md), [Claude 제안서 작성 프롬프트](docs/CLAUDE_PROPOSAL_PROMPT.md), 확정 [UI 계획](docs/UI_PLAN.md)을 기준으로 한다.

## 현재 화면 흐름

`장소·주소 검색 → 현재 날씨 확인 → 햇빛 노출 경로 비교 → 도보 안내 → 3D 그림자 근거 화면`

- 출발·도착 자동완성, 지도 보조 선택, 순서 교환
- 추천/최단/그늘 우선 경로와 시간대별 그늘 구간
- 기본 GPS 추적과 1×·2×·4×·8×·16× 경로 미리보기, 진행 방향 부채꼴, 지도 회전 마커, 한국어 음성 안내, 주변 건물·상호 라벨
- 라이트/다크 모드, 모바일 추적 카메라, 수동 지도 탐색
- 높이 기반 3D 건물과 현재 시각 우선 표시·07~18시 그림자 애니메이션
- 일반/어르신 동행별 예상 햇빛 노출 시간과 일반 이용 가능한 공식 무더위쉼터 경유 후보
- 출발지 현재 기온·체감온도와 체감 33°C 이상에서만 표시되는 외출 미루기 안내
- 지도 클릭 시 주소·출발·도착만 빠르게 고르는 330px 장소 카드

## 실행

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -e ".[dev]"
Copy-Item .env.example .env
# 파일 저장 모드는 .env에서 USE_POSTGIS=false
.venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000
```

브라우저에서 http://127.0.0.1:8000 을 연다.

macOS/Linux에서는 같은 순서로 아래 명령을 사용한다.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
cp .env.example .env
.venv/bin/python -m uvicorn api.main:app --host 127.0.0.1 --port 8000
```

### 새 clone 실행

실행에 필요한 `data/processed` 산출물(건물·그림자·보행 그래프·장소 색인·공식 무더위쉼터)은 저장소에 함께 포함된다. 원천 공공데이터, PostGIS, Kakao 키, 무더위쉼터 API 키 없이도 위 기본 명령으로 live 장소 검색·경로 비교·현재 날씨 안내·3D 화면을 실행한다. `web/mock`은 정적 서버 또는 오프라인 발표용 실제 파이프라인 스냅샷이다. 현재 날씨는 키 없는 Open-Meteo를 사용하므로 네트워크가 끊기면 날씨 문구만 중립 상태로 폴백한다.

`data/raw`와 `tmp`는 Git에서 제외하고, 재배포 가능한 실행 산출물만 추적한다. 현재 추가된 `cooling_spots.parquet`은 약 58KB로 GitHub 파일 크기 제한보다 충분히 작다.

## Vercel 배포

`vercel.json`은 `web` 정적 스냅샷을 루트에 배포하고 `api/weather.mjs`를 키 없는 현재 날씨 함수로 제공한다. 건물 스냅샷은 노원구 전체 12,273동을 포함하되 화면에 보이는 bbox만 클라이언트에서 추려 렌더링한다. 따라서 원천 데이터나 로컬 DB 없이 검색·경로 비교·3D와 현재 날씨 안내가 함께 동작한다.

```powershell
npx vercel --prod
```

## 데이터 파이프라인

```powershell
.venv\Scripts\python.exe pipeline\01_prepare.py
.venv\Scripts\python.exe pipeline\02_shadows.py
.venv\Scripts\python.exe pipeline\03_grid.py
.venv\Scripts\python.exe pipeline\04_graph.py
.venv\Scripts\python.exe pipeline\08_places.py
.venv\Scripts\python.exe pipeline\09_shadow_frames.py
.venv\Scripts\python.exe pipeline\10_mockdata.py
.venv\Scripts\python.exe pipeline\13_cooling_spots.py
```

`13_cooling_spots.py`는 키 없이 서울 열린데이터광장 공식 CSV를 다시 받아 실행 산출물을 갱신한다. S-DoT 원천 파일이 있는 환경에서만 `05_validate.py`와 `12_microclimate.py`를 실행할 수 있다. 현재 학습 모델은 공간 교차검증 게이트를 통과하지 못해 제품 경로에 사용하지 않으며, 냉각 효과도 입증하지 않는다.

## 검증

```powershell
.venv\Scripts\python.exe -m ruff check .
.venv\Scripts\python.exe -m pytest -q
Get-ChildItem web\js\*.js | ForEach-Object { node --check $_.FullName }
Get-ChildItem api\*.mjs | ForEach-Object { node --check $_.FullName }
```

같은 검증은 `.github/workflows/ci.yml`에서 Ubuntu/Python 3.11과 Windows/Python 3.12로 자동 실행된다.

## 주의

- 서비스 범위는 노원구다.
- 현재 날씨는 Open-Meteo 모델 현재값이며 공식 기상청 관측·특보가 아니다. 체감온도 33°C는 외출 미루기 문구의 현재값 트리거로만 사용한다.
- 2026-08-06 그림자는 맑은 하늘 가정의 물리 시뮬레이션이며 실측·실시간 그림자가 아니다.
- Kakao Local을 활성화하지 않으면 OSM과 공공 지번 색인으로 폴백하므로 일부 상호가 검색되지 않는다.
- `web/mock`은 손으로 만든 가짜 데이터가 아니라 실데이터 산출물의 정적 스냅샷이다.
