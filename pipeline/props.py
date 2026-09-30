"""Street props and building colliders for the chunk JSON.

Props are placements only (type, position, yaw); the game draws them with
instanced meshes. Every random choice is seeded by a way or feature id so
rebuilds are stable. A prop is dropped if its footprint touches a building or
another road's corridor.

Yaw is about +Y with 0 = north, like spawn points: the prop's local forward
(-Z) faces the road it serves.
"""

from __future__ import annotations

import math
import zlib

import numpy as np
import shapely
from shapely import affinity

from .roads import RoadEdge

POLE_SPACING_M = 38.0
POLE_SETBACK_M = 0.8
POLE_CLASSES = {"primary", "secondary", "tertiary", "residential", "unclassified", "trunk"}
JUNCTION_CLEAR_M = 10.0

KIOSK_SIZE = (2.2, 1.8)  # width along the road, depth
KIOSK_SETBACK_M = 1.2
KIOSK_EVERY_M = 55.0
KIOSK_CHANCE = {"trunk": 0.3, "primary": 0.4, "secondary": 0.4, "tertiary": 0.25, "residential": 0.06, "unclassified": 0.08}

SHED_SIZE = (7.0, 5.0)
SHED_SETBACK_M = 2.0
SHED_EVERY_M = 140.0
SHED_CHANCE = {"trunk": 0.2, "primary": 0.3, "secondary": 0.3, "tertiary": 0.2, "unclassified": 0.08}

GARAGE_SHELTER_SIZE = (14.0, 5.0)

MAX_HULL_POINTS = 8


def _rng(key: str) -> np.random.Generator:
    return np.random.default_rng(zlib.crc32(key.encode()))


def _r(v, n=2):
    return round(float(v), n)


def _yaw_facing(dx: float, dz: float) -> float:
    """Yaw about +Y so local forward (-Z) points along (dx, dz). 0 = north."""
    return math.atan2(-dx, -dz)


def _rect(x: float, z: float, w: float, d: float, yaw: float):
    """Footprint of a w (local x) by d (local z) box at (x, z) rotated by yaw."""
    r = shapely.box(-w / 2, -d / 2, w / 2, d / 2)
    # three.js rotation about +Y maps local (x, z) to (x cos + z sin, -x sin + z cos).
    # shapely rotates counter-clockwise in the (x, z) plane, which is the opposite sense.
    r = affinity.rotate(r, -yaw, origin=(0, 0), use_radians=True)
    return affinity.translate(r, x, z)


class _Blockers:
    """Buildings, road corridors and props already placed (hashed on a coarse grid)."""

    CELL = 20.0

    def __init__(self, building_polys, edges: list[RoadEdge]):
        corr = [shapely.buffer(shapely.LineString(e.xz), e.corridor_half_width, cap_style="flat") for e in edges if len(e.xz) > 1]
        self.static = shapely.STRtree(np.array(list(building_polys) + corr, dtype=object))
        self.placed: dict[tuple[int, int], list] = {}

    def _cells(self, geom):
        x0, z0, x1, z1 = geom.bounds
        c = self.CELL
        for i in range(math.floor(x0 / c), math.floor(x1 / c) + 1):
            for j in range(math.floor(z0 / c), math.floor(z1 / c) + 1):
                yield i, j

    def free(self, geom) -> bool:
        if len(self.static.query(geom, predicate="intersects")):
            return False
        return not any(geom.intersects(p) for k in self._cells(geom) for p in self.placed.get(k, ()))

    def take(self, geom) -> None:
        for k in self._cells(geom):
            self.placed.setdefault(k, []).append(geom)


def _sample_at(e: RoadEdge, s: float):
    i = min(int(np.searchsorted(e.s, s)), len(e.s) - 1)
    return e.xz[i], e.nrm[i]


def building_colliders(buildings: list[dict], base_y: dict[str, float], skirt: float) -> list[dict]:
    """One collider per building: a box for near-rectangular footprints, else a convex hull."""
    out = []
    for b in buildings:
        y0 = base_y.get(b["id"])
        if y0 is None:
            continue
        poly = b["poly"]
        y_lo, y_hi = _r(y0 - skirt), _r(y0 + b["height"])
        rect = poly.minimum_rotated_rectangle
        c = poly.centroid
        rec = {"id": b["id"], "cx": c.x, "cz": c.y}
        if rect.area > 0 and poly.area / rect.area > 0.85:
            p = np.asarray(rect.exterior.coords)[:4]
            a, bb = p[1] - p[0], p[2] - p[1]
            la, lb = np.linalg.norm(a), np.linalg.norm(bb)
            ctr = p.mean(axis=0)
            # Local +X runs along a; three.js yaw maps local +X to (cos, -sin).
            yaw = math.atan2(-a[1], a[0])
            rec.update({"shape": "box", "x": _r(ctr[0]), "z": _r(ctr[1]), "hx": _r(la / 2), "hz": _r(lb / 2), "yaw": _r(yaw, 4), "y0": y_lo, "y1": y_hi})
        else:
            hull = poly.convex_hull.simplify(0.5)
            pts = np.asarray(hull.exterior.coords)[:-1]
            if len(pts) > MAX_HULL_POINTS:
                hull = hull.simplify(1.5)
                pts = np.asarray(hull.exterior.coords)[:-1]
            rec.update({"shape": "hull", "pts": [[_r(x), _r(z)] for x, z in pts], "y0": y_lo, "y1": y_hi})
        out.append(rec)
    return out


def place_props(edges: list[RoadEdge], nodes: dict, building_polys, sample_height, stops, garages, pois) -> list[dict]:
    """All props in the area as dicts with world x, y, z and yaw."""
    blockers = _Blockers(building_polys, edges)
    edges_by_id = {e.id: e for e in edges}
    props: list[dict] = []

    def add(kind: str, x: float, z: float, yaw: float, footprint, **extra) -> bool:
        if footprint is not None:
            if not blockers.free(footprint):
                return False
            blockers.take(footprint)
        props.append({"type": kind, "x": x, "z": z, "yaw": _r(yaw, 3), **extra})
        return True

    # Garage shelters and name boards come first so nothing crowds them out.
    for g in garages:
        road = g.get("road")
        e = edges_by_id.get(road["edgeId"]) if road else None
        if e is None:
            continue
        p, n = _sample_at(e, road["s"])
        side = 1.0 if road["side"] == "right" else -1.0
        to_road = -n * side
        yaw = _yaw_facing(*to_road)
        w, d = GARAGE_SHELTER_SIZE
        # Sit the shelter between the garage point and the road edge.
        back = e.corridor_half_width + d / 2 + 1.0
        sx, sz = p + n * side * max(back, min(road["distance"], back + 8.0))
        add("garage_shelter", sx, sz, yaw, None)
        bx, bz = p + n * side * (e.corridor_half_width + 0.6)
        add("garage_board", bx, bz, yaw, None, name=g["name"])
        blockers.take(_rect(sx, sz, w, d, yaw))

    # Kiosk clusters at bus stops and markets.
    for src, count in ((stops, 3), ([p for p in pois if p["type"] == "market"], 8)):
        for f in src:
            road = f.get("road")
            e = edges_by_id.get(road["edgeId"]) if road else None
            if e is None:
                continue
            rng = _rng(f"kiosk:{f['id']}")
            side = 1.0 if road["side"] == "right" else -1.0
            placed = 0
            for k in range(count * 3):
                if placed >= count:
                    break
                s = road["s"] + (k // 2 + 1) * 3.2 * (1 if k % 2 == 0 else -1) + rng.uniform(-0.5, 0.5)
                if not (2.0 < s < e.length - 2.0):
                    continue
                p, n = _sample_at(e, s)
                off = e.corridor_half_width + KIOSK_SETBACK_M + KIOSK_SIZE[1] / 2 + rng.uniform(0, 1.5)
                x, z = p + n * side * off
                yaw = _yaw_facing(*(-n * side))
                if add("kiosk", x, z, yaw, _rect(x, z, *KIOSK_SIZE, yaw), variant=int(rng.integers(4))):
                    placed += 1

    for e in edges:
        cls = e.highway.replace("_link", "")
        if e.bridge or len(e.xz) < 2:
            continue
        rng = _rng(f"props:{e.way_id}:{e.id}")
        u, v = nodes.get(e.u), nodes.get(e.v)
        clear0 = JUNCTION_CLEAR_M if u is None or u.degree > 1 else 2.0
        clear1 = JUNCTION_CLEAR_M if v is None or v.degree > 1 else 2.0

        # Electric poles on one side, chained so the game can string wires.
        if cls in POLE_CLASSES and e.length > 2 * JUNCTION_CLEAR_M:
            side = 1.0 if (e.way_id % 2) else -1.0
            prev = None
            for s in np.arange(clear0 + rng.uniform(0, 8), e.length - clear1, POLE_SPACING_M * rng.uniform(0.9, 1.1)):
                p, n = _sample_at(e, s)
                x, z = p + n * side * (e.corridor_half_width + POLE_SETBACK_M)
                fp = shapely.Point(x, z).buffer(0.25, quad_segs=2)
                if not blockers.free(fp):
                    prev = None
                    continue
                blockers.take(fp)
                rec = {"type": "pole", "x": x, "z": z, "yaw": _r(_yaw_facing(*(-n * side)), 3)}
                props.append(rec)
                if prev is not None:
                    prev["next"] = [x, z]
                prev = rec

        # Kiosks along busy frontage.
        chance = KIOSK_CHANCE.get(cls, 0.0)
        if chance:
            for s in np.arange(clear0 + 5, e.length - clear1 - 5, KIOSK_EVERY_M):
                if rng.random() > chance:
                    continue
                side = rng.choice([-1.0, 1.0])
                s2 = s + rng.uniform(-10, 10)
                if not (clear0 < s2 < e.length - clear1):
                    continue
                p, n = _sample_at(e, s2)
                off = e.corridor_half_width + KIOSK_SETBACK_M + KIOSK_SIZE[1] / 2
                x, z = p + n * side * off
                yaw = _yaw_facing(*(-n * side))
                add("kiosk", x, z, yaw, _rect(x, z, *KIOSK_SIZE, yaw), variant=int(rng.integers(4)))

        # Roadside mechanic sheds on the main roads.
        chance = SHED_CHANCE.get(cls, 0.0)
        if chance:
            for s in np.arange(clear0 + 10, e.length - clear1 - 10, SHED_EVERY_M):
                if rng.random() > chance:
                    continue
                side = rng.choice([-1.0, 1.0])
                p, n = _sample_at(e, s + rng.uniform(-20, 20))
                off = e.corridor_half_width + SHED_SETBACK_M + SHED_SIZE[1] / 2
                x, z = p + n * side * off
                yaw = _yaw_facing(*(-n * side))
                add("mechanic_shed", x, z, yaw, _rect(x, z, *SHED_SIZE, yaw), variant=int(rng.integers(3)))

    # Heights last, in one vectorised pass.
    xs = np.array([p["x"] for p in props])
    zs = np.array([p["z"] for p in props])
    ys = sample_height(xs, zs) if len(props) else []
    for p, y in zip(props, ys):
        p["x"], p["y"], p["z"] = _r(p["x"]), _r(y), _r(p["z"])
    poles = [p for p in props if p["type"] == "pole"]
    if poles:
        nx = np.array([p["next"][0] if "next" in p else p["x"] for p in poles])
        nz = np.array([p["next"][1] if "next" in p else p["z"] for p in poles])
        ny = sample_height(nx, nz)
        for p, x, y, z in zip(poles, nx, ny, nz):
            if "next" in p:
                p["next"] = [_r(x), _r(y), _r(z)]
    return props

