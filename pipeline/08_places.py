"""8단계: OSM 장소(역·동·학교·공원·아파트 등)를 색인해 검색용 places.json을 만든다."""

from gneulro.places import build_building_addresses, build_places, merge_places, save_places


def main():
    """장소 색인을 만들어 저장하고 개수를 출력한다."""
    osm_entries = build_places()
    address_entries = build_building_addresses()
    entries = merge_places(
        osm_entries,
        address_entries,
        limit=len(osm_entries) + len(address_entries),
    )
    save_places(entries)
    print(f"[완료] places.json 저장 ({len(entries)}곳)")


if __name__ == "__main__":
    main()
