import { subscribe } from "./state.js";
import { refreshIcons } from "./icons.js";

const ITEM_HEIGHT = 44;
const HOURS = Array.from({ length: 24 }, (_, index) => index);
const MINUTES = Array.from({ length: 12 }, (_, index) => index * 5);
const elements = {};
const scrollTimers = new Map();
const gestureStarts = new Map();
const wheelLocks = new Map();
let selectedTime = "now";
let wheelHour = 14;
let wheelMinute = 0;
let onSelect = () => {};

function pad(value) {
  return String(value).padStart(2, "0");
}

function clockValue() {
  return `${pad(wheelHour)}:${pad(wheelMinute)}`;
}

function timeLabel(value) {
  return value === "now" ? "지금 출발" : `${value} 출발`;
}

function partsFor(value) {
  if (value !== "now") {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value);
    if (match) return { hour: Number(match[1]) % 24, minute: Math.round(Number(match[2]) / 5) * 5 };
  }
  const now = new Date();
  let hour = now.getHours();
  let minute = Math.round(now.getMinutes() / 5) * 5;
  if (minute === 60) {
    minute = 0;
    hour = (hour + 1) % 24;
  }
  return { hour, minute };
}

function renderChart(exposure) {
  const curve = exposure?.curve ?? [];
  if (!curve.length) {
    elements.chart.innerHTML = "";
    return;
  }

  const values = curve.map((point) => Number(point.exposure_m));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const width = 400;
  const height = 126;
  const padX = 12;
  const padY = 16;
  const pointAt = (point, index) => {
    const x = padX + (index / Math.max(1, curve.length - 1)) * (width - padX * 2);
    const y = padY + ((Number(point.exposure_m) - min) / range) * (height - padY * 2);
    return [x, y];
  };
  const points = curve.map(pointAt);
  const path = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${path} L${points.at(-1)[0].toFixed(1)},${height} L${points[0][0].toFixed(1)},${height} Z`;
  const bestIndex = curve.findIndex((point) => point.t === exposure.best?.t);
  const bestX = bestIndex >= 0 ? pointAt(curve[bestIndex], bestIndex)[0] : width / 2;
  const leftPercent = Math.max(18, Math.min(82, (bestX / width) * 100));
  const firstHour = curve[0].t.slice(0, 2);
  const middleHour = curve[Math.floor(curve.length / 2)].t.slice(0, 2);
  const lastHour = curve.at(-1).t.slice(0, 2);

  elements.chart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="햇빛 노출이 낮을수록 위쪽에 표시됩니다">
      <path d="${area}" fill="#fff0e5"></path>
      <path d="${path}" fill="none" stroke="#ef7d36" stroke-width="3" vector-effect="non-scaling-stroke"></path>
      <line x1="${bestX}" x2="${bestX}" y1="12" y2="${height}" stroke="#167958" stroke-width="1.5" stroke-dasharray="4 4"></line>
    </svg>
    <span class="chart-best" style="left:${leftPercent}%">추천 ${exposure.best.t}</span>
    <span class="chart-label is-start">${firstHour}</span>
    <span class="chart-label is-mid">${middleHour}</span>
    <span class="chart-label is-end">${lastHour}</span>`;
}

function buildWheel(container, values, unit) {
  container.innerHTML = values.map((value) => `
    <button class="wheel-option" type="button" role="option" data-wheel-value="${value}"
      aria-label="${value}${unit}" aria-selected="false">${pad(value)}</button>`).join("");
}

function syncWheel(container, value, behavior = "smooth") {
  const options = [...container.querySelectorAll(".wheel-option")];
  const index = Math.max(0, options.findIndex((option) => Number(option.dataset.wheelValue) === value));
  for (const [optionIndex, option] of options.entries()) {
    option.setAttribute("aria-selected", String(optionIndex === index));
  }
  const target = index * ITEM_HEIGHT;
  if (Math.abs(container.scrollTop - target) > 0.5) {
    if (behavior === "auto") {
      const previousBehavior = container.style.scrollBehavior;
      container.style.scrollBehavior = "auto";
      container.scrollTop = target;
      container.style.scrollBehavior = previousBehavior;
    } else {
      container.scrollTo({ top: target, behavior });
    }
  }
}

function renderSummary() {
  const isNow = selectedTime === "now";
  elements.now.setAttribute("aria-pressed", String(isNow));
  elements.summary.innerHTML = isNow
    ? "현재 시각 기준으로 출발합니다."
    : `8월 6일 <strong>${clockValue()}</strong> 출발`;
}

function selectClock(hour, minute, { behavior = "smooth" } = {}) {
  wheelHour = (Number(hour) + 24) % 24;
  wheelMinute = Math.max(0, Math.min(55, Math.round(Number(minute) / 5) * 5));
  selectedTime = clockValue();
  syncWheel(elements.hour, wheelHour, behavior);
  syncWheel(elements.minute, wheelMinute, behavior);
  renderSummary();
}

function selectNow() {
  selectedTime = "now";
  const parts = partsFor("now");
  wheelHour = parts.hour;
  wheelMinute = parts.minute;
  syncWheel(elements.hour, wheelHour);
  syncWheel(elements.minute, wheelMinute);
  renderSummary();
}

function selectValue(value, behavior = "auto") {
  selectedTime = value;
  const parts = partsFor(value);
  wheelHour = parts.hour;
  wheelMinute = parts.minute === 60 ? 0 : parts.minute;
  syncWheel(elements.hour, wheelHour, behavior);
  syncWheel(elements.minute, wheelMinute, behavior);
  renderSummary();
}

function settleWheel(container, kind) {
  const values = kind === "hour" ? HOURS : MINUTES;
  let index = Math.max(0, Math.min(values.length - 1, Math.round(container.scrollTop / ITEM_HEIGHT)));
  const gestureStart = gestureStarts.get(container);
  if (Number.isInteger(gestureStart?.index)) {
    index = Math.max(gestureStart.index - 1, Math.min(gestureStart.index + 1, index));
    gestureStarts.delete(container);
  }
  if (kind === "hour") wheelHour = values[index];
  else wheelMinute = values[index];
  selectClock(wheelHour, wheelMinute, { behavior: "auto" });
}

function bindWheel(container, kind) {
  container.addEventListener("pointerdown", () => {
    gestureStarts.set(container, {
      index: Math.round(container.scrollTop / ITEM_HEIGHT),
      scrollTop: container.scrollTop,
    });
  });
  container.addEventListener("pointerup", () => {
    const start = gestureStarts.get(container);
    if (start && Math.abs(container.scrollTop - start.scrollTop) < 1) gestureStarts.delete(container);
  });
  container.addEventListener("wheel", (event) => {
    event.preventDefault();
    if (wheelLocks.get(container)) return;
    wheelLocks.set(container, true);
    stepWheel(kind, event.deltaY < 0 ? -1 : 1);
    window.setTimeout(() => wheelLocks.delete(container), 140);
  }, { passive: false });
  container.addEventListener("scroll", () => {
    window.clearTimeout(scrollTimers.get(container));
    scrollTimers.set(container, window.setTimeout(() => settleWheel(container, kind), 90));
  }, { passive: true });
  container.addEventListener("click", (event) => {
    const option = event.target.closest("[data-wheel-value]");
    if (!option) return;
    const value = Number(option.dataset.wheelValue);
    if (kind === "hour") selectClock(value, wheelMinute);
    else selectClock(wheelHour, value);
  });
}

function stepWheel(kind, delta) {
  if (kind === "hour") {
    selectClock(wheelHour + delta, wheelMinute);
    return;
  }
  const nextIndex = MINUTES.indexOf(wheelMinute) + delta;
  if (nextIndex < 0) selectClock(wheelHour - 1, MINUTES.at(-1));
  else if (nextIndex >= MINUTES.length) selectClock(wheelHour + 1, MINUTES[0]);
  else selectClock(wheelHour, MINUTES[nextIndex]);
}

function openDialog(state) {
  selectedTime = state.departAt;
  renderChart(state.exposure);
  const best = state.exposure?.best?.t;
  elements.recommended.hidden = !best;
  if (best) elements.recommended.querySelector("strong").textContent = best;
  elements.dialog.showModal();
  window.requestAnimationFrame(() => selectValue(selectedTime));
}

function render(state) {
  elements.label.textContent = timeLabel(state.departAt);
  const best = state.exposure?.best?.t;
  elements.best.hidden = !best || state.routeData?.meta?.night;
  if (best) elements.best.innerHTML = `추천 <span>${best}</span>`;
}

export function initTime(options = {}) {
  onSelect = options.onSelect ?? onSelect;
  elements.open = document.querySelector("#departTimeButton");
  elements.label = document.querySelector("#departTimeLabel");
  elements.best = document.querySelector("#bestTimeButton");
  elements.dialog = document.querySelector("#timeDialog");
  elements.chart = document.querySelector("#exposureChart");
  elements.now = document.querySelector("#nowTimeChoice");
  elements.recommended = document.querySelector("#recommendedTimeChoice");
  elements.hour = document.querySelector("#hourWheel");
  elements.minute = document.querySelector("#minuteWheel");
  elements.summary = document.querySelector("#selectedTimeSummary");
  elements.confirm = document.querySelector("#confirmTime");

  buildWheel(elements.hour, HOURS, "시");
  buildWheel(elements.minute, MINUTES, "분");
  bindWheel(elements.hour, "hour");
  bindWheel(elements.minute, "minute");

  let latestState;
  subscribe((state) => {
    latestState = state;
    render(state);
  });

  elements.open.addEventListener("click", () => openDialog(latestState));
  elements.best.addEventListener("click", () => {
    const best = latestState.exposure?.best?.t;
    if (best) onSelect(best);
  });
  elements.now.addEventListener("click", selectNow);
  elements.recommended.addEventListener("click", () => {
    const best = latestState.exposure?.best?.t;
    if (best) selectValue(best, "smooth");
  });
  document.querySelectorAll(".wheel-step").forEach((button) => {
    button.addEventListener("click", () => stepWheel(button.dataset.wheel, Number(button.dataset.step)));
  });
  elements.confirm.addEventListener("click", () => {
    elements.dialog.close();
    onSelect(selectedTime);
  });

  refreshIcons();
}
