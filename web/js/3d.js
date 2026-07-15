import { fetchBuildings, fetchSunPositions, USE_MOCK } from "./api.js";
import { refreshIcons } from "./icons.js";
import { applyMapTheme, DARK_3D_MAP_STYLE } from "./map-style.js";
import { initTheme } from "./theme.js";

const query = new URLSearchParams(window.location.search);
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
const LOW_POWER = window.matchMedia("(max-width: 700px)").matches
  || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4)
  || (navigator.deviceMemory && navigator.deviceMemory <= 4);
const FRAME_INTERVAL = LOW_POWER ? 50 : 30;
const parsePoint = (value) => {
  const [lat, lon] = (value ?? "").split(",").map(Number);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
};
const origin = parsePoint(query.get("from"));
const destination = parsePoint(query.get("to"));
const selectedOption = query.get("option_id");
const initialHour = Math.max(7, Math.min(18, Number(query.get("hour")) || 14));
const elements = {
  clock: document.querySelector("#clock"),
  range: document.querySelector("#frameRange"),
  play: document.querySelector("#play"),
  orbit: document.querySelector("#orbit"),
  theme: document.querySelector("#themeToggle"),
  status: document.querySelector("#loadStatus"),
  sunMeta: document.querySelector("#sunMeta"),
  compass: document.querySelector("#sunCompass"),
  hover: document.querySelector("#buildingHover"),
  evidence: document.querySelector("#routeEvidence"),
  error: document.querySelector("#mapError"),
};

let currentHour = initialHour;
let playing = false;
let orbiting = false;
let orbitFrame = 0;
let runnerFrame = 0;
let transitionToken = 0;
let playTimer = null;
let frameHours = [];
let sunPositions = [];
let runnerCoordinates = [];
let sceneTheme = "dark";
let lastRunnerUpdate = 0;

refreshIcons();
elements.play.disabled = true;
elements.range.disabled = true;
elements.clock.textContent = `${String(currentHour).padStart(2, "0")}:00`;
elements.range.value = String(currentHour);

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = false;
  elements.status.textContent = "데이터를 표시하지 못했습니다.";
}

const center = origin && destination
  ? [(origin.lon + destination.lon) / 2, (origin.lat + destination.lat) / 2]
  : [127.0655, 37.6425];

const sceneBounds = origin && destination
  ? [
    Math.min(origin.lon, destination.lon) - 0.006,
    Math.min(origin.lat, destination.lat) - 0.006,
    Math.max(origin.lon, destination.lon) + 0.006,
    Math.max(origin.lat, destination.lat) + 0.006,
  ]
  : [127.038, 37.61, 127.116, 37.694];
const sceneLod = LOW_POWER ? "mobile" : "standard";
const initialFrameHour = Math.max(7, Math.min(18, Math.round(initialHour)));
let mockFramesPromise = null;

async function fetchSceneJson(url, errorMessage) {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(errorMessage);
  return response.json();
}

function fetchAllShadowFrames() {
  if (USE_MOCK) {
    mockFramesPromise ??= fetchSceneJson("./mock/shade_frames.json", "그림자 프레임을 불러오지 못했습니다.");
    return mockFramesPromise;
  }
  const params = new URLSearchParams({ bbox: sceneBounds.join(","), lod: sceneLod });
  return fetchSceneJson(`/api/shade_frames?${params}`, "그림자 프레임을 불러오지 못했습니다.");
}

async function fetchInitialShadowFrame() {
  if (USE_MOCK) {
    const frames = await fetchAllShadowFrames();
    return {
      type: "FeatureCollection",
      features: frames.features.filter((feature) => feature.properties.hour === initialFrameHour),
    };
  }
  const params = new URLSearchParams({
    hour: String(initialFrameHour),
    bbox: sceneBounds.join(","),
    lod: sceneLod,
  });
  return fetchSceneJson(`/api/shade_frame?${params}`, "현재 시각 그림자를 불러오지 못했습니다.");
}

async function fetchSelectedRoute() {
  if (!origin || !destination) return null;
  const routeHour = [10, 13, 14, 15, 17].reduce((best, hour) =>
    Math.abs(hour - initialHour) < Math.abs(best - initialHour) ? hour : best,
  );
  const params = new URLSearchParams({
    start_lat: origin.lat,
    start_lon: origin.lon,
    end_lat: destination.lat,
    end_lon: destination.lon,
    hour: routeHour,
  });
  const data = await fetchSceneJson(
    USE_MOCK ? `./mock/routes_${routeHour}.json` : `/api/routes?${params}`,
    "선택 경로를 불러오지 못했습니다.",
  );
  const requestedIndex = Number(/r(\d+)$/.exec(selectedOption ?? "")?.[1]);
  return USE_MOCK
    ? data.options.find((option) => option.id === selectedOption)
      ?? data.options.find((option) => option.id === data.recommended_id)
      ?? data.options[0]
    : data.routes[Number.isInteger(requestedIndex) ? requestedIndex : data.recommended_idx]
      ?? data.routes[data.recommended_idx];
}

// Start scene I/O before the base map finishes loading so network waits overlap.
const buildingsPromise = fetchBuildings({ bbox: sceneBounds, lod: sceneLod });
const initialShadowPromise = fetchInitialShadowFrame();
const sunPositionsPromise = fetchSunPositions().catch(() => []);
const selectedRoutePromise = fetchSelectedRoute();

const map = new window.maplibregl.Map({
  container: "map",
  style: DARK_3D_MAP_STYLE,
  center,
  zoom: origin && destination ? 15.4 : 14.5,
  pitch: 66,
  bearing: -22,
  maxPitch: 74,
  maxBounds: [[126.985, 37.56], [127.17, 37.74]],
  canvasContextAttributes: { antialias: true },
});
map.addControl(new window.maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

function firstSymbolLayer() {
  return map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
}

function directionName(azimuth) {
  const labels = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];
  return labels[Math.round(((azimuth % 360) / 45)) % 8];
}

function fallbackSun(hour) {
  const altitude = Math.max(6, 66 - Math.abs(hour - 12.5) * 11);
  const azimuth = 92 + (hour - 7) * 16;
  return { hour, altitude, azimuth };
}

function sunAt(hour) {
  if (!sunPositions.length) return fallbackSun(hour);
  const lower = [...sunPositions].reverse().find((position) => position.hour <= hour) ?? sunPositions[0];
  const upper = sunPositions.find((position) => position.hour >= hour) ?? sunPositions.at(-1);
  const ratio = lower.hour === upper.hour ? 0 : (hour - lower.hour) / (upper.hour - lower.hour);
  return {
    hour,
    altitude: lower.altitude + (upper.altitude - lower.altitude) * ratio,
    azimuth: lower.azimuth + (upper.azimuth - lower.azimuth) * ratio,
  };
}

function updateSun(hour) {
  const sun = sunAt(hour);
  const totalMinutes = Math.round(hour * 60);
  const hourValue = Math.floor(totalMinutes / 60);
  const minuteValue = totalMinutes % 60;
  elements.clock.textContent = `${String(hourValue).padStart(2, "0")}:${String(minuteValue).padStart(2, "0")}`;
  elements.sunMeta.textContent = `8월 6일 · 태양 고도 ${sun.altitude.toFixed(1)}° · ${directionName(sun.azimuth)} ${sun.azimuth.toFixed(0)}°`;
  elements.compass.style.setProperty("--sun-azimuth", `${sun.azimuth}deg`);
  if (typeof map.setLight === "function") {
    try {
      map.setLight({
        anchor: "map",
        color: sun.altitude < 25 ? "#ffd6a0" : "#fff7e8",
        intensity: Math.max(0.25, Math.min(0.78, sun.altitude / 85)),
        position: [1.5, sun.azimuth, Math.max(10, 90 - sun.altitude)],
      });
    } catch {
      // Some base styles omit the legacy light block; geometry and shadows remain available.
    }
  }
}

function syncPlayButton() {
  elements.play.setAttribute("aria-pressed", String(playing));
  elements.play.innerHTML = `<i data-lucide="${playing ? "pause" : "play"}"></i><span>${playing ? "시간 정지" : "시간 재생"}</span>`;
  refreshIcons(elements.play);
}

function setShadowLayers(hour) {
  if (map.getLayer("shade-initial") && !map.getSource("shadow-frames")) {
    map.setPaintProperty("shade-initial", "fill-opacity", sceneTheme === "dark" ? 0.2 : 0.22);
    return;
  }
  const lower = [...frameHours].reverse().find((candidate) => candidate <= hour) ?? frameHours[0];
  const upper = frameHours.find((candidate) => candidate >= hour) ?? frameHours.at(-1);
  const ratio = lower === upper ? 0 : (hour - lower) / (upper - lower);
  const opacity = sceneTheme === "dark" ? 0.2 : 0.22;
  for (const frameHour of frameHours) {
    if (map.getLayer(`shade-${frameHour}`)) {
      const weight = frameHour === lower ? 1 - ratio : frameHour === upper ? ratio : 0;
      map.setPaintProperty(`shade-${frameHour}`, "fill-opacity", opacity * weight);
    }
  }
}

function transitionToHour(nextHour, { animate = true } = {}) {
  if (!frameHours.length || nextHour < frameHours[0] || nextHour > frameHours.at(-1)) return Promise.resolve();
  const token = ++transitionToken;
  const previousHour = currentHour;
  currentHour = nextHour;
  elements.range.value = String(nextHour);
  setShadowLayers(nextHour);
  if (!animate || REDUCED_MOTION.matches || previousHour === nextHour) {
    updateSun(nextHour);
    return Promise.resolve();
  }
  const started = performance.now();
  const duration = LOW_POWER ? 360 : 440;
  return new Promise((resolve) => {
    const step = (now) => {
      if (token !== transitionToken) {
        resolve();
        return;
      }
      const raw = Math.min(1, (now - started) / duration);
      const progress = 1 - (1 - raw) ** 3;
      updateSun(previousHour + (nextHour - previousHour) * progress);
      if (raw < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

async function playNext() {
  if (!playing || !frameHours.length) return;
  const next = currentHour >= frameHours.at(-1)
    ? frameHours[0]
    : Math.round((currentHour + 0.25) * 4) / 4;
  await transitionToHour(next);
  if (!playing) return;
  playTimer = window.setTimeout(playNext, LOW_POWER ? 240 : 170);
}

function togglePlay() {
  if (!frameHours.length) return;
  playing = !playing;
  window.clearTimeout(playTimer);
  syncPlayButton();
  if (playing) playNext();
}

function toggleOrbit() {
  orbiting = !orbiting;
  elements.orbit.setAttribute("aria-pressed", String(orbiting));
  cancelAnimationFrame(orbitFrame);
  if (!orbiting || REDUCED_MOTION.matches) return;
  let previous = performance.now();
  const rotate = (now) => {
    if (now - previous < FRAME_INTERVAL) {
      orbitFrame = requestAnimationFrame(rotate);
      return;
    }
    const delta = now - previous;
    previous = now;
    map.rotateTo(map.getBearing() + delta * 0.006, { duration: 0 });
    orbitFrame = requestAnimationFrame(rotate);
  };
  orbitFrame = requestAnimationFrame(rotate);
}

function addMarker(point, color) {
  const element = document.createElement("div");
  element.className = "route-marker-3d";
  element.style.setProperty("--marker-color", color);
  new window.maplibregl.Marker({ element }).setLngLat([point.lon, point.lat]).addTo(map);
}

function routeFeatures(route, progress = 1) {
  const segments = route.segments ?? [{ shaded: false, coords: route.coords ?? [] }];
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.coords.length - 1), 0);
  let budget = Math.max(1, Math.ceil(total * progress));
  const features = [];
  for (const segment of segments) {
    if (budget <= 0) break;
    const count = Math.min(segment.coords.length - 1, budget);
    budget -= count;
    const coordinates = segment.coords.slice(0, count + 1).map(([lat, lon]) => [lon, lat]);
    if (coordinates.length >= 2) {
      features.push({
        type: "Feature",
        properties: { shaded: Boolean(segment.shaded) },
        geometry: { type: "LineString", coordinates },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

function startRunner() {
  cancelAnimationFrame(runnerFrame);
  if (runnerCoordinates.length < 2 || REDUCED_MOTION.matches) return;
  const started = performance.now();
  const animate = (now) => {
    if (now - lastRunnerUpdate < FRAME_INTERVAL) {
      runnerFrame = requestAnimationFrame(animate);
      return;
    }
    lastRunnerUpdate = now;
    const progress = ((now - started) % 16000) / 16000;
    const index = Math.min(runnerCoordinates.length - 1, Math.floor(progress * runnerCoordinates.length));
    map.getSource("route-runner")?.setData({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: runnerCoordinates[index] } }],
    });
    runnerFrame = requestAnimationFrame(animate);
  };
  runnerFrame = requestAnimationFrame(animate);
}

function revealRoute(route) {
  if (REDUCED_MOTION.matches) {
    map.getSource("selected-route")?.setData(routeFeatures(route));
    startRunner();
    return;
  }
  const started = performance.now();
  let lastUpdate = 0;
  const reveal = (now) => {
    const raw = Math.min(1, (now - started) / 900);
    if (now - lastUpdate >= FRAME_INTERVAL || raw === 1) {
      lastUpdate = now;
      map.getSource("selected-route")?.setData(routeFeatures(route, 1 - (1 - raw) ** 3));
    }
    if (raw < 1) requestAnimationFrame(reveal);
    else startRunner();
  };
  requestAnimationFrame(reveal);
}

function buildingColorExpression(theme) {
  return theme === "dark"
    ? [
      "interpolate", ["linear"], ["coalesce", ["get", "height_eff"], 6],
      3, "#30383b", 18, "#29343a", 42, "#25404a", 90, "#1c5364",
    ]
    : [
      "interpolate", ["linear"], ["coalesce", ["get", "height_eff"], 6],
      3, "#f2f4f0", 18, "#dce4df", 42, "#b9cdd0", 90, "#7899a3",
    ];
}

function applySceneTheme(theme) {
  sceneTheme = theme;
  applyMapTheme(map, theme);
  if (map.getLayer("buildings-3d")) {
    map.setPaintProperty("buildings-3d", "fill-extrusion-color", buildingColorExpression(theme));
    map.setPaintProperty("buildings-3d", "fill-extrusion-opacity", theme === "dark" ? 0.9 : 0.98);
    map.setPaintProperty("buildings-3d", "fill-extrusion-vertical-gradient", theme === "dark");
  }
  if (map.getLayer("building-footprints")) {
    map.setPaintProperty("building-footprints", "line-color", theme === "dark" ? "#87a7b7" : "#61777c");
    map.setPaintProperty("building-footprints", "line-opacity", theme === "dark" ? 0.34 : 0.3);
  }
  for (const hour of frameHours) {
    if (map.getLayer(`shade-${hour}`)) {
      map.setPaintProperty(`shade-${hour}`, "fill-color", theme === "dark" ? "#178dcc" : "#193554");
    }
  }
  if (map.getLayer("shade-initial")) {
    map.setPaintProperty("shade-initial", "fill-color", theme === "dark" ? "#178dcc" : "#193554");
  }
  if (frameHours.length) setShadowLayers(currentHour);
}

async function drawRoute() {
  const route = await selectedRoutePromise;
  if (!route) return;
  runnerCoordinates = (route.segments ?? [{ coords: route.coords }]).flatMap((segment, index) =>
    segment.coords.slice(index === 0 ? 0 : 1).map(([lat, lon]) => [lon, lat]),
  );

  map.addSource("selected-route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("route-runner", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "route-glow",
    type: "line",
    source: "selected-route",
    paint: { "line-color": "#20a8ff", "line-width": 22, "line-opacity": 0.22, "line-blur": 8 },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  map.addLayer({
    id: "route-case",
    type: "line",
    source: "selected-route",
    paint: { "line-color": "#bfe7ff", "line-width": 10, "line-opacity": 0.82, "line-blur": 1 },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  map.addLayer({
    id: "route-main",
    type: "line",
    source: "selected-route",
    paint: {
      "line-color": ["case", ["boolean", ["get", "shaded"], false], "#51c4ff", "#ff954f"],
      "line-width": 6,
      "line-opacity": 0.98,
    },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  map.addLayer({
    id: "route-runner-layer",
    type: "circle",
    source: "route-runner",
    paint: {
      "circle-radius": 6,
      "circle-color": "#ffffff",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
      "circle-stroke-opacity": 0.45,
      "circle-blur": 0.08,
    },
  });
  revealRoute(route);
  addMarker(origin, "#16805d");
  addMarker(destination, "#f27d32");
  const bounds = runnerCoordinates.reduce(
    (box, coordinate) => box.extend(coordinate),
    new window.maplibregl.LngLatBounds(runnerCoordinates[0], runnerCoordinates[0]),
  );
  map.fitBounds(bounds, {
    padding: window.innerWidth <= 700
      ? { top: 310, right: 36, bottom: 170, left: 36 }
      : { top: 76, right: 240, bottom: 76, left: 390 },
    pitch: 66,
    bearing: -22,
    duration: REDUCED_MOTION.matches ? 0 : 1200,
  });
  elements.evidence.hidden = false;
  elements.evidence.innerHTML = `<strong>선택 경로</strong>${route.time_min ?? route.minutes}분 · ${Math.round(route.dist_m ?? route.distance_m)}m · 그늘 ${route.shade_pct}%`;
}

function installBuildings(buildings, before) {
  map.addSource("buildings", { type: "geojson", data: buildings });
  map.addLayer({
    id: "buildings-3d",
    type: "fill-extrusion",
    source: "buildings",
    paint: {
      "fill-extrusion-height": ["coalesce", ["get", "height_eff"], 6],
      "fill-extrusion-color": buildingColorExpression(sceneTheme),
      "fill-extrusion-opacity": sceneTheme === "dark" ? 0.9 : 0.98,
      "fill-extrusion-vertical-gradient": sceneTheme === "dark",
    },
  }, before);
  map.addLayer({
    id: "building-footprints",
    type: "line",
    source: "buildings",
    minzoom: 14,
    paint: {
      "line-color": "#87a7b7",
      "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.35, 17, 1.05],
      "line-opacity": 0.34,
    },
  }, before);
  applySceneTheme(sceneTheme);
}

function installInitialShadow(frames) {
  frameHours = [initialFrameHour];
  map.addSource("shadow-initial", { type: "geojson", data: frames });
  map.addLayer({
    id: "shade-initial",
    type: "fill",
    source: "shadow-initial",
    paint: {
      "fill-color": sceneTheme === "dark" ? "#178dcc" : "#193554",
      "fill-opacity": sceneTheme === "dark" ? 0.2 : 0.22,
      "fill-antialias": true,
    },
  }, "buildings-3d");
}

function installAllShadowFrames(frames) {
  frameHours = [...new Set(frames.features.map((feature) => feature.properties.hour))].sort((a, b) => a - b);
  map.addSource("shadow-frames", { type: "geojson", data: frames });
  for (const hour of frameHours) {
    map.addLayer({
      id: `shade-${hour}`,
      type: "fill",
      source: "shadow-frames",
      filter: ["==", ["get", "hour"], hour],
      paint: {
        "fill-color": sceneTheme === "dark" ? "#178dcc" : "#193554",
        "fill-opacity": 0,
        "fill-antialias": true,
        "fill-opacity-transition": { duration: LOW_POWER ? 360 : 480, delay: 0 },
      },
    }, "buildings-3d");
  }
  if (map.getLayer("shade-initial")) map.removeLayer("shade-initial");
  if (map.getSource("shadow-initial")) map.removeSource("shadow-initial");
  currentHour = Math.max(frameHours[0], Math.min(frameHours.at(-1), initialHour));
  transitionToHour(currentHour, { animate: false });
  elements.range.disabled = false;
  elements.play.disabled = false;
}

function bindBuildingInspection() {
  map.on("mousemove", "buildings-3d", (event) => {
    map.getCanvas().style.cursor = "pointer";
    const feature = event.features?.[0];
    if (!feature) return;
    const height = Number(feature.properties.height_eff);
    const floors = Number(feature.properties.floors);
    elements.hover.textContent = `높이 ${height.toFixed(1)}m${floors > 0 ? ` · 지상 ${Math.round(floors)}층` : ""}`;
  });
  map.on("mouseleave", "buildings-3d", () => {
    map.getCanvas().style.cursor = "";
    elements.hover.textContent = "건물을 가리키면 높이와 층수를 표시합니다.";
  });
}

function scheduleShadowAnimation(buildingCount) {
  const load = async () => {
    try {
      const frames = await fetchAllShadowFrames();
      installAllShadowFrames(frames);
      elements.status.textContent = `${USE_MOCK ? "데모 · " : ""}건물 ${buildingCount.toLocaleString("ko-KR")}동 · 그림자 ${frameHours.length}개 시각`;
    } catch (error) {
      console.warn("시간별 그림자 애니메이션을 준비하지 못했습니다.", error);
      elements.status.textContent = `건물 ${buildingCount.toLocaleString("ko-KR")}동 · 현재 시각 그림자`;
    }
  };
  if ("requestIdleCallback" in window) window.requestIdleCallback(load, { timeout: 500 });
  else window.setTimeout(load, 80);
}

map.on("load", async () => {
  try {
    updateSun(initialHour);
    const before = firstSymbolLayer();
    elements.status.textContent = "건물과 경로를 먼저 준비하는 중";
    const buildings = await buildingsPromise;
    installBuildings(buildings, before);
    bindBuildingInspection();
    elements.status.textContent = `건물 ${buildings.features.length.toLocaleString("ko-KR")}동 · 경로 표시 중`;

    const sunTask = sunPositionsPromise.then((positions) => {
      sunPositions = positions;
      updateSun(initialHour);
    });
    const initialShadowTask = initialShadowPromise
      .then(installInitialShadow)
      .catch((error) => console.warn("현재 시각 그림자를 표시하지 못했습니다.", error));
    await Promise.all([drawRoute(), sunTask, initialShadowTask]);
    elements.status.textContent = `건물 ${buildings.features.length.toLocaleString("ko-KR")}동 · 시간 애니메이션 준비 중`;
    scheduleShadowAnimation(buildings.features.length);
  } catch (error) {
    showError(error.message);
  }
});

elements.range.addEventListener("input", () => {
  if (playing) togglePlay();
  transitionToHour(Number(elements.range.value));
});
elements.play.addEventListener("click", togglePlay);
elements.orbit.addEventListener("click", toggleOrbit);
document.querySelector("#returnToRoute").addEventListener("click", (event) => {
  if (!window.opener || window.opener.closed) return;
  event.preventDefault();
  window.opener.focus();
  window.close();
});
map.on("dragstart", () => {
  if (orbiting) toggleOrbit();
});
syncPlayButton();
initTheme({ button: elements.theme, fallback: "dark", onChange: applySceneTheme });

const scenePanel = document.querySelector(".scene-panel");
const updatePanelBottom = () => {
  document.documentElement.style.setProperty(
    "--scene-panel-bottom",
    `${Math.ceil(scenePanel.getBoundingClientRect().bottom)}px`,
  );
  map.resize();
};
new ResizeObserver(updatePanelBottom).observe(scenePanel);
window.addEventListener("resize", updatePanelBottom);
updatePanelBottom();
