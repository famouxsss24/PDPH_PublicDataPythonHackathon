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

function heatMeter(route) {
  if (!route.heat) return "";
  const exposure = Math.max(0, Number(route.heat.exposure_sun_min) || 0);
  const duration = Math.max(exposure, Number(route.heat.mode_time_min) || 0, 1);
  const exposureShare = Math.min(100, exposure / duration * 100);
  return `
    <span class="route-heat-meter" aria-label="예상 햇빛 노출 ${exposure.toFixed(1)}분">
      <span>햇빛 예상</span>
      <span class="route-heat-track" aria-hidden="true"><span style="width:${exposureShare.toFixed(1)}%"></span></span>
      <strong>${exposure.toFixed(0)}분</strong>
    </span>`;
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
      ${heatMeter(route)}
      ${
        qualifiers.length
          ? `<span class="route-qualifiers">${qualifiers
              .map((label) => `<span class="route-qualifier">${escapeHtml(label)}</span>`)
              .join("")}</span>`
          : ""
      }
    </button>`;
}

function baseInsight(route) {
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

function heatInsight(route) {
  if (!route?.heat) return "";
  const heat = route.heat;
  const exposure = Math.max(0, Number(heat.exposure_sun_min) || 0);
  const duration = Math.max(exposure, Number(heat.mode_time_min) || 0, 1);
  const exposureShare = Math.min(100, exposure / duration * 100);
  const stops = heat.stops ?? [];
  const stopMarkup = stops.length
    ? `<div class="cooling-stop-list" aria-label="경로 주변 공식 무더위쉼터">
        ${stops.map((stop) => `
          <div class="cooling-stop">
            <i class="cooling-stop-icon" aria-hidden="true">+</i>
            <span>
              <strong>${escapeHtml(stop.name)}</strong>
              <small>${escapeHtml(stop.address)} · 운영 여부 확인 필요</small>
            </span>
            <small>경로에서 ${Math.round(Number(stop.distance_from_route_m) || 0)}m</small>
          </div>`).join("")}
      </div>`
    : !heat.within_budget
      ? '<p class="heat-disclaimer">경로 주변 240m 안에서 일반 이용 가능한 공식 쉼터를 찾지 못했습니다.</p>'
      : "";
  return `
    <section class="heat-route-detail" aria-label="예상 햇빛 노출">
      <header class="heat-route-heading">
        <strong>${escapeHtml(heat.mode_label)} 기준 · 예상 햇빛 ${exposure.toFixed(1)}분</strong>
        <b>${exposureShare.toFixed(0)}%</b>
      </header>
      <div class="heat-gauge" role="meter" aria-valuemin="0" aria-valuemax="100"
        aria-valuenow="${exposureShare.toFixed(0)}" aria-label="전체 보행 중 햇빛 예상 비율">
        <span style="width:${exposureShare.toFixed(1)}%"></span>
      </div>
      <p class="heat-disclaimer">맑은 하늘 그림자 기반 예상치</p>
      ${stopMarkup}
    </section>`;
}

function insightFor(route) {
  if (!route) return "";
  const base = baseInsight(route);
  return `${base ? `<p class="route-insight-base">${base}</p>` : ""}${heatInsight(route)}`;
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
