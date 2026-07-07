"""프로젝트 전역 설정 — 모든 상수는 여기서만 정의하고 다른 모듈은 import해서 쓴다."""

from datetime import date
from pathlib import Path
from zoneinfo import ZoneInfo

CRS_METRIC = 5186  # 계산용 좌표계 (미터, 중부원점)
CRS_WGS = 4326  # 표시·API 응답용 좌표계 (위도/경도)
TZ = ZoneInfo("Asia/Seoul")
CALC_DATE = date(2026, 8, 6)  # 대표일 = 본선 발표일
HOURS = [10, 13, 14, 15, 17]  # 사전계산 시간대
PLACE = "Nowon-gu, Seoul, South Korea"

GRID_SIZE_M = 50  # 격자 한 변 길이 (m)
TREE_SHADE_RADIUS_M = 3.0  # 가로수 그늘 반경 (m)
MIN_SUN_ALT_DEG = 10.0  # 이 고도 이하면 그림자 계산 생략 (길이 폭주 방지)
MAX_SHADOW_LEN_M = 300.0  # 그림자 길이 상한 (m)
FLOOR_HEIGHT_M = 3.0  # 층수 → 높이 환산 계수 (m/층)
WALK_SPEED_MPS = 1.2  # 보행 속도 (m/s)
BETA_DEFAULT = 2.0  # 그늘 선호도 기본값

DATA_RAW = Path("data/raw")
DATA_PROCESSED = Path("data/processed")
REPORTS = Path("reports")
# DB 설정(POSTGRES_URL, USE_POSTGIS)은 .env 환경변수에서 읽는다 (store.py 담당).
