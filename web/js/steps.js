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
const GENERIC_ROAD_NAMES = new Set(["", "골목길", "이름 없는 길", "도로"]);
const VOICE_NAME_HINTS = ["natural", "online", "sunhi", "heami", "google", "sora"];

const elements = {};
const announcedGuidance = new Set();
let currentGuidance = null;
let currentRouteId = "";
let lastVisualKey = "";
let voiceEnabled = false;
let voiceSupported = false;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function roundedDistance(meters) {
  if (meters >= 1000) return Math.round(meters / 100) * 100;
  return Math.max(0, Math.round(meters / 10) * 10);
}

function formatDistance(meters) {
  const rounded = roundedDistance(meters);
  if (rounded >= 1000) return `${(rounded / 1000).toFixed(1)}km`;
  return `${rounded}m`;
}

function instruction(step) {
  if (!step) return "목적지에 도착합니다";
  if (step.turn === "도착") return `${step.name} 도착`;
  if (step.turn === "출발") return `${step.name} 방향으로 출발`;
  if (step.turn === "직진") return `${step.name} 따라 직진`;
  return `${step.name}에서 ${step.turn}`;
}

function meaningfulRoadName(step) {
  const name = String(step?.name ?? "").trim();
  return GENERIC_ROAD_NAMES.has(name) ? "" : name;
}

function guidanceBucket(distance) {
  if (distance <= 15) return "now";
  if (distance <= 40) return "40";
  if (distance <= 100) return "100";
  if (distance <= 250) return "250";
  return "far";
}

function spokenGuidance(step, distance) {
  const name = meaningfulRoadName(step);
  if (step?.turn === "도착") {
    if (distance <= 15) return `${name || "목적지"}에 도착했습니다.`;
    return `${name || "목적지"}까지 ${roundedDistance(distance)}미터 남았습니다.`;
  }

  let command;
  if (step?.turn === "출발") command = name ? `${name} 방향으로 출발하세요` : "출발하세요";
  else if (step?.turn === "직진") command = name ? `${name} 방향으로 직진하세요` : "직진하세요";
  else command = name ? `${name}에서 ${step?.turn}하세요` : `${step?.turn || "직진"}하세요`;

  if (distance <= 15) return `잠시 후 ${command}.`;
  return `${roundedDistance(distance)}미터 앞에서 ${command}.`;
}

function voiceScore(voice) {
  const name = voice.name.toLowerCase();
  const hintIndex = VOICE_NAME_HINTS.findIndex((hint) => name.includes(hint));
  return (voice.lang.toLowerCase() === "ko-kr" ? 20 : 0)
    + (hintIndex >= 0 ? VOICE_NAME_HINTS.length - hintIndex : 0);
}

function koreanVoice() {
  return window.speechSynthesis.getVoices()
    .filter((voice) => voice.lang?.toLowerCase().startsWith("ko"))
    .sort((left, right) => voiceScore(right) - voiceScore(left))[0];
}

function speak(text) {
  if (!voiceSupported || !voiceEnabled || !text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ko-KR";
  utterance.rate = 0.92;
  utterance.pitch = 1;
  const voice = koreanVoice();
  if (voice) utterance.voice = voice;
  window.speechSynthesis.speak(utterance);
}

function setAnnouncement(message) {
  if (!elements.announcement || elements.announcement.textContent === message) return;
  elements.announcement.textContent = "";
  requestAnimationFrame(() => { elements.announcement.textContent = message; });
}

function syncVoiceButton() {
  if (!elements.voice) return;
  elements.voice.disabled = !voiceSupported;
  elements.voice.classList.toggle("is-active", voiceEnabled);
  elements.voice.setAttribute("aria-pressed", String(voiceEnabled));
  elements.voice.setAttribute(
    "aria-label",
    voiceSupported ? (voiceEnabled ? "음성 안내 끄기" : "음성 안내 켜기") : "음성 안내를 지원하지 않는 브라우저",
  );
  elements.voice.title = voiceSupported ? (voiceEnabled ? "음성 안내 끄기" : "음성 안내 켜기") : "음성 안내 미지원";
  elements.voice.innerHTML = `<i data-lucide="${voiceEnabled ? "volume-2" : "volume-x"}"></i>`;
  refreshIcons(elements.voice);
}

function renderNext(step, distance) {
  const visualKey = `${step?.turn}:${step?.name}:${formatDistance(distance)}`;
  if (visualKey === lastVisualKey) return;
  lastVisualKey = visualKey;
  elements.next.innerHTML = `
    <span class="turn-icon" aria-hidden="true"><i data-lucide="${TURN_ICONS[step?.turn] ?? "arrow-up"}"></i></span>
    <span><small>${formatDistance(distance)} 후</small><strong>${escapeHtml(instruction(step))}</strong></span>`;
  refreshIcons(elements.next);
}

function renderRoute(state) {
  const route = state.routeData?.options.find((item) => item.id === state.selectedRouteId);
  if (!route) return;
  const routeChanged = route.id !== currentRouteId;
  currentRouteId = route.id;
  if (routeChanged) {
    announcedGuidance.clear();
    lastVisualKey = "";
  }
  elements.progress.textContent = `남은 ${formatDistance(route.distance_m)} · ${Math.round(route.minutes)}분`;
  const steps = route.steps ?? [];
  const next = steps[1] ?? steps[0] ?? { turn: "도착", name: state.destination?.label ?? "목적지" };
  renderNext(next, Number(steps[0]?.dist_m) || 0);

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
  refreshIcons(elements.list);
}

export function updateNavigationGuidance({ step, distance = 0, key = "guidance" }) {
  if (!step || !elements.next) return;
  const safeDistance = Math.max(0, Number(distance) || 0);
  currentGuidance = { step, distance: safeDistance };
  renderNext(step, safeDistance);

  const bucketKey = `${currentRouteId}:${key}:${guidanceBucket(safeDistance)}`;
  if (announcedGuidance.has(bucketKey)) return;
  announcedGuidance.add(bucketKey);
  const message = spokenGuidance(step, safeDistance);
  setAnnouncement(message);
  speak(message);
}

export function resetNavigationGuidance() {
  currentGuidance = null;
  lastVisualKey = "";
  announcedGuidance.clear();
  voiceEnabled = false;
  if (voiceSupported) window.speechSynthesis.cancel();
  if (elements.announcement) elements.announcement.textContent = "";
  syncVoiceButton();
}

export function initSteps() {
  elements.progress = document.querySelector("#navigationProgress");
  elements.next = document.querySelector("#nextTurn");
  elements.list = document.querySelector("#stepList");
  elements.voice = document.querySelector("#voiceToggle");
  elements.announcement = document.querySelector("#navigationAnnouncement");
  voiceSupported = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  syncVoiceButton();

  elements.voice.addEventListener("click", () => {
    if (!voiceSupported) {
      setAnnouncement("이 브라우저에서는 음성 안내를 사용할 수 없습니다.");
      return;
    }
    voiceEnabled = !voiceEnabled;
    syncVoiceButton();
    if (!voiceEnabled) {
      window.speechSynthesis.cancel();
      setAnnouncement("음성 안내를 종료했습니다.");
      return;
    }
    const guidance = currentGuidance
      ? spokenGuidance(currentGuidance.step, currentGuidance.distance)
      : "경로를 따라 이동하세요.";
    const message = `음성 안내를 시작합니다. ${guidance}`;
    setAnnouncement(message);
    speak(message);
  });

  subscribe((state, actionName) => {
    if (["setRoutes", "selectRoute", "startNavigation", "subscribe"].includes(actionName)) renderRoute(state);
  });
}
