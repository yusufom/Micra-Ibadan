"use client";

import { useEffect, useState } from "react";
import { trafficStats } from "@/game/npc/traffic/trafficStats";
import { useWorldStore } from "@/game/store/worldStore";
import { GRADE_BANDS } from "@/game/world/debug/gradeBands";

/** Loading and missing-map notices, plus the debug key legend. */
export function WorldOverlay({ debugTools }: { debugTools: boolean }) {
  const status = useWorldStore((s) => s.status);
  const freeFly = useWorldStore((s) => s.freeFly);
  const showGrades = useWorldStore((s) => s.showGrades);
  const harmattan = useWorldStore((s) => s.harmattan);

  return (
    <>
      {status === "loading" && (
        <div className="pointer-events-none absolute inset-x-0 top-1/3 text-center font-mono text-sm text-white/80">Loading Ibadan…</div>
      )}
      {status === "missing" && (
        <div className="pointer-events-none absolute inset-x-4 top-1/3 mx-auto max-w-md rounded bg-black/70 p-3 text-center font-mono text-xs text-white/90">
          No map chunks in public/chunks/dugbe-ui. Build them with
          <br />
          <code>python -m pipeline build --area dugbe-ui</code>
        </div>
      )}
      {debugTools && (
        <div className="pointer-events-none absolute top-16 left-4 rounded bg-black/55 px-2 py-1.5 font-mono text-[11px] leading-snug text-white/85">
          <div>
            <b>F</b> free fly {freeFly ? "on" : "off"} · <b>G</b> grades {showGrades ? "on" : "off"} · <b>K</b> haze{" "}
            {harmattan ? "on" : "off"}
          </div>
          <div className="text-white/60">
            <b>[ ]</b> passengers · <b>L</b> luggage · <b>B</b> burst tyre · <b>N</b> condition −20 · <b>O</b> overheat
          </div>
          <TrafficLine />
          {freeFly && <div className="text-white/60">drag to look · WASD · E/Q up/down · Shift fast · wheel speed</div>}
          {showGrades && (
            <div className="mt-1 flex flex-wrap gap-x-2">
              {GRADE_BANDS.map((b) => (
                <span key={b.label} className="flex items-center gap-1">
                  <span className="inline-block h-2 w-3 rounded-sm" style={{ background: b.color }} />
                  {b.label}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Traffic counts, refreshed twice a second from trafficStats. */
function TrafficLine() {
  const [s, setS] = useState(() => ({ ...trafficStats }));
  useEffect(() => {
    const id = setInterval(() => setS({ ...trafficStats }), 500);
    return () => clearInterval(id);
  }, []);
  if (!s.enabled) return null;
  const kinds = Object.entries(s.byKind)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ");
  return (
    <div className="text-white/60">
      traffic {s.active}/{s.target} ({s.parked} parked) · bodies {s.physics} · {s.ms.toFixed(2)} ms · waving {s.hailers} · stolen {s.stolen} · horns {s.horns}
      <br />
      {kinds}
    </div>
  );
}
