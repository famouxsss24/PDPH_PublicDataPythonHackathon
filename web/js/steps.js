import { subscribe } from "./state.js";
import { refreshIcons } from "./icons.js";

const TURN_ICONS = {
  출발: "navigation",
  직진: "arrow-up",
  좌회전: "corner-up-left",
  우회전: "corner-up-right",
  유턴: "undo-2",
  도착: "flag",
};

const elements = {};
let currentInstruction = "";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDistance(meters) {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)}km`;
  return `${Math.round(meters)}m`;
}

function instruction(step) {
  if (!step) return "목적지에 도착합니다";
  if (step.turn === "도착") return `${step.name} 도착`;
  if (step.turn === "출발") return `${step.name} 방향으로 출발`;
  if (step.turn === "직진") return `${step.name} 따라 직진`;
  return `${step.name}에서 ${step.turn}`;
}

function render(state) {
  const route = state.routeData?.options.find((item) => item.id === state.selectedRouteId);
  if (!route) return;
  const steps = route.steps ?? [];
  const next = steps[1] ?? steps[0];
  currentInstruction = instruction(next);

  elements.progress.textContent = `남은 ${formatDistance(route.distance_m)} · ${Math.round(route.minutes)}분`;
  elements.next.innerHTML = `
    <span class="turn-icon" aria-hidden="true"><i data-lucide="${TURN_ICONS[next?.turn] ?? "arrow-up"}"></i></span>
    <span><small>${formatDistance(next?.dist_m ?? 0)} 후</small><strong>${escapeHtml(currentInstruction)}</strong></span>`;

  const renderedSteps = [
    ...steps,
    { turn: "도착", name: state.destination?.label ?? "목적지", dist_m: 0 },
  ];
  elements.list.innerHTML = renderedSteps
    .map(
      (step) => `
        <li class="step-item">
          <span class="turn-icon" aria-hidden="true"><i data-lucide="${TURN_ICONS[step.turn] ?? "arrow-up"}"></i></span>
          <span><strong>${escapeHtml(instruction(step))}</strong><small>${escapeHtml(step.turn)}</small></span>
          <span class="step-distance">${step.dist_m ? formatDistance(step.dist_m) : ""}</span>
        </li>`,
    )
    .join("");
  refreshIcons();
}

export function initSteps() {
  elements.progress = document.querySelector("#navigationProgress");
  elements.next = document.querySelector("#nextTurn");
  elements.list = document.querySelector("#stepList");
  elements.voice = document.querySelector("#voiceToggle");

  elements.voice.addEventListener("click", () => {
    const pressed = elements.voice.getAttribute("aria-pressed") === "true";
    const nextPressed = !pressed;
    elements.voice.setAttribute("aria-pressed", String(nextPressed));
    elements.voice.setAttribute("aria-label", nextPressed ? "음성 안내 끄기" : "음성 안내 켜기");
    if (nextPressed && "speechSynthesis" in window && currentInstruction) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(currentInstruction);
      utterance.lang = "ko-KR";
      window.speechSynthesis.speak(utterance);
    } else if (!nextPressed && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  });

  subscribe((state, actionName) => {
    if (["setRoutes", "selectRoute", "startNavigation", "subscribe"].includes(actionName)) render(state);
  });
}
