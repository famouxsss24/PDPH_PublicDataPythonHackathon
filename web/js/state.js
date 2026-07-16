const createInitialState = () => ({
  phase: "search",
  origin: null,
  destination: null,
  departAt: "now",
  heatCareAccepted: false,
  heatMode: "elder",
  routeData: null,
  selectedRouteId: null,
  exposure: null,
  shadeData: null,
  shadowExploreOpen: false,
  shadowExploreHour: 14,
  shadowExplorePlaying: false,
  sheetSnap: "half",
  status: "idle",
  error: null,
});

let state = Object.freeze(createInitialState());
const listeners = new Set();

function publish(actionName) {
  for (const listener of listeners) listener(state, actionName);
}

function commit(patch, actionName) {
  state = Object.freeze({ ...state, ...patch });
  publish(actionName);
}

export function getState() {
  return state;
}

export function subscribe(listener) {
  listeners.add(listener);
  listener(state, "subscribe");
  return () => listeners.delete(listener);
}

export const actions = Object.freeze({
  setDestination(destination) {
    commit(
      {
        destination,
        phase: state.phase === "navigate" ? "search" : state.phase,
        routeData: null,
        selectedRouteId: null,
        shadeData: null,
        status: "idle",
        error: null,
      },
      "setDestination",
    );
  },

  setOrigin(origin) {
    commit(
      {
        origin,
        phase: state.phase === "navigate" ? "search" : state.phase,
        routeData: null,
        selectedRouteId: null,
        shadeData: null,
        status: "idle",
        error: null,
      },
      "setOrigin",
    );
  },

  requireOrigin() {
    commit({ phase: "pick-origin", status: "idle", error: null }, "requireOrigin");
  },

  beginOriginPick() {
    commit({ phase: "pick-origin", status: "idle", error: null }, "beginOriginPick");
  },

  clearEndpoint(field) {
    if (!["origin", "destination"].includes(field)) return;
    commit(
      {
        [field]: null,
        phase: "search",
        routeData: null,
        selectedRouteId: null,
        shadeData: null,
        status: "idle",
        error: null,
      },
      "clearEndpoint",
    );
  },

  searchDestination() {
    commit({ phase: "search", status: "idle", error: null }, "searchDestination");
  },

  setLoading() {
    commit({ status: "loading", error: null }, "setLoading");
  },

  setRoutes(routeData) {
    const recommendedExists = routeData.options.some(
      (route) => route.id === routeData.recommended_id,
    );
    const selectedRouteId = recommendedExists
      ? routeData.recommended_id
      : routeData.options[0]?.id ?? null;

    commit(
      {
        phase: "compare",
        status: "ready",
        routeData,
        selectedRouteId,
        error: null,
        sheetSnap: "half",
      },
      "setRoutes",
    );
  },

  selectRoute(optionId) {
    if (!state.routeData?.options.some((route) => route.id === optionId)) return;
    commit({ selectedRouteId: optionId }, "selectRoute");
  },

  setDepartAt(departAt) {
    commit(
      {
        departAt,
        routeData: null,
        selectedRouteId: null,
        shadeData: null,
        status: "loading",
        error: null,
      },
      "setDepartAt",
    );
  },

  setExposure(exposure) {
    commit({ exposure }, "setExposure");
  },

  enableHeatCare() {
    commit(
      {
        heatCareAccepted: true,
        heatMode: "elder",
        routeData: null,
        selectedRouteId: null,
        shadeData: null,
        status: "loading",
        error: null,
      },
      "enableHeatCare",
    );
  },

  setHeatMode(heatMode) {
    if (!new Set(["default", "elder"]).has(heatMode) || heatMode === state.heatMode) return;
    commit(
      {
        heatMode,
        routeData: null,
        selectedRouteId: null,
        shadeData: null,
        status: "loading",
        error: null,
      },
      "setHeatMode",
    );
  },

  setShadeData(shadeData) {
    commit({ shadeData }, "setShadeData");
  },

  enterShadowExplore() {
    commit(
      { shadowExploreOpen: true, shadowExplorePlaying: false, sheetSnap: "peek" },
      "enterShadowExplore",
    );
  },

  exitShadowExplore() {
    commit(
      {
        shadowExploreOpen: false,
        shadowExplorePlaying: false,
        sheetSnap: ["compare", "navigate"].includes(state.phase) ? "half" : state.sheetSnap,
      },
      "exitShadowExplore",
    );
  },

  setShadowExploreHour(shadowExploreHour) {
    const hour = Math.max(7, Math.min(18, Math.round(Number(shadowExploreHour))));
    commit({ shadowExploreHour: hour }, "setShadowExploreHour");
  },

  setShadowExplorePlaying(shadowExplorePlaying) {
    commit({ shadowExplorePlaying: Boolean(shadowExplorePlaying) }, "setShadowExplorePlaying");
  },

  setSheetSnap(sheetSnap) {
    if (!new Set(["peek", "half", "full"]).has(sheetSnap)) return;
    commit({ sheetSnap }, "setSheetSnap");
  },

  startNavigation() {
    if (!state.selectedRouteId) return;
    commit({ phase: "navigate", sheetSnap: "half" }, "startNavigation");
  },

  backToCompare() {
    commit({ phase: "compare", sheetSnap: "half" }, "backToCompare");
  },

  swapEndpoints() {
    if (!state.origin || !state.destination) return;
    commit(
      {
        origin: state.destination,
        destination: state.origin,
        routeData: null,
        selectedRouteId: null,
        shadeData: null,
        status: "loading",
      },
      "swapEndpoints",
    );
  },

  resetRoute() {
    commit(
      {
        phase: "search",
        origin: null,
        routeData: null,
        selectedRouteId: null,
        shadeData: null,
        status: "idle",
        error: null,
      },
      "resetRoute",
    );
  },

  resetAll() {
    state = Object.freeze(createInitialState());
    publish("resetAll");
  },

  setError(error) {
    commit({ status: "error", error }, "setError");
  },
});
