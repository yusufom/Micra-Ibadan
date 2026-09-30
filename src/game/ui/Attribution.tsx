"use client";

import { useWorldStore } from "@/game/store/worldStore";

/** Shown until manifest.json arrives, and if it never does. */
const FALLBACK = [
  { source: "OpenStreetMap", text: "© OpenStreetMap contributors (ODbL)", url: "https://www.openstreetmap.org/copyright" },
  { source: "Google Open Buildings", text: "Google Open Buildings v3 (CC BY 4.0)", url: "https://sites.research.google/open-buildings/" },
  {
    source: "Copernicus DEM GLO-30",
    text: "Copernicus DEM GLO-30 © DLR e.V. 2010-2014, © Airbus Defence and Space GmbH 2014-2018",
    url: "https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model",
  },
];

const SHORT: Record<string, string> = {
  OpenStreetMap: "© OpenStreetMap contributors",
  "Google Open Buildings": "Google Open Buildings (CC BY 4.0)",
  "Copernicus DEM GLO-30": "Copernicus DEM GLO-30 © DLR, Airbus",
};

/** Required data attribution, small in the bottom-right corner. Full text on hover. */
export function Attribution() {
  const fromManifest = useWorldStore((s) => s.attribution);
  const items = fromManifest.length ? fromManifest : FALLBACK;
  return (
    <div className="pointer-events-auto absolute right-1 bottom-1 max-w-[calc(100%-0.5rem)] rounded bg-black/45 px-1.5 py-0.5 text-right font-sans text-[10px] leading-tight text-white/80">
      {items.map((a, i) => (
        <span key={a.source}>
          {i > 0 && " · "}
          <a href={a.url} target="_blank" rel="noopener noreferrer" title={a.text} className="hover:text-white hover:underline">
            {SHORT[a.source] ?? a.source}
          </a>
        </span>
      ))}
    </div>
  );
}
