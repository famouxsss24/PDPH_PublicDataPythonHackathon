import {
  recenterNavigation,
  setNavigationMode,
  setNavigationPlaces,
  setNavigationPoint,
  setNavigationTurn,
} from "./map.js";
import { fetchNearbyPlaces } from "./api.js";
import { getState, subscribe } from "./state.js";
import { refreshIcons } from "./icons.js";
import { resetNavigationGuidance, updateNavigationGuidance } from "./steps.js";

const MOBILE_UI = window.matchMedia("(max-width: 700px)");
const LOW_POWER = window.matchMedia("(max-width: 700px)").matches
  || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4)
  || (navigator.deviceMemory && navigator.deviceMemory <= 4);
const FRAME_INTERVAL = LOW_POWER ? 40 : 30;
const MAP_TURN_TYPES = new Set(["좌회전", "우회전", "유턴"]);
const elements = {};
let previewFrame = 0;
let previewStarted = 0;
let geolocationWatch = null;
let routeTrack = null;
let lastNearbyPoint = null;
let lastNearbyAt = 0;
let nearbyToken = 0;
let lastVisualUpdate = 0;
let uiIdleTimer = 0;
let navigationMode = "live";
let locationState = "waiting";
let lastLivePosition = null;

function scheduleNavigationUiIdle() {
  window.clearTimeout(uiIdleTimer);
  if (!MOBILE_UI.matches || getState().phase !== "navigate") return;
  uiIdleTimer = window.setTimeout(() => {
    if (getState().phase === "navigate" && !document.body.classList.contains("nav-detached")) {
      document.body.classList.add("nav-ui-idle");
    }
  }, 3200);
}

function wakeNavigationUi({ settle = true } = {}) {
  document.body.classList.remove("nav-ui-idle");
  window.clearTimeout(uiIdleTimer);
  if (settle) scheduleNavigationUiIdle();
}

function resetNavigationUi() {
  window.clearTimeout(uiIdleTimer);
  document.body.classList.remove("nav-ui-idle", "nav-detached");
}

function radians(value) {
  return (value * Math.PI) / 180;
}

function haversine(a, b) {
  const radius = 6371000;
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function bearing(a, b) {
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const dLon = radians(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function buildTrack(route) {
  const points = (route?.segments ?? []).flatMap((segment, index) =>
    segment.coords.slice(index === 0 ? 0 : 1).map(([lat, lon]) => ({ lat, lon })),
  );
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(cumulative.at(-1) + haversine(points[index - 1], points[index]));
  }
  const track = { points, cumulative, total: cumulative.at(-1) || 1, route, maneuvers: [] };
  const steps = route?.steps ?? [];
  const declaredDistance = steps.reduce((sum, step) => sum + Math.max(0, Number(step.dist_m) || 0), 0);
  const distanceScale = declaredDistance > 0 ? track.total / declaredDistance : 1;
  let traveled = 0;
  steps.forEach((step, index) => {
    if (index > 0) {
      const routeDistance = Math.min(track.total, traveled * distanceScale);
      const position = pointOnTrack(track, routeDistance);
      if (position) {
        track.maneuvers.push({
          key: `${index}:${step.turn}:${step.name}`,
          routeDistance,
          point: position.point,
          step,
        });
      }
    }
    traveled += Math.max(0, Number(step.dist_m) || 0);
  });
  return track;
}

function pointOnTrack(track, targetDistance) {
  if (!track?.points.length) return null;
  if (track.points.length === 1) return { point: track.points[0], bearing: 0 };
  const target = Math.max(0, Math.min(track.total, targetDistance));
  let index = track.cumulative.findIndex((distance) => distance >= target);
  if (index < 0) index = track.points.length - 1;
  if (index <= 0) index = 1;
  if (index >= track.points.length) index = track.points.length - 1;
  const previousDistance = track.cumulative[index - 1];
  const nextDistance = track.cumulative[index];
  const ratio = (target - previousDistance) / Math.max(1, nextDistance - previousDistance);
  const previous = track.points[index - 1];
  const next = track.points[index];
  return {
    point: {
      lat: previous.lat + (next.lat - previous.lat) * ratio,
      lon: previous.lon + (next.lon - previous.lon) * ratio,
    },
    bearing: bearing(previous, next),
  };
}

function pointAt(progress) {
  if (!routeTrack) return null;
  return pointOnTrack(routeTrack, routeTrack.total * Math.max(0, Math.min(1, progress)));
}

function formatDistance(meters) {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)}km`;
  return `${Math.max(0, Math.round(meters / 10) * 10)}m`;
}

function updateProgress(progress) {
  const route = routeTrack?.route;
  if (!route) return;
  const remainingDistance = Number(route.distance_m) * (1 - progress);
  const remainingMinutes = Math.max(0, Math.ceil(Number(route.minutes) * (1 - progress)));
  elements.progress.textContent = `남은 ${formatDistance(remainingDistance)} · ${remainingMinutes}분`;
  elements.bar.style.width = `${Math.round(progress * 1000) / 10}%`;
  updateManeuver(progress);
}

function updateManeuver(progress) {
  if (!routeTrack) return;
  const traveled = routeTrack.total * Math.max(0, Math.min(1, progress));
  const next = routeTrack.maneuvers.find((maneuver) => maneuver.routeDistance > traveled + 2);
  if (!next) {
    updateNavigationGuidance({
      key: "destination",
      step: { turn: "도착", name: elements.destination.textContent || "목적지" },
      distance: Math.max(0, routeTrack.total - traveled),
    });
    setNavigationTurn(null);
    return;
  }
  const distance = Math.max(0, next.routeDistance - traveled);
  updateNavigationGuidance({ key: next.key, step: next.step, distance });
  const shouldShowTurn = MAP_TURN_TYPES.has(next.step.turn) && distance <= 320;
  setNavigationTurn(shouldShowTurn ? {
    point: next.point,
    turn: next.step.turn,
    distance,
  } : null);
}

async function updateNearbyPlaces(point, { force = false } = {}) {
  const now = performance.now();
  const moved = lastNearbyPoint ? haversine(lastNearbyPoint, point) : Infinity;
  if (!force && moved < 60 && now - lastNearbyAt < 3500) return;
  const token = ++nearbyToken;
  lastNearbyPoint = point;
  lastNearbyAt = now;
  try {
    const places = await fetchNearbyPlaces(point, 240, LOW_POWER ? 4 : 7);
    if (token === nearbyToken && getState().phase === "navigate") setNavigationPlaces(places);
  } catch (error) {
    if (error.name !== "AbortError" && error.name !== "StaleRequestError") {
      console.warn("주변 건물 라벨을 갱신하지 못했습니다.", error);
    }
  }
}

function animatePreview(now) {
  if (!routeTrack || navigationMode !== "preview") return;
  if (now - lastVisualUpdate < FRAME_INTERVAL) {
    previewFrame = requestAnimationFrame(animatePreview);
    return;
  }
  lastVisualUpdate = now;
  const elapsed = now - previewStarted;
  const progress = Math.min(1, elapsed / 52000);
  const position = pointAt(progress);
  if (!position) return;
  setNavigationPoint(position.point, position.bearing, true);
  updateNearbyPlaces(position.point);
  updateProgress(progress);
  if (progress < 1) {
    previewFrame = requestAnimationFrame(animatePreview);
  } else {
    elements.mode.textContent = "목적지 도착";
    syncPreviewButton();
  }
}

function syncPreviewButton() {
  const previewing = navigationMode === "preview";
  elements.preview.setAttribute("aria-pressed", String(previewing));
  elements.preview.classList.toggle("is-active", previewing);
  elements.preview.innerHTML = previewing
    ? '<i data-lucide="locate-fixed"></i><span>실시간 안내</span>'
    : '<i data-lucide="play"></i><span>경로 미리보기</span>';
  refreshIcons(elements.preview);
}

function liveModeLabel() {
  if (locationState === "waiting") return "현재 위치 확인 중";
  if (locationState === "off-route") return "경로 근처에서 안내 시작";
  if (locationState === "unavailable") return "위치 권한 확인 필요";
  return "실시간 위치 안내";
}

function syncNavigationMode() {
  document.body.dataset.navigationMode = navigationMode;
  elements.mode.textContent = navigationMode === "live" ? liveModeLabel() : "경로 미리보기";
  syncPreviewButton();
}

function startPreview() {
  if (!routeTrack) return;
  cancelAnimationFrame(previewFrame);
  navigationMode = "preview";
  previewStarted = performance.now();
  lastVisualUpdate = 0;
  syncNavigationMode();
  previewFrame = requestAnimationFrame(animatePreview);
}

function returnToLive() {
  cancelAnimationFrame(previewFrame);
  previewFrame = 0;
  navigationMode = "live";
  syncNavigationMode();
  if (lastLivePosition) {
    setNavigationPoint(lastLivePosition.point, lastLivePosition.bearing, true);
    updateNearbyPlaces(lastLivePosition.point, { force: true });
    updateProgress(lastLivePosition.progress);
  } else {
    const first = pointAt(0);
    if (first) {
      setNavigationPoint(first.point, first.bearing, true);
      updateNearbyPlaces(first.point, { force: true });
    }
    updateProgress(0);
  }
}

function togglePreview() {
  if (navigationMode === "preview") returnToLive();
  else startPreview();
}

function closestProgress(point) {
  if (!routeTrack?.points.length) return { progress: 0, distance: Infinity };
  let bestIndex = 0;
  let bestDistance = Infinity;
  routeTrack.points.forEach((candidate, index) => {
    const distance = haversine(point, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return { progress: routeTrack.cumulative[bestIndex] / routeTrack.total, distance: bestDistance };
}

function beginGeolocation() {
  if (!navigator.geolocation || !window.isSecureContext) {
    locationState = "unavailable";
    syncNavigationMode();
    return;
  }
  geolocationWatch = navigator.geolocation.watchPosition(
    (position) => {
      const point = { lat: position.coords.latitude, lon: position.coords.longitude };
      const closest = closestProgress(point);
      if (closest.distance > 300) {
        locationState = "off-route";
        if (navigationMode === "live") syncNavigationMode();
        return;
      }
      const previousPoint = lastLivePosition?.point;
      const moved = previousPoint ? haversine(previousPoint, point) : 0;
      const heading = Number.isFinite(position.coords.heading)
        ? position.coords.heading
        : moved > 3 ? bearing(previousPoint, point) : lastLivePosition?.bearing;
      lastLivePosition = { point, bearing: heading, progress: closest.progress };
      locationState = "active";
      if (navigationMode !== "live") return;
      syncNavigationMode();
      setNavigationPoint(point, heading, true);
      updateNearbyPlaces(point);
      updateProgress(closest.progress);
    },
    () => {
      locationState = "unavailable";
      if (navigationMode === "live") syncNavigationMode();
    },
    { enableHighAccuracy: true, timeout: 9000, maximumAge: 3000 },
  );
}

function stopNavigation() {
  cancelAnimationFrame(previewFrame);
  previewFrame = 0;
  routeTrack = null;
  navigationMode = "live";
  locationState = "waiting";
  lastLivePosition = null;
  lastNearbyPoint = null;
  lastNearbyAt = 0;
  nearbyToken += 1;
  setNavigationPlaces([]);
  setNavigationTurn(null);
  resetNavigationGuidance();
  if (geolocationWatch !== null) navigator.geolocation.clearWatch(geolocationWatch);
  geolocationWatch = null;
  delete document.body.dataset.navigationMode;
  resetNavigationUi();
  setNavigationMode(false);
}

function beginNavigation(state) {
  const route = state.routeData?.options.find((item) => item.id === state.selectedRouteId);
  if (!route) return;
  routeTrack = buildTrack(route);
  navigationMode = "live";
  locationState = "waiting";
  lastLivePosition = null;
  lastVisualUpdate = 0;
  elements.destination.textContent = state.destination?.label ?? "목적지";
  resetNavigationUi();
  setNavigationMode(true);
  const first = pointAt(0);
  if (first) {
    setNavigationPoint(first.point, first.bearing, true);
    updateNearbyPlaces(first.point, { force: true });
  }
  updateProgress(0);
  syncNavigationMode();
  beginGeolocation();
  scheduleNavigationUiIdle();
}

export function initNavigation() {
  elements.mode = document.querySelector("#navigationMode");
  elements.destination = document.querySelector("#navigationDestination");
  elements.progress = document.querySelector("#navigationProgress");
  elements.bar = document.querySelector("#navigationProgressBar");
  elements.preview = document.querySelector("#previewToggle");
  elements.recenter = document.querySelector("#recenterNavigation");

  elements.preview.addEventListener("click", togglePreview);
  elements.recenter.addEventListener("click", () => {
    recenterNavigation();
    wakeNavigationUi();
  });
  for (const target of [document.querySelector("#map"), document.querySelector("#navigationView")]) {
    target?.addEventListener("pointerdown", () => wakeNavigationUi({ settle: false }), { passive: true });
    target?.addEventListener("pointerup", scheduleNavigationUiIdle, { passive: true });
    target?.addEventListener("pointercancel", scheduleNavigationUiIdle, { passive: true });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && getState().phase === "navigate" && navigationMode === "preview") returnToLive();
  });

  subscribe((state, actionName) => {
    if (actionName === "startNavigation") beginNavigation(state);
    if (["backToCompare", "resetAll", "clearEndpoint"].includes(actionName)) stopNavigation();
  });
}
