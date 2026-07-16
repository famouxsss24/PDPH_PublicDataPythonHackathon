import { actions, subscribe } from "./state.js";
import { fetchCurrentWeather } from "./api.js";
import { refreshIcons } from "./icons.js";

const elements = {};
let onRefresh = () => {};
let onReviewTime = () => {};
let weatherPointKey = "";
let weatherRequestToken = 0;

function neutralWeatherCopy(summary = "현재 날씨 확인 불가") {
  elements.panel.dataset.heatAlert = "false";
  elements.weather.textContent = summary;
  elements.title.textContent = "그늘이 많은 경로를 비교해 보세요.";
  elements.description.textContent = "물과 양산·모자를 챙기고 햇빛 노출이 적은 시간과 경로를 확인하세요.";
}

function renderWeather(weather) {
  if (!weather) {
    neutralWeatherCopy();
    return;
  }

  const temperature = Number(weather.temperature_c).toFixed(1);
  const apparent = Number(weather.apparent_temperature_c).toFixed(1);
  const threshold = Number(weather.threshold?.value_c ?? 33).toFixed(0);
  const shouldDefer = Boolean(weather.recommend_defer_outdoor);
  elements.panel.dataset.heatAlert = String(shouldDefer);
  elements.weather.textContent = `기온 ${temperature}° · 체감 ${apparent}°`;
  elements.weather.title = `${weather.provider ?? "현재 날씨"} 모델 기반 현재값`;

  if (shouldDefer) {
    elements.title.textContent = "지금은 외출을 미루는 편이 좋습니다.";
    elements.description.textContent = `현재 체감온도가 ${threshold}°C 기준 이상입니다. 꼭 이동해야 한다면 햇빛 노출이 적은 경로를 선택하세요.`;
    return;
  }

  elements.title.textContent = "그늘이 많은 경로를 비교해 보세요.";
  elements.description.textContent = `현재 체감온도는 ${threshold}°C 외출 자제 권고 기준 미만입니다. 물과 양산·모자를 챙겨주세요.`;
}

async function updateWeather(point) {
  const key = `${Number(point.lat).toFixed(4)},${Number(point.lon).toFixed(4)}`;
  if (key === weatherPointKey) return;
  weatherPointKey = key;
  const token = ++weatherRequestToken;
  neutralWeatherCopy("현재 날씨 확인 중");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const weather = await fetchCurrentWeather(point);
      if (token === weatherRequestToken) renderWeather(weather);
      return;
    } catch {
      if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 600));
    }
  }
  if (token === weatherRequestToken) neutralWeatherCopy();
}

function render(state) {
  const active = state.heatCareAccepted;
  elements.panel.dataset.active = String(active);
  elements.prompt.hidden = active;
  elements.controls.hidden = !active;
  for (const element of elements.dependent) element.hidden = !active;

  for (const button of elements.modeButtons) {
    const selected = button.dataset.heatMode === state.heatMode;
    button.setAttribute("aria-checked", String(selected));
  }

  const selectedRoute = state.routeData?.options.find(
    (route) => route.id === state.selectedRouteId,
  );
  elements.fallback.hidden = !active || !state.routeData || Boolean(selectedRoute?.heat);

  if (!state.origin || !state.destination) {
    weatherPointKey = "";
    weatherRequestToken += 1;
    neutralWeatherCopy("현재 날씨 확인 전");
  } else if (state.routeData) {
    updateWeather(state.origin);
  }
}

export function initHeatCare(options = {}) {
  onRefresh = options.onRefresh ?? onRefresh;
  onReviewTime = options.onReviewTime ?? onReviewTime;
  elements.panel = document.querySelector("#heatCarePanel");
  elements.prompt = document.querySelector("#heatCarePrompt");
  elements.controls = document.querySelector("#heatCareControls");
  elements.continue = document.querySelector("#heatCareContinue");
  elements.reviewTime = document.querySelector("#heatCareReviewTime");
  elements.fallback = document.querySelector("#heatCareFallback");
  elements.weather = document.querySelector("#heatCareWeather");
  elements.title = document.querySelector("#heatCareTitle");
  elements.description = document.querySelector("#heatCareDescription");
  elements.dependent = [...document.querySelectorAll(".heat-care-dependent")];
  elements.modeButtons = [...document.querySelectorAll("[data-heat-mode]")];

  elements.continue.addEventListener("click", () => {
    actions.enableHeatCare();
    onRefresh();
  });
  elements.reviewTime.addEventListener("click", () => onReviewTime());
  for (const button of elements.modeButtons) {
    button.addEventListener("click", () => {
      const nextMode = button.dataset.heatMode;
      if (button.getAttribute("aria-checked") === "true") return;
      actions.setHeatMode(nextMode);
      onRefresh();
    });
  }

  subscribe(render);
  refreshIcons(elements.panel);
}
