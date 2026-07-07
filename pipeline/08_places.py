"""8단계: OSM 장소(역·동·학교·공원·아파트 등)를 색인해 검색용 places.json을 만든다."""

from gneulro.places import build_places, save_places


def main():
    """장소 색인을 만들어 저장하고 개수를 출력한다."""
    entries = build_places()
    save_places(entries)
    print(f"[완료] places.json 저장 ({len(entries)}곳)")


if __name__ == "__main__":
    main()
