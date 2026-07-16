const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
const NOWON_BOUNDS = { west: 127.038, south: 37.61, east: 127.116, north: 37.694 };
const HEAT_ADVISORY_APPARENT_C = 33;

function json(body, { status = 200, cache = false } = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": cache
        ? "public, max-age=60, s-maxage=300, stale-while-revalidate=600, stale-if-error=3600"
        : "no-store",
    },
  });
}

function numberFrom(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${field}`);
  return parsed;
}

function inNowon(lat, lon) {
  return (
    lat >= NOWON_BOUNDS.south &&
    lat <= NOWON_BOUNDS.north &&
    lon >= NOWON_BOUNDS.west &&
    lon <= NOWON_BOUNDS.east
  );
}

export default {
  async fetch(request) {
    if (request.method !== "GET") return json({ detail: "Method not allowed" }, { status: 405 });

    const url = new URL(request.url);
    let lat;
    let lon;
    try {
      lat = numberFrom(url.searchParams.get("lat") ?? 37.654, "latitude");
      lon = numberFrom(url.searchParams.get("lon") ?? 127.0567, "longitude");
    } catch {
      return json({ detail: "위도와 경도는 숫자여야 합니다." }, { status: 422 });
    }
    if (!inNowon(lat, lon)) {
      return json({ detail: "현재 날씨 조회 범위는 노원구입니다." }, { status: 422 });
    }

    const roundedLat = Number(lat.toFixed(2));
    const roundedLon = Number(lon.toFixed(2));
    const upstream = new URL(OPEN_METEO_URL);
    upstream.search = new URLSearchParams({
      latitude: roundedLat,
      longitude: roundedLon,
      current:
        "temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code",
      temperature_unit: "celsius",
      timezone: "Asia/Seoul",
    });

    try {
      const response = await fetch(upstream, {
        headers: { "User-Agent": "gneulro/0.1 (+current-weather)" },
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new Error(`weather upstream ${response.status}`);
      const current = (await response.json()).current;
      const temperature = numberFrom(current?.temperature_2m, "temperature_2m");
      const apparent = numberFrom(current?.apparent_temperature, "apparent_temperature");
      const humidity = numberFrom(current?.relative_humidity_2m, "relative_humidity_2m");

      return json(
        {
          temperature_c: Number(temperature.toFixed(1)),
          apparent_temperature_c: Number(apparent.toFixed(1)),
          relative_humidity_pct: Math.round(humidity),
          current_at: current.time ?? null,
          is_day: Boolean(current.is_day ?? 1),
          weather_code: current.weather_code ?? null,
          recommend_defer_outdoor: apparent >= HEAT_ADVISORY_APPARENT_C,
          threshold: {
            metric: "apparent_temperature",
            value_c: HEAT_ADVISORY_APPARENT_C,
            basis: "KMA heat-advisory apparent-temperature level",
          },
          provider: "Open-Meteo",
          provider_url: "https://open-meteo.com/en/docs",
          data_kind: "model_current_conditions",
          location: { lat: roundedLat, lon: roundedLon },
        },
        { cache: true },
      );
    } catch {
      return json({ detail: "현재 날씨를 불러오지 못했습니다." }, { status: 503 });
    }
  },
};
