"""Terrain heightfield: road flattening, per-chunk heightfields and meshes.

Under every road the terrain is replaced by the road surface: the smoothed
centreline height plus a cross slope capped at area.road_max_cross_slope
(4 %). The plane extends one grid cell past the corridor so bilinear
interpolation stays on it, then blends back to the natural surface over
SHOULDER_M. Bridges are not stamped.
"""

from __future__ import annotations

import numpy as np
import shapely
import trimesh
from affine import Affine
from rasterio import features as rio_features
from scipy import ndimage

from .config import Area
from .fetch_dem import DemGrid
from .meshes import MeshBank, orient_faces, rgba
from .roads import RoadEdge, RoadIndex

SHOULDER_M = 8.0

LATERITE = np.array([0.58, 0.40, 0.28])
GRASS = np.array([0.33, 0.45, 0.20])
BUSH = np.array([0.24, 0.36, 0.16])


def flatten_under_roads(dem: DemGrid, edges: list[RoadEdge]) -> np.ndarray:
    """Return a copy of dem.heights with road corridors stamped in."""
    h = dem.heights.copy()
    idx = RoadIndex(edges, include_bridges=False)
    nz, nx = h.shape
    gx, gz = np.meshgrid(dem.x0 + np.arange(nx) * dem.spacing, dem.z0 + np.arange(nz) * dem.spacing)
    px, pz = gx.ravel(), gz.ravel()
    # Keep the road plane 1.5 grid cells past the corridor so every cell that
    # touches the carriageway interpolates on the plane, not the blend.
    pad = dem.spacing * 1.5
    reach = float(idx.half.max()) + pad + SHOULDER_M
    d, i = idx.nearest(px, pz, max_dist=reach)
    hit = np.isfinite(d)
    px, pz, d, i = px[hit], pz[hit], d[hit], i[hit]

    half = idx.half[i] + pad
    road_h = idx.surface_height(i, px, pz)
    orig = h.ravel()[hit]

    t = np.clip((d - half) / SHOULDER_M, 0, 1)
    t = t * t * (3 - 2 * t)  # smoothstep
    new = road_h * (1 - t) + orig * t
    flat = h.ravel()
    flat[np.nonzero(hit)[0]] = new
    return flat.reshape(h.shape)


def _game_transform(dem: DemGrid) -> Affine:
    """Affine from (col, row) to game (x, z) with cells centred on samples."""
    s = dem.spacing
    return Affine(s, 0, dem.x0 - s / 2, 0, s, dem.z0 - s / 2)


def cover_masks(dem: DemGrid, green, water) -> tuple[np.ndarray, np.ndarray]:
    """Rasterise green and water polygons (game x,z) onto the DEM grid, softened."""
    shape = dem.heights.shape
    tr = _game_transform(dem)

    def burn(geoms):
        geoms = [g for g in geoms if g is not None and not g.is_empty]
        if not geoms:
            return np.zeros(shape, dtype=np.float32)
        m = rio_features.rasterize(((g, 1) for g in geoms), out_shape=shape, transform=tr, fill=0, dtype="uint8", all_touched=True)
        return ndimage.gaussian_filter(m.astype(np.float32), 1.0)

    return burn(green), burn(water)


def _noise(x, z, seed=0) -> np.ndarray:
    """Cheap deterministic value noise in [0,1] for colour variation."""
    xi = np.floor(x / 23.0).astype(np.int64)
    zi = np.floor(z / 23.0).astype(np.int64)
    h = (xi * 73856093) ^ (zi * 19349663) ^ (seed * 83492791)
    return ((h & 0xFFFF) / 65535.0).astype(np.float64)


def chunk_heightfield(area: Area, dem: DemGrid, heights: np.ndarray, cx: int, cz: int) -> np.ndarray:
    """(n+1, n+1) heights for chunk (cx, cz). Row = z index (north->south), col = x (west->east)."""
    sp = dem.spacing
    n = int(area.chunk_size / sp)
    i0 = int(round((cx * area.chunk_size - dem.x0) / sp))
    j0 = int(round((cz * area.chunk_size - dem.z0) / sp))
    return heights[j0 : j0 + n + 1, i0 : i0 + n + 1]


def add_terrain_mesh(area: Area, dem: DemGrid, heights: np.ndarray, green: np.ndarray, cx: int, cz: int, bank: MeshBank) -> np.ndarray:
    hf = chunk_heightfield(area, dem, heights, cx, cz)
    sp = dem.spacing
    n = hf.shape[0]
    x0, z0 = cx * area.chunk_size, cz * area.chunk_size
    xs = x0 + np.arange(n) * sp
    zs = z0 + np.arange(n) * sp
    gx, gz = np.meshgrid(xs, zs)
    pos = np.stack([gx.ravel(), hf.ravel(), gz.ravel()], axis=1).astype(np.float64)

    # Normals from the full grid so they match across chunk borders.
    i0 = int(round((x0 - dem.x0) / sp))
    j0 = int(round((z0 - dem.z0) / sp))
    dz_, dx_ = np.gradient(heights, sp)
    dx = dx_[j0 : j0 + n, i0 : i0 + n].ravel()
    dz = dz_[j0 : j0 + n, i0 : i0 + n].ravel()
    nrm = np.stack([-dx, np.ones_like(dx), -dz], axis=1)
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)

    g = green[j0 : j0 + n, i0 : i0 + n].ravel()
    base = LATERITE[None, :] * (0.9 + 0.2 * _noise(pos[:, 0], pos[:, 2])[:, None])
    veg = np.where(_noise(pos[:, 0], pos[:, 2], 7)[:, None] > 0.5, GRASS, BUSH)
    col = base * (1 - g[:, None]) + veg * g[:, None]
    colors = np.concatenate([np.clip(col * 255, 0, 255), np.full((len(col), 1), 255)], axis=1).astype(np.uint8)

    ii, jj = np.meshgrid(np.arange(n - 1), np.arange(n - 1))
    a = (jj * n + ii).ravel()
    b = a + 1
    c = a + n
    d = c + 1
    # Winding: counter-clockwise seen from +Y with +x east, +z south.
    faces = np.concatenate([np.stack([a, c, b], axis=1), np.stack([b, c, d], axis=1)])
    uv = np.stack([pos[:, 0], pos[:, 2]], axis=1)  # metres; the game picks the texture scale
    bank.add("terrain", pos, faces, nrm, uv, colors, key=(cx, cz))
    return hf


def add_water_meshes(area: Area, dem: DemGrid, heights: np.ndarray, water_geoms, bank: MeshBank) -> None:
    """Drape water polygons on the terrain, split per chunk."""
    size = area.chunk_size
    fi = lambda x: (x - dem.x0) / dem.spacing
    fj = lambda z: (z - dem.z0) / dem.spacing
    col = rgba((0.22, 0.30, 0.24))
    for g in water_geoms:
        if g is None or g.is_empty:
            continue
        minx, minz, maxx, maxz = g.bounds
        for ccx in range(int(np.floor(minx / size)), int(np.floor(maxx / size)) + 1):
            for ccz in range(int(np.floor(minz / size)), int(np.floor(maxz / size)) + 1):
                if (ccx, ccz) not in bank.valid:
                    continue
                piece = g.intersection(shapely.box(ccx * size, ccz * size, (ccx + 1) * size, (ccz + 1) * size))
                for poly in getattr(piece, "geoms", [piece]):
                    if poly.geom_type != "Polygon" or poly.area < 2:
                        continue
                    poly = shapely.segmentize(poly, 4.0)
                    try:
                        v2, f = trimesh.creation.triangulate_polygon(poly, engine="earcut")
                    except Exception:
                        continue
                    if len(f) == 0:
                        continue
                    y = ndimage.map_coordinates(heights, [fj(v2[:, 1]), fi(v2[:, 0])], order=1, mode="nearest")
                    pos = np.stack([v2[:, 0], y + 0.12, v2[:, 1]], axis=1)
                    f = orient_faces(pos, np.asarray(f), np.array([0.0, 1.0, 0.0]))
                    uv = v2.copy()
                    bank.add("water", pos, f, None, uv, np.tile(col, (len(pos), 1)), key=(ccx, ccz))
