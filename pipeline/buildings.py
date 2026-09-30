"""Building extrusion from Open Buildings footprints.

Height: OSM building:levels (or height) wins when an OSM building covers the
footprint; otherwise floors are picked from footprint area and zone. Every
random choice is seeded by the building id so rebuilds are stable.

Buildings sit on the flattened terrain at their lowest footprint corner, with
walls extended SKIRT_M below that so slopes never show a gap.
"""

from __future__ import annotations

import math
import zlib
from dataclasses import dataclass

import geopandas as gpd
import numpy as np
import shapely
import trimesh
from scipy import ndimage
from scipy.spatial import cKDTree

from .config import Area
from .fetch_dem import DemGrid
from .meshes import MeshBank, orient_faces, rgba
from .projection import to_game
from .roads import RoadEdge

SKIRT_M = 1.5
FLOOR_H = 3.1
GROUND_FLOOR_COMMERCIAL_H = 3.6
SIMPLIFY_M = 0.3
MIN_AREA_M2 = 12.0
ROOF_PITCH_DEG = 18.0
ROOF_OVERHANG_M = 0.4
MAJOR_ROADS = {"trunk", "primary", "secondary", "trunk_link", "primary_link", "secondary_link"}
FRONTAGE_M = 35.0

MATERIALS = ("plaster", "painted", "unfinished_block", "mud_brick", "glass")

# Wall material weights by zone. mud_brick is boosted inside old_areas.
MATERIAL_WEIGHTS = {
    "residential": {"plaster": 0.36, "painted": 0.30, "unfinished_block": 0.24, "mud_brick": 0.10},
    "old": {"plaster": 0.18, "painted": 0.14, "unfinished_block": 0.18, "mud_brick": 0.50},
    "commercial": {"plaster": 0.38, "painted": 0.36, "unfinished_block": 0.22, "glass": 0.04},
    "market": {"painted": 0.45, "unfinished_block": 0.35, "plaster": 0.20},
    "institutional": {"plaster": 0.55, "painted": 0.35, "unfinished_block": 0.10},
    "industrial": {"plaster": 0.40, "unfinished_block": 0.45, "painted": 0.15},
}

WALL_COLORS = {
    "plaster": [(0.86, 0.83, 0.76), (0.80, 0.78, 0.73), (0.90, 0.88, 0.82), (0.76, 0.75, 0.72)],
    "painted": [
        (0.93, 0.84, 0.55), (0.62, 0.78, 0.86), (0.72, 0.84, 0.62), (0.93, 0.70, 0.62),
        (0.85, 0.60, 0.62), (0.95, 0.95, 0.93), (0.80, 0.62, 0.45), (0.55, 0.66, 0.78),
    ],
    "unfinished_block": [(0.62, 0.61, 0.58), (0.58, 0.57, 0.54)],
    "mud_brick": [(0.60, 0.40, 0.28), (0.68, 0.50, 0.36), (0.55, 0.36, 0.25)],
    "glass": [(0.33, 0.46, 0.52), (0.28, 0.38, 0.45)],
}
ROOF_COLORS = {
    "roof_zinc_rusted": [(0.45, 0.26, 0.16), (0.52, 0.31, 0.19), (0.38, 0.22, 0.14)],
    "roof_zinc": [(0.72, 0.73, 0.74), (0.64, 0.66, 0.68)],
    "roof_concrete": [(0.62, 0.61, 0.59), (0.55, 0.54, 0.52)],
}

ZONE_PRIORITY = ["market", "institutional", "commercial", "industrial", "residential"]


@dataclass
class BuildingStats:
    total: int = 0
    osm_levels: int = 0
    removed_on_roads: int = 0
    trimmed_by_roads: int = 0
    by_material: dict = None
    by_roof: dict = None


def _rng(bid: str) -> np.random.Generator:
    return np.random.default_rng(zlib.crc32(bid.encode()))


def to_game_geoms(geoms) -> np.ndarray:
    """Project shapely geometries from lon/lat to game (x, z)."""

    def f(c):
        x, z = to_game(c[:, 0], c[:, 1])
        return np.stack([x, z], axis=1)

    return shapely.transform(np.asarray(geoms), f)


def _parse_float(v) -> float | None:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    try:
        return float(str(v).split(";")[0].replace("m", "").strip())
    except ValueError:
        return None


def _zones(features: gpd.GeoDataFrame) -> list[tuple[str, object]]:
    polys = features[features.geometry.geom_type.isin(["Polygon", "MultiPolygon"])]
    out = []
    for _, r in polys.iterrows():
        lu, am = r.get("landuse"), r.get("amenity")
        zone = None
        if am == "marketplace" or (lu == "retail" and "market" in str(r.get("name") or "").lower()):
            zone = "market"
        elif am in ("university", "college", "school", "hospital") or lu in ("education", "institutional", "military", "religious"):
            zone = "institutional"
        elif lu in ("commercial", "retail"):
            zone = "commercial"
        elif lu == "industrial":
            zone = "industrial"
        elif lu == "residential":
            zone = "residential"
        if zone:
            out.append((zone, r.geometry))
    return out


def _floors(rng, zone: str, area: float, old: bool) -> int:
    r = rng.random()
    if zone == "market":
        return 1 if area < 400 or r < 0.7 else 2
    if zone == "industrial":
        return 1 if area < 2000 or r < 0.6 else 2
    if zone == "institutional":
        if area < 200:
            return 1 if r < 0.6 else 2
        if area < 1000:
            return 2 if r < 0.6 else 3
        return int(rng.integers(2, 5))
    if zone == "commercial":
        if area < 60:
            return 1
        if area < 200:
            return 1 if r < 0.45 else (2 if r < 0.85 else 3)
        if area < 800:
            return int(rng.integers(2, 5))
        return int(rng.integers(3, 7))
    # residential
    if old:
        return 1 if r < 0.75 or area < 60 else 2
    if area < 40:
        return 1
    if area < 120:
        return 1 if r < 0.8 else 2
    if area < 300:
        return 1 if r < 0.45 else (2 if r < 0.85 else 3)
    if area < 800:
        return 2 if r < 0.55 else (3 if r < 0.9 else 4)
    return int(rng.integers(2, 5))


def _pick(rng, weights: dict[str, float]) -> str:
    keys = list(weights)
    p = np.asarray([weights[k] for k in keys], dtype=np.float64)
    return keys[int(rng.choice(len(keys), p=p / p.sum()))]


def _tint(rng, palette) -> np.ndarray:
    c = np.asarray(palette[int(rng.integers(len(palette)))]) * rng.uniform(0.93, 1.05)
    return rgba(np.clip(c, 0, 1))


def prepare_buildings(area: Area, ob: gpd.GeoDataFrame, osm_b: gpd.GeoDataFrame, features: gpd.GeoDataFrame, edges: list[RoadEdge]):
    """Project, clean and attribute footprints. Returns a list of dicts and stats."""
    stats = BuildingStats(by_material={}, by_roof={})
    geoms = to_game_geoms(ob.geometry.values)
    geoms = shapely.make_valid(shapely.simplify(geoms, SIMPLIFY_M, preserve_topology=True))
    ids = ob["building_id"].to_numpy()

    # Remove or trim footprints that sit on road corridors.
    corridors = np.array([shapely.buffer(shapely.LineString(e.xz), e.corridor_half_width, cap_style="flat") for e in edges if len(e.xz) > 1])
    tree = shapely.STRtree(corridors)
    bi, ci = tree.query(geoms, predicate="intersects")
    hits: dict[int, list[int]] = {}
    for b, c in zip(bi, ci):
        hits.setdefault(int(b), []).append(int(c))
    for b, cs in hits.items():
        g = geoms[b]
        cut = shapely.difference(g, shapely.union_all(corridors[cs]))
        if cut.is_empty or cut.area < 0.6 * g.area:
            geoms[b] = None
            stats.removed_on_roads += 1
            continue
        if cut.geom_type != "Polygon":
            parts = [p for p in getattr(cut, "geoms", []) if p.geom_type == "Polygon"]
            if not parts:
                geoms[b] = None
                stats.removed_on_roads += 1
                continue
            cut = max(parts, key=lambda p: p.area)
        geoms[b] = cut
        stats.trimmed_by_roads += 1

    # Only single polygons of useful size.
    keep = []
    for i, g in enumerate(geoms):
        if g is None or g.is_empty:
            continue
        if g.geom_type == "MultiPolygon":
            g = max(g.geoms, key=lambda p: p.area)
        if g.geom_type != "Polygon" or g.area < MIN_AREA_M2:
            continue
        keep.append((i, shapely.orient_polygons(g)))
    idx = np.array([k[0] for k in keep], dtype=int)
    polys = np.array([k[1] for k in keep], dtype=object)
    cents = shapely.centroid(polys)

    # OSM building attributes by centroid containment.
    osm_levels = np.full(len(polys), np.nan)
    osm_height = np.full(len(polys), np.nan)
    osm_name = np.full(len(polys), None, dtype=object)
    osm_kind = np.full(len(polys), None, dtype=object)
    if len(osm_b):
        og = to_game_geoms(osm_b.geometry.values)
        otree = shapely.STRtree(og)
        pi, oi = otree.query(cents, predicate="within")
        lv = osm_b.get("building:levels")
        ht = osm_b.get("height")
        nm = osm_b.get("name")
        kd = osm_b.get("building")
        for p, o in zip(pi, oi):
            if lv is not None:
                osm_levels[p] = _parse_float(lv.iloc[o]) or np.nan
            if ht is not None:
                osm_height[p] = _parse_float(ht.iloc[o]) or np.nan
            if nm is not None and isinstance(nm.iloc[o], str):
                osm_name[p] = nm.iloc[o]
            if kd is not None and isinstance(kd.iloc[o], str):
                osm_kind[p] = kd.iloc[o]

    # Zones.
    zone = np.full(len(polys), None, dtype=object)
    zlist = _zones(features)
    if zlist:
        zg = to_game_geoms([g for _, g in zlist])
        ztree = shapely.STRtree(zg)
        pi, zi = ztree.query(cents, predicate="within")
        for p, z in zip(pi, zi):
            new = zlist[z][0]
            cur = zone[p]
            if cur is None or ZONE_PRIORITY.index(new) < ZONE_PRIORITY.index(cur):
                zone[p] = new
    kind_zone = {
        "commercial": "commercial", "retail": "commercial", "office": "commercial", "supermarket": "commercial",
        "industrial": "industrial", "warehouse": "industrial",
        "church": "institutional", "mosque": "institutional", "school": "institutional",
        "university": "institutional", "hospital": "institutional", "public": "institutional",
        "house": "residential", "residential": "residential", "apartments": "residential",
    }
    major = [e for e in edges if e.highway in MAJOR_ROADS]
    ftree = cKDTree(np.concatenate([e.xz for e in major])) if major else None
    cx = shapely.get_x(cents)
    cz = shapely.get_y(cents)
    near_major = ftree.query(np.stack([cx, cz], axis=1), distance_upper_bound=FRONTAGE_M)[0] < FRONTAGE_M if ftree else np.zeros(len(polys), bool)

    old_boxes = [shapely.box(*to_game_bbox(a["bbox"])) for a in area.old_areas]
    old = np.zeros(len(polys), dtype=bool)
    for bx in old_boxes:
        old |= shapely.contains_xy(bx, cx, cz)

    out = []
    for k in range(len(polys)):
        bid = str(ids[idx[k]])
        rng = _rng(bid)
        poly = polys[k]
        a = poly.area
        z = zone[k] or kind_zone.get(osm_kind[k] or "", None)
        if z is None:
            z = "commercial" if near_major[k] else "residential"
        elif z == "residential" and near_major[k] and rng.random() < 0.6:
            z = "commercial"

        levels = osm_levels[k]
        height = osm_height[k]
        from_osm = not (np.isnan(levels) and np.isnan(height))
        if from_osm:
            stats.osm_levels += 1
            floors = int(levels) if not np.isnan(levels) else max(1, int(round(height / FLOOR_H)))
            h = height if not np.isnan(height) else floors * FLOOR_H
        else:
            floors = _floors(rng, z, a, bool(old[k]))
            h = floors * FLOOR_H + (GROUND_FLOOR_COMMERCIAL_H - FLOOR_H if z == "commercial" else 0)
            if z == "industrial":
                h = 5.5 * floors

        wz = "old" if old[k] and z == "residential" else z
        weights = dict(MATERIAL_WEIGHTS[wz])
        if z == "commercial" and floors >= 4 and a > 400:
            weights["glass"] = 0.35
        if floors >= 3:
            weights.pop("mud_brick", None)
        mat = _pick(rng, weights)

        rect = poly.minimum_rotated_rectangle
        rectangular = rect.area > 0 and a / rect.area > 0.85
        hip = mat != "glass" and floors <= 2 and rectangular and 30 <= a <= 600 and (z in ("residential", "market") or mat == "mud_brick")
        if hip:
            roof = "roof_zinc_rusted" if mat == "mud_brick" or rng.random() < 0.75 else "roof_zinc"
        elif mat == "mud_brick" or z == "market":
            roof = "roof_zinc_rusted"
        else:
            roof = "roof_concrete"

        stats.by_material[mat] = stats.by_material.get(mat, 0) + 1
        stats.by_roof[roof] = stats.by_roof.get(roof, 0) + 1
        out.append(
            {
                "id": bid,
                "poly": rect if hip else poly,
                "area": a,
                "zone": z,
                "floors": floors,
                "height": float(h),
                "material": mat,
                "roof": roof,
                "hip": hip,
                "name": osm_name[k],
                "wall_rgba": _tint(rng, WALL_COLORS[mat]),
                "roof_rgba": _tint(rng, ROOF_COLORS[roof]),
            }
        )
    stats.total = len(out)
    return out, stats


def to_game_bbox(bbox) -> tuple[float, float, float, float]:
    w, s, e, n = bbox
    xs, zs = [], []
    for lon in (w, e):
        for lat in (s, n):
            x, z = to_game(lon, lat)
            xs.append(x)
            zs.append(z)
    return min(xs), min(zs), max(xs), max(zs)


def _walls(ring: np.ndarray, y0: float, y1: float, color):
    """Quads for one closed ring (k+1, 2), outward normals, uv in metres."""
    p0 = ring[:-1]
    p1 = ring[1:]
    d = p1 - p0
    ln = np.linalg.norm(d, axis=1)
    ok = ln > 1e-3
    p0, p1, d, ln = p0[ok], p1[ok], d[ok], ln[ok]
    k = len(p0)
    if k == 0:
        return None
    out = np.stack([d[:, 1], np.zeros(k), -d[:, 0]], axis=1) / ln[:, None]
    pos = np.empty((k, 4, 3))
    pos[:, 0] = np.stack([p0[:, 0], np.full(k, y0), p0[:, 1]], axis=1)
    pos[:, 1] = np.stack([p1[:, 0], np.full(k, y0), p1[:, 1]], axis=1)
    pos[:, 2] = np.stack([p1[:, 0], np.full(k, y1), p1[:, 1]], axis=1)
    pos[:, 3] = np.stack([p0[:, 0], np.full(k, y1), p0[:, 1]], axis=1)
    u0 = np.concatenate([[0], np.cumsum(ln)[:-1]])
    uv = np.empty((k, 4, 2))
    uv[:, 0] = np.stack([u0, np.zeros(k)], axis=1)
    uv[:, 1] = np.stack([u0 + ln, np.zeros(k)], axis=1)
    uv[:, 2] = np.stack([u0 + ln, np.full(k, y1 - y0)], axis=1)
    uv[:, 3] = np.stack([u0, np.full(k, y1 - y0)], axis=1)
    base = np.arange(k)[:, None] * 4
    faces = np.concatenate([base + [0, 1, 2], base + [0, 2, 3]])
    nrm = np.repeat(out, 4, axis=0)
    pos = pos.reshape(-1, 3)
    faces = orient_faces(pos, faces, np.concatenate([out, out]))
    return pos, faces, nrm, uv.reshape(-1, 2), np.tile(color, (len(pos), 1))


def _flat_roof(poly, y: float, color):
    v2, f = trimesh.creation.triangulate_polygon(poly, engine="earcut")
    if len(f) == 0:
        return None
    pos = np.stack([v2[:, 0], np.full(len(v2), y), v2[:, 1]], axis=1)
    f = orient_faces(pos, np.asarray(f), np.array([0.0, 1.0, 0.0]))
    nrm = np.tile([0.0, 1.0, 0.0], (len(pos), 1))
    return pos, f, nrm, v2.copy(), np.tile(color, (len(pos), 1))


def _hip_roof(rect, eave: float, roof_color):
    """Hip roof over a rectangle, with overhanging eaves."""
    c = np.asarray(rect.exterior.coords)[:4]
    e0 = c[1] - c[0]
    e1 = c[2] - c[1]
    if np.linalg.norm(e0) >= np.linalg.norm(e1):
        a, b = e0, e1
    else:
        a, b = e1, e0
    L, W = np.linalg.norm(a), np.linalg.norm(b)
    a, b = a / L, b / W
    ctr = c.mean(axis=0)
    hl, hw = L / 2 + ROOF_OVERHANG_M, W / 2 + ROOF_OVERHANG_M
    rise = (W / 2) * math.tan(math.radians(ROOF_PITCH_DEG))
    r = max(hl - hw, 0.0)
    y0 = eave - ROOF_OVERHANG_M * math.tan(math.radians(ROOF_PITCH_DEG))
    y1 = eave + rise
    E = [ctr - a * hl - b * hw, ctr + a * hl - b * hw, ctr + a * hl + b * hw, ctr - a * hl + b * hw]
    R0, R1 = ctr - a * r, ctr + a * r
    P = lambda p, y: [p[0], y, p[1]]
    pos = np.array([P(E[0], y0), P(E[1], y0), P(E[2], y0), P(E[3], y0), P(R0, y1), P(R1, y1)])
    faces = np.array([[0, 1, 5], [0, 5, 4], [2, 3, 4], [2, 4, 5], [1, 2, 5], [3, 0, 4]])
    # Separate vertices per face for crisp shading.
    pos = pos[faces.ravel()]
    faces = np.arange(len(pos)).reshape(-1, 3)
    faces = orient_faces(pos, faces, np.array([0.0, 1.0, 0.0]))
    fn = np.cross(pos[faces[:, 1]] - pos[faces[:, 0]], pos[faces[:, 2]] - pos[faces[:, 0]])
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-9)
    # Face k owns vertices 3k..3k+2 (orientation only reorders within a face).
    nrm = np.repeat(fn, 3, axis=0)
    uv = np.stack([pos[:, 0], pos[:, 2]], axis=1)
    return pos, faces, nrm, uv, np.tile(roof_color, (len(pos), 1))


def add_building_meshes(buildings: list[dict], dem: DemGrid, heights: np.ndarray, bank: MeshBank) -> dict:
    """Extrude and add to the bank. Returns per-building base heights keyed by id."""
    base_y = {}
    for b in buildings:
        poly = b["poly"]
        ext = np.asarray(poly.exterior.coords)
        fi = (ext[:, 0] - dem.x0) / dem.spacing
        fj = (ext[:, 1] - dem.z0) / dem.spacing
        ground = ndimage.map_coordinates(heights, [fj, fi], order=1, mode="nearest")
        y0 = float(ground.min())
        y_top = y0 + b["height"]
        base_y[b["id"]] = y0
        c = poly.centroid
        key = bank.chunk_of(c.x, c.y)
        if key not in bank.valid:
            continue
        pri = b["area"]
        for ring in [ext] + [np.asarray(r.coords) for r in poly.interiors]:
            w = _walls(ring, y0 - SKIRT_M, y_top, b["wall_rgba"])
            if w:
                bank.add(b["material"], *w, key=key, priority=pri)
        if b["hip"]:
            r = _hip_roof(poly, y_top, b["roof_rgba"])
        else:
            try:
                r = _flat_roof(poly, y_top, b["roof_rgba"])
            except Exception:
                r = None
        if r:
            bank.add(b["roof"], *r, key=key, priority=pri)
    return base_y
