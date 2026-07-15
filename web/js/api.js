const MOCK_HOURS = [10, 13, 14, 15, 17];
const params = new URLSearchParams(window.location.search);

export const USE_MOCK =
  params.get("mock") === "1" ||
  (params.get("api") !== "1" && ["8080", ""].includes(window.location.port));

const requests = new Map();
const staticCache = new Map();

export class StaleRequestError extends Error {
  constructor() {
    super("A newer request replaced this one");
    this.name = "StaleRequestError";
  }
}

async function requestJson(key, url, { cache = false } = {}) {
  if (cache && staticCache.has(url)) return staticCache.get(url);

  const previous = requests.get(key);
  if (previous) previous.controller.abort();

  const controller = new AbortController();
  const token = (previous?.token ?? 0) + 1;
  requests.set(key, { controller, token });

  const promise = fetch(url, { signal: controller.signal }).then(async (response) => {
    if (!response.ok) {
      let detail = `요청 실패 (${response.status})`;
      try {
        const body = await response.json();
        detail = body.detail || detail;
      } catch {
        // Non-JSON errors keep the HTTP fallback message.
      }
      throw new Error(detail);
    }

    const data = await response.json();
    if (requests.get(key)?.token !== token) throw new StaleRequestError();
    return data;
  });

  if (cache) staticCache.set(url, promise);

  try {
    return await promise;
  } catch (error) {
    if (cache) staticCache.delete(url);
    throw error;
  }
}

function timeParts(departAt) {
  if (departAt === "now") {
    const now = new Date();
    return { hour: now.getHours(), minute: now.getMinutes(), label: "now" };
  }

  const match = /^(\d{1,2}):(\d{2})$/.exec(departAt);
  if (!match) return { hour: 14, minute: 0, label: "14:00" };
  return { hour: Number(match[1]), minute: Number(match[2]), label: departAt };
}

function nearestMockHour(hour, minute = 0) {
  const value = hour + minute / 60;
  return MOCK_HOURS.reduce((best, candidate) =>
    Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best,
  );
}

function addMinutes(departAt, minutes) {
  const now = new Date();
  const parts = timeParts(departAt);
  const date = new Date(now);
  if (departAt !== "now") date.setHours(parts.hour, parts.minute, 0, 0);
  date.setMinutes(date.getMinutes() + Math.round(minutes));
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function deriveSegments(route) {
  if (route.segments?.length) return route.segments;
  return [{ shaded: route.shade_pct >= 50, coords: route.coords ?? [] }];
}

function normalizeLegacyRoutes(payload, departAt, requested) {
  const hour = nearestMockHour(requested.hour, requested.minute);
  const candidates = payload.routes.map((route, index) => ({
    ...route,
    id: `h${hour}-r${index}`,
    labels: [],
    minutes: route.time_min,
    distance_m: route.dist_m,
    extra_min: route.delta_min ?? 0,
    segments: deriveSegments(route),
    arrive_at: addMinutes(departAt, route.time_min),
  }));
  const shortest = candidates.reduce((best, route) =>
    route.minutes < best.minutes ? route : best,
  );
  const recommended = candidates[payload.recommended_idx] ?? shortest;
  const shadeFirst = candidates.reduce((best, route) =>
    route.shade_pct > best.shade_pct ? route : best,
  );
  const addLabel = (route, label) => {
    if (route && !route.labels.includes(label)) route.labels.push(label);
  };
  addLabel(recommended, "추천");
  addLabel(shortest, "최단");
  addLabel(shadeFirst, "그늘 우선");
  for (const target of [30, 50]) {
    const eligible = candidates
      .filter((route) => route.shade_pct >= target)
      .sort((a, b) => a.minutes - b.minutes)[0];
    addLabel(eligible, `그늘 ${target}%+`);
  }
  const orderScore = (route) => {
    if (route.id === recommended.id) return 0;
    if (route.id === shortest.id) return 1;
    if (route.id === shadeFirst.id) return 2;
    return 3;
  };
  candidates.sort((a, b) => orderScore(a) - orderScore(b) || a.minutes - b.minutes);
  return { options: candidates, recommendedId: recommended.id, hour };
}

function normalizeRoutes(payload, departAt) {
  const requested = timeParts(departAt);
  const isNight = requested.hour >= 19 || requested.hour < 7;
  const legacy = payload.routes ? normalizeLegacyRoutes(payload, departAt, requested) : null;
  let options = legacy
    ? legacy.options
    : payload.options.map((route) => ({
        ...route,
        minutes: route.minutes ?? route.time_min,
        distance_m: route.distance_m ?? route.dist_m,
        extra_min: route.extra_min ?? route.delta_min ?? 0,
        segments: deriveSegments(route),
        arrive_at: route.arrive_at ?? addMinutes(departAt, route.minutes ?? route.time_min),
      }));

  if (isNight) {
    const shortest = options.find((route) => route.labels?.includes("최단")) ?? options[0];
    options = shortest ? [shortest] : [];
  }

  const recommendedId = isNight
    ? options[0]?.id ?? null
    : legacy?.recommendedId ?? payload.recommended_id ?? options[0]?.id ?? null;

  return {
    ...payload,
    options,
    recommended_id: recommendedId,
    meta: {
      ...payload.meta,
      data_mode: USE_MOCK ? "mock" : "live",
      depart_hour: legacy?.hour ?? payload.meta?.depart_hour,
      depart_at_used: departAt,
      requested_time: requested,
      night: isNight,
    },
  };
}

export async function searchPlaces(query) {
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    const places = await requestJson("places-index", "./mock/places.json", { cache: true });
    return places.filter((place) => place.cat === "역").slice(0, 10);
  }
  if (!USE_MOCK) {
    const payload = await requestJson("places", `/api/places?q=${encodeURIComponent(cleanQuery)}`);
    return payload.results ?? payload;
  }

  const places = await requestJson("places-index", "./mock/places.json", { cache: true });
  const terms = cleanQuery.toLocaleLowerCase("ko-KR").split(/\s+/).filter(Boolean);
  const scored = places
    .map((place, index) => {
      const haystack = `${place.name} ${place.cat}`.toLocaleLowerCase("ko-KR");
      const matches = terms.length === 0 || terms.every((term) => haystack.includes(term));
      const score = cleanQuery && place.name.startsWith(cleanQuery) ? 0 : 1;
      return { place, index, matches, score };
    })
    .filter((item) => item.matches)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, 10)
    .map(({ place }) => place);

  return scored;
}

export async function reversePlace({ lat, lon }) {
  if (USE_MOCK) {
    const places = await requestJson("places-index", "./mock/places.json", { cache: true });
    const nearest = places.reduce((best, place) => {
      const distance = (place.lat - lat) ** 2 + (place.lon - lon) ** 2;
      return !best || distance < best.distance ? { place, distance } : best;
    }, null);
    if (nearest?.distance < 0.00003) return nearest.place;
    return { name: "지도에서 선택한 위치", cat: "위치", lat, lon };
  }
  return requestJson(
    "reverse-place",
    `/api/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`,
  );
}

export async function fetchNearbyPlaces({ lat, lon }, radius = 240, limit = 7) {
  if (USE_MOCK) {
    const places = await requestJson("places-index", "./mock/places.json", { cache: true });
    const latScale = 111000;
    const lonScale = 87690;
    return places
      .filter((place) => !["주소", "행정", "동네"].includes(place.cat))
      .map((place, index) => ({
        ...place,
        index,
        distance_m: Math.hypot((place.lat - lat) * latScale, (place.lon - lon) * lonScale),
      }))
      .filter((place) => place.distance_m <= radius)
      .sort((a, b) => a.distance_m - b.distance_m || a.index - b.index)
      .slice(0, limit);
  }
  const query = new URLSearchParams({ lat, lon, radius_m: radius, limit });
  const payload = await requestJson("nearby-places", `/api/nearby?${query}`);
  return payload.results ?? [];
}

export async function fetchBuildings({ bbox = null, lod = "standard" } = {}) {
  const query = !USE_MOCK && bbox
    ? `?${new URLSearchParams({ bbox: bbox.join(","), lod })}`
    : "";
  return requestJson(
    "buildings",
    USE_MOCK ? "./mock/buildings.json" : `/api/buildings${query}`,
    { cache: true },
  );
}

export async function fetchSunPositions() {
  if (USE_MOCK) return [];
  const payload = await requestJson("sun-positions", "/api/sun_positions", { cache: true });
  return payload.positions ?? [];
}

export async function fetchRoutes({ origin, destination, departAt }) {
  let payload;
  if (USE_MOCK) {
    const parts = timeParts(departAt);
    const hour = nearestMockHour(parts.hour, parts.minute);
    payload = await requestJson("routes", `./mock/routes_${hour}.json`);
  } else {
    const parts = timeParts(departAt);
    const hour = nearestMockHour(parts.hour, parts.minute);
    const query = new URLSearchParams({
      start_lat: origin.lat,
      start_lon: origin.lon,
      end_lat: destination.lat,
      end_lon: destination.lon,
      hour,
      depart_at: departAt,
    });
    payload = await requestJson("routes", `/api/routes?${query}`);
  }

  return normalizeRoutes(payload, departAt);
}

export async function fetchExposure({ origin, destination }) {
  if (USE_MOCK) {
    return requestJson("exposure", "./mock/exposure.json", { cache: true });
  }

  const query = new URLSearchParams({
    start_lat: origin.lat,
    start_lon: origin.lon,
    end_lat: destination.lat,
    end_lon: destination.lon,
  });
  return requestJson("exposure", `/api/departure?${query}`);
}

export async function fetchShade(departAt) {
  const parts = timeParts(departAt);
  const hour = nearestMockHour(parts.hour, parts.minute);
  return fetchShadowFrame(hour);
}

export async function fetchShadowFrame(hour) {
  const requestedHour = Math.max(7, Math.min(18, Math.round(Number(hour))));
  if (USE_MOCK) {
    const mockHour = nearestMockHour(requestedHour);
    return requestJson(`shadow-frame-${mockHour}`, `./mock/shade_${mockHour}.json`, {
      cache: true,
    });
  }
  return requestJson(`shadow-frame-${requestedHour}`, `/api/shade_frame?hour=${requestedHour}`, {
    cache: true,
  });
}

export function getDepartHour(departAt) {
  const parts = timeParts(departAt);
  return nearestMockHour(parts.hour, parts.minute);
}
