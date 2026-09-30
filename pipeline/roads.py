"""Road graph and road meshes.

Nodes are junctions (and dead ends). Each edge is one OSM way between two
junctions, with a dense 3D centreline whose height profile follows the
smoothed terrain along its length. The same profile, plus a cross slope capped
at area.road_max_cross_slope, drives both the road mesh and terrain flattening
(terrain.py), so the two always agree.
"""

from __future__ import annotations

import ast
import math
import re
import zlib
from dataclasses import dataclass

import networkx as nx
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
from shapely.geometry import MultiPoint

from .config import Area
from .fetch_dem import DemGrid
from .meshes import MeshBank, orient_faces, rgba, sweep, vertex_normals
from .projection import to_game

SAMPLE_SPACING = 2.0  # metres between centreline samples
PROFILE_SMOOTH_M = 10.0  # 1D smoothing of the height profile along the road
GRADE_WINDOW_M = 20.0
ROAD_LIFT = 0.05  # road mesh sits this far above the flattened terrain
PATCH_LIFT = 0.07

# Drain cross-section beyond the road edge: (lateral offset from edge, height).
DRAIN_WALL = 0.12
DRAIN_WIDTH = 0.5
DRAIN_DEPTH_LIP = 0.3  # wall height above road
DRAIN_ZONE = 2 * DRAIN_WALL + DRAIN_WIDTH
VERGE = 0.3  # flattened strip beyond the edge on roads without drains

# (two-way total lanes, one-way lanes, lane width m, default speed km/h)
CLASS_DEFAULTS = {
    "motorway": (4, 2, 3.5, 100),
    "trunk": (4, 2, 3.5, 80),
    "primary": (2, 2, 3.4, 60),
    "secondary": (2, 2, 3.2, 50),
    "tertiary": (2, 1, 3.0, 50),
    "unclassified": (2, 1, 2.8, 40),
    "residential": (2, 1, 2.75, 30),
    "living_street": (1, 1, 2.75, 20),
    "service": (1, 1, 2.75, 20),
    "road": (2, 1, 2.8, 40),
    "busway": (2, 1, 3.2, 50),
}
LINK_DEFAULTS = (2, 1, 3.2, 40)

# Share of untagged roads that are paved, by class. Deterministic per way id.
PAVED_SHARE = {
    "unclassified": 0.7,
    "residential": 0.55,
    "living_street": 0.5,
    "service": 0.6,
    "road": 0.6,
}
PAVED_SURFACES = {
    "asphalt", "paved", "concrete", "concrete:plates", "concrete:lanes", "paving_stones",
    "sett", "cobblestone", "chipseal", "bricks", "metal", "wood", "unhewn_cobblestone",
}
NO_DRAIN_CLASSES = {"motorway", "service", "living_street"}


@dataclass
class RoadNode:
    id: int
    x: float
    z: float
    y: float = 0.0
    degree: int = 0


@dataclass
class RoadEdge:
    id: int
    u: int
    v: int
    way_id: int
    name: str | None
    ref: str | None
    highway: str
    lanes: int
    lanes_tagged: bool
    oneway: bool
    speed_kph: int
    speed_tagged: bool
    surface: str  # "paved" | "unpaved"
    surface_tag: str | None
    bridge: bool
    lane_width: float
    xz: np.ndarray  # (n,2) dense centreline
    s: np.ndarray  # (n,) distance along
    nrm: np.ndarray  # (n,2) unit lateral (right of travel u->v)
    hc: np.ndarray = None  # (n,) centre height
    cs: np.ndarray = None  # (n,) cross slope (dh per m to the right)
    grade: float = 0.0  # % from u to v
    max_grade: float = 0.0  # steepest GRADE_WINDOW_M stretch, %

    @property
    def length(self) -> float:
        return float(self.s[-1])

    @property
    def width(self) -> float:
        return self.lanes * self.lane_width

    @property
    def half_width(self) -> float:
        return self.width / 2

    @property
    def has_drains(self) -> bool:
        return self.surface == "paved" and not self.bridge and self.highway.replace("_link", "") not in NO_DRAIN_CLASSES

    @property
    def corridor_half_width(self) -> float:
        """Half width of the flattened strip: road plus drains or verge."""
        return self.half_width + (DRAIN_ZONE if self.has_drains else VERGE)


# --- tag parsing -----------------------------------------------------------


def _one(v):
    if isinstance(v, str) and v.startswith("["):
        try:
            v = ast.literal_eval(v)
        except (ValueError, SyntaxError):
            return v
    if isinstance(v, (list, tuple)):
        return v[0] if v else None
    if isinstance(v, float) and math.isnan(v):
        return None
    return v


def _num(v) -> float | None:
    v = _one(v)
    if v is None:
        return None
    nums = re.findall(r"\d+(?:\.\d+)?", str(v))
    return max(float(n) for n in nums) if nums else None


def _speed(v) -> int | None:
    v = _one(v)
    if v is None:
        return None
    s = str(v).lower()
    if s in ("ng:urban",):
        return 50
    if s in ("ng:rural",):
        return 80
    n = _num(s)
    if n is None:
        return None
    return int(round(n * 1.609)) if "mph" in s else int(n)


def _truthy(v) -> bool:
    v = _one(v)
    return str(v).lower() in ("yes", "true", "1", "viaduct")


def _seed_rng(key: str) -> np.random.Generator:
    return np.random.default_rng(zlib.crc32(key.encode()))


# --- graph -----------------------------------------------------------------


def _densify(line: np.ndarray, spacing: float) -> tuple[np.ndarray, np.ndarray]:
    seg = np.linalg.norm(np.diff(line, axis=0), axis=1)
    keep = np.concatenate([[True], seg > 1e-6])
    line = line[keep]
    seg = np.linalg.norm(np.diff(line, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    total = cum[-1]
    n = max(2, int(math.ceil(total / spacing)) + 1)
    s = np.union1d(np.linspace(0, total, n), cum)
    # Drop samples that nearly coincide (uniform grid vs original vertices).
    s = s[np.concatenate([[True], np.diff(s) > 0.25])]
    s[-1] = total
    x = np.interp(s, cum, line[:, 0])
    z = np.interp(s, cum, line[:, 1])
    return np.stack([x, z], axis=1), s


def _lateral(xz: np.ndarray) -> np.ndarray:
    t = np.gradient(xz, axis=0)
    t /= np.maximum(np.linalg.norm(t, axis=1, keepdims=True), 1e-9)
    # Right of travel with +x east, +z south: rotate tangent by -90 deg in the map view.
    return np.stack([-t[:, 1], t[:, 0]], axis=1)


def build_road_graph(G: nx.MultiDiGraph, dem: DemGrid, area: Area) -> tuple[dict[int, RoadNode], list[RoadEdge]]:
    nodes: dict[int, RoadNode] = {}
    for nid, d in G.nodes(data=True):
        x, z = to_game(float(d["x"]), float(d["y"]))
        nodes[int(nid)] = RoadNode(int(nid), float(x), float(z))

    seen: set = set()
    edges: list[RoadEdge] = []
    for u, v, _k, d in sorted(G.edges(keys=True, data=True), key=lambda e: (str(e[3].get("osmid")), e[0], e[1], e[2])):
        u, v = int(u), int(v)
        way_id = int(_one(d.get("osmid")))
        oneway = bool(_one(d.get("oneway")) in (True, "True", "true", "yes"))
        geom = d.get("geometry")
        if geom is not None:
            lon, lat = np.asarray(geom.xy)
        else:
            lon = np.array([G.nodes[u]["x"], G.nodes[v]["x"]], dtype=float)
            lat = np.array([G.nodes[u]["y"], G.nodes[v]["y"]], dtype=float)
        x, z = to_game(lon, lat)
        line = np.stack([x, z], axis=1)
        if not oneway:
            # Two-way roads appear as u->v and v->u; keep one.
            key = (way_id, min(u, v), max(u, v), round(float(d.get("length", 0)), 1))
            if key in seen:
                continue
            seen.add(key)
        # Graph geometry already runs u -> v.
        xz, s = _densify(line, SAMPLE_SPACING)
        if s[-1] < 0.5:
            continue

        hw = _one(d.get("highway")) or "road"
        base = hw.replace("_link", "")
        defaults = CLASS_DEFAULTS.get(base, CLASS_DEFAULTS["road"])
        if hw.endswith("_link"):
            defaults = LINK_DEFAULTS
        two_way_lanes, one_way_lanes, lane_w, speed = defaults

        lanes_tag = _num(d.get("lanes"))
        lanes = int(lanes_tag) if lanes_tag and 1 <= lanes_tag <= 8 else (one_way_lanes if oneway else two_way_lanes)
        width_tag = _num(d.get("width"))
        if width_tag and 2.5 <= width_tag <= 40:
            lane_w = width_tag / lanes

        speed_tag = _speed(d.get("maxspeed"))
        surface_tag = _one(d.get("surface"))
        if surface_tag:
            surface = "paved" if str(surface_tag).lower() in PAVED_SURFACES else "unpaved"
        else:
            share = PAVED_SHARE.get(base, 1.0)
            surface = "paved" if _seed_rng(f"surface:{way_id}").random() < share else "unpaved"

        name = _one(d.get("name"))
        ref = _one(d.get("ref"))
        edges.append(
            RoadEdge(
                id=len(edges),
                u=u,
                v=v,
                way_id=way_id,
                name=str(name) if name else None,
                ref=str(ref) if ref else None,
                highway=hw,
                lanes=lanes,
                lanes_tagged=lanes_tag is not None,
                oneway=oneway,
                speed_kph=speed_tag or speed,
                speed_tagged=speed_tag is not None,
                surface=surface,
                surface_tag=str(surface_tag) if surface_tag else None,
                bridge=_truthy(d.get("bridge")),
                lane_width=lane_w,
                xz=xz,
                s=s,
                nrm=_lateral(xz),
            )
        )

    for e in edges:
        nodes[e.u].degree += 1
        nodes[e.v].degree += 1
    nodes = {k: n for k, n in nodes.items() if n.degree > 0}

    _profile(nodes, edges, dem, area)
    return nodes, edges


def _profile(nodes: dict[int, RoadNode], edges: list[RoadEdge], dem: DemGrid, area: Area) -> None:
    """Heights, cross slopes and grades from the smoothed DEM."""
    ids = list(nodes)
    ys = dem.sample([nodes[i].x for i in ids], [nodes[i].z for i in ids])
    for i, y in zip(ids, ys):
        nodes[i].y = float(y)

    gx, gz = dem.gradient()
    for e in edges:
        L = e.length
        t = e.s / L
        hu, hv = nodes[e.u].y, nodes[e.v].y
        if e.bridge:
            hc = hu + (hv - hu) * t
        else:
            raw = dem.sample(e.xz[:, 0], e.xz[:, 1])
            step = L / max(len(e.s) - 1, 1)
            hc = ndimage.gaussian_filter1d(raw, sigma=PROFILE_SMOOTH_M / max(step, 0.1), mode="nearest")
            # Pin the ends to the junction heights so edges meet cleanly.
            hc = hc + (hu - hc[0]) * (1 - t) + (hv - hc[-1]) * t
        fi = (e.xz[:, 0] - dem.x0) / dem.spacing
        fj = (e.xz[:, 1] - dem.z0) / dem.spacing
        sx = ndimage.map_coordinates(gx, [fj, fi], order=1, mode="nearest")
        sz = ndimage.map_coordinates(gz, [fj, fi], order=1, mode="nearest")
        cs = sx * e.nrm[:, 0] + sz * e.nrm[:, 1]
        cs = ndimage.gaussian_filter1d(cs, sigma=4, mode="nearest")
        m = area.road_max_cross_slope
        e.hc = hc
        e.cs = np.clip(cs, -m, m) if not e.bridge else np.zeros_like(cs)
        e.grade = float((hv - hu) / L * 100)
        if L > GRADE_WINDOW_M:
            s0 = np.arange(0, L - GRADE_WINDOW_M + 1e-6, SAMPLE_SPACING)
            dh = np.interp(s0 + GRADE_WINDOW_M, e.s, hc) - np.interp(s0, e.s, hc)
            e.max_grade = float(np.abs(dh).max() / GRADE_WINDOW_M * 100)
        else:
            e.max_grade = abs(e.grade)


# --- serialisation ---------------------------------------------------------


def _rdp(points: np.ndarray, tol: float) -> np.ndarray:
    """Ramer-Douglas-Peucker on 3D points; returns kept indices."""
    keep = np.zeros(len(points), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        p, q = points[a], points[b]
        seg = q - p
        L2 = seg @ seg
        pts = points[a + 1 : b]
        if L2 == 0:
            d = np.linalg.norm(pts - p, axis=1)
        else:
            t = np.clip(((pts - p) @ seg) / L2, 0, 1)
            d = np.linalg.norm(pts - (p + t[:, None] * seg), axis=1)
        i = int(np.argmax(d))
        if d[i] > tol:
            m = a + 1 + i
            keep[m] = True
            stack += [(a, m), (m, b)]
    return np.nonzero(keep)[0]


def edge_polyline(e: RoadEdge, tol: float = 0.25) -> list[list[float]]:
    pts = np.stack([e.xz[:, 0], e.hc, e.xz[:, 1]], axis=1)
    idx = _rdp(pts, tol)
    return np.round(pts[idx], 2).tolist()


def edge_to_json(e: RoadEdge) -> dict:
    return {
        "id": e.id,
        "u": e.u,
        "v": e.v,
        "wayId": e.way_id,
        "name": e.name,
        "ref": e.ref,
        "highway": e.highway,
        "lanes": e.lanes,
        "lanesTagged": e.lanes_tagged,
        "oneway": e.oneway,
        "speedLimitKph": e.speed_kph,
        "speedTagged": e.speed_tagged,
        "surface": e.surface,
        "surfaceTag": e.surface_tag,
        "bridge": e.bridge,
        "width": round(e.width, 2),
        "drains": e.has_drains,
        "length": round(e.length, 1),
        "grade": round(e.grade, 2),
        "maxGrade": round(e.max_grade, 2),
        "polyline": edge_polyline(e),
    }


def node_to_json(n: RoadNode) -> dict:
    return {"id": n.id, "x": round(n.x, 2), "y": round(n.y, 2), "z": round(n.z, 2), "degree": n.degree}


# --- spatial lookups -------------------------------------------------------


class RoadIndex:
    """Nearest-centreline lookups over every dense road sample."""

    def __init__(self, edges: list[RoadEdge], include_bridges: bool = True):
        rows = [e for e in edges if include_bridges or not e.bridge]
        self.edge_of = np.concatenate([np.full(len(e.s), e.id) for e in rows])
        self.idx_in_edge = np.concatenate([np.arange(len(e.s)) for e in rows])
        xz = np.concatenate([e.xz for e in rows])
        self.xz = xz
        self.hc = np.concatenate([e.hc for e in rows])
        self.cs = np.concatenate([e.cs for e in rows])
        self.nrm = np.concatenate([e.nrm for e in rows])
        self.half = np.concatenate([np.full(len(e.s), e.corridor_half_width) for e in rows])
        self.s = np.concatenate([e.s for e in rows])
        # Longitudinal slope, so lookups can correct for the offset between a
        # query point's foot on the centreline and the nearest sample.
        self.dhds = np.clip(np.concatenate([np.gradient(e.hc, e.s) if len(e.s) > 1 else np.zeros(1) for e in rows]), -0.5, 0.5)
        self.tree = cKDTree(xz)

    def surface_height(self, i, x, z):
        """Road plane height at (x, z) using sample i as the reference."""
        dx, dz = x - self.xz[i, 0], z - self.xz[i, 1]
        nx, nz = self.nrm[i, 0], self.nrm[i, 1]
        lateral = dx * nx + dz * nz
        along = dx * nz - dz * nx  # tangent = (nz, -nx)
        return self.hc[i] + along * self.dhds[i] + lateral * self.cs[i]

    def nearest(self, x, z, max_dist=np.inf):
        d, i = self.tree.query(np.stack([np.ravel(x), np.ravel(z)], axis=1), distance_upper_bound=max_dist)
        return d, i


# --- meshes ----------------------------------------------------------------

PAVED_RGB = (0.30, 0.30, 0.31)
UNPAVED_RGB = (0.62, 0.38, 0.24)
DRAIN_WALL_RGB = (0.62, 0.61, 0.58)
DRAIN_BED_RGB = (0.16, 0.15, 0.12)


def _junction_trim(nodes, edges) -> dict[int, float]:
    """Distance to pull road ribbons back from each junction that gets a patch."""
    inc: dict[int, list[RoadEdge]] = {}
    for e in edges:
        inc.setdefault(e.u, []).append(e)
        inc.setdefault(e.v, []).append(e)
    trims = {}
    for nid, es in inc.items():
        if len(es) >= 3 or (len(es) == 2 and _bend(nid, es) > 20):
            trims[nid] = max(e.corridor_half_width for e in es) * 1.1 + 0.5
    return trims


def _bend(nid, es) -> float:
    dirs = []
    for e in es:
        if e.u == nid:
            d = e.xz[min(3, len(e.xz) - 1)] - e.xz[0]
        else:
            d = e.xz[max(-4, -len(e.xz))] - e.xz[-1]
        dirs.append(d / max(np.linalg.norm(d), 1e-9))
    c = float(np.clip(-dirs[0] @ dirs[1], -1, 1))
    return math.degrees(math.acos(c))


def _trim_range(e: RoadEdge, trims: dict[int, float]) -> tuple[int, int]:
    a = trims.get(e.u, 0.0)
    b = trims.get(e.v, 0.0)
    if a + b > e.length * 0.9:
        scale = e.length * 0.9 / (a + b)
        a, b = a * scale, b * scale
    i0 = int(np.searchsorted(e.s, a))
    i1 = int(np.searchsorted(e.s, e.length - b, side="right")) - 1
    return i0, i1


def build_road_meshes(nodes, edges, bank: MeshBank) -> None:
    trims = _junction_trim(nodes, edges)
    ends: dict[int, list] = {}  # node -> [(left pt, right pt, edge)]

    for e in edges:
        i0, i1 = _trim_range(e, trims)
        if i1 - i0 < 1:
            continue
        sl = slice(i0, i1 + 1)
        xz, s, nrm, hc, cs = e.xz[sl], e.s[sl], e.nrm[sl], e.hc[sl], e.cs[sl]
        hw = e.half_width
        mat = "road_paved" if e.surface == "paved" else "road_unpaved"
        pos, faces, nr, uv = sweep(xz, s, nrm, hc, cs, [(-hw, 0.0), (hw, 0.0)], lift=ROAD_LIFT)
        uv[:, 0] = uv[:, 0] / e.width + 0.5  # u 0..1 across, v metres along
        col = np.tile(rgba(PAVED_RGB if e.surface == "paved" else UNPAVED_RGB), (len(pos), 1))
        bank.add(mat, pos, faces, nr, uv, col)

        if e.has_drains:
            w0, w1, w2, w3 = hw, hw + DRAIN_WALL, hw + DRAIN_WALL + DRAIN_WIDTH, hw + DRAIN_ZONE
            lip, bed = DRAIN_DEPTH_LIP, 0.02
            right = [(w0, 0.0), (w0, lip), (w1, lip), (w1, bed), (w2, bed), (w2, lip), (w3, lip), (w3, -0.4)]
            left = [(-o, d) for o, d in reversed(right)]
            for prof in (left, right):
                pos, faces, nr, uv = sweep(xz, s, nrm, hc, cs, prof, lift=ROAD_LIFT)
                col = _drain_colors(prof, len(xz))
                bank.add("drain", pos, faces, nr, uv, col)

        for nid, k in ((e.u, 0), (e.v, -1)):
            if nid in trims:
                left_pt = xz[k] - nrm[k] * hw
                right_pt = xz[k] + nrm[k] * hw
                ends.setdefault(nid, []).append((left_pt, hc[k] - cs[k] * hw, right_pt, hc[k] + cs[k] * hw, e))

    for nid, items in ends.items():
        _junction_patch(nodes[nid], items, bank)


def _drain_colors(prof, n) -> np.ndarray:
    cols = []
    for a in range(len(prof) - 1):
        is_bed = 0 <= prof[a][1] < 0.1 and 0 <= prof[a + 1][1] < 0.1
        c = rgba(DRAIN_BED_RGB if is_bed else DRAIN_WALL_RGB)
        cols.append(np.tile(c, (2 * n, 1)))
    return np.concatenate(cols)


def _junction_patch(node: RoadNode, items, bank: MeshBank) -> None:
    pts, hs = [], []
    paved_w, unpaved_w = 0.0, 0.0
    for lp, hl, rp, hr, e in items:
        pts += [lp, rp]
        hs += [hl, hr]
        if e.surface == "paved":
            paved_w = max(paved_w, e.width)
        else:
            unpaved_w = max(unpaved_w, e.width)
    pts = np.asarray(pts)
    hull = MultiPoint([tuple(p) for p in pts] + [(node.x, node.z)]).convex_hull
    if hull.geom_type != "Polygon" or hull.area < 1:
        return
    ring = np.asarray(hull.exterior.coords)[:-1]
    tree = cKDTree(pts)
    _, nearest = tree.query(ring)
    ring_h = np.asarray(hs)[nearest]
    # Hull vertices that aren't road corners (the node itself) take the node height.
    far = np.linalg.norm(pts[nearest] - ring, axis=1) > 0.01
    ring_h[far] = node.y
    n = len(ring)
    pos = np.zeros((n + 1, 3))
    pos[0] = (node.x, node.y + PATCH_LIFT, node.z)
    pos[1:, 0] = ring[:, 0]
    pos[1:, 1] = ring_h + PATCH_LIFT
    pos[1:, 2] = ring[:, 1]
    i = np.arange(n)
    faces = np.stack([np.zeros(n, dtype=int), 1 + i, 1 + (i + 1) % n], axis=1)
    faces = orient_faces(pos, faces, np.array([0.0, 1.0, 0.0]))
    paved = paved_w >= unpaved_w
    mat = "road_paved" if paved else "road_unpaved"
    # u = 0.5 everywhere: a junction has no road edge, so the game draws no edge wear.
    uv = np.stack([np.full(len(pos), 0.5), np.zeros(len(pos))], axis=1)
    col = np.tile(rgba(PAVED_RGB if paved else UNPAVED_RGB), (len(pos), 1))
    key = bank.chunk_of(node.x, node.z)
    bank.add(mat, pos, faces, vertex_normals(pos, faces), uv, col, key=key)
