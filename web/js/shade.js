import { fetchShadowFrame } from "./api.js";
import { actions, getState, subscribe } from "./state.js";
import { refreshIcons } from "./icons.js";

const elements = {};
let timer = null;
let requestToken = 0;
let onError = () => {};
const frameCache = new Map();

async function getFrame(hour) {
  if (!frameCache.has(hour)) frameCache.set(hour, fetchShadowFrame(hour));
  try {
    return await frameCache.get(hour);
  } catch (error) {
    frameCache.delete(hour);
    throw error;
  }
}

function prefetchAround(hour) {
  for (const candidate of [hour - 1, hour + 1]) {
    if (candidate >= 7 && candidate <= 18 && !frameCache.has(candidate)) {
      frameCache.set(candidate, fetchShadowFrame(candidate));
    }
  }
}

async function loadHour(hour) {
  const token = ++requestToken;
  elements.clock.textContent = `${String(hour).padStart(2, "0")}:00 · 불러오는 중`;
  try {
    const data = await getFrame(hour);
    if (token !== requestToken) return;
    actions.setShadeData(data);
    elements.clock.textContent = `${String(hour).padStart(2, "0")}:00`;
    prefetchAround(hour);
  } catch (error) {
    if (error.name === "AbortError") return;
    elements.clock.textContent = `${String(hour).padStart(2, "0")}:00`;
    actions.setShadowExplorePlaying(false);
    onError(`그림자 프레임을 불러오지 못했습니다: ${error.message}`);
  }
}

function syncTimer(state) {
  if (state.shadowExplorePlaying && !timer) {
    timer = window.setInterval(() => {
      const current = getState().shadowExploreHour;
      const next = current >= 18 ? 7 : current + 1;
      actions.setShadowExploreHour(next);
      loadHour(next);
    }, 1500);
  } else if (!state.shadowExplorePlaying && timer) {
    window.clearInterval(timer);
    timer = null;
  }
}

function render(state) {
  elements.panel.hidden = !state.shadowExploreOpen;
  elements.open.setAttribute("aria-expanded", String(state.shadowExploreOpen));
  elements.range.value = String(state.shadowExploreHour);
  if (!elements.clock.textContent.includes("불러오는 중")) {
    elements.clock.textContent = `${String(state.shadowExploreHour).padStart(2, "0")}:00`;
  }
  elements.play.setAttribute("aria-pressed", String(state.shadowExplorePlaying));
  elements.play.setAttribute(
    "aria-label",
    state.shadowExplorePlaying ? "그림자 시간 정지" : "그림자 시간 재생",
  );
  elements.play.innerHTML = `<i data-lucide="${state.shadowExplorePlaying ? "pause" : "play"}"></i>`;
  refreshIcons(elements.play);
  syncTimer(state);
}

export function initShade(options = {}) {
  onError = options.onError ?? onError;
  elements.open = document.querySelector("#shadowExploreButton");
  elements.panel = document.querySelector("#shadowExplorer");
  elements.close = document.querySelector("#shadowClose");
  elements.play = document.querySelector("#shadowPlay");
  elements.range = document.querySelector("#shadowRange");
  elements.clock = document.querySelector("#shadowClock");

  elements.open.addEventListener("click", () => {
    const state = getState();
    if (state.shadowExploreOpen) {
      actions.exitShadowExplore();
      return;
    }
    actions.enterShadowExplore();
    loadHour(state.shadowExploreHour);
  });
  elements.close.addEventListener("click", () => actions.exitShadowExplore());
  elements.play.addEventListener("click", () => {
    actions.setShadowExplorePlaying(!getState().shadowExplorePlaying);
  });
  elements.range.addEventListener("input", () => {
    const hour = Number(elements.range.value);
    actions.setShadowExplorePlaying(false);
    actions.setShadowExploreHour(hour);
    loadHour(hour);
  });

  subscribe(render);
}
