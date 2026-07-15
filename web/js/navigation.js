import {
  recenterNavigation,
  setNavigationMode,
  setNavigationPlaces,
  setNavigationPoint,
} from "./map.js";
import { fetchNearbyPlaces } from "./api.js";
import { getState, subscribe } from "./state.js";
import { refreshIcons } from "./icons.js";

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
const MOBILE_UI = window.matchMedia("(max-width: 700px)");
const LOW_POWER = window.matchMedia("(max-width: 700px)").matches
  || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4)
  || (navigator.deviceMemory && navigator.deviceMemory <= 4);
const FRAME_INTERVAL = LOW_POWER ? 40 : 30;
const elements = {};
let previewFrame = 0;
let previewStarted = 0;
let previewOffset = 0;
let previewPaused = false;
let geolocationWatch = null;
let routeTrack = null;
let lastNearbyPoint = null;
let lastNearbyAt = 0;
let nearbyToken = 0;
let lastVisualUpdate = 0;
let uiIdleTimer = 0;

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
  return { points, cumulative, total: cumulative.at(-1) || 1, route };
}

function pointAt(progress) {
  if (!routeTrack?.points.length) return null;
  const target = routeTrack.total * Math.max(0, Math.min(1, progress));
  let index = routeTrack.cumulative.findIndex((distance) => distance >= target);
  if (index <= 0) index = 1;
  if (index >= routeTrack.points.length) index = routeTrack.points.length - 1;
  const previousDistance = routeTrack.cumulative[index - 1];
  const nextDistance = routeTrack.cumulative[index];
  const ratio = (target - previousDistance) / Math.max(1, nextDistance - previousDistance);
  const previous = routeTrack.points[index - 1];
  const next = routeTrack.points[index];
  return {
    point: {
      lat: previous.lat + (next.lat - previous.lat) * ratio,
      lon: previous.lon + (next.lon - previous.lon) * ratio,
    },
    bearing: bearing(previous, next),
  };
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
  if (!routeTrack || previewPaused) return;
  if (now - lastVisualUpdate < FRAME_INTERVAL) {
    previewFrame = requestAnimationFrame(animatePreview);
    return;
  }
  lastVisualUpdate = now;
  const elapsed = previewOffset + (now - previewStarted);
  const progress = Math.min(1, elapsed / 52000);
  const position = pointAt(progress);
  if (!position) return;
  setNavigationPoint(position.point, position.bearing, true);
  updateNearbyPlaces(position.point);
  updateProgress(progress);
  if (progress < 1) {
    previewFrame = requestAnimationFrame(animatePreview);
  } else {
    previewPaused = true;
    elements.mode.textContent = "목적지 도착";
    syncPreviewButton();
  }
}

function syncPreviewButton() {
  elements.preview.innerHTML = `<i data-lucide="${previewPaused ? "play" : "pause"}"></i><span>${previewPaused ? "미리보기 재생" : "미리보기 정지"}</span>`;
  refreshIcons(elements.preview);
}

function startPreview({ reset = false } = {}) {
  if (!routeTrack) return;
  cancelAnimationFrame(previewFrame);
  if (reset) previewOffset = 0;
  previewPaused = false;
  previewStarted = performance.now();
  elements.mode.textContent = "경로 미리보기";
  elements.preview.hidden = false;
  syncPreviewButton();
  previewFrame = requestAnimationFrame(animatePreview);
}

function pausePreview() {
  if (previewPaused) {
    previewStarted = performance.now();
    previewPaused = false;
    syncPreviewButton();
    previewFrame = requestAnimationFrame(animatePreview);
    return;
  }
  previewOffset += performance.now() - previewStarted;
  previewPaused = true;
  cancelAnimationFrame(previewFrame);
  syncPreviewButton();
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
  if (!navigator.geolocation || !window.isSecureContext) return;
  geolocationWatch = navigator.geolocation.watchPosition(
    (position) => {
      const point = { lat: position.coords.latitude, lon: position.coords.longitude };
      const closest = closestProgress(point);
      if (closest.distance > 300) return;
      cancelAnimationFrame(previewFrame);
      previewPaused = true;
      elements.mode.textContent = "실시간 위치 안내";
      elements.preview.hidden = true;
      setNavigationPoint(point, position.coords.heading, true);
      updateNearbyPlaces(point);
      updateProgress(closest.progress);
    },
    () => {
      if (!previewFrame && !previewPaused) startPreview();
    },
    { enableHighAccuracy: true, timeout: 9000, maximumAge: 3000 },
  );
}

function stopNavigation() {
  cancelAnimationFrame(previewFrame);
  previewFrame = 0;
  previewOffset = 0;
  routeTrack = null;
  lastNearbyPoint = null;
  lastNearbyAt = 0;
  nearbyToken += 1;
  setNavigationPlaces([]);
  if (geolocationWatch !== null) navigator.geolocation.clearWatch(geolocationWatch);
  geolocationWatch = null;
  resetNavigationUi();
  setNavigationMode(false);
}

function beginNavigation(state) {
  const route = state.routeData?.options.find((item) => item.id === state.selectedRouteId);
  if (!route) return;
  routeTrack = buildTrack(route);
  previewOffset = 0;
  previewPaused = false;
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
  if (!REDUCED_MOTION.matches) startPreview({ reset: true });
  else {
    elements.mode.textContent = "경로 미리보기";
    elements.preview.hidden = false;
    previewPaused = true;
    syncPreviewButton();
  }
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

  elements.preview.addEventListener("click", pausePreview);
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
    if (document.hidden && getState().phase === "navigate" && !previewPaused) pausePreview();
  });

  subscribe((state, actionName) => {
    if (actionName === "startNavigation") beginNavigation(state);
    if (["backToCompare", "resetAll", "clearEndpoint"].includes(actionName)) stopNavigation();
  });
}
