import { refreshIcons } from "./icons.js";

const STORAGE_KEY = "gneulro-theme";

function storedTheme(fallback) {
  const queryTheme = new URLSearchParams(window.location.search).get("theme");
  if (["light", "dark"].includes(queryTheme)) return queryTheme;
  const saved = localStorage.getItem(STORAGE_KEY);
  return ["light", "dark"].includes(saved) ? saved : fallback;
}

function syncThemeButton(button, theme) {
  if (!button) return;
  const nextLabel = theme === "dark" ? "라이트" : "다크";
  button.setAttribute("aria-label", `${nextLabel} 모드로 전환`);
  button.setAttribute("title", `${nextLabel} 모드로 전환`);
  button.setAttribute("aria-pressed", String(theme === "dark"));
  const label = button.classList.contains("map-tool") ? `<span>${nextLabel}</span>` : "";
  button.innerHTML = `<i data-lucide="${theme === "dark" ? "sun" : "moon"}"></i>${label}`;
  refreshIcons(button);
}

export function initTheme({ button, fallback = "light", onChange = () => {} } = {}) {
  let theme = storedTheme(fallback);
  const apply = (nextTheme, { persist = false } = {}) => {
    theme = nextTheme;
    document.body.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content",
      theme === "dark" ? "#111718" : "#f3f6f2",
    );
    if (persist) localStorage.setItem(STORAGE_KEY, theme);
    syncThemeButton(button, theme);
    onChange(theme);
  };

  button?.addEventListener("click", () => apply(theme === "dark" ? "light" : "dark", { persist: true }));
  apply(theme);
  return { get value() { return theme; }, set: apply };
}
