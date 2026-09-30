"""Far-field LOD for the whole area: a coarse heightfield and a baked colour map.

The game draws this single mesh beyond the streamed chunks so a player on a
hill sees the city spread out without loading hundreds of chunk .glb files.
Buildings are baked into the colour map as roof-coloured footprints with a
short sun shadow, which reads as the "sea of zinc roofs" at a distance.

  far.bin  float32 LE, rows x cols, row-major, row = z (north->south); sample
           (i, j) at (extent.minX + i*spacing, extent.minZ + j*spacing)
  far.jpg  colour map covering the extent, north up (row 0 = minZ)
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import shapely
from affine import Affine
from PIL import Image
from rasterio import features as rio_features
from scipy import ndimage

from .fetch_dem import DemGrid
from .roads import PAVED_RGB, UNPAVED_RGB, RoadEdge
from .terrain import BUSH, GRASS, LATERITE

FAR_SPACING_M = 20.0
FAR_PIXEL_M = 4.0
JPEG_QUALITY = 82
# Morning sun is in the east, so shadows fall west (-x), a pixel or two long.
SHADOW_SHIFT_PX = (0, -1)
SHADOW_DARKEN = 0.62


def build_far_field(out: Path, extent, dem: DemGrid, heights: np.ndarray, green_mask: np.ndarray, edges: list[RoadEdge], buildings: list[dict]) -> dict:
    min_x, min_z, max_x, max_z = extent

    # Coarse heights.
    cols = int(round((max_x - min_x) / FAR_SPACING_M)) + 1
    rows = int(round((max_z - min_z) / FAR_SPACING_M)) + 1
    gx, gz = np.meshgrid(min_x + np.arange(cols) * FAR_SPACING_M, min_z + np.arange(rows) * FAR_SPACING_M)
    fi = (gx - dem.x0) / dem.spacing
    fj = (gz - dem.z0) / dem.spacing
    far_h = ndimage.map_coordinates(heights, [fj.ravel(), fi.ravel()], order=1, mode="nearest").reshape(rows, cols)
    (out / "far.bin").write_bytes(np.ascontiguousarray(far_h, dtype="<f4").tobytes())

    # Colour map.
    w = int(round((max_x - min_x) / FAR_PIXEL_M))
    h = int(round((max_z - min_z) / FAR_PIXEL_M))
    px, pz = np.meshgrid(min_x + (np.arange(w) + 0.5) * FAR_PIXEL_M, min_z + (np.arange(h) + 0.5) * FAR_PIXEL_M)
    g = ndimage.map_coordinates(green_mask, [((pz - dem.z0) / dem.spacing).ravel(), ((px - dem.x0) / dem.spacing).ravel()], order=1, mode="nearest").reshape(h, w)
    rng = np.random.default_rng(7)
    grain = ndimage.gaussian_filter(rng.random((h, w)), 2.0)
    grain = (grain - grain.mean()) / max(grain.std(), 1e-6)
    base = LATERITE[None, None, :] * (1.0 + 0.06 * grain[..., None])
    veg = np.where((grain > 0)[..., None], GRASS, BUSH)
    img = base * (1 - g[..., None]) + veg * g[..., None]

    tr = Affine(FAR_PIXEL_M, 0, min_x, 0, FAR_PIXEL_M, min_z)
    paved = [shapely.buffer(shapely.LineString(e.xz), e.half_width, cap_style="flat") for e in edges if len(e.xz) > 1 and e.surface == "paved"]
    unpaved = [shapely.buffer(shapely.LineString(e.xz), e.half_width, cap_style="flat") for e in edges if len(e.xz) > 1 and e.surface != "paved"]
    for geoms, rgb in ((unpaved, UNPAVED_RGB), (paved, PAVED_RGB)):
        if geoms:
            m = rio_features.rasterize(((gg, 1) for gg in geoms), out_shape=(h, w), transform=tr, fill=0, dtype="uint8", all_touched=True)
            img[m > 0] = rgb

    if buildings:
        lut = np.zeros((len(buildings) + 1, 3))
        for k, b in enumerate(buildings, start=1):
            lut[k] = np.asarray(b["roof_rgba"][:3], dtype=np.float64) / 255.0
        ids = rio_features.rasterize(((b["poly"], k) for k, b in enumerate(buildings, start=1)), out_shape=(h, w), transform=tr, fill=0, dtype="int32")
        roof = ids > 0
        dy, dx = SHADOW_SHIFT_PX
        shadow = np.roll(np.roll(roof, dy, axis=0), dx, axis=1) & ~roof
        img[shadow] *= SHADOW_DARKEN
        img[roof] = lut[ids[roof]]

    rgb8 = (np.clip(img, 0, 1) * 255).astype(np.uint8)
    Image.fromarray(rgb8, "RGB").save(out / "far.jpg", quality=JPEG_QUALITY, optimize=True)

    return {
        "heightfield": "far.bin",
        "colorMap": "far.jpg",
        "spacing": FAR_SPACING_M,
        "rows": rows,
        "cols": cols,
        "pixelSize": FAR_PIXEL_M,
        "imageSize": [w, h],
        "format": "far.bin: float32 LE, row-major, row = z (north to south); far.jpg row 0 = extent.minZ",
    }
