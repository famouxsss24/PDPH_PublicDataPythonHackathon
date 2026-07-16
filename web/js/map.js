import { fetchBuildings, reversePlace } from "./api.js";
import { refreshIcons } from "./icons.js";
import { applyMapTheme, BASE_MAP_STYLE } from "./map-style.js";
import { actions, getState, subscribe } from "./state.js";

const NOWON_BOUNDS = {
  south: 37.59,
  north: 37.71,
  west: 127.015,
  east: 127.13,
};
const TURN_MARKER_ICONS = {
  "좌회전": "corner-up-left",
  "우회전": "corner-up-right",
  "유턴": "undo-2",
};
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
const LOW_POWER = window.matchMedia("(max-width: 700px)").matches
  || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4)
  || (navigator.deviceMemory && navigator.deviceMemory <= 4);

let map;
let ready = false;
let onMapPick = () => {};
let onError = () => {};
let pickMode = null;
let lastState = null;
let lastRouteKey = "";
let activeShadow = "shadow-a";
let shadowToken = 0;
let routeAnimation = 0;
let calculationAnimation = 0;
let pulseAnimation = 0;
let currentNavigationPoint = null;
let currentNavigationBearing = null;
let navigationMarker = null;
let navigationMarkerElement = null;
let navigationTurnMarker = null;
let navigationTurnElement = null;
let navigationTurnKey = "";
let navigationPlaceMarkers = [];
let navigationActive = false;
let followSuspendedUntil = 0;
let followResumeTimer = null;
let navigationCameraFrame = 0;
let navigationCameraTarget = null;
let navigationCameraState = null;
let navigationCameraUpdatedAt = 0;
let mapTheme = "light";
let buildingRefreshTimer = null;
let lastBuildingView = null;
let popup = null;

function pointInsideNowon(point) {
  return (
    point.lat >= NOWON_BOUNDS.south &&
    point.lat <= NOWON_BOUNDS.north &&
    point.lon >= NOWON_BOUNDS.west &&
    point.lon <= NOWON_BOUNDS.east
  );
}

function emptyCollection() {
  return { type: "FeatureCollection", features: [] };
}

function source(id) {
  return ready ? map.getSource(id) : null;
}

function setSourceData(id, data) {
  source(id)?.setData(data);
}

function endpointCollection(state) {
  const features = [];
  for (const [kind, point] of [
    ["origin", state.origin],
    ["destination", state.destination],
  ]) {
    if (!point) continue;
    features.push({
      type: "Feature",
      properties: { kind, label: point.label ?? "" },
      geometry: { type: "Point", coordinates: [point.lon, point.lat] },
    });
  }
  return { type: "FeatureCollection", features };
}

function routeCoordinates(route) {
  return (route?.segments ?? []).flatMap((segment, index) =>
    segment.coords.slice(index === 0 ? 0 : 1).map(([lat, lon]) => [lon, lat]),
  );
}

function routeFeatures(route, progress = 1) {
  if (!route) return [];
  const segments = route.segments ?? [];
  const totalEdges = segments.reduce((sum, segment) => sum + Math.max(0, segment.coords.length - 1), 0);
  let remaining = Math.max(1, Math.ceil(totalEdges * progress));
  const features = [];
  for (const segment of segments) {
    if (remaining <= 0) break;
    const edgeCount = Math.min(Math.max(0, segment.coords.length - 1), remaining);
    const coords = segment.coords.slice(0, edgeCount + 1);
    remaining -= edgeCount;
    if (coords.length < 2) continue;
    features.push({
      type: "Feature",
      properties: { shaded: Boolean(segment.shaded), routeId: route.id },
      geometry: {
        type: "LineString",
        coordinates: coords.map(([lat, lon]) => [lon, lat]),
      },
    });
  }
  return features;
}

function alternativeFeatures(routes, progress = 1) {
  return routes.flatMap((route) => {
    const coords = routeCoordinates(route);
    const length = Math.max(2, Math.ceil(coords.length * progress));
    const partial = coords.slice(0, length);
    if (partial.length < 2) return [];
    return [{
      type: "Feature",
      properties: { routeId: route.id },
      geometry: { type: "LineString", coordinates: partial },
    }];
  });
}

function selectedRoute(state) {
  return state.routeData?.options.find((route) => route.id === state.selectedRouteId) ?? null;
}

function coolingStopCollection(state) {
  const stops = selectedRoute(state)?.heat?.stops ?? [];
  return {
    type: "FeatureCollection",
    features: stops.map((stop) => ({
      type: "Feature",
      properties: {
        spot_id: stop.spot_id,
        name: stop.name,
        address: stop.address,
        facility_type: stop.facility_type,
        distance_from_route_m: stop.distance_from_route_m,
        availability: stop.availability,
        source: stop.source,
        source_url: stop.source_url,
      },
      geometry: { type: "Point", coordinates: [stop.lon, stop.lat] },
    })),
  };
}

function renderEndpoints(state) {
  setSourceData("route-endpoints", endpointCollection(state));
}

function renderCoolingStops(state) {
  setSourceData("cooling-stops", coolingStopCollection(state));
}

function renderRouteAtProgress(state, progress) {
  const options = state.routeData?.options ?? [];
  const selected = selectedRoute(state);
  const alternatives = options.filter((route) => route.id !== state.selectedRouteId);
  setSourceData("route-alternatives", {
    type: "FeatureCollection",
    features: alternativeFeatures(alternatives, progress),
  });
  setSourceData("route-selected", {
    type: "FeatureCollection",
    features: routeFeatures(selected, progress),
  });
}

function startRoutePulse(route) {
  cancelAnimationFrame(pulseAnimation);
  const coords = routeCoordinates(route);
  if (coords.length < 2 || REDUCED_MOTION.matches) {
    setSourceData("route-pulse", emptyCollection());
    return;
  }
  const started = performance.now();
  const duration = 9000;
  const animate = (now) => {
    if (getState().phase === "navigate") return;
    const progress = ((now - started) % duration) / duration;
    const position = coords[Math.min(coords.length - 1, Math.floor(progress * coords.length))];
    setSourceData("route-pulse", {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: position } }],
    });
    pulseAnimation = requestAnimationFrame(animate);
  };
  pulseAnimation = requestAnimationFrame(animate);
}

function animateRoutes(state) {
  cancelAnimationFrame(routeAnimation);
  stopRouteCalculation();
  if (REDUCED_MOTION.matches) {
    renderRouteAtProgress(state, 1);
    startRoutePulse(selectedRoute(state));
    return;
  }
  const started = performance.now();
  const duration = 760;
  const draw = (now) => {
    const raw = Math.min(1, (now - started) / duration);
    const progress = 1 - (1 - raw) ** 3;
    renderRouteAtProgress(state, progress);
    if (raw < 1) {
      routeAnimation = requestAnimationFrame(draw);
    } else {
      startRoutePulse(selectedRoute(state));
    }
  };
  routeAnimation = requestAnimationFrame(draw);
}

function renderRoutes(state, actionName) {
  const options = state.routeData?.options ?? [];
  const key = `${options.map((route) => route.id).join("|")}:${state.selectedRouteId}`;
  if (key === lastRouteKey && actionName !== "setRoutes") return;
  lastRouteKey = key;
  if (!options.length) {
    setSourceData("route-alternatives", emptyCollection());
    setSourceData("route-selected", emptyCollection());
    setSourceData("route-pulse", emptyCollection());
    return;
  }
  if (actionName === "setRoutes") animateRoutes(state);
  else {
    renderRouteAtProgress(state, 1);
    startRoutePulse(selectedRoute(state));
  }
}

function renderShade(state) {
  const token = ++shadowToken;
  if (!state.shadeData) {
    for (const id of ["shadow-a", "shadow-b"]) {
      if (map.getLayer(id)) map.setPaintProperty(id, "fill-opacity", 0);
    }
    return;
  }

  const next = activeShadow === "shadow-a" ? "shadow-b" : "shadow-a";
  setSourceData(next, state.shadeData);
  map.setPaintProperty(next, "fill-opacity", 0);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (token !== shadowToken) return;
      map.setPaintProperty(next, "fill-opacity", 0.2);
      map.setPaintProperty(activeShadow, "fill-opacity", 0);
      const previous = activeShadow;
      activeShadow = next;
      window.setTimeout(() => {
        if (token === shadowToken) setSourceData(previous, emptyCollection());
      }, 720);
    });
  });
}

function panelPadding() {
  if (window.innerWidth > 700 && getState().phase !== "navigate") {
    return { top: 36, right: 86, bottom: 48, left: 448 };
  }
  if (getState().phase === "navigate") {
    return { top: 190, right: 30, bottom: 158, left: 30 };
  }
  const panel = document.querySelector("#journeyPanel");
  return {
    top: Math.min(window.innerHeight * 0.52, (panel?.getBoundingClientRect().bottom ?? 300) + 18),
    right: 66,
    bottom: 48,
    left: 30,
  };
}

function fitRoutes(options, animated = true) {
  const coords = options.flatMap(routeCoordinates);
  if (!coords.length) return;
  const bounds = coords.reduce(
    (box, coordinate) => box.extend(coordinate),
    new window.maplibregl.LngLatBounds(coords[0], coords[0]),
  );
  map.fitBounds(bounds, {
    padding: panelPadding(),
    maxZoom: 17.2,
    pitch: window.innerWidth > 700 ? 32 : 18,
    bearing: -8,
    duration: animated && !REDUCED_MOTION.matches ? 820 : 0,
  });
}

function focusEndpoint(point) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return;
  const center = window.innerWidth <= 700
    ? [point.lon, Math.min(NOWON_BOUNDS.north, point.lat + 0.0024)]
    : [Math.max(NOWON_BOUNDS.west, point.lon - 0.0018), point.lat];
  map.easeTo({
    center,
    zoom: Math.max(map.getZoom(), 16.4),
    pitch: window.innerWidth > 700 ? 28 : 18,
    bearing: 0,
    duration: REDUCED_MOTION.matches ? 0 : 680,
  });
}

function sceneForAction(state, actionName) {
  if (actionName === "setOrigin") {
    focusEndpoint(state.origin);
  } else if (actionName === "setDestination") {
    focusEndpoint(state.destination);
  } else if (actionName === "setRoutes") {
    fitRoutes(state.routeData.options);
  } else if (actionName === "backToCompare") {
    fitRoutes(state.routeData?.options ?? []);
  } else if (["resetAll", "resetRoute"].includes(actionName)) {
    map.easeTo({ pitch: 0, bearing: 0, zoom: 14.3, center: [127.0655, 37.6425], duration: 650 });
  }
}

function render(state, actionName) {
  lastState = state;
  if (!ready) return;
  renderCoolingStops(state);
  if (["setDestination", "setOrigin", "swapEndpoints", "clearEndpoint", "resetAll"].includes(actionName)) {
    renderEndpoints(state);
  }
  if (["setRoutes", "selectRoute", "resetAll", "resetRoute", "clearEndpoint", "setDepartAt"].includes(actionName)) {
    renderRoutes(state, actionName);
  }
  if (["setShadeData", "setDepartAt", "resetAll", "resetRoute"].includes(actionName)) {
    renderShade(state);
  }
  sceneForAction(state, actionName);
}

function addGeoJsonSource(id) {
  map.addSource(id, { type: "geojson", data: emptyCollection() });
}

function firstSymbolLayer() {
  return map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
}

function addCoreLayers() {
  const beforeLabels = firstSymbolLayer();
  for (const id of [
    "shadow-a",
    "shadow-b",
    "route-alternatives",
    "route-selected",
    "route-pulse",
    "cooling-stops",
    "route-endpoints",
    "navigation-point",
    "calculation-line",
    "calculation-probe",
    "current-location",
  ]) addGeoJsonSource(id);

  for (const id of ["shadow-a", "shadow-b"]) {
    map.addLayer({
      id,
      type: "fill",
      source: id,
      paint: {
        "fill-color": "#203d64",
        "fill-opacity": 0,
        "fill-antialias": true,
        "fill-opacity-transition": { duration: 560, delay: 0 },
      },
    }, beforeLabels);
  }

  map.addLayer({
    id: "route-alternatives-line",
    type: "line",
    source: "route-alternatives",
    paint: { "line-color": "#72807a", "line-width": 4, "line-opacity": 0.52 },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  map.addLayer({
    id: "route-selected-case",
    type: "line",
    source: "route-selected",
    paint: { "line-color": "#ffffff", "line-width": 11, "line-opacity": 0.96 },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  map.addLayer({
    id: "route-selected-main",
    type: "line",
    source: "route-selected",
    paint: {
      "line-color": ["case", ["boolean", ["get", "shaded"], false], "#253e70", "#f27d32"],
      "line-width": 7,
      "line-opacity": 1,
    },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  map.addLayer({
    id: "route-pulse-layer",
    type: "circle",
    source: "route-pulse",
    paint: {
      "circle-radius": 5,
      "circle-color": "#ffffff",
      "circle-stroke-color": "#253e70",
      "circle-stroke-width": 2,
      "circle-opacity": 0.9,
    },
  });
  map.addLayer({
    id: "cooling-stop-halo",
    type: "circle",
    source: "cooling-stops",
    paint: {
      "circle-radius": 13,
      "circle-color": "#ffffff",
      "circle-opacity": 0.94,
      "circle-stroke-color": "#167958",
      "circle-stroke-width": 1,
    },
  });
  map.addLayer({
    id: "cooling-stop-dot",
    type: "circle",
    source: "cooling-stops",
    paint: {
      "circle-radius": 9,
      "circle-color": "#167958",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5,
    },
  });
  map.addLayer({
    id: "cooling-stop-symbol",
    type: "symbol",
    source: "cooling-stops",
    layout: {
      "text-field": "+",
      "text-size": 17,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: { "text-color": "#ffffff" },
  });

  map.addLayer({
    id: "calculation-line-layer",
    type: "line",
    source: "calculation-line",
    paint: { "line-color": "#2f78c8", "line-width": 3, "line-opacity": 0.38, "line-dasharray": [1, 2] },
    layout: { "line-cap": "round" },
  });
  map.addLayer({
    id: "calculation-probe-layer",
    type: "circle",
    source: "calculation-probe",
    paint: {
      "circle-radius": 6,
      "circle-color": "#2f78c8",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 3,
    },
  });

  map.addLayer({
    id: "route-endpoint-halo",
    type: "circle",
    source: "route-endpoints",
    paint: { "circle-radius": 11, "circle-color": "#ffffff", "circle-opacity": 0.96 },
  });
  map.addLayer({
    id: "route-endpoint-dot",
    type: "circle",
    source: "route-endpoints",
    paint: {
      "circle-radius": 7,
      "circle-color": ["case", ["==", ["get", "kind"], "origin"], "#16805d", "#f27d32"],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: "navigation-point-layer",
    type: "circle",
    source: "navigation-point",
    paint: {
      "circle-radius": 15,
      "circle-color": "#2476db",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
      "circle-opacity": 0.2,
      "circle-stroke-opacity": 0.52,
      "circle-blur": 0.08,
    },
  });
  map.addLayer({
    id: "current-location-layer",
    type: "circle",
    source: "current-location",
    paint: {
      "circle-radius": 7,
      "circle-color": "#2476db",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 3,
    },
  });

  map.on("click", "route-alternatives-line", (event) => {
    const routeId = event.features?.[0]?.properties?.routeId;
    if (routeId) actions.selectRoute(routeId);
  });
  map.on("click", "cooling-stop-dot", (event) => {
    const feature = event.features?.[0];
    if (feature) showCoolingPopup(feature);
  });
  map.on("mouseenter", "route-alternatives-line", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "route-alternatives-line", () => { map.getCanvas().style.cursor = pickMode ? "crosshair" : ""; });
  map.on("mouseenter", "cooling-stop-dot", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "cooling-stop-dot", () => { map.getCanvas().style.cursor = pickMode ? "crosshair" : ""; });
}

function createNavigationMarker() {
  navigationMarkerElement = document.createElement("div");
  navigationMarkerElement.className = "navigation-marker";
  navigationMarkerElement.setAttribute("aria-hidden", "true");
  navigationMarkerElement.hidden = true;
  navigationMarkerElement.innerHTML = `
    <svg class="navigation-heading-cone" viewBox="0 0 64 72" aria-hidden="true">
      <path d="M32 65 L7 18 Q32 -2 57 18 Z"></path>
    </svg>
    <span class="navigation-dot"></span>`;
  navigationMarker = new window.maplibregl.Marker({
    element: navigationMarkerElement,
    anchor: "bottom",
    offset: [0, 6],
    rotationAlignment: "viewport",
    pitchAlignment: "viewport",
  });
}

function createNavigationTurnMarker() {
  navigationTurnElement = document.createElement("div");
  navigationTurnElement.className = "navigation-turn-marker";
  navigationTurnElement.setAttribute("aria-hidden", "true");
  navigationTurnElement.hidden = true;
  navigationTurnMarker = new window.maplibregl.Marker({
    element: navigationTurnElement,
    anchor: "center",
    rotationAlignment: "viewport",
    pitchAlignment: "viewport",
  });
}

function clearNavigationPlaces() {
  for (const marker of navigationPlaceMarkers) marker.remove();
  navigationPlaceMarkers = [];
}

function isMobileNavigation() {
  return window.innerWidth <= 700;
}

function navigationCamera() {
  const mobile = isMobileNavigation();
  const edge = mobile ? 132 : 174;
  return {
    zoom: mobile ? 17.05 : 17.35,
    pitch: mobile ? 55 : 62,
    padding: { top: edge, right: mobile ? 18 : 30, bottom: edge, left: mobile ? 18 : 30 },
  };
}

function shortestBearingDelta(from, to) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

function readNavigationCamera() {
  const center = map.getCenter();
  return {
    lon: center.lng,
    lat: center.lat,
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };
}

function stopNavigationCamera({ clearTarget = false } = {}) {
  cancelAnimationFrame(navigationCameraFrame);
  navigationCameraFrame = 0;
  navigationCameraUpdatedAt = 0;
  navigationCameraState = null;
  if (clearTarget) navigationCameraTarget = null;
}

function animateNavigationCamera(now) {
  if (!navigationActive || !navigationCameraTarget || Date.now() < followSuspendedUntil) {
    navigationCameraFrame = 0;
    return;
  }
  const elapsed = navigationCameraUpdatedAt ? Math.min(64, now - navigationCameraUpdatedAt) : 16;
  navigationCameraUpdatedAt = now;
  const state = navigationCameraState ?? readNavigationCamera();
  const target = navigationCameraTarget;
  const positionAlpha = 1 - Math.exp(-elapsed / (LOW_POWER ? 240 : 190));
  const rotationAlpha = 1 - Math.exp(-elapsed / (LOW_POWER ? 340 : 280));
  const next = {
    lon: state.lon + (target.lon - state.lon) * positionAlpha,
    lat: state.lat + (target.lat - state.lat) * positionAlpha,
    zoom: state.zoom + (target.zoom - state.zoom) * positionAlpha,
    pitch: state.pitch + (target.pitch - state.pitch) * positionAlpha,
    bearing: state.bearing + shortestBearingDelta(state.bearing, target.bearing) * rotationAlpha,
  };
  navigationCameraState = next;
  map.jumpTo({
    center: [next.lon, next.lat],
    zoom: next.zoom,
    pitch: next.pitch,
    bearing: next.bearing,
  });
  const settled =
    Math.abs(target.lon - next.lon) < 0.0000003
    && Math.abs(target.lat - next.lat) < 0.0000003
    && Math.abs(target.zoom - next.zoom) < 0.002
    && Math.abs(target.pitch - next.pitch) < 0.03
    && Math.abs(shortestBearingDelta(next.bearing, target.bearing)) < 0.06;
  if (settled) {
    navigationCameraState = { ...target };
    navigationCameraFrame = 0;
    return;
  }
  navigationCameraFrame = requestAnimationFrame(animateNavigationCamera);
}

function followNavigationCamera(point, bearing) {
  const camera = navigationCamera();
  navigationCameraTarget = {
    lon: point.lon,
    lat: point.lat,
    zoom: camera.zoom,
    pitch: camera.pitch,
    bearing: Number.isFinite(bearing) ? bearing : map.getBearing(),
  };
  if (REDUCED_MOTION.matches) {
    stopNavigationCamera();
    navigationCameraState = { ...navigationCameraTarget };
    map.jumpTo({
      center: [point.lon, point.lat],
      zoom: camera.zoom,
      pitch: camera.pitch,
      bearing: navigationCameraTarget.bearing,
    });
    return;
  }
  if (!navigationCameraState) navigationCameraState = readNavigationCamera();
  if (!navigationCameraFrame) navigationCameraFrame = requestAnimationFrame(animateNavigationCamera);
}

function beginManualNavigationView() {
  if (!navigationActive) return;
  stopNavigationCamera();
  window.clearTimeout(followResumeTimer);
  followSuspendedUntil = Number.POSITIVE_INFINITY;
  document.body.classList.add("nav-detached");
}

function scheduleNavigationResume() {
  if (!navigationActive || !document.body.classList.contains("nav-detached")) return;
  window.clearTimeout(followResumeTimer);
  followSuspendedUntil = Date.now() + 5000;
  followResumeTimer = window.setTimeout(() => recenterNavigation(), 5000);
}

function bindManualNavigationGesture(startEvent, endEvent) {
  let gestureActive = false;
  map.on(startEvent, (event) => {
    if (!navigationActive || !event.originalEvent) return;
    gestureActive = true;
    beginManualNavigationView();
  });
  map.on(endEvent, () => {
    if (!gestureActive) return;
    gestureActive = false;
    scheduleNavigationResume();
  });
}

async function addBuildings({ force = false } = {}) {
  try {
    const center = map.getCenter();
    const view = { lat: center.lat, lon: center.lng, zoom: map.getZoom() };
    if (!force && lastBuildingView) {
      const moved = Math.hypot(
        (view.lat - lastBuildingView.lat) * 111000,
        (view.lon - lastBuildingView.lon) * 87690,
      );
      if (moved < 420 && Math.abs(view.zoom - lastBuildingView.zoom) < 0.7) return;
    }
    lastBuildingView = view;
    const bounds = map.getBounds();
    const latPad = (bounds.getNorth() - bounds.getSouth()) * 0.18;
    const lonPad = (bounds.getEast() - bounds.getWest()) * 0.18;
    const bbox = [
      bounds.getWest() - lonPad,
      bounds.getSouth() - latPad,
      bounds.getEast() + lonPad,
      bounds.getNorth() + latPad,
    ];
    const buildings = await fetchBuildings({ bbox, lod: LOW_POWER ? "mobile" : "standard" });
    if (map.getSource("buildings")) {
      map.getSource("buildings").setData(buildings);
      return;
    }
    map.addSource("buildings", { type: "geojson", data: buildings, promoteId: "id" });
    map.addLayer({
      id: "buildings-3d",
      type: "fill-extrusion",
      source: "buildings",
      minzoom: 13.5,
      paint: {
        "fill-extrusion-height": [
          "interpolate", ["linear"], ["zoom"],
          13.5, 0,
          15, ["coalesce", ["get", "height_eff"], 6],
        ],
        "fill-extrusion-color": buildingColorExpression(mapTheme),
        "fill-extrusion-opacity": mapTheme === "dark" ? 0.72 : 0.9,
        "fill-extrusion-vertical-gradient": true,
      },
    }, firstSymbolLayer());
  } catch (error) {
    onError(`건물 높이 데이터를 불러오지 못했습니다: ${error.message}`);
  }
}

function scheduleBuildingRefresh() {
  window.clearTimeout(buildingRefreshTimer);
  buildingRefreshTimer = window.setTimeout(addBuildings, LOW_POWER ? 520 : 340);
}

function buildingColorExpression(theme) {
  return theme === "dark"
    ? [
      "interpolate", ["linear"], ["coalesce", ["get", "height_eff"], 6],
      3, "#30383b",
      18, "#293238",
      42, "#26343b",
      85, "#1d323d",
    ]
    : [
      "interpolate", ["linear"], ["coalesce", ["get", "height_eff"], 6],
      3, "#e4e8e4",
      18, "#cbd5ce",
      42, "#aabdc1",
      85, "#6e8791",
    ];
}

function applyBuildingTheme(theme) {
  if (!map?.getLayer("buildings-3d")) return;
  map.setPaintProperty("buildings-3d", "fill-extrusion-color", buildingColorExpression(theme));
  map.setPaintProperty("buildings-3d", "fill-extrusion-opacity", theme === "dark" ? 0.72 : 0.9);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderedPlaceName(event) {
  const features = map.queryRenderedFeatures(event.point);
  for (const feature of features) {
    const name = feature.properties?.["name:ko"] || feature.properties?.name;
    if (name) return name;
  }
  return null;
}

async function inspectMap(event) {
  const point = { lat: event.lngLat.lat, lon: event.lngLat.lng };
  const building = map.getLayer("buildings-3d")
    ? map.queryRenderedFeatures(event.point, { layers: ["buildings-3d"] })[0]
    : null;
  const renderedName = renderedPlaceName(event);
  const initial = {
    name: renderedName || (building ? "선택한 건물" : "지도에서 선택한 위치"),
    cat: building ? "건물" : "위치",
    ...point,
  };
  showPlacePopup(initial, building?.properties);
  try {
    const resolved = await reversePlace(point);
    if (popup?.isOpen()) showPlacePopup({ ...initial, ...resolved, ...point }, building?.properties);
  } catch {
    // The first popup remains usable when reverse lookup is unavailable.
  }
}

function keepPopupClearOfInterface() {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const element = popup?.getElement();
      if (!element || !popup?.isOpen()) return;

      const rect = element.getBoundingClientRect();
      const journeyPanel = document.querySelector("#journeyPanel")?.getBoundingClientRect();
      const mapTools = document.querySelector(".map-tools")?.getBoundingClientRect();
      const attribution = document.querySelector(".maplibregl-ctrl-bottom-right")?.getBoundingClientRect();
      const isMobile = window.innerWidth <= 700;
      const safeLeft = isMobile ? 12 : Math.max(12, (journeyPanel?.right ?? 0) + 12);
      const safeTop = isMobile ? Math.max(12, (journeyPanel?.bottom ?? 0) + 12) : 12;
      const safeRight = isMobile
        ? window.innerWidth - 12
        : Math.min(window.innerWidth - 12, (mapTools?.left ?? window.innerWidth) - 12);
      const safeBottom = Math.min(window.innerHeight - 12, (attribution?.top ?? window.innerHeight) - 12);
      let shiftX = 0;
      let shiftY = 0;

      if (rect.left < safeLeft) shiftX = safeLeft - rect.left;
      else if (rect.right > safeRight) shiftX = safeRight - rect.right;
      if (rect.top < safeTop) shiftY = safeTop - rect.top;
      else if (rect.bottom > safeBottom) shiftY = safeBottom - rect.bottom;

      if (Math.abs(shiftX) > 1 || Math.abs(shiftY) > 1) {
        const canvas = map.getCanvas();
        const nextCenter = map.unproject([
          canvas.clientWidth / 2 - shiftX,
          canvas.clientHeight / 2 - shiftY,
        ]);
        map.jumpTo({ center: nextCenter });
      }
    });
  });
}

function showPlacePopup(place, building = null) {
  popup?.remove();
  document.body.classList.add("place-popup-open");
  const node = document.createElement("section");
  node.className = "place-popup";
  const height = Number(building?.height_eff);
  const floors = Number(building?.floors);
  const address = String(place.road_address || place.address || "").trim();
  const showAddress = address && address.replace(/\s+/g, " ") !== String(place.name).trim().replace(/\s+/g, " ");
  const buildingMeta = Number.isFinite(height)
    ? `높이 ${height.toFixed(1)}m${floors > 0 ? ` · 지상 ${Math.round(floors)}층` : ""}`
    : "";
  const buildingAction = building
    ? '<button type="button" data-building-view><i data-lucide="boxes"></i><span>입체 보기</span></button>'
    : "";
  node.innerHTML = `
    <header>
      <span class="place-popup-title"><small>${escapeHtml(place.cat || "장소")}</small><strong>${escapeHtml(place.name)}</strong></span>
      <button class="icon-button" type="button" data-popup-close aria-label="장소 정보 닫기"><i data-lucide="x"></i></button>
    </header>
    ${showAddress ? `<p class="place-popup-address">${escapeHtml(address)}</p>` : ""}
    ${buildingMeta ? `<p class="place-popup-meta">${escapeHtml(buildingMeta)}</p>` : ""}
    <div class="place-popup-actions" data-count="${building ? 3 : 2}">
      <button type="button" data-endpoint="origin"><i data-lucide="circle-dot"></i><span>출발</span></button>
      <button type="button" data-endpoint="destination"><i data-lucide="map-pin"></i><span>도착</span></button>
      ${buildingAction}
    </div>`;
  refreshIcons(node);
  node.addEventListener("click", (event) => {
    const endpoint = event.target.closest("[data-endpoint]")?.dataset.endpoint;
    if (endpoint) {
      onMapPick({ ...place, label: place.name }, endpoint);
      popup?.remove();
      return;
    }
    if (event.target.closest("[data-building-view]")) {
      map.easeTo({ center: [place.lon, place.lat], zoom: Math.max(16.8, map.getZoom()), pitch: 64, bearing: -18, duration: 780 });
      popup?.remove();
    }
    if (event.target.closest("[data-popup-close]")) popup?.remove();
  });
  popup = new window.maplibregl.Popup({ closeButton: false, offset: 18, maxWidth: "330px" })
    .setLngLat([place.lon, place.lat])
    .setDOMContent(node)
    .addTo(map);
  popup.on("close", () => document.body.classList.remove("place-popup-open"));
  keepPopupClearOfInterface();
}

function showCoolingPopup(feature) {
  popup?.remove();
  const properties = feature.properties ?? {};
  const [lon, lat] = feature.geometry.coordinates;
  const distance = Math.max(0, Math.round(Number(properties.distance_from_route_m) || 0));
  const node = document.createElement("section");
  node.className = "place-popup cooling-popup";
  node.innerHTML = `
    <header>
      <span><small>공식 무더위쉼터 후보</small><strong>${escapeHtml(properties.name)}</strong></span>
      <button class="icon-button" type="button" data-popup-close aria-label="쉼터 정보 닫기"><i data-lucide="x"></i></button>
    </header>
    <p>${escapeHtml(properties.address || "주소 정보 없음")}</p>
    <dl class="cooling-popup-facts">
      <div><dt>시설</dt><dd>${escapeHtml(properties.facility_type || "미분류")}</dd></div>
      <div><dt>경로에서</dt><dd>약 ${distance}m</dd></div>
    </dl>
    <p class="cooling-popup-note">공공시설 후보만 표시합니다. 실제 개방·운영 여부는 방문 전에 확인하세요.</p>
    <a class="cooling-popup-source" data-cooling-source target="_blank" rel="noreferrer">
      <span>${escapeHtml(properties.source || "서울 열린데이터광장")}</span><i data-lucide="external-link"></i>
    </a>`;
  const sourceLink = node.querySelector("[data-cooling-source]");
  const sourceUrl = String(properties.source_url ?? "");
  if (/^https:\/\//i.test(sourceUrl)) sourceLink.href = sourceUrl;
  else sourceLink.hidden = true;
  node.addEventListener("click", (event) => {
    if (event.target.closest("[data-popup-close]")) popup?.remove();
  });
  refreshIcons(node);
  popup = new window.maplibregl.Popup({ closeButton: false, offset: 18, maxWidth: "310px" })
    .setLngLat([lon, lat])
    .setDOMContent(node)
    .addTo(map);
}

export function initMap(options = {}) {
  onMapPick = options.onMapPick ?? onMapPick;
  onError = options.onError ?? onError;
  map = new window.maplibregl.Map({
    container: "map",
    style: BASE_MAP_STYLE,
    center: [127.0655, 37.6425],
    zoom: 14.3,
    pitch: 0,
    bearing: 0,
    maxPitch: 72,
    maxBounds: [[126.985, 37.56], [127.17, 37.74]],
    canvasContextAttributes: { antialias: true },
  });
  map.addControl(new window.maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

  map.on("load", () => {
    ready = true;
    applyMapTheme(map, mapTheme);
    addCoreLayers();
    createNavigationMarker();
    createNavigationTurnMarker();
    addBuildings({ force: true });
    if (lastState) {
      renderEndpoints(lastState);
      renderRoutes(lastState, "load");
      renderCoolingStops(lastState);
      if (lastState.shadeData) renderShade(lastState);
    }
  });

  map.on("click", (event) => {
    const interactiveLayers = [
      "route-alternatives-line",
      "route-selected-main",
      "cooling-stop-dot",
      "cooling-stop-symbol",
    ].filter((id) => map.getLayer(id));
    if (
      interactiveLayers.length
      && map.queryRenderedFeatures(event.point, { layers: interactiveLayers }).length
    ) return;
    if (pickMode) {
      onMapPick({ lat: event.lngLat.lat, lon: event.lngLat.lng, label: "지도에서 선택한 위치" }, pickMode);
      setPickMode(null);
      return;
    }
    inspectMap(event);
  });
  map.on("error", (event) => {
    if (event.error?.message && !event.error.message.includes("Failed to fetch")) {
      console.warn("MapLibre", event.error);
    }
  });
  map.on("moveend", scheduleBuildingRefresh);
  bindManualNavigationGesture("dragstart", "dragend");
  bindManualNavigationGesture("rotatestart", "rotateend");
  bindManualNavigationGesture("pitchstart", "pitchend");
  bindManualNavigationGesture("zoomstart", "zoomend");
  map.on("rotate", () => {
    if (navigationMarker && Number.isFinite(currentNavigationBearing)) {
      navigationMarker.setRotation(currentNavigationBearing - map.getBearing());
    }
  });
  subscribe(render);
  return map;
}

export function setPickMode(mode) {
  pickMode = mode;
  if (map) map.getCanvas().style.cursor = mode ? "crosshair" : "";
}

export function setSheetPadding() {
  map?.resize();
}

export function setMapTheme(theme) {
  mapTheme = theme === "dark" ? "dark" : "light";
  if (!ready) return;
  applyMapTheme(map, mapTheme);
  applyBuildingTheme(mapTheme);
}

export function refitSelectedRoute() {
  const options = getState().routeData?.options ?? [];
  if (options.length) fitRoutes(options);
}

export function getCurrentLocation({ requireNowon = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("이 브라우저에서는 위치를 확인할 수 없습니다."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const point = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          label: "현재 위치",
        };
        if (requireNowon && !pointInsideNowon(point)) {
          reject(new Error("현재 위치가 노원구 밖입니다. 출발지를 검색하거나 지도에서 지정해주세요."));
          return;
        }
        showCurrentLocation(point, pointInsideNowon(point));
        resolve(point);
      },
      () => reject(new Error("현재 위치를 확인하지 못했습니다.")),
      { enableHighAccuracy: true, timeout: 7000, maximumAge: 30000 },
    );
  });
}

export function showCurrentLocation(point, pan = false) {
  if (!ready) return;
  setSourceData("current-location", {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [point.lon, point.lat] } }],
  });
  if (pan) map.flyTo({ center: [point.lon, point.lat], zoom: Math.max(map.getZoom(), 16), duration: 620 });
}

export function startRouteCalculation(origin, destination) {
  if (!ready || !origin || !destination) return;
  cancelAnimationFrame(calculationAnimation);
  const start = [origin.lon, origin.lat];
  const end = [destination.lon, destination.lat];
  setSourceData("calculation-line", {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [start, end] } }],
  });
  const bounds = new window.maplibregl.LngLatBounds(start, start).extend(end);
  map.fitBounds(bounds, { padding: panelPadding(), maxZoom: 16.5, duration: REDUCED_MOTION.matches ? 0 : 520 });
  const started = performance.now();
  const animate = (now) => {
    const progress = ((now - started) % 1100) / 1100;
    const position = [start[0] + (end[0] - start[0]) * progress, start[1] + (end[1] - start[1]) * progress];
    setSourceData("calculation-probe", {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: position } }],
    });
    calculationAnimation = requestAnimationFrame(animate);
  };
  if (!REDUCED_MOTION.matches) calculationAnimation = requestAnimationFrame(animate);
}

export function stopRouteCalculation() {
  cancelAnimationFrame(calculationAnimation);
  setSourceData("calculation-line", emptyCollection());
  setSourceData("calculation-probe", emptyCollection());
}

export function setNavigationMode(active) {
  if (!ready) return;
  navigationActive = active;
  window.clearTimeout(followResumeTimer);
  followSuspendedUntil = 0;
  document.body.classList.remove("nav-detached");
  if (!active) {
    stopNavigationCamera({ clearTarget: true });
    setSourceData("navigation-point", emptyCollection());
    currentNavigationPoint = null;
    currentNavigationBearing = null;
    navigationMarker?.remove();
    if (navigationMarkerElement) navigationMarkerElement.hidden = true;
    navigationTurnMarker?.remove();
    if (navigationTurnElement) navigationTurnElement.hidden = true;
    navigationTurnKey = "";
    clearNavigationPlaces();
  }
  const camera = navigationCamera();
  if (active) {
    map.jumpTo({ padding: camera.padding });
    navigationCameraState = readNavigationCamera();
  } else {
    map.easeTo({
      padding: panelPadding(),
      pitch: 32,
      bearing: -8,
      duration: REDUCED_MOTION.matches ? 0 : 620,
    });
  }
}

export function setNavigationPoint(point, bearing = null, follow = false) {
  if (!ready || !point) return;
  currentNavigationPoint = point;
  currentNavigationBearing = Number.isFinite(bearing) ? bearing : currentNavigationBearing;
  setSourceData("navigation-point", {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [point.lon, point.lat] } }],
  });
  if (navigationMarker && navigationMarkerElement) {
    navigationMarkerElement.hidden = false;
    const screenBearing = Number.isFinite(currentNavigationBearing)
      ? currentNavigationBearing - map.getBearing()
      : 0;
    navigationMarker
      .setLngLat([point.lon, point.lat])
      .setRotation(screenBearing)
      .addTo(map);
  }
  if (follow && Date.now() >= followSuspendedUntil) {
    followNavigationCamera(point, bearing);
  }
}

export function setNavigationTurn(maneuver = null) {
  if (!ready || !navigationTurnMarker || !navigationTurnElement) return;
  if (!maneuver?.point || !TURN_MARKER_ICONS[maneuver.turn]) {
    navigationTurnMarker.remove();
    navigationTurnElement.hidden = true;
    navigationTurnKey = "";
    return;
  }
  const key = `${maneuver.turn}:${maneuver.point.lat.toFixed(6)}:${maneuver.point.lon.toFixed(6)}`;
  if (key !== navigationTurnKey) {
    navigationTurnElement.innerHTML = `<i data-lucide="${TURN_MARKER_ICONS[maneuver.turn]}"></i>`;
    refreshIcons(navigationTurnElement);
    navigationTurnKey = key;
  }
  navigationTurnElement.hidden = false;
  navigationTurnElement.classList.toggle("is-near", Number(maneuver.distance) <= 35);
  navigationTurnMarker
    .setLngLat([maneuver.point.lon, maneuver.point.lat])
    .addTo(map);
}

export function setNavigationPlaces(places = []) {
  if (!ready) return;
  clearNavigationPlaces();
  const occupied = [];
  const mobile = isMobileNavigation();
  const minimumSpacing = mobile ? 64 : 90;
  const topInset = mobile ? 118 : 190;
  const bottomInset = mobile ? 136 : 150;
  const visiblePlaces = places.filter((place) => {
    const projected = map.project([place.lon, place.lat]);
    if (
      projected.x < 40
      || projected.x > map.getCanvas().clientWidth - 40
      || projected.y < topInset
      || projected.y > map.getCanvas().clientHeight - bottomInset
    ) return false;
    if (occupied.some((point) => Math.hypot(point.x - projected.x, point.y - projected.y) < minimumSpacing)) return false;
    occupied.push(projected);
    return true;
  });
  navigationPlaceMarkers = visiblePlaces.slice(0, mobile ? 4 : 7).map((place) => {
    const element = document.createElement("div");
    element.className = "nearby-place-label";
    element.innerHTML = `<strong>${escapeHtml(place.name)}</strong><small>${escapeHtml(place.cat || "건물")}</small>`;
    return new window.maplibregl.Marker({
      element,
      anchor: "bottom",
      offset: [0, -12],
      pitchAlignment: "viewport",
      rotationAlignment: "viewport",
    })
      .setLngLat([place.lon, place.lat])
      .addTo(map);
  });
}

export function recenterNavigation() {
  window.clearTimeout(followResumeTimer);
  followSuspendedUntil = 0;
  document.body.classList.remove("nav-detached");
  stopNavigationCamera();
  if (currentNavigationPoint) setNavigationPoint(currentNavigationPoint, currentNavigationBearing, true);
}
