import { actions, subscribe } from "./state.js";
import { getDepartHour } from "./api.js";
import { refreshIcons } from "./icons.js";

const elements = {};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function haversine(a, b) {
  const radius = 6371000;
  const radians = (degree) => (degree * Math.PI) / 180;
  const dLat = radians(b[0] - a[0]);
  const dLon = radians(b[1] - a[1]);
  const lat1 = radians(a[0]);
  const lat2 = radians(b[0]);
  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function segmentLength(segment) {
  return segment.coords.slice(1).reduce(
    (total, point, index) => total + haversine(segment.coords[index], point),
    0,
  );
}

function formatDistance(meters) {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)}km`;
  return `${Math.round(meters)}m`;
}

function routeTitle(route) {
  if (route.labels.includes("추천")) return "추천 경로";
  if (route.labels.includes("최단")) return "가장 빠른 길";
  if (route.labels.includes("그늘 우선")) return "그늘 우선";
  return route.labels[0] ?? "경로";
}

function routeBadge(route) {
  if (route.labels.includes("추천")) return '<span class="route-badge">추천</span>';
  if (route.labels.includes("최단")) return '<span class="route-badge is-shortest">최단</span>';
  return "";
}

function shadeBar(route) {
  const lengths = route.segments.map(segmentLength);
  const total = lengths.reduce((sum, length) => sum + length, 0) || 1;
  return route.segments
    .map(
      (segment, index) =>
        `<span class="${segment.shaded ? "is-shade" : "is-sun"}" style="flex:${Math.max(lengths[index] / total, 0.025)}"></span>`,
    )
    .join("");
}

function optionTemplate(route, state) {
  const selected = route.id === state.selectedRouteId;
  const recommended = route.id === state.routeData.recommended_id;
  const qualifiers = route.labels.filter((label) => !["추천", "최단"].includes(label));
  const extra = Number(route.extra_min ?? 0);
  return `
    <button class="route-option${recommended ? " is-recommended" : ""}" type="button" role="radio"
      aria-checked="${selected}" data-route-id="${escapeHtml(route.id)}">
      <span class="route-title-row">
        ${routeBadge(route)}
        <span class="route-title">${escapeHtml(routeTitle(route))}</span>
      </span>
      <span class="route-time-block">
        <span class="route-duration">${Math.round(route.minutes)}분</span>
        <span class="arrival-time">${escapeHtml(route.arrive_at)} 도착</span>
      </span>
      <span class="route-metrics">
        <span>그늘 ${Math.round(route.shade_pct)}%</span>
        <span>${formatDistance(route.distance_m)}</span>
        ${extra > 0 ? `<span class="extra">+${Number.isInteger(extra) ? extra : extra.toFixed(1)}분</span>` : ""}
      </span>
      <span class="shade-bar" aria-label="그늘 ${Math.round(route.shade_pct)}%, 햇빛 ${100 - Math.round(route.shade_pct)}%">
        ${shadeBar(route)}
      </span>
      ${
        qualifiers.length
          ? `<span class="route-qualifiers">${qualifiers
              .map((label) => `<span class="route-qualifier">${escapeHtml(label)}</span>`)
              .join("")}</span>`
          : ""
      }
    </button>`;
}

function insightFor(route) {
  if (!route?.segments?.length) return "";
  const first = route.segments[0];
  const firstMeters = Math.max(10, Math.round(segmentLength(first) / 10) * 10);
  const changes = route.segments.length - 1;
  if (route.shade_pct === 0) {
    return `<strong>햇빛 노출이 가장 많은 경로예요.</strong> 빠르지만 그늘 구간이 거의 없습니다.`;
  }
  if (first.shaded) {
    return `<strong>출발 후 약 ${firstMeters}m를 그늘로 걸어요.</strong> 이후 햇빛과 그늘이 ${changes}번 바뀝니다.`;
  }
  return `<strong>처음 약 ${firstMeters}m는 햇빛 구간이에요.</strong> 이후 남색 경로부터 그늘이 이어집니다.`;
}

function update3dLink(state) {
  const route = state.routeData?.options.find((item) => item.id === state.selectedRouteId);
  if (!route || !state.origin || !state.destination) return;
  const params = new URLSearchParams({
    from: `${state.origin.lat},${state.origin.lon}`,
    to: `${state.destination.lat},${state.destination.lon}`,
    hour: String(getDepartHour(state.departAt)),
    option_id: route.id,
  });
  elements.open3d.href = `./3d.html?${params}`;
}

function render(state, actionName) {
  if (!state.routeData) {
    elements.options.innerHTML = "";
    elements.insight.innerHTML = "";
    return;
  }

  if (["setRoutes", "selectRoute", "subscribe"].includes(actionName)) {
    elements.options.innerHTML = state.routeData.options.map((route) => optionTemplate(route, state)).join("");
    const route = state.routeData.options.find((item) => item.id === state.selectedRouteId);
    elements.insight.innerHTML = insightFor(route);
    elements.start.disabled = !route;
    update3dLink(state);
    refreshIcons();
  }
}

export function initRoutes() {
  elements.options = document.querySelector("#routeOptions");
  elements.insight = document.querySelector("#routeInsight");
  elements.start = document.querySelector("#startNavigation");
  elements.open3d = document.querySelector("#open3d");

  elements.options.addEventListener("click", (event) => {
    const option = event.target.closest("[data-route-id]");
    if (!option || elements.options.classList.contains("is-launching")) return;
    const routeId = option.dataset.routeId;
    actions.selectRoute(routeId);
    requestAnimationFrame(() => {
      elements.options.classList.add("is-launching");
      elements.options.querySelector(`[data-route-id="${CSS.escape(routeId)}"]`)?.classList.add("is-launching");
    });
    window.setTimeout(() => {
      elements.options.classList.remove("is-launching");
      actions.startNavigation();
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 360);
  });

  subscribe(render);
}
