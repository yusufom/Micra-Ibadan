"use client";

import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry, Color, LineBasicMaterial, LineSegments } from "three";
import type { RoadEdge } from "../chunks/types";
import { GRADE_BANDS } from "./gradeBands";

/** Drawn this far above the road so the lines clear the surface and drains. */
const LIFT_M = 0.8;

const bandColors = GRADE_BANDS.map((b) => new Color(b.color));

function colorFor(gradePct: number): Color {
  const g = Math.abs(gradePct);
  return bandColors[GRADE_BANDS.findIndex((b) => g < b.max)];
}

/**
 * Debug overlay (G): every road graph edge from the manifest as lines,
 * coloured per polyline segment by its own grade, so short steep stretches
 * stand out even on an edge whose average grade is gentle.
 */
export function GradeOverlay({ edges }: { edges: RoadEdge[] }) {
  const lines = useMemo(() => {
    let segs = 0;
    for (const e of edges) segs += Math.max(0, e.polyline.length - 1);
    const pos = new Float32Array(segs * 6);
    const col = new Float32Array(segs * 6);
    let o = 0;
    for (const e of edges) {
      const p = e.polyline;
      for (let i = 0; i < p.length - 1; i++) {
        const [x0, y0, z0] = p[i];
        const [x1, y1, z1] = p[i + 1];
        const run = Math.hypot(x1 - x0, z1 - z0);
        const c = colorFor(run > 0.5 ? ((y1 - y0) / run) * 100 : e.grade);
        pos.set([x0, y0 + LIFT_M, z0, x1, y1 + LIFT_M, z1], o);
        col.set([c.r, c.g, c.b, c.r, c.g, c.b], o);
        o += 6;
      }
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(pos, 3));
    g.setAttribute("color", new BufferAttribute(col, 3));
    g.computeBoundingSphere();
    const m = new LineBasicMaterial({ vertexColors: true, fog: false, toneMapped: false });
    const l = new LineSegments(g, m);
    l.name = "grade-overlay";
    l.renderOrder = 2;
    return l;
  }, [edges]);

  useEffect(
    () => () => {
      lines.geometry.dispose();
      (lines.material as LineBasicMaterial).dispose();
    },
    [lines],
  );

  return <primitive object={lines} />;
}
