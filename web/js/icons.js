const ICONS = {
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h6.5a3.5 3.5 0 0 0 0-7H8.5a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  "map-pin": '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  "arrow-up-down": '<path d="m3 8 4-4 4 4M7 4v16M21 16l-4 4-4-4M17 20V4"/>',
  pencil: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  "locate-fixed": '<line x1="2" x2="5" y1="12" y2="12"/><line x1="19" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="5"/><line x1="12" x2="12" y1="19" y2="22"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/>',
  crosshair: '<circle cx="12" cy="12" r="9"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><circle cx="12" cy="12" r="2"/>',
  "sun-medium": '<circle cx="12" cy="12" r="4"/><path d="M12 3v1M12 20v1M3 12h1M20 12h1M5.6 5.6l.7.7M17.7 17.7l.7.7M18.4 5.6l-.7.7M6.3 17.7l-.7.7"/>',
  boxes: '<path d="m7.5 4.3 4.5 2.6 4.5-2.6L12 1.7Z"/><path d="m3 11 4.5 2.6L12 11l-4.5-2.6Z"/><path d="m12 11 4.5 2.6L21 11l-4.5-2.6Z"/><path d="M7.5 13.6V19l4.5 2.6V16.2ZM16.5 13.6V19L12 21.6V16.2Z"/>',
  "clock-3": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5h5"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-up": '<path d="m18 15-6-6-6 6"/>',
  moon: '<path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z"/>',
  navigation: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
  "arrow-left": '<path d="m15 18-6-6 6-6M9 12h12"/>',
  "volume-2": '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8 8 0 0 1 0 12"/>',
  "volume-x": '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="m22 9-6 6M16 9l6 6"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  "train-front": '<rect x="4" y="3" width="16" height="16" rx="3"/><path d="M8 19l-2 3M16 19l2 3M8 8h8M8 14h.01M16 14h.01"/>',
  "graduation-cap": '<path d="m2 10 10-5 10 5-10 5Z"/><path d="M6 12v5c3 2 9 2 12 0v-5M22 10v6"/>',
  landmark: '<path d="m3 10 9-6 9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 21h18"/>',
  map: '<polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21 3 6"/><path d="M9 3v15M15 6v15"/>',
  hospital: '<path d="M4 21V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16M9 21v-5h6v5M9 8h6M12 5v6"/>',
  trees: '<path d="m12 3-4 6h3l-5 7h5v5h2v-5h5l-5-7h3Z"/>',
  "corner-up-left": '<path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v5"/>',
  "corner-up-right": '<path d="m15 14 5-5-5-5M20 9H10a6 6 0 0 0-6 6v5"/>',
  "arrow-up": '<path d="m18 9-6-6-6 6M12 3v18"/>',
  "arrow-up-right": '<path d="M7 17 17 7M7 7h10v10"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/>',
  focus: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/><circle cx="12" cy="12" r="3"/>',
  "rotate-3d": '<path d="M5 3v4h4M5.5 7A8 8 0 1 1 4 15"/><path d="m12 8 4 2.3v4.6L12 17.2 8 14.9v-4.6Z"/>',
  "rotate-ccw": '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  sparkles: '<path d="m12 3-1.2 3.2L8 7.5l2.8 1.3L12 12l1.2-3.2L16 7.5l-2.8-1.3Z"/><path d="m5 14-.8 2.2L2 17l2.2.8L5 20l.8-2.2L8 17l-2.2-.8ZM19 13l-.9 2.6-2.6.9 2.6.9L19 20l.9-2.6 2.6-.9-2.6-.9Z"/>',
  "building-2": '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18M2 22h20M9 6h1M14 6h1M9 10h1M14 10h1M9 14h1M14 14h1M10 22v-4h4v4"/>',
  building: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M16 6h.01M8 10h.01M16 10h.01M8 14h.01M16 14h.01"/>',
  mailbox: '<path d="M22 17H4a2 2 0 0 1-2-2v-5a4 4 0 0 1 4-4h12a4 4 0 0 1 4 4Z"/><path d="M6 6v11M14 6v4h4M14 10h4M10 21v-4"/>',
  utensils: '<path d="M3 2v7c0 1.7 1.3 3 3 3s3-1.3 3-3V2M6 2v20M21 15V2c-3 1.2-5 4.1-5 8v5h5Zm0 0v7"/>',
  coffee: '<path d="M10 2v2M14 2v2M6 2v2M18 8h1a3 3 0 0 1 0 6h-1M4 8h14v6a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6ZM4 22h16"/>',
  store: '<path d="M3 9 5 3h14l2 6M5 13v8h14v-8M9 21v-6h6v6"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/>',
  dumbbell: '<path d="m6.5 6.5 11 11M3.5 10l-1.2 1.2a2.4 2.4 0 0 0 0 3.4l2.1 2.1a2.4 2.4 0 0 0 3.4 0L9 15.5M15 8.5l1.2-1.2a2.4 2.4 0 0 1 3.4 0l2.1 2.1a2.4 2.4 0 0 1 0 3.4L20.5 14M5.5 4 4 5.5M20 18.5 18.5 20"/>',
  "circle-dot": '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>',
  "undo-2": '<path d="M9 7 4 12l5 5M4 12h9a6 6 0 0 1 6 6v1"/>',
  flag: '<path d="M5 22V4M5 4h12l-2 4 2 4H5"/>',
};

export function refreshIcons(root = document) {
  for (const element of root.querySelectorAll("i[data-lucide]")) {
    const name = element.dataset.lucide;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.dataset.icon = name;
    svg.innerHTML = ICONS[name] ?? ICONS["map-pin"];
    element.replaceWith(svg);
  }
}
