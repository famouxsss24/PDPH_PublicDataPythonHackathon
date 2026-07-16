import { fetchExposure, fetchRoutes, fetchShade, StaleRequestError, USE_MOCK } from "./api.js";
import { actions, getState, subscribe } from "./state.js";
import {
  getCurrentLocation,
  initMap,
  refitSelectedRoute,
  setMapTheme,
  setPickMode,
  setSheetPadding,
  startRouteCalculation,
  stopRouteCalculation,
} from "./map.js";
import {
  closeResults,
  initSearch,
  resetSearch,
  setPickingMode,
  setSearchMode,
} from "./search.js";
import { initRoutes } from "./routes.js";
import { initTime } from "./time.js";
import { initSteps } from "./steps.js";
import { initNavigation } from "./navigation.js";
import { refreshIcons } from "./icons.js";
import { initShade } from "./shade.js";
import { initTheme } from "./theme.js";
import { initHeatCare } from "./heat-care.js";

const elements = {};
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
let toastTimer = null;
let placeConfirmTimer = null;
let nextFieldTimer = null;

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", isError);
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

async function requestRoutes() {
  const state = getState();
  if (!state.origin || !state.destination) return;
  const requestContext = {
    origin: state.origin,
    destination: state.destination,
    departAt: state.departAt,
    mode: state.heatCareAccepted ? state.heatMode : null,
  };
  actions.setLoading();
  startRouteCalculation(requestContext.origin, requestContext.destination);

  try {
    const [routeData, exposure] = await Promise.all([
      fetchRoutes(requestContext),
      fetchExposure(requestContext),
    ]);
    actions.setExposure(exposure);
    actions.setRoutes(routeData);

    fetchShade(requestContext.departAt)
      .then((shadeData) => actions.setShadeData(shadeData))
      .catch((error) => {
        if (error.name !== "AbortError" && !(error instanceof StaleRequestError)) {
          console.warn("그림자 데이터를 불러오지 못했습니다.", error);
        }
      });
  } catch (error) {
    stopRouteCalculation();
    if (error.name === "AbortError" || error instanceof StaleRequestError) return;
    actions.setError(error.message);
    showToast(error.message, true);
  }
}

function normalizePoint(place) {
  return {
    lat: Number(place.lat),
    lon: Number(place.lon),
    label: place.label ?? place.name ?? "선택한 위치",
    address: place.road_address || place.address || "",
    cat: place.cat || "장소",
  };
}

function handlePlacePick(place, mode) {
  window.clearTimeout(placeConfirmTimer);
  window.clearTimeout(nextFieldTimer);
  const point = normalizePoint(place);
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
    showToast("선택한 장소의 좌표를 확인하지 못했습니다.", true);
    return;
  }

  if (mode === "origin") actions.setOrigin(point);
  else actions.setDestination(point);
  closeResults();
  setPickMode(null);
  setPickingMode(null);

  const nextState = getState();
  if (nextState.origin && nextState.destination) {
    showToast(`${mode === "origin" ? "출발지" : "도착지"} 위치를 확인했습니다. 경로를 계산합니다.`);
    placeConfirmTimer = window.setTimeout(requestRoutes, REDUCED_MOTION.matches ? 0 : 680);
    return;
  }

  const nextField = nextState.origin ? "destination" : "origin";
  setSearchMode(nextField, { focus: false });
  showToast(`${mode === "origin" ? "출발지" : "도착지"} 위치를 지도에서 확인하세요.`);
  nextFieldTimer = window.setTimeout(
    () => setSearchMode(nextField, { focus: true }),
    REDUCED_MOTION.matches ? 0 : 680,
  );
}

function beginMapPick(mode) {
  setPickMode(mode);
  setPickingMode(mode);
  closeResults();
  showToast(`지도에서 ${mode === "origin" ? "출발지" : "도착지"}를 선택하세요.`);
}

function clearEndpoint(field) {
  window.clearTimeout(placeConfirmTimer);
  window.clearTimeout(nextFieldTimer);
  stopRouteCalculation();
  setPickMode(null);
  setPickingMode(null);
  actions.clearEndpoint(field);
  setSearchMode(field, { focus: true });
}

function renderShell(state, actionName) {
  const hasRouteContext = Boolean(state.origin && state.destination);
  const isLoading = state.status === "loading" && hasRouteContext;
  const isNavigate = state.phase === "navigate";
  const isCompare = state.phase === "compare" || isLoading;
  document.body.dataset.phase = isNavigate ? "navigate" : isCompare ? "compare" : "search";
  document.body.classList.toggle("shadow-open", state.shadowExploreOpen);

  elements.loading.hidden = !isLoading;
  elements.compare.hidden = isLoading;
  elements.navigation.hidden = !isNavigate;
  const route = state.routeData?.options.find((item) => item.id === state.selectedRouteId);
  elements.legend.hidden = !state.routeData || isLoading || isNavigate || state.shadowExploreOpen;
  elements.coolingLegend.hidden = !route?.heat?.stops?.length;
  elements.night.hidden = !state.routeData?.meta?.night;

  if (state.destination) {
    elements.heading.textContent = `${state.destination.label}까지`;
    elements.navigationDestination.textContent = state.destination.label;
  }

  if (isCompare || isNavigate) {
    setPickMode(null);
    setPickingMode(null);
  }

  const threeParams = new URLSearchParams({ hour: String(state.shadowExploreHour) });
  if (state.origin && state.destination) {
    threeParams.set("from", `${state.origin.lat},${state.origin.lon}`);
    threeParams.set("to", `${state.destination.lat},${state.destination.lon}`);
  }
  if (route) threeParams.set("option_id", route.id);
  elements.open3dGlobal.href = `./3d.html?${threeParams}`;

  if (["setRoutes", "backToCompare"].includes(actionName)) {
    window.setTimeout(refitSelectedRoute, 80);
  }
}

function bindCommands() {
  elements.locate.addEventListener("click", async () => {
    try {
      await getCurrentLocation({ requireNowon: true });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  elements.swap.addEventListener("click", () => {
    window.clearTimeout(placeConfirmTimer);
    window.clearTimeout(nextFieldTimer);
    const state = getState();
    if (!state.origin || !state.destination) {
      showToast("출발지와 도착지를 모두 선택해주세요.");
      return;
    }
    actions.swapEndpoints();
    requestRoutes();
    showToast("출발지와 도착지를 바꿨습니다.");
  });

  elements.reset.addEventListener("click", () => {
    window.clearTimeout(placeConfirmTimer);
    window.clearTimeout(nextFieldTimer);
    stopRouteCalculation();
    setPickMode(null);
    setPickingMode(null);
    actions.resetAll();
    resetSearch();
    setSearchMode("origin", { focus: true });
    showToast("출발지와 도착지를 다시 입력할 수 있습니다.");
  });

  elements.start.addEventListener("click", () => actions.startNavigation());
  elements.back.addEventListener("click", () => actions.backToCompare());
}

function observeLayout() {
  const update = () => {
    const rect = elements.panel.getBoundingClientRect();
    document.documentElement.style.setProperty("--panel-bottom", `${Math.round(rect.bottom)}px`);
    setSheetPadding();
  };
  new ResizeObserver(update).observe(elements.panel);
  window.addEventListener("resize", update);
  update();
}

function init() {
  elements.toast = document.querySelector("#toast");
  elements.panel = document.querySelector("#journeyPanel");
  elements.loading = document.querySelector("#loadingView");
  elements.compare = document.querySelector("#compareView");
  elements.navigation = document.querySelector("#navigationView");
  elements.legend = document.querySelector("#routeLegend");
  elements.coolingLegend = document.querySelector("#coolingLegend");
  elements.night = document.querySelector("#nightNotice");
  elements.heading = document.querySelector("#routeHeading");
  elements.navigationDestination = document.querySelector("#navigationDestination");
  elements.locate = document.querySelector("#locateButton");
  elements.swap = document.querySelector("#swapRoute");
  elements.reset = document.querySelector("#resetRouteInput");
  elements.start = document.querySelector("#startNavigation");
  elements.back = document.querySelector("#backToRoutes");
  elements.open3dGlobal = document.querySelector("#open3dGlobal");
  elements.theme = document.querySelector("#themeToggle");
  elements.dataBadge = document.querySelector(".data-badge");
  elements.dataBadge.textContent = USE_MOCK ? "실데이터 스냅샷" : "맑은 하늘 기준";

  refreshIcons();
  initMap({ onMapPick: handlePlacePick, onError: (message) => showToast(message, true) });
  initTheme({ button: elements.theme, fallback: "light", onChange: setMapTheme });
  initSearch({ onSelect: handlePlacePick, onPick: beginMapPick, onClear: clearEndpoint });
  initRoutes();
  initHeatCare({
    onRefresh: requestRoutes,
    onReviewTime: () => document.querySelector("#departTimeButton").click(),
  });
  initTime({
    onSelect: (departAt) => {
      if (departAt === getState().departAt) return;
      actions.setDepartAt(departAt);
      requestRoutes();
    },
  });
  initSteps();
  initNavigation();
  initShade({ onError: (message) => showToast(message, true) });
  bindCommands();
  observeLayout();
  subscribe(renderShell);
}

init();
