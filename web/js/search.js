import { searchPlaces } from "./api.js";
import { refreshIcons } from "./icons.js";
import { subscribe } from "./state.js";

const CATEGORY_ICONS = {
  역: "train-front",
  학교: "graduation-cap",
  공공: "landmark",
  동네: "map",
  행정: "map",
  병원: "hospital",
  공원: "trees",
  주소: "mailbox",
  건물: "building-2",
  아파트: "building",
  음식점: "utensils",
  카페: "coffee",
  상점: "store",
  체육시설: "dumbbell",
  장소: "map-pin",
};

const elements = {};
let mode = "origin";
let results = [];
let activeIndex = -1;
let searchTimer = null;
let requestSequence = 0;
let onSelect = () => {};
let onPick = () => {};
let onClear = () => {};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function inputFor(field) {
  return field === "origin" ? elements.origin : elements.destination;
}

function fieldFor(field) {
  return document.querySelector(`.place-field.is-${field}`);
}

function resultSubtitle(place) {
  const address = place.road_address || place.address;
  return address || `노원구 · ${place.cat || "장소"}`;
}

function renderResults() {
  if (!results.length) {
    elements.results.innerHTML = '<div class="search-empty">일치하는 노원구 장소나 주소가 없습니다.</div>';
    elements.results.hidden = false;
    return;
  }

  elements.results.innerHTML = results
    .map((place, index) => {
      const category = place.cat || "장소";
      const icon = CATEGORY_ICONS[category] ?? "map-pin";
      return `
        <button class="search-result${index === activeIndex ? " is-active" : ""}" type="button"
          role="option" aria-selected="${index === activeIndex}" data-result-index="${index}">
          <span class="category-icon" aria-hidden="true"><i data-lucide="${icon}"></i></span>
          <span>
            <strong>${escapeHtml(place.name)}</strong>
            <small>${escapeHtml(resultSubtitle(place))}</small>
          </span>
          <span class="result-category">${escapeHtml(category)}</span>
        </button>`;
    })
    .join("");
  elements.results.hidden = false;
  refreshIcons(elements.results);
}

async function runSearch(query) {
  const sequence = ++requestSequence;
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    closeResults();
    return;
  }

  try {
    const nextResults = await searchPlaces(cleanQuery);
    if (sequence !== requestSequence) return;
    results = nextResults;
    activeIndex = results.length ? 0 : -1;
    renderResults();
  } catch (error) {
    if (error.name === "AbortError") return;
    results = [];
    elements.results.innerHTML = `<div class="search-empty">${escapeHtml(error.message)}</div>`;
    elements.results.hidden = false;
  }
}

function choose(index, targetMode = mode) {
  const place = results[index];
  if (!place) return;
  inputFor(targetMode).value = place.name;
  closeResults();
  onSelect({ ...place, label: place.name }, targetMode);
}

function setActiveMode(nextMode, { focus = false, search = false } = {}) {
  mode = nextMode;
  for (const field of ["origin", "destination"]) {
    fieldFor(field)?.classList.toggle("is-active", field === mode);
  }
  if (focus) inputFor(mode).focus();
  if (search) runSearch(inputFor(mode).value);
}

function bindInput(field) {
  const input = inputFor(field);
  input.addEventListener("focus", () => setActiveMode(field, { search: true }));
  input.addEventListener("input", () => {
    setActiveMode(field);
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => runSearch(input.value), 170);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && results.length) {
      event.preventDefault();
      activeIndex = (activeIndex + 1) % results.length;
      renderResults();
    } else if (event.key === "ArrowUp" && results.length) {
      event.preventDefault();
      activeIndex = (activeIndex - 1 + results.length) % results.length;
      renderResults();
    } else if (event.key === "Escape") {
      closeResults();
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      choose(activeIndex, field);
    }
  });
}

function renderSuggestions(places) {
  elements.suggestions.innerHTML = places
    .slice(0, 4)
    .map(
      (place, index) => `
        <button class="suggestion-place" type="button" data-suggestion-index="${index}">
          <i data-lucide="map-pin" aria-hidden="true"></i>
          <span><strong>${escapeHtml(place.name)}</strong><small>${escapeHtml(place.cat || "장소")}</small></span>
          <i data-lucide="arrow-up-right" aria-hidden="true"></i>
        </button>`,
    )
    .join("");
  elements.suggestionPlaces = places.slice(0, 4);
  refreshIcons(elements.suggestions);
}

export function closeResults() {
  requestSequence += 1;
  clearTimeout(searchTimer);
  results = [];
  elements.results.hidden = true;
  activeIndex = -1;
}

export function setSearchMode(nextMode, options = {}) {
  setActiveMode(nextMode, { focus: options.focus !== false, search: Boolean(options.search) });
}

export function setPickingMode(nextMode) {
  for (const field of ["origin", "destination"]) {
    fieldFor(field)?.classList.toggle("is-picking", field === nextMode);
  }
}

export function resetSearch() {
  elements.origin.value = "";
  elements.destination.value = "";
  closeResults();
  setActiveMode("origin");
}

export function initSearch(options = {}) {
  onSelect = options.onSelect ?? onSelect;
  onPick = options.onPick ?? onPick;
  onClear = options.onClear ?? onClear;
  elements.form = document.querySelector("#routePlanner");
  elements.origin = document.querySelector("#originQuery");
  elements.destination = document.querySelector("#destinationQuery");
  elements.results = document.querySelector("#searchResults");
  elements.suggestions = document.querySelector("#searchSuggestions");
  elements.clearOrigin = document.querySelector("#clearOrigin");
  elements.clearDestination = document.querySelector("#clearDestination");
  elements.pickOrigin = document.querySelector("#pickOriginButton");
  elements.pickDestination = document.querySelector("#pickDestinationButton");

  bindInput("origin");
  bindInput("destination");
  elements.form.addEventListener("submit", (event) => event.preventDefault());
  elements.results.addEventListener("click", (event) => {
    const button = event.target.closest("[data-result-index]");
    if (button) choose(Number(button.dataset.resultIndex));
  });

  for (const field of ["origin", "destination"]) {
    const clear = field === "origin" ? elements.clearOrigin : elements.clearDestination;
    const pick = field === "origin" ? elements.pickOrigin : elements.pickDestination;
    clear.addEventListener("click", (event) => {
      event.preventDefault();
      inputFor(field).value = "";
      onClear(field);
      setActiveMode(field, { focus: true });
    });
    pick.addEventListener("click", (event) => {
      event.preventDefault();
      setActiveMode(field);
      onPick(field);
    });
  }

  elements.suggestions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-suggestion-index]");
    const place = elements.suggestionPlaces?.[Number(button?.dataset.suggestionIndex)];
    if (!place) return;
    const target = elements.origin.value ? "destination" : "origin";
    inputFor(target).value = place.name;
    onSelect({ ...place, label: place.name }, target);
  });

  document.addEventListener("pointerdown", (event) => {
    if (!elements.form.contains(event.target) && !elements.results.contains(event.target)) {
      closeResults();
    }
  });

  subscribe((state, actionName) => {
    if (["setOrigin", "setDestination", "swapEndpoints", "clearEndpoint", "resetAll"].includes(actionName)) {
      if (document.activeElement !== elements.origin) elements.origin.value = state.origin?.label ?? "";
      if (document.activeElement !== elements.destination) {
        elements.destination.value = state.destination?.label ?? "";
      }
    }
    elements.clearOrigin.hidden = !state.origin && !elements.origin.value;
    elements.clearDestination.hidden = !state.destination && !elements.destination.value;
  });

  searchPlaces("")
    .then(renderSuggestions)
    .catch(() => renderSuggestions([]));
  setActiveMode("origin");
}
