export const BASE_MAP_STYLE = {
  version: 8,
  sources: {
    carto: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    },
    cartoDark: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    },
  },
  layers: [
    {
      id: "carto-base",
      type: "raster",
      source: "carto",
      paint: {
        "raster-saturation": -0.08,
        "raster-contrast": 0.04,
        "raster-fade-duration": 180,
      },
    },
    {
      id: "carto-dark-base",
      type: "raster",
      source: "cartoDark",
      paint: {
        "raster-opacity": 0,
        "raster-brightness-max": 0.78,
        "raster-contrast": 0.16,
        "raster-saturation": -0.82,
        "raster-fade-duration": 180,
      },
    },
  ],
};

export const DARK_3D_MAP_STYLE = {
  version: 8,
  sources: {
    cartoDark: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    },
    carto: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    },
  },
  layers: [
    {
      id: "carto-dark-base",
      type: "raster",
      source: "cartoDark",
      paint: {
        "raster-brightness-max": 0.78,
        "raster-contrast": 0.16,
        "raster-saturation": -0.82,
        "raster-fade-duration": 180,
      },
    },
    {
      id: "carto-base",
      type: "raster",
      source: "carto",
      paint: {
        "raster-opacity": 0,
        "raster-saturation": -0.32,
        "raster-contrast": 0.08,
        "raster-fade-duration": 180,
      },
    },
  ],
};

export function applyMapTheme(map, theme) {
  if (!map?.getLayer("carto-base") || !map?.getLayer("carto-dark-base")) return;
  const dark = theme === "dark";
  map.setPaintProperty("carto-base", "raster-opacity-transition", { duration: 360, delay: 0 });
  map.setPaintProperty("carto-dark-base", "raster-opacity-transition", { duration: 360, delay: 0 });
  map.setPaintProperty("carto-base", "raster-opacity", dark ? 0 : 1);
  map.setPaintProperty("carto-dark-base", "raster-opacity", dark ? 1 : 0);
}
