import { actions, subscribe } from "./state.js";

const SNAP_RATIOS = {
  peek: 96,
  half: 0.45,
  full: 0.88,
};

function snapHeight(name) {
  const value = SNAP_RATIOS[name];
  return value > 1 ? value : window.innerHeight * value;
}

export function initSheet({ onResize } = {}) {
  const sheet = document.querySelector("#routeSheet");
  const handle = document.querySelector("#sheetHandle");
  let drag = null;
  let moved = false;

  const observer = new ResizeObserver(() => {
    if (!sheet.hidden) onResize?.(sheet.getBoundingClientRect().height);
  });
  observer.observe(sheet);

  handle.addEventListener("pointerdown", (event) => {
    if (window.matchMedia("(min-width: 901px)").matches) return;
    drag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: sheet.getBoundingClientRect().height,
    };
    moved = false;
    sheet.classList.add("is-dragging");
    handle.setPointerCapture(event.pointerId);
  });

  handle.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const delta = drag.startY - event.clientY;
    if (Math.abs(delta) > 4) moved = true;
    const height = Math.max(96, Math.min(window.innerHeight * 0.88, drag.startHeight + delta));
    sheet.style.height = `${height}px`;
    onResize?.(height);
  });

  function finishDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const height = sheet.getBoundingClientRect().height;
    const nearest = Object.keys(SNAP_RATIOS).reduce((best, name) =>
      Math.abs(snapHeight(name) - height) < Math.abs(snapHeight(best) - height) ? name : best,
    );
    sheet.classList.remove("is-dragging");
    sheet.style.height = "";
    drag = null;
    actions.setSheetSnap(nearest);
  }

  handle.addEventListener("pointerup", finishDrag);
  handle.addEventListener("pointercancel", finishDrag);
  handle.addEventListener("click", () => {
    if (moved || window.matchMedia("(min-width: 901px)").matches) return;
    const current = sheet.dataset.snap;
    actions.setSheetSnap(current === "peek" ? "half" : current === "half" ? "full" : "half");
  });

  subscribe((state) => {
    sheet.dataset.snap = state.sheetSnap;
    requestAnimationFrame(() => {
      if (!sheet.hidden) onResize?.(sheet.getBoundingClientRect().height);
    });
  });

  window.addEventListener("resize", () => {
    if (!sheet.hidden) onResize?.(sheet.getBoundingClientRect().height);
  });
}
